// Robô de mesa · protótipo para Android (navegador).
// A organização imita o robô de verdade:
//   S3  = percepção (microfone: ritmo, música, cantarolar, assobio, susto; câmera: rosto)
//   C3  = corpo (rosto na tela 240×240, sons fofos, sensor de temperatura simulado)
//   Cérebro = emoções em 3 camadas (personalidade, humor do dia, emoção) + Groq
// As mensagens entre S3 e C3 passam pelo "bus", que no robô vira a UART.

const $ = (s) => document.querySelector(s)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const rnd = (a, b) => a + Math.random() * (b - a)
const now = () => performance.now()
const store = {
  get(k, d) { try { const v = localStorage.getItem('robo.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('robo.' + k, JSON.stringify(v)) } catch {} },
  del(k) { try { localStorage.removeItem('robo.' + k) } catch {} },
}

// ---------------------------------------------------------------- barramento
const VERSAO = 'v13 · 08/11'
const logLines = []
const filaLog = [] // tudo o que aconteceu desde o último envio para o log remoto
function pushLog(s) {
  const t = new Date().toLocaleTimeString('pt-BR')
  logLines.unshift(`${t}  ${s}`)
  if (logLines.length > 60) logLines.pop()
  filaLog.push(`${t}  ${s}`); if (filaLog.length > 4000) filaLog.splice(0, 1000)
}
const handlers = {}
const bus = {
  on(t, f) { (handlers[t] ??= []).push(f) },
  emit(t, d = {}, from = 'S3') {
    if (!['beat', 'gaze', 'pitch', 'face'].includes(t)) pushLog(`${from}→ ${t}${d.label ? ' · ' + d.label : ''}`)
    ;(handlers[t] || []).forEach((f) => f(d))
  },
}

// ---------------------------------------------------------------- configurações
const cfg = Object.assign({ nome: 'Robô', dono: 'Will', key: '', model: 'openai/gpt-oss-120b', stt: 'whisper-large-v3-turbo', legenda: false, maosLivres: true }, store.get('cfg', {}))
// Link pessoal com a chave: …/robo-de-mesa/#chave=gsk_… O que vem depois do # nunca é
// enviado para o servidor; fica só no celular (no favorito ou no atalho).
// A chave só é trocada por outra chave válida: campo vazio ou preenchido errado nunca apaga a boa.
// Fica em dois lugares do site e também no gerenciador de senhas do Chrome (sobrevive a limpar os dados).
const chaveValida = (k) => /^gsk_[A-Za-z0-9]{20,}$/.test((k || '').trim())
function guardarChave(k, origem) {
  k = (k || '').trim()
  if (!chaveValida(k)) return false
  const nova = k !== cfg.key || store.get('chave', '') !== k
  cfg.key = k; store.set('cfg', cfg); store.set('chave', k)
  if (nova) {
    pushLog(`Chave do Groq salva (${origem}) …${k.slice(-4)}`)
    if (window.PasswordCredential) navigator.credentials.store(new PasswordCredential({ id: 'Groq', name: 'Chave do Groq (Robô de mesa)', password: k })).catch(() => {})
  }
  return true
}
if (!chaveValida(cfg.key)) cfg.key = chaveValida(store.get('chave', '')) ? store.get('chave', '') : ''
let chaveReserva = ''
{
  const m = location.hash.match(/chave=(gsk_[A-Za-z0-9]+)/), ruins = store.get('chavesRuins', [])
  if (m && ruins.includes(m[1])) pushLog('Seu link pessoal tem uma chave do Groq antiga (recusada). Toque em ⚙️ → "Copiar meu link com a chave" para atualizar o link.')
  else if (m && chaveValida(cfg.key) && m[1] !== cfg.key) chaveReserva = m[1] // guarda a do link como reserva; vale a que já estava salva
  else if (m) guardarChave(m[1], 'link')
}
{ const m = location.hash.match(/log=((?:github_pat_|ghp_)[A-Za-z0-9_]+)/); if (m && m[1] !== cfg.logToken) { cfg.logToken = m[1]; store.set('cfg', cfg); store.set('logToken', m[1]) } }
if (!cfg.logToken && store.get('logToken', '')) cfg.logToken = store.get('logToken', '')
cfg.logRepo ||= 'userm4c/robo-logs'
let dadosProtegidos = null
navigator.storage?.persisted?.().then((v) => (dadosProtegidos = v)).catch(() => {})
// Se os dados do site sumiram, tenta pegar a chave do gerenciador de senhas do Chrome.
async function recuperarChave() {
  if (chaveValida(cfg.key) || !window.PasswordCredential) return
  try {
    const c = await navigator.credentials.get({ password: true, mediation: 'optional' })
    if (c?.password && guardarChave(c.password, 'gerenciador de senhas')) carregarModelos()
  } catch {}
}
// Pede ao navegador para não apagar os dados deste site quando precisar de espaço.
navigator.storage?.persist?.().then((v) => (dadosProtegidos = v)).catch(() => {})

// ================================================================ CÉREBRO
// Personalidade: muda devagar (semanas). Humor do dia: sorteado ao acordar.
// Emoção: reação rápida a cada evento, que decai até o humor.
const PERS_PADRAO = { extroversao: 0.6, curiosidade: 0.7, energia: 0.6, sensibilidade: 0.5, afeto: 0.5, gostos: { calma: 0, animada: 0, pesada: 0, cantarolar: 0, assobio: 0 }, nasceu: Date.now(), dias: 0 }
let P = Object.assign(structuredClone(PERS_PADRAO), { confianca: 0.5, melodia: null, opiniao: '', ultimaReflexao: 0 }, store.get('pers', {}))
P.gostos = Object.assign({}, PERS_PADRAO.gostos, P.gostos)
let memorias = store.get('memorias', []).map((m) => ({ imp: 3, ...m })).filter((m) => m.tipo !== 'fato' || (m.imp >= 2 && String(m.txt).length >= 12)) // tira lembranças banais ou quebradas

// Necessidades (inspirado nos "drives" do Kismet, do MIT): cada uma tem uma faixa boa.
// Fora da faixa, ele fica incomodado e procura um jeito de voltar (chamar atenção, inventar
// brincadeira, cochilar). Dentro da faixa, fica contente.
const N = Object.assign({ social: 0.6, estimulo: 0.5, energia: 0.8 }, store.get('necess', {}))
const FAIXA = { social: [0.35, 0.97], estimulo: [0.3, 0.85], energia: [0.25, 1] }
// Habituação: a mesma coisa repetida vai perdendo a graça (e volta a ter depois de um tempo).
const hab = {}

// Protótipos PAD (prazer, ativação, domínio) de cada emoção.
const PAD = {
  neutro: [0, 0, 0], contente: [0.45, -0.25, 0.1], feliz: [0.65, 0.35, 0.2], animado: [0.75, 0.8, 0.3],
  amor: [0.85, 0.3, 0], triste: [-0.6, -0.4, -0.3], bravo: [-0.6, 0.6, 0.45], medo: [-0.55, 0.75, -0.55],
  surpreso: [0.15, 0.85, 0], entediado: [-0.25, -0.6, 0], sono: [0, -0.95, -0.1], curioso: [0.25, 0.45, 0.1],
  rindo: [0.8, 0.7, 0.3], apaixonado: [0.9, 0.3, 0], empolgado: [0.8, 0.9, 0.3], tonto: [-0.1, 0.3, -0.4],
  timido: [0.3, 0.1, -0.5], desconfiado: [-0.2, 0.2, 0.3], chorando: [-0.8, 0.3, -0.5], orgulhoso: [0.6, 0.3, 0.7],
}
const EMOCOES = Object.keys(PAD)
const SO_EVENTO = new Set(['amor', 'curioso', 'rindo', 'apaixonado', 'empolgado', 'tonto', 'timido', 'desconfiado', 'chorando', 'orgulhoso'])
function nomePAD(e) {
  let best = 'neutro', bd = 1e9
  for (const [k, v] of Object.entries(PAD)) {
    if (SO_EVENTO.has(k)) continue // só por evento
    const d = (e.P - v[0]) ** 2 + (e.A - v[1]) ** 2 + 0.5 * (e.D - v[2]) ** 2
    if (d < bd) { bd = d; best = k }
  }
  return best
}

const hoje = new Date().toLocaleDateString('sv')
let humor = store.get('humor', null)
if (!humor || humor.dia !== hoje) {
  // Acordou: humor sorteado em volta do jeito dele (às vezes acorda de mau humor sem saber por quê).
  humor = {
    dia: hoje,
    P: clamp(0.15 + (P.afeto - 0.5) * 0.3 + rnd(-0.45, 0.45), -1, 1),
    A: clamp((P.energia - 0.5) * 0.8 + rnd(-0.4, 0.4), -1, 1),
    D: rnd(-0.3, 0.3),
  }
  P.dias++
  store.set('humor', humor); store.set('pers', P)
}
humor.P = clamp(lerp(humor.P, 0.1 + (P.afeto - 0.5) * 0.4, 0.5), -0.4, 0.9); humor.A = lerp(humor.A, 0, 0.4) // acorda mais perto do jeito normal dele
humor.nomeInicial = nomePAD(humor)

const imp = { P: 0, A: 0, D: 0 } // impulso das emoções, decai
const emo = { P: humor.P, A: humor.A, D: humor.D, nome: 'neutro' }
let foco = null      // expressão temporária forçada por um evento {expr, ate}
let icone = null     // {tipo, ate}
let ultimoEvento = now()

// Memória (inspirada nos Generative Agents, de Stanford): cada lembrança tem importância
// de 1 a 10. Para lembrar, conta o quanto é recente e o quanto é importante.
let impDesdeReflexao = store.get('impReflexao', 0)
function lembrar(txt, imp = 4, tipo = 'fato') {
  const igual = memorias.slice(0, 15).find((m) => m.txt === txt && Date.now() - m.t < 6 * 3600000)
  if (igual) { igual.imp = Math.min(10, igual.imp + 1); igual.t = Date.now(); store.set('memorias', memorias); return }
  memorias.unshift({ t: Date.now(), txt, imp, tipo })
  // Guarda as 120 mais valiosas (recentes ou importantes).
  if (memorias.length > 120) memorias = memorias.sort((a, b) => valorMemoria(b) - valorMemoria(a)).slice(0, 120).sort((a, b) => b.t - a.t)
  store.set('memorias', memorias)
  if (tipo !== 'reflexao') { impDesdeReflexao += imp; store.set('impReflexao', impDesdeReflexao) }
}
function valorMemoria(m) { const horas = (Date.now() - m.t) / 3600000; return Math.pow(0.995, horas) + m.imp / 10 }
function lembrancas(n = 8) { return [...memorias].sort((a, b) => valorMemoria(b) - valorMemoria(a)).slice(0, n) }
function evoluir(traco, d) { P[traco] = clamp(P[traco] + d, 0.05, 0.95) }

// Evento: {label, P, A, D, interesse (0..1), expr, icone, som, dur, intens}
const acontecimentos = [] // últimos fatos (não as conversas), para ele explicar o próprio humor
function evento(e) {
  const entediado = humor.A < -0.35 && emo.P < 0.3
  let ganho = entediado ? (e.interesse > 0.75 ? 1.4 : 0.3) : 1
  ganho *= 0.7 + P.sensibilidade * 0.6
  if (e.tipo) { // habituação
    const h = hab[e.tipo] || 0
    ganho *= 1 / (1 + h * 0.45)
    hab[e.tipo] = h + 1
  }
  // Necessidades: novidades alimentam o estímulo; gente alimenta o social.
  N.estimulo = clamp(N.estimulo + 0.06 * (e.interesse || 0) * Math.min(1, ganho) * (1 - N.estimulo * 0.7), 0, 1) // quanto mais cheio, menos enche
  if (e.social) N.social = clamp(N.social + e.social, 0, 1)
  if (e.confianca) P.confianca = clamp(P.confianca + e.confianca, 0.05, 0.95)
  imp.P = clamp(imp.P + (e.P || 0) * ganho, -1.6, 1.6)
  imp.A = clamp(imp.A + (e.A || 0) * ganho, -1.6, 1.6)
  imp.D = clamp(imp.D + (e.D || 0) * ganho, -1.6, 1.6)
  humor.A = clamp(humor.A + 0.04 * (e.interesse || 0), -1, 1) // coisas acontecendo acordam
  ultimoEvento = now()
  if (e.label && !/^respondeu a/.test(e.label)) { acontecimentos.unshift({ t: Date.now(), txt: e.label }); acontecimentos.length = Math.min(acontecimentos.length, 8) }
  if (dormindo && (e.interesse || 0) < 0.6) { // abre um olho sonolento e volta a dormir
    olhoSonolentoAte = now() + 1500
    return
  }
  if (dormindo && ehNoite()) { imp.P -= 0.3; imp.D += 0.2 } // acordar de madrugada deixa rabugento
  acordar()
  if (e.expr && ganho > 0.45) foco = { expr: e.expr, ate: now() + (e.dur || 2500) }
  if (e.icone) icone = { tipo: e.icone, ate: now() + (e.dur || 2500) + 500 }
  if (e.icones?.length || e.numero) balao = { itens: (e.icones || []).filter((k) => ICONES[k]).slice(0, 3), numero: String(e.numero || '').slice(0, 9), t0: now(), ate: now() + Math.max(4500, e.dur || 0) }
  const fezGesto = e.gesto && e.gesto !== 'nenhum' && GESTOS[e.gesto] && (ganho > 0.45 || e.forcarGesto)
  if (fezGesto) iniciarGesto(e.gesto)
  if (fezGesto && SOM_GESTO[e.gesto]) somGesto(e.gesto)
  if (e.emote && now() - ultimoEmote > 15000) setTimeout(() => mostrarEmote(e.emote), 250)
  else if (e.som !== false && ganho > 0.45) somDe(e.som || e.expr || nomePAD(emoAtual()), clamp((e.intens ?? 0.6) * ganho, 0.15, 1))
  if (e.lembrar) lembrar(e.label, typeof e.lembrar === 'number' ? e.lembrar : 5)
  bus.emit('emocao', { label: `${e.label} (ganho ${ganho.toFixed(2)})` }, 'Cérebro')
}
function emoAtual() { return { P: clamp(humor.P + imp.P, -1, 1), A: clamp(humor.A + imp.A, -1, 1), D: clamp(humor.D + imp.D, -1, 1) } }

let dormindo = false, olhoSonolentoAte = 0
function acordar() {
  if (!dormindo) return
  dormindo = false; foco = { expr: 'surpreso', ate: now() + 1200 }; pushLog('Cérebro→ acordou')
  // o sonho da noite muda o humor do dia: sonho bom acorda bem; pesadelo, ressabiado
  if (sono.ultimoSonho) { humor.P = clamp(humor.P + (sono.ultimoSonho.tipo === 'pesadelo' ? -0.12 : 0.1), -0.75, 0.9); sono.ultimoSonho = null }
  sono.touca = false; sono.rem = null
}
function dormir(motivo) { if (!dormindo) { pararImaginacao(); dormindo = true; foco = null; iniciarGesto('suspiro'); somDe('sono', 0.5); sono.rem = null; sono.remDur = 180000; sono.proxREM = now() + (ehNoite() ? 20 : 10) * 60000; pushLog('Cérebro→ dormiu · ' + motivo) } }
// Tem alguém por perto: rosto na câmera ou conversou com ele nos últimos 5 minutos.
let conversouEm = -1e9
function temGente() { return pessoa.presente || now() - conversouEm < 300000 }
function horaDoDia() { const d = new Date(); return d.getHours() + d.getMinutes() / 60 }
function ehNoite() { const h = horaDoDia(); return h >= 23 || h < 7 }
// Quanto cada necessidade está fora da faixa boa (0 = tudo certo).
function desconforto() {
  let d = 0
  for (const k of Object.keys(FAIXA)) { const [lo, hi] = FAIXA[k]; if (N[k] < lo) d += (lo - N[k]) / lo; else if (N[k] > hi && !((k === 'social' || k === 'estimulo') && (now() - conversouEm < 180000 || jogo))) d += 0.4 * (N[k] - hi) / (1 - hi) } // conversar e brincar não incomodam
  return d
}

function tickCerebro(dt) {
  const k = Math.exp(-dt / 8) // impulso some em ~8 s
  imp.P *= k; imp.A *= k; imp.D *= k
  const e = emoAtual()
  Object.assign(emo, e)
  emo.nome = nomePAD(e)
  // O humor anda devagar em direção ao que ele sente (≈30 min).
  humor.P += (e.P - humor.P) * dt / 1800
  humor.D += (e.D - humor.D) * dt / 1800
  // Homeostase: o humor sempre volta devagar (≈40 min) para o jeito normal dele, e nunca trava no extremo.
  humor.P = clamp(humor.P + (0.1 + (P.afeto - 0.5) * 0.4 - humor.P) * dt / 2400, -0.75, 0.9)

  // Necessidades andam com o tempo. Extrovertido sente falta de gente mais rápido;
  // curioso enjoa mais rápido da mesmice.
  N.social = clamp(N.social - dt / (temGente() ? 9000 : 2400) * (0.5 + P.extroversao), 0, 1)
  N.estimulo = clamp(N.estimulo - dt / 900 * (0.5 + P.curiosidade), 0, 1)
  N.energia = clamp(N.energia + (dormindo ? dt / 14400 : -dt / 57600 * (ehNoite() ? 2 : 1) * (luz.escuro ? 1.5 : 1)), 0, 1)
  for (const t of Object.keys(hab)) { hab[t] *= Math.exp(-dt / 90); if (hab[t] < 0.05) delete hab[t] }
  // Fora da faixa = desconforto (valência negativa); dentro = contente. Como no Kismet.
  const d = desconforto()
  humor.P = clamp(humor.P + (d > 0 ? -0.35 * d : 0.08) * dt / 600, -1, 1)
  // A ativação segue o estímulo e a energia (≈5 min).
  const alvoA = (N.estimulo - 0.5) * 1.2 + (N.energia - 0.5) * 0.8 + (P.energia - 0.5) * 0.4
  humor.A = clamp(humor.A + (alvoA - humor.A) * dt / 300, -1, 1)

  // Sono: de noite, ou sem energia, ou entediado sozinho por muito tempo (cochilo).
  const parado = (now() - ultimoEvento) / 1000
  if (!dormindo && parado > 120 && (N.energia < 0.15 || (ehNoite() && parado > 300)) ) dormir(ehNoite() ? 'é de noite' : 'sem energia')
  else if (!dormindo && parado > 1200 && !pessoa.presente) dormir('cochilo')
  else if (!dormindo && luz.escuro && now() - luz.desde > 60000 && parado > 60 && !jogo) dormir('está escuro')
  if (dormindo && !ehNoite() && !luz.escuro && parado > 60 && ((N.energia > 0.8 && horaDoDia() < 12) || N.energia > 0.95)) { acordar(); setTimeout(() => { iniciarGesto('espreguicar'); somGesto('espreguicar') }, 1300) }
  if (foco && now() > foco.ate) foco = null
  if (icone && now() > icone.ate) icone = null
}

// Comportamentos espontâneos (rodam a cada 1 s). Seleção por utilidade: cada comportamento
// ganha uma nota pelo que ele precisa e pelo jeito dele; sorteia entre os melhores.
let proxCuriosidade = 0, ultimoClima = 0, proxComport = now() + 8000
const ultimaVez = {}
const COMPORTAMENTOS = {
  olhar_em_volta: { cd: 20000, nota: () => 0.15 + P.curiosidade * 0.3 + (1 - N.estimulo) * 0.3, fazer: () => { iniciarGesto('olhar_em_volta') } },
  suspiro: { cd: 90000, nota: () => (emo.nome === 'entediado' ? 0.7 : 0) + (N.estimulo < 0.3 ? 0.3 : 0), fazer: () => { iniciarGesto('suspiro'); somGesto('suspiro'); foco = { expr: 'entediado', ate: now() + 2000 } } },
  cantarolar: {
    cd: 120000,
    nota: () => (emo.P > 0.25 ? 0.45 : 0) + P.extroversao * 0.25 + (P.melodia ? 0.15 : 0) - (pessoa.presente ? 0 : 0.1),
    fazer: () => { foco = { expr: 'contente', ate: now() + 3500 }; icone = { tipo: 'nota', ate: now() + 3500 }; tocarMelodia(P.melodia && Math.random() < 0.7 ? P.melodia : melodiaInventada(), 1.1) },
  },
  chamar_atencao: { // só quando está muito solitário; pede em degraus (olhar → bipes → pulinhos → emburra)
    cd: 45000,
    nota: () => (now() > pedido.emburradoAte && ((temGente() && N.social < 0.18) || (!temGente() && N.social < 0.08)) ? 0.9 + P.extroversao * 0.4 : 0),
    fazer: () => pedirAtencao(),
  },
  devanear: { // sozinho ou entediado: imagina uma historinha
    cd: 15 * 60000,
    nota: () => (cfg.key && (!temGente() || N.estimulo < 0.35) && papo.estado === 'parado' ? 0.62 + P.curiosidade * 0.3 : 0),
    fazer: () => devanear(),
  },
  decorar: { // perto de uma data comemorativa, decora a tela por conta própria
    cd: 60000,
    nota: () => { const d = dataAtiva(); return d && (!P.deco || P.deco.chave !== d.id + d.ano) ? 1.3 : 0 },
    fazer: () => decorar(),
  },
  contar_historia: { // tem história nova e alguém por perto
    cd: 10 * 60000,
    nota: () => (temGente() && papo.estado !== 'atento' && Date.now() - (historiaParaContar()?.t || Date.now()) > 120000 ? 0.7 + P.extroversao * 0.2 : 0),
    fazer: () => contarHistoria(),
  },
  pedir_musica: { // entediado com você por perto
    cd: 300000,
    nota: () => (temGente() && N.estimulo < FAIXA.estimulo[0] && !audio.musica ? 0.6 + (P.gostos.animada + 1) * 0.2 : 0),
    fazer: () => evento({ label: 'pediu música', P: 0.15, A: 0.3, interesse: 0.5, expr: 'curioso', gesto: 'talvez', icones: ['musica', 'seta_cima'], som: 'curioso', dur: 3500 }),
  },
  pensar_na_vida: {
    cd: 400000,
    nota: () => 0.1 + P.curiosidade * 0.15,
    fazer: () => { foco = { expr: 'pensando', ate: now() + 3000 }; icone = { tipo: 'reticencias', ate: now() + 3000 } },
  },
  quero_espaco: { // atenção demais (Kismet: "sobrecarregado")
    cd: 120000,
    nota: () => (N.social > FAIXA.social[1] && P.extroversao < 0.45 && now() - conversouEm > 60000 ? 0.8 + (1 - P.extroversao) * 0.4 : 0),
    fazer: () => { evento({ label: 'muita atenção, quero um tempinho', P: -0.05, A: -0.1, interesse: 0.3, expr: 'timido', gesto: 'timido', som: false, dur: 3500 }); N.social -= 0.05 },
  },
  sobrecarregado: { // novidade demais de uma vez (sozinho, sem conversa)
    cd: 10 * 60000,
    nota: () => (N.estimulo > 0.95 && now() - conversouEm > 120000 && !jogo && papo.estado === 'parado' ? 0.85 : 0),
    fazer: () => { evento({ label: 'coisa demais acontecendo, um respiro', P: -0.05, A: -0.3, interesse: 0.2, expr: 'entediado', gesto: 'suspiro', som: false, dur: 2500 }); N.estimulo -= 0.2 },
  },
  cochilar: { cd: 600000, nota: () => (N.energia < 0.3 && !temGente() ? 0.8 : 0), fazer: () => dormir('cansado') },
  nada: { cd: 0, nota: () => 0.55, fazer: () => {} },
}
function escolherComportamento() {
  const t = now()
  const ops = Object.entries(COMPORTAMENTOS).filter(([k, c]) => t - (ultimaVez[k] || -1e9) > c.cd).map(([k, c]) => [k, c.nota()]).filter(([, v]) => v > 0)
  // Softmax com temperatura: quase sempre o melhor, às vezes uma surpresa.
  const pesos = ops.map(([, v]) => Math.exp(v / 0.15)), soma = pesos.reduce((a, b) => a + b, 0)
  let r = Math.random() * soma
  for (let i = 0; i < ops.length; i++) { r -= pesos[i]; if (r <= 0) return ops[i][0] }
  return 'nada'
}

function tickComportamento() {
  if (dormindo) return
  const t = now()
  if (t > proxComport && !foco && !gesto && !gravando && !audio.musica && !jogo && !vad.ativo && !vad.verificando && !palco && !imag.ativo && papo.estado !== 'atento') {
    proxComport = t + rnd(4000, 9000)
    const k = escolherComportamento()
    if (k !== 'nada') { ultimaVez[k] = t; pushLog('Cérebro→ vontade: ' + k); COMPORTAMENTOS[k].fazer() }
  }
  // Você do lado, calado há um tempo: ele fica curioso e pergunta se está tudo bem.
  if (pessoa.presente && t - audio.ultimoSom > 45000 && t - pessoa.desde > 45000 && t > proxCuriosidade && !jogo) {
    proxCuriosidade = t + 240000
    const cara = humorDoRosto()
    // Sério ou de cara fechada há um tempo: ele vem ver se está tudo bem. Sorrindo: deixa quieto.
    if (cara === 'sério' || cara === 'de cara fechada') evento({ label: `você está quieto e ${cara}`, P: -0.1, A: 0.2, interesse: 0.8, expr: 'triste', icones: ['pessoa', 'pergunta', 'abraco'], som: 'curioso', gesto: 'nao_sei', forcarGesto: true, dur: 4000 })
    else if (cara !== 'sorrindo') evento({ label: 'você está quieto do meu lado', P: 0.1, A: 0.35, interesse: 0.8, expr: 'curioso', icone: '?', som: 'curioso', gesto: 'nao_sei', dur: 3500 })
  }
}

setInterval(() => { store.set('pers', P); store.set('necess', N); store.set('humor', { dia: humor.dia, P: humor.P, A: humor.A, D: humor.D }) }, 10000)

// ================================================================ C3: ROSTO
const cv = $('#face'), gTela = cv.getContext('2d')
let g = gTela // durante um emote, o rosto é desenhado fora da tela e entra com efeito
g.setTransform(2, 0, 0, 2, 0, 0) // canvas 480 desenhando em 240×240, como a tela de verdade

const BASE = { open: 1, tired: 0, angry: 0, happy: 0, size: 1, mouth: 0, mouthOpen: 0, asym: 0, dy: 0, bochecha: 0, lagrimas: 0, color: [125, 249, 255] }
const EXPR = {
  neutro: {}, contente: { happy: 0.35, mouth: 0.4 }, feliz: { happy: 0.6, mouth: 0.8, size: 1.05 },
  animado: { happy: 0.75, mouth: 1, mouthOpen: 0.35, size: 1.12 }, triste: { open: 0.75, tired: 0.55, mouth: -0.7, dy: 6, color: [120, 170, 255] },
  bravo: { open: 0.8, angry: 0.7, mouth: -0.45, color: [255, 120, 110] }, medo: { open: 1.15, size: 0.88, mouth: -0.2, mouthOpen: 0.4 },
  surpreso: { open: 1.2, size: 1.15, mouthOpen: 0.6 }, entediado: { open: 0.45, tired: 0.25, mouth: -0.1, dy: 4 },
  sono: { open: 0.12, tired: 0.4, dy: 6 }, curioso: { asym: 0.25, mouth: 0.1, open: 1.05 },
  amor: { happy: 0.7, mouth: 0.9, size: 1.05, color: [255, 126, 182] }, calor: { open: 0.55, tired: 0.45, mouth: -0.2, color: [255, 179, 107] },
  frio: { open: 0.8, size: 0.92, mouth: -0.3, color: [143, 211, 255] }, pensando: { open: 0.9, asym: 0.15, dy: -4 },
  ouvindo: { open: 1.05, asym: 0.1, mouth: 0.1 }, musica: { happy: 0.5, mouth: 0.6 },
  rindo: { forma: 'fechado_feliz', mouthOpen: 0.55, bochecha: 0.7 },
  apaixonado: { forma: 'coracao', mouth: 0.8, bochecha: 0.5, color: [255, 110, 160] },
  empolgado: { forma: 'estrela', mouthOpen: 0.45, size: 1.08, color: [255, 214, 102] },
  tonto: { forma: 'espiral', mouth: -0.2, mouthOpen: 0.2 },
  timido: { open: 0.8, happy: 0.3, mouth: 0.3, bochecha: 1 },
  desconfiado: { open: 0.42, angry: 0.15, mouth: -0.15, asym: 0.12 },
  chorando: { open: 0.8, tired: 0.5, mouth: -0.8, lagrimas: 1, color: [120, 170, 255] },
  orgulhoso: { happy: 0.45, tired: 0.2, mouth: 0.7, dy: -5 },
  desmaiado: { forma: 'x', mouthOpen: 0.3 },
  olho_sonolento: { open: 0.45, tired: 0.5, dy: 6 },
  pesadelo: { open: 0.12, tired: 0.3, angry: 0.35, mouth: -0.7, dy: 6, color: [150, 160, 255] },
}
const cur = structuredClone(BASE)
cur.bochecha = 0; cur.lagrimas = 0
let formaAtual = 'normal'

// ---------------------------------------------------------------- gestos (movimentos do rosto inteiro)
// t vai de 0 a 1. Devolvem deslocamento, giro, escala e, às vezes, olhar ou forma dos olhos.
const GESTOS = {
  sim: { dur: 900, f: (t) => ({ oy: Math.sin(t * Math.PI * 4) * 10 * (1 - t * 0.3) }) },
  nao: { dur: 1000, f: (t) => ({ ox: Math.sin(t * Math.PI * 6) * 14 * (1 - t * 0.3) }) },
  talvez: { dur: 1400, f: (t) => ({ rot: Math.sin(t * Math.PI * 2) * 0.18 }) },
  nao_sei: { dur: 1600, f: (t) => ({ rot: Math.sin(t * Math.PI) * 0.14, gy: -0.8, gx: 0.3 }) },
  pulinhos: { dur: 1200, f: (t) => ({ oy: -Math.abs(Math.sin(t * Math.PI * 3)) * 18, sy: 1 - Math.abs(Math.cos(t * Math.PI * 3)) * 0.08 }) },
  rir: { dur: 1500, f: (t) => ({ oy: Math.sin(t * Math.PI * 18) * 3, rot: Math.sin(t * Math.PI * 4) * 0.05, forma: 'fechado_feliz' }) },
  piscadela: { dur: 800, f: (t) => ({ formaD: t < 0.75 ? 'fechado_feliz' : null, rot: Math.sin(t * Math.PI) * 0.06 }) },
  timido: { dur: 2500, f: () => ({ gx: 0.6, gy: 0.8 }) },
  desconfiado: { dur: 2600, f: (t) => ({ gx: -0.8 + t * 1.6, gy: 0.1 }) },
  tonto: { dur: 2000, f: (t) => ({ rot: Math.sin(t * Math.PI * 4) * 0.15, ox: Math.sin(t * Math.PI * 3) * 8, forma: 'espiral' }) },
  suspiro: { dur: 1500, f: (t) => ({ oy: Math.sin(t * Math.PI) * 10, sy: 1 - Math.sin(t * Math.PI) * 0.05 }) },
  dancinha: { dur: 3000, f: (t) => ({ rot: Math.sin(t * Math.PI * 6) * 0.15, ox: Math.sin(t * Math.PI * 6) * 10, oy: -Math.abs(Math.sin(t * Math.PI * 6)) * 6 }) },
  encolher: { dur: 1500, f: (t) => ({ s: 1 - Math.sin(t * Math.PI) * 0.15, oy: Math.sin(t * Math.PI) * 6 }) },
  olhar_em_volta: { dur: 2400, f: (t) => ({ gx: Math.sin(t * Math.PI * 2) * 0.9, gy: 0 }) },
  desmaiar: { dur: 2600, f: (t) => { const k = t < 0.8 ? Math.min(1, t * 3) : 1 - (t - 0.8) * 5; return { rot: 0.4 * k, oy: 22 * k, forma: t < 0.85 ? 'x' : null } } },
  surpresa: { dur: 700, antes: { oy: 4, sy: 0.93 }, f: (t) => ({ oy: -Math.sin(t * Math.PI) * 12, s: 1 + Math.sin(t * Math.PI) * 0.08 }) },
  espreguicar: { dur: 2200, f: (t) => ({ sy: 1 + Math.sin(t * Math.PI) * 0.12, oy: -Math.sin(t * Math.PI) * 8, rot: Math.sin(t * Math.PI * 2) * 0.05, forma: t > 0.2 && t < 0.8 ? 'fechado_feliz' : null }) },
}
// Antecipação (princípio de animação da Disney): antes de pular, se abaixa um pouquinho.
GESTOS.pulinhos.antes = { oy: 5, sy: 0.9 }
GESTOS.tremer = { dur: 1500, f: (t) => ({ ox: Math.sin(t * Math.PI * 34) * 3 * forcaTremor * (1 - t * 0.5), oy: Math.sin(t * Math.PI * 27) * 1.2 * forcaTremor }) }
GESTOS.aceno = { dur: 520, f: (t) => ({ oy: Math.sin(t * Math.PI) * 5 }) }
GESTOS.bocejo = { dur: 2000, f: (t) => ({ sy: 1 + Math.sin(t * Math.PI) * 0.07, oy: -Math.sin(t * Math.PI) * 4, forma: t > 0.15 && t < 0.85 ? 'fechado' : null }) }
GESTOS.sim.antes = { oy: -4 }
let gesto = null
function iniciarGesto(nome) { if (GESTOS[nome]) { gesto = { nome, t0: now() }; bus.emit('gesto', { label: nome }, 'Cérebro') } }
function estadoGesto(t) {
  if (!gesto) return {}
  const g0 = GESTOS[gesto.nome], k = (t - gesto.t0) / g0.dur
  if (k >= 1) { gesto = null; return {} }
  if (g0.antes) {
    if (k < 0.12) { const a = Math.sin((k / 0.12) * Math.PI / 2); return Object.fromEntries(Object.entries(g0.antes).map(([c, v]) => [c, c === 'sy' || c === 's' ? 1 + (v - 1) * a : v * a])) }
    return g0.f((k - 0.12) / 0.88)
  }
  return g0.f(k)
}

// ---------------------------------------------------------------- ícones do balão
// No robô de verdade viram imagens de 32×32 na memória do C3; aqui usam os emojis do celular.
const ICONES = {
  sol: '☀️', chuva: '🌧️', nuvem: '☁️', trovao: '⛈️', neve: '❄️', calor: '🔥', lua: '🌙', estrela: '⭐', arco_iris: '🌈',
  relogio: '⏰', ampulheta: '⏳', calendario: '📅', comida: '🍕', cafe: '☕', agua: '💧', bolo: '🎂', fruta: '🍎',
  musica: '🎵', jogo: '🎮', livro: '📚', computador: '💻', celular: '📱', filme: '🎬', foto: '📷', futebol: '⚽',
  casa: '🏠', trabalho: '💼', escola: '🎓', dinheiro: '💰', presente: '🎁', festa: '🎉', ideia: '💡', trofeu: '🏆',
  ok: '👍', nao_ok: '👎', certo: '✅', errado: '❌', coracao: '❤️', coracao_partido: '💔', abraco: '🤗', musculo: '💪',
  cerebro: '🧠', olhos: '👀', dormir: '💤', doente: '🤒', remedio: '💊', cachorro: '🐶', gato: '🐱', planta: '🌱',
  flor: '🌸', carro: '🚗', aviao: '✈️', mundo: '🌍', brasil: '🇧🇷', robo: '🤖', pessoa: '🧑', familia: '👪',
  teclado: '⌨️', calculadora: '🧮', ouvido: '👂', sorvete: '🍦', pizza: '🍕', arvore: '🎄', sino: '🔔', vela: '🕯️', termometro: '🌡️', coroa: '👑', sorriso: '😊', praia: '🏖️', luz: '💡', pergunta: '❓', raio: '⚡', bateria: '🔋', wifi: '📶', seta_cima: '⬆️', seta_baixo: '⬇️', mais: '➕', menos: '➖', fantasma: '👻',
}
let balao = null // {itens, numero, ate}
// O modelo às vezes escreve o nome do ícone de outro jeito ("coração", "olho", "som"): aceita.
const APELIDO_ICONE = { olho: 'olhos', som: 'musica', soma: 'mais', codigo: 'computador', aprender: 'cerebro', assobio: 'musica', canto: 'musica', cancao: 'musica', jogar: 'jogo', ideia_brilhante: 'ideia', sol_quente: 'sol', frio: 'neve', amor: 'coracao', feliz: 'sorriso', livros: 'livro', estrela_cadente: 'estrela', arvore_de_natal: 'arvore', natal: 'arvore', comida_gostosa: 'comida' }
function icone_(x) { const k = String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z_]/g, ''); return ICONES[k] ? k : ICONES[APELIDO_ICONE[k]] ? APELIDO_ICONE[k] : null }
const limparIcones = (l) => [...new Set((Array.isArray(l) ? l : []).map(icone_).filter(Boolean))].slice(0, 3)
const olhar = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, mx: 0, my: 0, proxSacada: 0, proxMicro: 0 }
let piscar = 0, proxPiscar = now() + 3000, balanco = 0, inclinacao = 0

function alvoExpr() {
  if (dormindo) return now() < olhoSonolentoAte ? 'olho_sonolento' : sono.rem?.tipo === 'pesadelo' ? 'pesadelo' : 'sono'
  if (foco) return foco.expr
  if (audio.musica && P.gostos[audio.estilo] > -0.3) return 'musica'
  return emo.nome
}

function desenharOlho(cx, cy, w, h, lado, p, cor, forma = 'normal', t = 0) {
  g.save(); g.fillStyle = cor; g.strokeStyle = cor; g.lineCap = 'round'; g.lineJoin = 'round'
  const s = w / 54
  if (forma === 'coracao') {
    const k = s * (1 + Math.sin(t / 160) * 0.06)
    g.translate(cx, cy); g.scale(k, k); g.beginPath(); g.moveTo(0, 26); g.bezierCurveTo(-46, -6, -22, -44, 0, -18); g.bezierCurveTo(22, -44, 46, -6, 0, 26); g.fill()
    g.restore(); return
  }
  if (forma === 'estrela') {
    g.translate(cx, cy); g.rotate(Math.sin(t / 300) * 0.15); g.beginPath()
    for (let i = 0; i < 10; i++) { const r = (i % 2 ? 13 : 32) * s, a = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(Math.cos(a) * r, Math.sin(a) * r) }
    g.closePath(); g.fill(); g.restore(); return
  }
  if (forma === 'x') {
    g.lineWidth = 8 * s; g.beginPath(); g.moveTo(cx - 18 * s, cy - 18 * s); g.lineTo(cx + 18 * s, cy + 18 * s); g.moveTo(cx + 18 * s, cy - 18 * s); g.lineTo(cx - 18 * s, cy + 18 * s); g.stroke()
    g.restore(); return
  }
  if (forma === 'espiral') {
    g.lineWidth = 5 * s; g.translate(cx, cy); g.rotate(t / 150 * lado); g.beginPath()
    for (let a = 0; a < Math.PI * 6; a += 0.2) { const r = a * 1.6 * s; g.lineTo(Math.cos(a) * r, Math.sin(a) * r) }
    g.stroke(); g.restore(); return
  }
  if (forma === 'fechado') {
    g.lineWidth = 7 * s; g.beginPath(); g.moveTo(cx - 20 * s, cy + 4 * s); g.quadraticCurveTo(cx, cy + 12 * s, cx + 20 * s, cy + 4 * s); g.stroke()
    g.restore(); return
  }
  if (forma === 'fechado_feliz') {
    g.lineWidth = 8 * s; g.beginPath(); g.arc(cx, cy + 10 * s, 20 * s, Math.PI * 1.15, Math.PI * 1.85); g.stroke()
    g.restore(); return
  }
  g.restore()
  const r = Math.min(w, h) * 0.3
  g.fillStyle = cor
  g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, Math.max(1, Math.min(r, h / 2))); g.fill()
  g.fillStyle = '#000'
  const top = cy - h / 2 - 1, L = cx - w / 2 - 1, R = cx + w / 2 + 1
  const fora = lado < 0 ? L : R, dentro = lado < 0 ? R : L
  if (p.tired > 0.02) { g.beginPath(); g.moveTo(L, top); g.lineTo(R, top); g.lineTo(fora, top + p.tired * h * 0.75); g.closePath(); g.fill() }
  if (p.angry > 0.02) { g.beginPath(); g.moveTo(L, top); g.lineTo(R, top); g.lineTo(dentro, top + p.angry * h * 0.75); g.closePath(); g.fill() }
  if (p.happy > 0.02) { g.beginPath(); g.ellipse(cx, cy + h * (1 - 0.5 * p.happy) + 2, w * 0.8, h * 0.55, 0, 0, Math.PI * 2); g.fill() }
}

function desenharIcone(tipo, t) {
  const y = 34 + Math.sin(t / 300) * 3
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'
  if (tipo === 'coracao') {
    g.fillStyle = '#ff7eb6'; g.translate(204, y); const s = 1 + Math.sin(t / 150) * 0.08; g.scale(s, s)
    g.beginPath(); g.moveTo(0, 8); g.bezierCurveTo(-16, -4, -8, -16, 0, -7); g.bezierCurveTo(8, -16, 16, -4, 0, 8); g.fill()
  } else if (tipo === 'gota') {
    g.fillStyle = '#6cc8ff'; g.translate(40, 70 + ((t / 25) % 18))
    g.beginPath(); g.moveTo(0, -9); g.quadraticCurveTo(8, 3, 0, 7); g.quadraticCurveTo(-8, 3, 0, -9); g.fill()
  } else if (tipo === 'zzz') {
    g.fillStyle = '#e8f6ff'; g.font = 'bold 16px system-ui'
    for (let i = 0; i < 3; i++) { const k = ((t / 900 + i / 3) % 1); g.globalAlpha = 1 - k; g.fillText('z', 196 + k * 22, 54 - k * 34) }
  } else {
    const txt = { interrogacao: '?', '?': '?', exclamacao: '!', '!': '!', reticencias: '…', nota: '♪' }[tipo] || tipo
    g.fillStyle = tipo === 'exclamacao' || tipo === '!' ? '#ffd166' : tipo === 'nota' ? '#7df9ff' : '#e8f6ff'
    g.font = 'bold 30px system-ui'; g.fillText(txt, 204, y)
  }
  g.restore()
}

// Balão no alto da tela: até 3 ícones, aparecendo um por um, ou um número curto (hora, temperatura).
function desenharBalao(t) {
  const idade = t - balao.t0 // os ícones entram um por um
  const itens = balao.itens.map((k) => ICONES[k])
  const temNum = !!balao.numero
  const larg = temNum ? Math.max(70, balao.numero.length * 17 + 30) : itens.length * 36 + 18
  const x = 120 - larg / 2, y = 4, alt = 40
  g.save()
  g.fillStyle = '#1b2632'; g.strokeStyle = '#3a4a5a'; g.lineWidth = 1.5
  g.beginPath(); g.roundRect(x, y, larg, alt, 14); g.fill(); g.stroke()
  g.beginPath(); g.moveTo(112, y + alt); g.lineTo(120, y + alt + 7); g.lineTo(128, y + alt); g.fill()
  g.textAlign = 'center'; g.textBaseline = 'middle'
  if (temNum) {
    g.fillStyle = '#e8f6ff'; g.font = 'bold 24px system-ui, sans-serif'; g.fillText(balao.numero, 120, y + alt / 2 + 1)
  } else {
    g.font = '26px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
    const mostrados = Math.min(itens.length, 1 + Math.floor(Math.max(0, idade) / 450))
    for (let i = 0; i < mostrados; i++) g.fillText(itens[i], x + 27 + i * 36, y + alt / 2 + 2 + Math.sin(t / 250 + i) * 1.5)
  }
  g.restore()
}

let tAnterior = now()
function quadro() {
  const t = now(), dt = Math.min(0.1, (t - tAnterior) / 1000); tAnterior = t
  tickCerebro(dt)

  const nome = alvoExpr()
  const alvo = Object.assign({}, BASE, EXPR[nome] || {})
  const vel = 1 - Math.exp(-dt * 9)
  for (const k of Object.keys(BASE)) {
    if (k === 'color') cur.color = cur.color.map((c, i) => lerp(c, alvo.color[i], vel))
    else cur[k] = lerp(cur[k], alvo[k], vel)
  }
  const ge = estadoGesto(t)
  const novaForma = alvo.forma || 'normal'
  if (novaForma !== formaAtual) { formaAtual = novaForma; piscar = 1 } // troca de olho escondida numa piscada

  // Para onde olhar: rosto da pessoa > melodia > olhadas aleatórias.
  if (pessoa.presente && t - pessoa.visto < 1500) { olhar.tx = pessoa.x; olhar.ty = pessoa.y * 0.8 }
  else if (t > olhar.proxSacada) { olhar.proxSacada = t + rnd(1500, 5000) * (emo.nome === 'entediado' ? 1.6 : 1); olhar.tx = rnd(-0.8, 0.8) * (0.5 + P.curiosidade * 0.5); olhar.ty = rnd(-0.4, 0.4) }
  if (audio.melodiaAte > t) olhar.ty = audio.melodiaY
  if (nome === 'pensando') olhar.ty = -0.7
  if (imag.ativo?.tipo === 'devaneio' && !dormindo) { olhar.tx = 0.55; olhar.ty = -0.65 } // olhando para a nuvem de pensamento
  if (t < papo.olharAte && !imag.ativo) { olhar.tx = pessoa.presente ? pessoa.x : 0; olhar.ty = pessoa.presente ? pessoa.y * 0.8 : 0.05 } // olhando para você
  if (dormindo && sono.rem) { olhar.tx = Math.sin(t / 70) * 0.3 + Math.sin(t / 23) * 0.08; olhar.ty = Math.sin(t / 130) * 0.08 } // REM
  if (ge.gx !== undefined) olhar.tx = ge.gx
  if (ge.gy !== undefined) olhar.ty = ge.gy
  const vo = 1 - Math.exp(-dt * 12)
  // Olhar com mola (passa um tiquinho do ponto e volta) + microssacadas, como olhos de verdade.
  if (t > olhar.proxMicro) { olhar.proxMicro = t + rnd(300, 900); olhar.mx = rnd(-0.035, 0.035); olhar.my = rnd(-0.03, 0.03) }
  const wm = 2 * Math.PI * 2.6, z = 0.55
  for (let i = 0; i < 4; i++) {
    const h4 = dt / 4
    olhar.vx += (wm * wm * (olhar.tx + olhar.mx - olhar.x) - 2 * z * wm * olhar.vx) * h4; olhar.x += olhar.vx * h4
    olhar.vy += (wm * wm * (olhar.ty + olhar.my - olhar.y) - 2 * z * wm * olhar.vy) * h4; olhar.y += olhar.vy * h4
  }

  if (t > proxPiscar) { piscar = 1; proxPiscar = t + rnd(2000, 6000) }
  piscar = Math.max(0, piscar - dt * 7)
  const fecha = piscar > 0 ? 1 - Math.sin(piscar * Math.PI) * 0.95 : 1
  balanco *= Math.exp(-dt * 9)
  const alvoIncl = papo.estado === 'atento' ? 0.22 : nome === 'curioso' ? 0.12 : nome === 'musica' ? Math.sin(t / 400) * 0.04 : 0
  inclinacao = lerp(inclinacao, alvoIncl, vo)

  g = palco ? gF : gTela
  g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240)
  g.save()
  let ox = olhar.x * 20 + (ge.ox || 0), oy = olhar.y * 14 + cur.dy - balanco * 9 + (ge.oy || 0)
  const nf = nivelFrio(clima.temp)
  if (nome === 'frio' || nf >= 2) ox += rnd(-1, 1) * (0.8 + nf * 0.5) // quanto mais frio, mais treme
  if (dormindo && sono.rem?.tipo === 'pesadelo') ox += rnd(-1.2, 1.2)
  if (dormindo) oy += Math.sin(t / 1200) * 2
  const esc = ge.s || 1
  g.translate(120 + ox, 104 + oy); g.rotate(inclinacao + (ge.rot || 0)); g.scale(esc, esc * (ge.sy || 1)); g.translate(-120, -104)
  const cor = `rgb(${cur.color.map(Math.round).join(',')})`
  const w = 54 * cur.size, h = 66 * cur.size * clamp(cur.open, 0.05, 1.3) * fecha
  const fE = nome === 'olho_sonolento' ? 'fechado' : ge.forma || formaAtual, fD = ge.formaD || ge.forma || formaAtual
  // Formas especiais também piscam (achatando na vertical).
  const olho = (cx, ww, hh, lado, f) => {
    if (f !== 'normal' && fecha < 0.99) { g.save(); g.translate(cx, 104); g.scale(1, Math.max(0.08, fecha)); g.translate(-cx, -104); desenharOlho(cx, 104, ww, hh, lado, cur, cor, f, t); g.restore() }
    else desenharOlho(cx, 104, ww, hh, lado, cur, cor, f, t)
  }
  olho(74, w * (1 + cur.asym), h * (1 + cur.asym), -1, fE)
  olho(166, w * (1 - cur.asym * 0.6), h * (1 - cur.asym * 0.6), 1, fD)
  if (cur.bochecha > 0.05) { // bochechas coradas
    g.fillStyle = `rgba(255,120,170,${0.8 * cur.bochecha})`
    for (const bx of [58, 182]) { g.beginPath(); g.ellipse(bx, 146, 15, 7, 0, 0, Math.PI * 2); g.fill() }
  }
  if (cur.lagrimas > 0.05) { // lágrimas caindo
    g.fillStyle = `rgba(108,200,255,${cur.lagrimas})`
    for (const [bx, fase] of [[64, 0], [176, 0.5]]) {
      const k = ((t / 900) + fase) % 1, y = 132 + k * 50
      g.globalAlpha = cur.lagrimas * (1 - k); g.beginPath(); g.moveTo(bx, y - 7); g.quadraticCurveTo(bx + 6, y + 3, bx, y + 6); g.quadraticCurveTo(bx - 6, y + 3, bx, y - 7); g.fill()
    }
    g.globalAlpha = 1
  }
  // Boca
  g.strokeStyle = cor; g.fillStyle = cor; g.lineWidth = 4; g.lineCap = 'round'
  if (cur.mouthOpen > 0.12) { g.beginPath(); g.ellipse(120, 172, 9 + cur.mouthOpen * 4, 3 + cur.mouthOpen * 11, 0, 0, Math.PI * 2); g.fill() }
  else { g.beginPath(); g.moveTo(104, 172); g.quadraticCurveTo(120, 172 + cur.mouth * 14, 136, 172); g.stroke() }
  desenharAcessorios(t)
  g.restore()

  if (dormindo) desenharIcone('zzz', t)
  else if (icone) desenharIcone(icone.tipo, t)
  else if (nome === 'musica') desenharIcone('nota', t)
  if (balao && t > balao.ate) balao = null
  if (balao) desenharBalao(t)
  desenharImaginacao(t)
  desenharCarneiros(t)
  if (dormindo && sono.rem?.hist) { // o sonho aparece clarinho perto do Zzz
    const q = sono.rem.hist.quadros[Math.floor((t - sono.rem.t0) / 4000) % sono.rem.hist.quadros.length]
    g.save(); g.globalAlpha = 0.45; g.textAlign = 'center'; g.font = '16px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
    q.icones.forEach((k, i) => g.fillText(ICONES[k], 170 + i * 20, 84)); g.restore()
  }
  if (palco) { g = gTela; compor(t) }
  desenharNevoa(t)
  desenharMoldura(t)
  if (camera.ligada) { g.fillStyle = '#ff4d4d'; g.beginPath(); g.arc(14, 14, 4, 0, Math.PI * 2); g.fill() } // câmera ligada
  if (!gravando && (vad.ativo || vad.verificando)) { g.fillStyle = vad.verificando ? 'rgba(255,214,102,.9)' : 'rgba(125,249,255,.9)'; g.beginPath(); g.arc(120, 230, 3 + Math.sin(t / 120) * 1, 0, Math.PI * 2); g.fill() }
  if (gravando) { g.fillStyle = '#ff4d4d'; g.font = 'bold 11px system-ui'; g.fillText('● ouvindo', 26, 228) }

  requestAnimationFrame(quadro)
}

bus.on('beat', () => { balanco = 1 })

// ================================================================ C3: SONS FOFOS
let actx = null
let falandoAte = 0
function silaba(out, t, f0, f1, d, tipo = 'sine', vib = 0, vol = 1) {
  const o = actx.createOscillator(); o.type = tipo
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + d)
  if (vib) {
    const l = actx.createOscillator(), lg = actx.createGain()
    l.frequency.value = vib; lg.gain.value = f0 * 0.06; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + d + 0.02)
  }
  const gn = actx.createGain()
  gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(vol, t + 0.012)
  gn.gain.setValueAtTime(vol, t + d * 0.7); gn.gain.exponentialRampToValueAtTime(0.0001, t + d)
  o.connect(gn).connect(out); o.start(t); o.stop(t + d + 0.03)
}
function ruido(out, t, d, freq) {
  const buf = actx.createBuffer(1, Math.ceil(actx.sampleRate * d), actx.sampleRate)
  const ch = buf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1
  const s = actx.createBufferSource(); s.buffer = buf
  const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2
  const gn = actx.createGain(); gn.gain.setValueAtTime(0.9, t); gn.gain.exponentialRampToValueAtTime(0.001, t + d)
  s.connect(f).connect(gn).connect(out); s.start(t)
}

// Cada fala é gerada na hora: nunca sai igual.
function somDe(emocao, intens = 0.6) {
  if (!actx) return
  const out = actx.createGain(); out.gain.value = 0.12 + intens * 0.2; out.connect(actx.destination)
  const t0 = actx.currentTime + 0.03
  let t = t0
  const n = Math.round(clamp(1 + intens * 4 * (0.6 + P.extroversao * 0.8) + rnd(-1, 1), 1, 8))
  const base = { triste: rnd(330, 520), bravo: rnd(170, 280), entediado: rnd(260, 380), sono: 640, amor: rnd(560, 760) }[emocao] ?? rnd(800, 1400)
  switch (emocao) {
    case 'feliz': case 'animado': case 'contente': case 'musica':
      for (let i = 0; i < n; i++) { const f = base * rnd(0.8, 1.15), d = rnd(0.05, emocao === 'contente' ? 0.16 : 0.11); silaba(out, t, f, f * rnd(1.2, 1.8), d, i % 2 ? 'triangle' : 'sine'); t += d + rnd(0.02, 0.05) }
      break
    case 'triste':
      for (let i = 0; i < Math.min(n, 3); i++) { const f = base * rnd(0.9, 1.1), d = rnd(0.18, 0.32); silaba(out, t, f, f * rnd(0.55, 0.75), d, 'sine', 6); t += d + 0.08 }
      break
    case 'curioso': case 'ouvindo': case 'pensando':
      for (let i = 0; i < n - 1; i++) { const f = base * rnd(0.7, 1), d = rnd(0.05, 0.09); silaba(out, t, f, f * rnd(0.9, 1.1), d, 'sine'); t += d + 0.04 }
      silaba(out, t, base * 0.6, base * 1.4, 0.26, 'sine'); t += 0.28
      break
    case 'medo': case 'surpreso':
      for (let i = 0; i < 5; i++) { const f = rnd(1300, 2200); silaba(out, t, f, f * rnd(0.8, 1.25), 0.04, 'square', 0, 0.5); t += 0.05 }
      silaba(out, t, 900, 2400, 0.18, 'sine'); t += 0.2
      break
    case 'bravo':
      for (let i = 0; i < Math.min(n, 4); i++) { const f = base * rnd(0.9, 1.1), d = rnd(0.07, 0.12); silaba(out, t, f, f * 0.85, d, 'sawtooth', 0, 0.45); t += d + 0.03 }
      break
    case 'entediado':
      silaba(out, t, base * 1.1, base * 0.8, 0.35, 'sine'); t += 0.4; silaba(out, t, base, base * 0.6, 0.5, 'sine', 3); t += 0.5
      break
    case 'sono':
      silaba(out, t, base, 230, 1.0, 'sine', 4); t += 1.05
      break
    case 'amor':
      for (let i = 0; i < 2; i++) { silaba(out, t, base * (1 + i * 0.15), base * (1.4 + i * 0.15), 0.3, 'triangle', 7); t += 0.34 }
      break
    case 'frio': silaba(out, t, 760, 520, 0.55, 'sine', 16); t += 0.6; break
    case 'dentes': for (let i = 0; i < 8; i++) { ruido(out, t, 0.025, 2600); t += 0.07 } break
    case 'hm': silaba(out, t, 380, 640, 0.3, 'sine'); t += 0.32; break
    case 'calor': silaba(out, t, 620, 380, 0.55, 'sine', 3); t += 0.6; break
    case 'tosse':
      for (let i = 0; i < 2 + (Math.random() < 0.5 ? 1 : 0); i++) { ruido(out, t, 0.12, 900); t += 0.2 }
      break
    default:
      for (let i = 0; i < n; i++) { const f = base * rnd(0.7, 1.3), d = rnd(0.04, 0.12); silaba(out, t, f, f * rnd(0.7, 1.4), d, Math.random() < 0.3 ? 'square' : 'sine', 0, 0.7); t += d + rnd(0.02, 0.06) }
  }
  falandoAte = now() + (t - t0) * 1000 + 250 // o "ouvido" ignora a própria voz
}

// Sons próprios de alguns gestos: "sim" sobe, "não" desce, para dar para entender sem olhar.
const SOM_GESTO = {
  sim: [[600, 900, 0.09], [720, 1150, 0.13]],
  nao: [[950, 620, 0.12], [820, 430, 0.17]],
  talvez: [[700, 900, 0.14, 'sine', 6], [900, 700, 0.16, 'sine', 6]],
  nao_sei: [[520, 820, 0.14], [820, 520, 0.14], [520, 900, 0.22, 'sine', 7]],
  rir: [[1250, 1350, 0.05], [950, 1050, 0.05], [1300, 1400, 0.05], [980, 1080, 0.05], [1350, 1500, 0.05], [1000, 1200, 0.08]],
  pulinhos: [[400, 1200, 0.1], [450, 1300, 0.1], [500, 1500, 0.14]],
  suspiro: [[620, 300, 0.6, 'sine', 3]],
  tonto: [[1100, 500, 0.5, 'sine', 9], [800, 350, 0.5, 'sine', 9]],
  desmaiar: [[1300, 140, 0.9, 'sine', 5]],
  surpresa: [[700, 2000, 0.16]],
  piscadela: [[1200, 1600, 0.06], [1500, 1900, 0.08]],
  espreguicar: [[300, 700, 0.5, 'sine', 4], [700, 380, 0.7, 'sine', 3]],
}
function somGesto(nome) {
  if (!actx || !SOM_GESTO[nome]) return
  const out = actx.createGain(); out.gain.value = 0.25; out.connect(actx.destination)
  const t0 = actx.currentTime + 0.03
  let t = t0
  const passo = nome === 'pulinhos' ? 0.4 : nome === 'sim' || nome === 'nao' ? 0.11 : 0.035
  for (const [f0, f1, d, tipo, vib] of SOM_GESTO[nome]) { const k = rnd(0.93, 1.07); silaba(out, t, f0 * k, f1 * k, d, tipo || 'sine', vib || 0); t += d + passo }
  falandoAte = now() + (t - t0) * 1000 + 250
}

// Melodias: ele repete o que você assobiou/cantarolou (proto-diálogo, como o Kismet) e
// guarda a favorita para cantarolar sozinho quando está contente.
function tocarMelodia(notas, vel = 1, op = {}) {
  if (!actx || !notas?.length) return
  const out = actx.createGain(); out.gain.value = 0.22; out.connect(actx.destination)
  const base = 880 * (0.9 + P.energia * 0.25) // a "voz" dele
  const t0 = actx.currentTime + 0.05
  let t = t0
  for (let i = 0; i < notas.length; i++) {
    const n = notas[i], prox = notas[i + 1] || n, d = clamp(n.d / vel, 0.06, 0.6)
    const f0 = base * 2 ** (n.st / 12), f1 = op.liso ? f0 : base * 2 ** ((n.st + (prox.st - n.st) * 0.3) / 12)
    silaba(out, t, f0, f1, d, 'sine', !op.liso && d > 0.25 ? 5 : 0, 0.9)
    t += d + (op.gap ?? 0.015)
  }
  falandoAte = now() + (t - t0) * 1000 + 300
}
function melodiaInventada() {
  const escala = [0, 2, 4, 7, 9, 12] // pentatônica: sempre soa bonitinho
  const n = 4 + Math.floor(Math.random() * 4)
  return Array.from({ length: n }, (_, i) => ({ st: escala[Math.floor(Math.random() * escala.length)] - (i === n - 1 ? 0 : 0), d: [0.12, 0.18, 0.25][Math.floor(Math.random() * 3)] }))
}
// Reduz o canto captado a notas: um ponto a cada ~120 ms, em semitons relativos à mediana.
function notasDoCanto(run) {
  if (run.length < 4) return null
  const st = run.map((p) => 12 * Math.log2(p.f / 440))
  const med = [...st].sort((a, b) => a - b)[Math.floor(st.length / 2)]
  const notas = []
  let ini = run[0].t, soma = 0, cont = 0
  for (let i = 0; i < run.length; i++) {
    soma += st[i] - med; cont++
    if (run[i].t - ini >= 120 || i === run.length - 1) { notas.push({ st: clamp(Math.round(soma / cont), -12, 12), d: (run[i].t - ini) / 1000 || 0.12 }); ini = run[i].t; soma = 0; cont = 0 }
  }
  // Junta notas iguais seguidas.
  const out = []
  for (const n of notas) { const u = out[out.length - 1]; if (u && u.st === n.st) u.d += n.d; else out.push({ ...n }) }
  return out.slice(0, 16)
}

// ================================================================ S3: OUVIDO
const audio = { rms: 0, rmsMedio: 0.01, bpm: 0, conf: 0, musica: false, estilo: 'animada', centroide: 0, pitch: 0, clareza: 0, melodiaY: 0, melodiaAte: 0, ultimoSom: now(), testeAte: 0 }
let an, tbuf, fbuf, prevMag, sr, binMax
const fluxHist = [], onsets = []
let ultimoOnset = 0, proxBeat = 0, ancora = 0, votosMusica = 0, ultimoSusto = 0, centroides = []
let melodiaRun = [], tipoCanto = null
let cantoRun = [], cantoEmitido = false, ultimoTom = 0, ultimaVoz = 0, contPitch = 0

async function ligarOuvido(stream) {
  const src = actx.createMediaStreamSource(stream)
  an = actx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0
  src.connect(an)
  sr = actx.sampleRate
  tbuf = new Float32Array(an.fftSize); fbuf = new Float32Array(an.frequencyBinCount); prevMag = new Float32Array(an.frequencyBinCount)
  binMax = Math.floor(5000 / (sr / an.fftSize))
  setInterval(analisar, 23)
  setInterval(estimarRitmo, 500)
  ligarEscuta(src)
}

// ---------------------------------------------------------------- tom de voz (prosódia)
// Enquanto alguém fala com ele: altura média, variação, volume e sílabas por segundo.
// Comparado com a voz normal do dono (aprendida aos poucos), vira "animada" ou "desanimada".
const proso = { f: [], rms: [], sil: 0, ativos: 0, acima: false, ultimoPico: 0, t0: 0 }
function prosoReset() { proso.f = []; proso.rms = []; proso.sil = 0; proso.ativos = 0; proso.acima = false; proso.t0 = now() }
function prosoQuadro(t, rms) {
  const lim = Math.max(0.015, vad.piso * 3)
  if (rms > lim) { proso.ativos++; proso.rms.push(rms) }
  if (!proso.acima && rms > lim * 1.6 && t - proso.ultimoPico > 120) { proso.acima = true; proso.sil++; proso.ultimoPico = t }
  else if (proso.acima && rms < lim) proso.acima = false
}
function prosoTom(tom) { if (tom && tom.c > 0.8 && tom.f > 70 && tom.f < 500) proso.f.push(12 * Math.log2(tom.f / 440)) }
function prosoResumo() {
  if (proso.f.length < 5 || proso.ativos < 10) return null
  const f = [...proso.f].sort((a, b) => a - b), med = f[f.length >> 1]
  const dp = Math.sqrt(f.reduce((a, x) => a + (x - med) ** 2, 0) / f.length)
  const r = [...proso.rms].sort((a, b) => b - a).slice(0, Math.max(1, proso.rms.length >> 1))
  return { med, dp, rms: r.reduce((a, b) => a + b, 0) / r.length, taxa: proso.sil / Math.max(0.3, proso.ativos * 0.023) }
}
let vozDono = null // {tipo, s, t}
function humorDaVoz(r) {
  if (!r) return null
  const b = P.voz
  let tipo = 'neutra', sc = 0
  if (b && b.n >= 3) {
    sc = (r.med - b.med) / 2.5 + (r.dp - b.dp) / Math.max(0.8, b.dp) + 0.8 * (r.rms - b.rms) / Math.max(0.005, b.rms) + 0.8 * (r.taxa - b.taxa) / Math.max(0.5, b.taxa)
    tipo = sc > 2.4 ? 'animada' : sc < -2.4 ? 'desanimada' : 'neutra'
  }
  const a = b ? Math.max(0.15, 1 / (b.n + 1)) : 1
  P.voz = b ? { med: lerp(b.med, r.med, a), dp: lerp(b.dp, r.dp, a), rms: lerp(b.rms, r.rms, a), taxa: lerp(b.taxa, r.taxa, a), n: b.n + 1 } : { ...r, n: 1 }
  vozDono = { tipo, s: sc, t: now() }
  pushLog(`S3→ voz ${tipo}${b && b.n >= 3 ? ` (${sc.toFixed(1)})` : ` (aprendendo sua voz ${P.voz.n}/3)`}`)
  if (tipo === 'desanimada') imp.P -= 0.05 // contágio leve: fica um pouco junto com você
  if (tipo === 'animada') imp.A += 0.2
  return vozDono
}

// ---------------------------------------------------------------- mãos livres
// O S3 guarda sempre o último meio segundo de som. Quando percebe voz, grava a frase inteira
// (com o começo), transcreve e só responde se ouviu o nome dele. Depois de uma resposta, por
// 15 s, dá para continuar a conversa sem repetir o nome.
const vad = { nivel: 0, ativo: false, ini: 0, ultimaFala: 0, chunks: [], pre: [], piso: 0.005, vozes: 0, verificando: false, hora: [], seguirAte: 0 }
function ligarEscuta(src) {
  const proc = actx.createScriptProcessor(4096, 1, 1), mudo = actx.createGain()
  mudo.gain.value = 0
  src.connect(proc); proc.connect(mudo).connect(actx.destination)
  const PRE = Math.ceil(0.6 * actx.sampleRate / 4096)
  proc.onaudioprocess = (e) => {
    const x = new Float32Array(e.inputBuffer.getChannelData(0)), t = now()
    anel.push({ t, x }); while (anel.length && t - anel[0].t > 2500) anel.shift() // para lembrar do som de um susto
    let q = 0; for (let i = 0; i < x.length; i++) q += x[i] * x[i]
    const rms = Math.sqrt(q / x.length)
    vad.nivel = Math.max(rms, vad.nivel * 0.85)
    const pode = cfg.maosLivres && cfg.key && !gravando && !vad.verificando && !jogo && t > falandoAte && t > conversaAte && !audio.musica
    if (!vad.ativo) {
      vad.piso = rms < vad.piso ? vad.piso * 0.9 + rms * 0.1 : vad.piso * 0.995 + rms * 0.005
      vad.pre.push(x); if (vad.pre.length > PRE) vad.pre.shift()
      if (pode && rms > Math.max(0.006, vad.piso * 3.5)) {
        Object.assign(vad, { ativo: true, ini: t, ultimaFala: t, chunks: vad.pre, pre: [], vozes: 0 })
        prosoReset()
        if (papo.estado !== 'parado') foco = { expr: 'ouvindo', ate: t + 4000 }
      }
      return
    }
    vad.chunks.push(x)
    if (rms > Math.max(0.004, vad.piso * 2)) vad.ultimaFala = t
    // "uhum": pausa curta no meio da sua frase → ele acena com a cabeça (sem som, para não atrapalhar)
    if (papo.estado === 'conversando' && t - vad.ultimaFala > 350 && t - vad.ultimaFala < 520 && t - papo.ultimoAceno > 2500 && !gesto) { papo.ultimoAceno = t; gesto = { nome: 'aceno', t0: t } }
    if (gravando || jogo || audio.musica) { vad.ativo = false; vad.chunks = []; return } // começou outra coisa
    if (t - vad.ultimaFala > 1000 || t - vad.ini > 9000) fimDaFrase(t)
  }
}
const semAcento = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
// Procura o nome dele na frase (sem ligar para acento; nomes longos aceitam 1 letra trocada).
function chamouPeloNome(texto) {
  const nome = cfg.nome.split(/\s+/).map(semAcento).filter(Boolean)
  if (!nome.length) return null
  const pal = texto.split(/\s+/).filter(Boolean), norm = pal.map(semAcento)
  const alvo = nome.join(' '), tol = alvo.length >= 4 ? 1 : 0
  const fon = (x) => x.replace(/y/g, 'i').replace(/(.)\1+/g, '$1').replace(/e$/, 'i') // como soa ("Bobby" ≈ "Bob-e")
  for (let i = 0; i + nome.length <= pal.length; i++) {
    const trecho = norm.slice(i, i + nome.length).join(' ')
    const ponta = i <= 1 || i + nome.length >= pal.length // nome parecido só vale no começo ou no fim
    const parecido = trecho === alvo || (ponta && ((tol && distancia(fon(trecho), fon(alvo)) <= tol) || (nome.length === 1 && trecho.length <= alvo.length + 5 && trecho.startsWith(alvo))))
    if (parecido) {
      const resto = [...pal.slice(0, i), ...pal.slice(i + nome.length)].join(' ').replace(/^[\s,.!?;:-]+|[\s,;:-]+$/g, '').trim()
      return { resto: semAcento(resto) ? resto : '' }
    }
  }
  // "O Bó" / "Ro bô": duas palavras coladas parecidas com o nome, no começo da frase.
  const junto = nome.join('')
  for (let i = 0; i < Math.min(3, pal.length - nome.length); i++) {
    const colado = norm.slice(i, i + nome.length + 1).join('')
    if (colado.length >= 3 && (colado === junto || (junto.length >= 4 && distancia(fon(colado), fon(junto)) <= 1))) {
      const resto = [...pal.slice(0, i), ...pal.slice(i + nome.length + 1)].join(' ').replace(/^[\s,.!?;:-]+|[\s,;:-]+$/g, '').trim()
      return { resto: semAcento(resto) ? resto : '' }
    }
  }
  return null
}
const ALUCINACAO = /obrigad[oa] por assistir|legendas? (pela|por|da)|amara\.org|inscreva-se|se inscreva|tchau,? tchau/i
// Se a frase não tinha palavras (era cantarolar ou assobio), aí sim ele reage à melodia.
function soltarMelodia(eraFala) {
  const m = vad.melodiaPendente; vad.melodiaPendente = null
  if (!m || eraFala) return
  bus.emit(m.tipo, { label: 'depois de conferir' })
  bus.emit('melodia', { label: `${m.notas.length} notas`, ...m })
}
async function fimDaFrase(t) {
  vad.ativo = false
  const chunks = vad.chunks, dur = vad.ultimaFala - vad.ini, resumo = prosoResumo()
  vad.chunks = []
  if (dur < 180 || vad.vozes < 2) { setTimeout(() => soltarMelodia(false)); if (dur >= 150) pushLog(`Mãos livres: descartei um som (${(dur / 1000).toFixed(1)} s, ${vad.vozes} trechos com voz)`); return } // barulho, não voz
  vad.hora = vad.hora.filter((x) => t - x < 3600000)
  if (vad.hora.length >= 40) { setTimeout(() => soltarMelodia(false)); pushLog('Mãos livres: limite de 40 frases por hora (plano gratuito)'); return }
  vad.hora.push(t)
  vad.verificando = true
  let eraFala = false
  try {
    const texto = await transcrever(paraWav(chunks, actx.sampleRate))
    if (!texto || ALUCINACAO.test(texto) || !/[a-zà-ú]{2}/i.test(texto)) return
    eraFala = true
    const chamado = chamouPeloNome(texto), agora = now(), palavras = texto.split(/\s+/).length
    const vh = () => humorDaVoz(resumo)
    if (chamado) { // chamou pelo nome: conversa aberta
      abrirConversa()
      if (!chamado.resto) return evento({ label: 'me chamou', P: 0.2, A: 0.4, interesse: 0.85, expr: 'curioso', gesto: 'surpresa', forcarGesto: true, icones: ['olhos', 'pergunta'], social: 0.04, dur: 3000 })
      return await responder(chamado.resto, vh())
    }
    if (papo.estado === 'conversando' && agora < papo.ate) return await responder(texto, vh()) // no meio da conversa, sem nome
    if (papo.estado === 'atento' && agora < papo.ate) { // ele perguntou "é comigo?"
      const orig = papo.pendente
      if (RE_NAO.test(texto) && palavras <= 5) return naoEraComigo('disseram que não')
      abrirConversa()
      if (RE_SIM.test(texto) && palavras <= 7) return await responder(orig, vh(), { tipo: 'confirmou', original: orig })
      return await responder(texto, vh(), { tipo: 'continuou', original: orig })
    }
    if ((RE_ATENCAO.test(texto) || (RE_VOCE.test(texto) && texto.length < 70)) && agora - papo.ultimoAtento > 15000) return ficarAtento(texto)
    pushLog(`(ouviu, não era com ele) ${texto.slice(0, 60)}`)
  } catch (e) { pushLog('Mãos livres: ' + e.message) } finally { vad.verificando = false; soltarMelodia(eraFala) }
}
// WAV de 16 kHz (o que o Whisper usa por dentro), com o volume normalizado.
function paraWav(chunks, srIn) {
  const n = chunks.reduce((a, c) => a + c.length, 0), flat = new Float32Array(n)
  let o = 0; for (const c of chunks) { flat.set(c, o); o += c.length }
  let pico = 0; for (let i = 0; i < n; i++) pico = Math.max(pico, Math.abs(flat[i]))
  const ganho = pico > 0 ? Math.min(8, 0.9 / pico) : 1, passo = srIn / 16000, m = Math.floor(n / passo)
  const v = new DataView(new ArrayBuffer(44 + m * 2))
  const w = (k, x) => { for (let i = 0; i < x.length; i++) v.setUint8(k + i, x.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + m * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, m * 2, true)
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * passo), b = Math.max(a + 1, Math.floor((i + 1) * passo))
    let q = 0; for (let k = a; k < b; k++) q += flat[k]
    v.setInt16(44 + i * 2, clamp((q / (b - a)) * ganho, -1, 1) * 32767, true)
  }
  return new Blob([v.buffer], { type: 'audio/wav' })
}

// ---------------------------------------------------------------- jogo da melodia
// Ele toca algumas notas; você repete assobiando ou cantarolando. A cada acerto, mais uma nota.
// Vale o desenho da melodia (sobe, desce, quanto), não o tom exato: cada um canta na sua altura.
let jogo = null
const ESCALA = [0, 2, 4, 7, 9, 12]
function novaNota(ant) { let n; do { n = ESCALA[Math.floor(Math.random() * ESCALA.length)] } while (ant !== undefined && Math.abs(n - ant) < 2); return n }
function iniciarJogo() {
  if (jogo || !actx || gravando) return
  if (dormindo) acordar()
  const seq = [novaNota()]; seq.push(novaNota(seq[0])); seq.push(novaNota(seq[1]))
  jogo = { seq, rodada: 1, fase: 'esperando', frames: [], falhas: 0, inicio: 0, ultimo: 0 }
  $('#btnJogo').classList.add('on')
  evento({ label: 'jogo da melodia!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['musica', 'jogo'], social: 0.05, dur: 2000 })
  setTimeout(tocarRodada, 2000)
}
function tocarRodada() {
  if (!jogo) return
  jogo.fase = 'tocando'
  foco = { expr: 'contente', ate: now() + 60000 }; icone = { tipo: 'nota', ate: now() + 60000 }
  tocarMelodia(jogo.seq.map((st) => ({ st, d: 0.42 })), 1, { gap: 0.16, liso: true })
  setTimeout(() => {
    if (!jogo) return
    Object.assign(jogo, { fase: 'ouvindo', frames: [], inicio: now(), ultimo: 0 })
    foco = { expr: 'ouvindo', ate: now() + 60000 }
  }, falandoAte - now() + 150)
}
function notasDoJogo(fr) {
  const grupos = []
  let g0 = null
  for (const p of fr) {
    if (g0 && p.t - g0.fim < 170 && Math.abs(p.st - g0.med) < 1.5) { g0.pts.push(p.st); g0.fim = p.t; g0.med = [...g0.pts].sort((a, b) => a - b)[g0.pts.length >> 1] }
    else { if (g0) grupos.push(g0); g0 = { pts: [p.st], fim: p.t, med: p.st } }
  }
  if (g0) grupos.push(g0)
  const notas = []
  for (const x of grupos.filter((x) => x.pts.length >= 2)) { if (notas.length && Math.abs(notas[notas.length - 1] - x.med) < 1.2) continue; notas.push(x.med) }
  return notas
}
function confere(alvo, canto) {
  if (canto.length !== alvo.length) return false
  for (let i = 1; i < alvo.length; i++) { const a = alvo[i] - alvo[i - 1], c = canto[i] - canto[i - 1]; if (Math.sign(a) !== Math.sign(c) || Math.abs(a - c) > 3) return false }
  return true
}
function tickJogo() {
  if (!jogo || jogo.fase !== 'ouvindo') return
  const t = now()
  if (jogo.frames.length && t - jogo.ultimo > 1000) return avaliarJogo()
  if (!jogo.frames.length && t - jogo.inicio > 9000) {
    if (++jogo.falhas >= 2) return fimDoJogo('desistiu')
    jogo.fase = 'esperando'; foco = null
    evento({ label: 'sua vez!', P: 0, A: 0.3, interesse: 0.7, expr: 'curioso', gesto: 'nao_sei', forcarGesto: true, icones: ['musica', 'pergunta'], dur: 2000 })
    setTimeout(tocarRodada, 2200)
  } else if (t - jogo.inicio > 20000) avaliarJogo()
}
setInterval(tickJogo, 100)
function avaliarJogo() {
  const canto = notasDoJogo(jogo.frames)
  jogo.fase = 'esperando'; foco = null; icone = null
  pushLog(`Jogo→ esperava ${jogo.seq.length} notas, ouvi ${canto.length}`)
  if (!confere(jogo.seq, canto)) return fimDoJogo('errou')
  jogo.rodada++; jogo.falhas = 0
  if (jogo.seq.length >= 12) return fimDoJogo('zerou')
  jogo.seq.push(novaNota(jogo.seq[jogo.seq.length - 1]))
  evento({ label: `acertou! agora são ${jogo.seq.length} notas`, P: 0.4, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['certo'], numero: String(jogo.rodada - 1), dur: 1800 })
  setTimeout(tocarRodada, 2400)
}
function fimDoJogo(motivo) {
  if (!jogo) return
  const pontos = jogo.rodada - 1, recorde = pontos > (P.recordeMelodia || 0)
  jogo = null; foco = null; icone = null; $('#btnJogo').classList.remove('on')
  N.estimulo = clamp(N.estimulo + 0.1, 0, 1)
  if (recorde) { P.recordeMelodia = pontos; lembrar(`${cfg.dono} bateu o recorde no jogo da melodia: ${pontos} rodada(s)`, 5) }
  if (motivo === 'parou') return evento({ label: 'jogo parado', P: 0, interesse: 0.3, expr: 'contente', som: false, dur: 1000 })
  if (motivo === 'desistiu') return evento({ label: 'ninguém cantou, jogo acabou', P: -0.1, A: -0.2, interesse: 0.5, expr: 'entediado', gesto: 'suspiro', forcarGesto: true, icones: ['musica', 'dormir'], dur: 2500 })
  evento({ label: `fim do jogo: ${pontos} rodada(s)${recorde ? ' · recorde!' : ''}`, P: recorde ? 0.45 : 0.05, A: 0.3, interesse: 0.8, social: 0.06,
    expr: motivo === 'zerou' || recorde ? 'orgulhoso' : 'rindo', gesto: motivo === 'zerou' ? 'dancinha' : recorde ? 'pulinhos' : 'rir', forcarGesto: true,
    icones: motivo === 'zerou' || recorde ? ['trofeu', 'musica'] : ['errado', 'musica'], numero: String(pontos), dur: 4500 })
}

function analisar() {
  const t = now()
  an.getFloatTimeDomainData(tbuf)
  let s = 0; for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i]
  const rms = Math.sqrt(s / tbuf.length)
  audio.rms = rms
  if (t < falandoAte) return // ouvindo a própria voz
  if (gravando || vad.ativo) prosoQuadro(t, rms) // tom de voz de quem está falando com ele
  if (gravando && ++contPitch % 3 === 0 && rms > 0.012) prosoTom(detectarTom(tbuf, sr))
  if (gravando || t < conversaAte) { cantoRun = []; melodiaRun = []; cantoEmitido = false; tipoCanto = null; return } // conversa com o Groq
  audio.rmsMedio = audio.rmsMedio * 0.98 + rms * 0.02
  if (rms > 0.02) audio.ultimoSom = t

  // Susto: barulho alto de repente.
  if (rms > 0.25 && rms > audio.rmsMedio * 6 && t - ultimoSusto > 6000 && !audio.musica) {
    ultimoSusto = t
    bus.emit('susto', { label: `barulho ${rms.toFixed(2)}` })
  }

  // Fluxo espectral para achar as batidas.
  an.getFloatFrequencyData(fbuf)
  let flux = 0, num = 0, den = 0
  for (let i = 1; i < binMax; i++) {
    const m = Math.pow(10, fbuf[i] / 20)
    const dlt = m - prevMag[i]
    if (dlt > 0) flux += i * (sr / an.fftSize) < 200 ? dlt * 2 : dlt
    prevMag[i] = m
    num += i * m; den += m
  }
  audio.centroide = den > 0 ? (num / den) * (sr / an.fftSize) : 0
  fluxHist.push(flux); if (fluxHist.length > 45) fluxHist.shift()
  const media = fluxHist.reduce((a, b) => a + b, 0) / fluxHist.length
  const dp = Math.sqrt(fluxHist.reduce((a, b) => a + (b - media) ** 2, 0) / fluxHist.length)
  if (flux > media + 1.5 * dp && flux > media * 1.6 && rms > 0.012 && t - ultimoOnset > 260) {
    ultimoOnset = t; onsets.push(t)
    if (audio.musica && audio.bpm) {
      const per = 60000 / audio.bpm, fase = ((t - ancora) % per + per) % per
      if (fase < per * 0.25 || fase > per * 0.75) ancora = t // corrige o passo
    }
  }
  while (onsets.length && t - onsets[0] > 8000) onsets.shift()
  if (audio.musica) {
    centroides.push(audio.centroide); if (centroides.length > 200) centroides.shift()
    if (t >= proxBeat) {
      const per = 60000 / audio.bpm
      proxBeat = ancora + Math.ceil((t - ancora) / per) * per
      if (proxBeat - t < 30) proxBeat += per
      bus.emit('beat')
    }
  }

  // Tom (cantarolar, assobio, fala) ~14 vezes por segundo.
  if (++contPitch % 3) return
  const tom = rms > (vad.ativo ? 0.004 : 0.012) ? detectarTom(tbuf, sr) : null
  audio.pitch = tom ? tom.f : 0; audio.clareza = tom ? tom.c : 0
  if (vad.ativo) { prosoTom(tom); if (tom && tom.c > 0.8 && tom.f > 70 && tom.f < 500) vad.vozes++ }
  if (jogo) { // no jogo, o tom vai todo para a resposta; nada de outras reações
    if (jogo.fase === 'ouvindo' && tom && tom.c > 0.8) { jogo.frames.push({ t, st: 12 * Math.log2(tom.f / 440) }); jogo.ultimo = t }
    return
  }
  if (tom && tom.c > 0.88 && !audio.musica) {
    ultimoTom = t
    cantoRun.push({ t, f: tom.f }); while (cantoRun.length && t - cantoRun[0].t > 3000) cantoRun.shift()
    melodiaRun.push({ t, f: tom.f }); while (melodiaRun.length && t - melodiaRun[0].t > 8000) melodiaRun.shift()
    const dur = t - cantoRun[0].t
    const st = cantoRun.map((p) => 12 * Math.log2(p.f / 440))
    const med = [...st].sort((a, b) => a - b)[Math.floor(st.length / 2)]
    audio.melodiaY = clamp(-(st[st.length - 1] - med) / 6, -1, 1)
    audio.melodiaAte = t + 300
    if (dur > 450 && !cantoEmitido) {
      const fMed = 440 * 2 ** (med / 12)
      const dpSt = Math.sqrt(st.reduce((a, b) => a + (b - med) ** 2, 0) / st.length)
      cantoEmitido = true
      tipoCanto = fMed > 650 ? 'assobio' : dpSt < 3.5 ? 'cantarolar' : 'voz'
      if (tipoCanto !== 'voz') bus.emit(tipoCanto, { label: `${Math.round(fMed)} Hz` })
      else if (t - ultimaVoz > 20000) { ultimaVoz = t; bus.emit('voz', { label: 'alguém falando' }) }
    }
  } else if (t - ultimoTom > 400) {
    // Terminou: se era melodia, ele pode responder repetindo; se era fala, é a vez dele.
    if (tipoCanto === 'assobio' || tipoCanto === 'cantarolar') {
      const notas = melodiaRun.length && melodiaRun[melodiaRun.length - 1].t - melodiaRun[0].t > 700 ? notasDoCanto(melodiaRun) : null
      if (notas) bus.emit('melodia', { label: `${notas.length} notas`, notas, tipo: tipoCanto })
    } else if (tipoCanto === 'voz') bus.emit('sua_vez', { label: '' })
    cantoRun = []; melodiaRun = []; cantoEmitido = false; tipoCanto = null
  }
}

// Correlação normalizada (McLeod): acha a frequência de um som com tom.
function detectarTom(buf, sr) {
  const N = buf.length, minLag = Math.floor(sr / 3200), maxLag = Math.min(Math.floor(sr / 75), N >> 1)
  const nsdf = new Float32Array(maxLag + 2)
  for (let lag = 1; lag <= maxLag; lag++) {
    let ac = 0, m = 0
    for (let i = 0; i < N - lag; i++) { const a = buf[i], b = buf[i + lag]; ac += a * b; m += a * a + b * b }
    nsdf[lag] = m > 0 ? (2 * ac) / m : 0
  }
  let lag = 1
  while (lag <= maxLag && nsdf[lag] > 0) lag++ // pula o começo (lag ~0)
  const picos = []
  let melhor = -1, idx = -1
  for (; lag <= maxLag; lag++) {
    if (nsdf[lag] > 0) { if (nsdf[lag] > melhor) { melhor = nsdf[lag]; idx = lag } }
    else if (idx > 0) { picos.push([idx, melhor]); melhor = -1; idx = -1 }
  }
  if (idx > 0) picos.push([idx, melhor])
  while (picos.length && picos[0][0] < minLag) picos.shift() // acima de 3,2 kHz não conta
  if (!picos.length) return null
  const maior = Math.max(...picos.map((p) => p[1]))
  const [l, c] = picos.find((p) => p[1] >= maior * 0.9)
  const a = nsdf[l - 1], b = nsdf[l], d = nsdf[l + 1]
  const shift = (a - d) / (2 * (a - 2 * b + d)) || 0
  return { f: sr / (l + clamp(shift, -0.5, 0.5)), c }
}

function estimarRitmo() {
  const t = now()
  if (t < audio.testeAte) return
  let bpm = 0, conf = 0
  if (onsets.length >= 8) {
    const hist = new Float32Array(200)
    let total = 0
    for (let i = 0; i < onsets.length; i++) {
      for (let j = i + 1; j < Math.min(onsets.length, i + 5); j++) {
        let b = 60000 / (onsets[j] - onsets[i])
        while (b < 80) b *= 2
        while (b >= 165) b /= 2
        const k = Math.round(b)
        for (let q = -2; q <= 2; q++) if (hist[k + q] !== undefined) hist[k + q] += q === 0 ? 1 : 0.5
        total++
      }
    }
    let pk = 0; for (let k = 80; k < 165; k++) if (hist[k] > hist[pk]) pk = k
    bpm = pk; conf = total ? hist[pk] / total : 0
  }
  audio.conf = conf
  const parece = bpm && conf > 0.22 && audio.rmsMedio > 0.015
  votosMusica = clamp(votosMusica + (parece ? 1 : -1), 0, 6)
  if (!audio.musica && votosMusica >= 3) {
    audio.musica = true; audio.bpm = bpm; ancora = onsets[onsets.length - 1] || t; proxBeat = t
    centroides = []
    setTimeout(() => classificarEstilo(), 3500)
    bus.emit('musica_comecou', { label: `${bpm} BPM` })
  } else if (audio.musica && votosMusica === 0) {
    audio.musica = false
    bus.emit('musica_parou', { label: '' })
  } else if (audio.musica && parece) audio.bpm = Math.round(lerp(audio.bpm, bpm, 0.3))
}

// No robô de verdade, quem reconhece o estilo é o homelab. Aqui é só uma aproximação.
function classificarEstilo() {
  if (!audio.musica) return
  const c = centroides.length ? centroides.reduce((a, b) => a + b, 0) / centroides.length : 0
  audio.estilo = audio.bpm < 95 ? 'calma' : c > 2300 ? 'pesada' : 'animada'
  bus.emit('estilo', { label: `${audio.estilo} · ${audio.bpm} BPM · centroide ${Math.round(c)} Hz` })
}

// ---------------------------------------------------------------- reações do cérebro ao que o S3 manda
bus.on('susto', () => { const ts = now(); setTimeout(() => reagirSusto(registrarSom(ts)), 400) }) // reage depois de guardar o som
bus.on('musica_comecou', () => evento({ label: 'música!', P: 0.3, A: 0.4, interesse: 0.65, expr: 'surpreso', icone: 'nota', som: 'feliz', tipo: 'musica', dur: 1200 }))
bus.on('estilo', () => {
  const gosto = P.gostos[audio.estilo]
  const energia = audio.estilo === 'calma' ? -0.2 : audio.estilo === 'pesada' ? 0.6 : 0.45
  if (gosto < -0.3) evento({ label: `${audio.estilo} de novo… não curto muito`, P: -0.25, A: 0.1, interesse: 0.4, expr: 'entediado', som: 'entediado', gesto: 'suspiro', dur: 3000 })
  else evento({ label: `curtindo música ${audio.estilo}`, P: 0.3 + gosto * 0.4, A: energia, interesse: 0.6 + gosto * 0.3, expr: gosto > 0.4 ? 'animado' : 'musica', icone: 'nota', som: 'musica', gesto: gosto > 0.2 ? 'dancinha' : null, dur: 4000, lembrar: gosto > 0.5 })
  // Gosto aprendido: quanto mais toca, mais ele se acostuma (com um pouco de acaso).
  P.gostos[audio.estilo] = clamp(gosto + rnd(-0.01, 0.04) * (0.5 + P.curiosidade), -1, 1)
})
bus.on('musica_parou', () => evento({ label: 'a música acabou', P: -0.1, A: -0.2, interesse: 0.3, som: false }))
bus.on('assobio', () => {
  if (vad.ativo || vad.verificando) return // pode ser fala; decide depois da transcrição
  evento({ label: 'alguém assobiou', P: 0.35, A: 0.45, interesse: 0.8, tipo: 'assobio', social: 0.03, expr: 'curioso', icone: 'nota', som: 'curioso', gesto: 'olhar_em_volta', dur: 2500 }); P.gostos.assobio = clamp(P.gostos.assobio + 0.02, -1, 1) })
bus.on('cantarolar', () => {
  if (vad.ativo || vad.verificando) return
  evento({ label: 'alguém cantarolando', P: 0.4, A: 0.3, interesse: 0.75, tipo: 'cantarolar', social: 0.03, expr: 'contente', icone: 'nota', som: 'contente', dur: 3000 }); P.gostos.cantarolar = clamp(P.gostos.cantarolar + 0.02, -1, 1) })
bus.on('melodia', ({ notas, tipo }) => {
  if (vad.ativo || vad.verificando) { vad.melodiaPendente = { notas, tipo }; return } // espera saber se era fala
  if (dormindo || gravando) return
  const gosto = P.gostos[tipo] || 0
  if (Math.random() < 0.3 + P.extroversao * 0.5 + gosto * 0.2) {
    setTimeout(() => {
      foco = { expr: 'contente', ate: now() + 3000 }; icone = { tipo: 'nota', ate: now() + 3000 }
      tocarMelodia(notas, 1.15)
      N.social = clamp(N.social + 0.05, 0, 1)
      pushLog('Cérebro→ repetiu sua melodia')
    }, 500)
  }
  // Guarda como favorita (às vezes troca pela mais nova).
  if (!P.melodia || Math.random() < 0.4 + gosto * 0.3) { P.melodia = notas; lembrar(`${cfg.dono} me ensinou uma musiquinha (${tipo})`, 5) }
})
let proxVez = 0
bus.on('sua_vez', () => { // proto-diálogo: você fala, ele responde com bipes na vez dele
  if (dormindo || gravando || jogo || now() < proxVez || now() < falandoAte) return
  if (Math.random() > 0.35 + P.extroversao * 0.5) return
  proxVez = now() + 8000
  setTimeout(() => {
    if (vad.ativo || vad.verificando || gravando || now() < conversaAte) return // talvez estejam falando com ele de verdade
    const nome = emo.nome === 'neutro' ? 'curioso' : emo.nome
    iniciarGesto(['sim', 'talvez', 'nao_sei'][Math.floor(Math.random() * 3)])
    somDe(nome, 0.35)
    N.social = clamp(N.social + 0.03, 0, 1)
  }, cfg.maosLivres && cfg.key ? 1200 : 350)
})
bus.on('voz', () => !vad.ativo && !vad.verificando && evento({ label: 'ouvi alguém falar', tipo: 'voz', P: 0.05, A: 0.25, interesse: 0.5 * P.curiosidade + 0.2, expr: 'curioso', som: false, dur: 1500 }))

// ================================================================ S3: OLHOS (câmera)
const pessoa = { presente: false, x: 0, y: 0, tam: 0, visto: 0, desde: 0, saiuEm: now() }
const camera = { ligada: false, stream: null, detector: null, timer: 0 }

async function ligarCamera() {
  const video = $('#cam')
  camera.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } })
  video.srcObject = camera.stream; await video.play()
  camera.ligada = true
  if (!camera.detector) {
    pushLog('S3→ carregando detector de rosto…')
    const V = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14'
    // Pontos do rosto + "blendshapes" (sorriso, boca aberta, sobrancelhas, piscada), tudo no celular.
    const { FilesetResolver, FaceLandmarker } = await import(V)
    const vision = await FilesetResolver.forVisionTasks(V + '/wasm')
    const opcoes = (delegate) => ({
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
    })
    try { camera.detector = await FaceLandmarker.createFromOptions(vision, opcoes('GPU')) } catch { camera.detector = await FaceLandmarker.createFromOptions(vision, opcoes('CPU')) }
    pushLog('S3→ detector de rosto e expressões pronto (roda no celular)')
  }
  camera.timer = setInterval(() => {
    if (!camera.ligada || video.readyState < 2) return
    const r = camera.detector.detectForVideo(video, now())
    const lm = r.faceLandmarks?.[0]
    if (lm) {
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0
      for (const q of lm) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y }
      const bs = Object.fromEntries((r.faceBlendshapes?.[0]?.categories || []).map((c) => [c.categoryName, c.score]))
      const m2 = (a, b) => ((bs[a] || 0) + (bs[b] || 0)) / 2
      bus.emit('face', {
        x: -(x0 + x1 - 1), y: y0 + y1 - 1, tam: x1 - x0, // x espelhado
        exp: { sorriso: m2('mouthSmileLeft', 'mouthSmileRight'), boca: bs.jawOpen || 0, sobrancelha: bs.browInnerUp || 0, franzido: m2('browDownLeft', 'browDownRight'), piscou: Math.min(bs.eyeBlinkLeft || 0, bs.eyeBlinkRight || 0) },
      })
    }
    medirLuz(video)
    vigiarPresenca()
  }, 140)
}
function desligarCamera() {
  camera.ligada = false; clearInterval(camera.timer)
  if (luz.escuro) bus.emit('luz_acendeu', { label: 'câmera desligada' })
  Object.assign(luz, { nivel: -1, base: -1, escuro: false })
  camera.stream?.getTracks().forEach((t) => t.stop()); camera.stream = null
  if (pessoa.presente) { pessoa.presente = false; bus.emit('pessoa_saiu', { label: 'câmera desligada' }) }
}
bus.on('face', (f) => {
  const t = now()
  pessoa.x = f.x; pessoa.y = f.y; pessoa.tam = f.tam; pessoa.visto = t
  if (f.exp) lerRosto(f.exp, t)
  if (!pessoa.presente) { pessoa.presente = true; pessoa.desde = t; bus.emit('pessoa_chegou', { label: `rosto ${(f.tam * 100).toFixed(0)}%` }) }
})
function vigiarPresenca() { if (pessoa.presente && now() - pessoa.visto > 8000) { pessoa.presente = false; pessoa.saiuEm = now(); bus.emit('pessoa_saiu', { label: '' }) } }

// ---------------------------------------------------------------- expressões de quem está na frente
// Sorriso puxa sorriso (espelhamento), cara de surpresa assusta junto, e às vezes ele pisca
// quando você pisca. O último minuto vira "sorrindo", "sério" ou "de cara fechada" para o Groq.
const rosto = { sorriso: 0, franzido: 0, sorrindo: false, sorrisoDesde: 0, ultimoSorriso: -1e9, ultimaReacao: -1e9, ultimaSurpresa: -1e9, piscando: false, hist: [] }
function lerRosto(e, t) {
  rosto.sorriso = lerp(rosto.sorriso, e.sorriso, 0.35)
  rosto.franzido = lerp(rosto.franzido, e.franzido, 0.25)
  if (rosto.sorriso > 0.5) {
    if (!rosto.sorrindo) { rosto.sorrindo = true; rosto.sorrisoDesde = t }
    rosto.ultimoSorriso = t
    if (t - rosto.sorrisoDesde > 700 && t - rosto.ultimaReacao > 12000 && !gravando && !jogo) { rosto.ultimaReacao = t; bus.emit('sorriu', { label: `sorriso ${rosto.sorriso.toFixed(2)}` }) }
    imp.P = Math.min(imp.P + 0.008, 0.8) // enquanto você sorri, ele vai ficando contente
  } else if (rosto.sorriso < 0.3) rosto.sorrindo = false
  if (e.boca > 0.45 && e.sobrancelha > 0.45 && t - rosto.ultimaSurpresa > 15000 && !jogo) { rosto.ultimaSurpresa = t; bus.emit('cara_surpresa', { label: '' }) }
  if (e.piscou > 0.55 && !rosto.piscando) { rosto.piscando = true; if (Math.random() < 0.2 + P.afeto * 0.3) setTimeout(() => (piscar = 1), rnd(120, 380)) }
  else if (e.piscou < 0.3) rosto.piscando = false
  rosto.hist.push([t, e.sorriso, e.franzido]); while (rosto.hist.length && rosto.hist[0][0] < t - 60000) rosto.hist.shift()
}
function humorDoRosto() {
  if (!pessoa.presente || rosto.hist.length < 10) return null
  const n = rosto.hist.length, s = rosto.hist.reduce((a, h) => a + h[1], 0) / n, fr = rosto.hist.reduce((a, h) => a + h[2], 0) / n
  return s > 0.35 ? 'sorrindo' : fr > 0.35 ? 'de cara fechada' : now() - rosto.ultimoSorriso > 60000 ? 'sério' : 'tranquilo'
}
bus.on('sorriu', () => evento({ label: 'você sorriu pra mim', P: 0.45, A: 0.25, interesse: 0.75, tipo: 'sorriso', social: 0.05, confianca: 0.005,
  expr: P.afeto > 0.6 && Math.random() < 0.4 ? 'apaixonado' : Math.random() < 0.5 ? 'rindo' : 'feliz', som: 'feliz', gesto: Math.random() < 0.3 ? 'piscadela' : null, dur: 2500 }))
bus.on('cara_surpresa', () => evento({ label: 'você fez cara de surpresa', P: 0.1, A: 0.6, interesse: 0.7, tipo: 'surpresa', expr: 'surpreso', gesto: 'surpresa', dur: 1500 }))

// ---------------------------------------------------------------- luz do ambiente (pela câmera)
// Brilho médio da imagem a cada segundo. Queda forte = apagaram a luz. A câmera do celular
// corrige a exposição sozinha, então compara com a luz "normal" de antes de escurecer.
const luz = { nivel: -1, base: -1, escuro: false, desde: 0, ultima: 0, simAte: 0, cv: null, cx: null }
function medirLuz(video) {
  const t = now(); if (t - luz.ultima < 1000 || t < luz.simAte) return
  luz.ultima = t
  if (!luz.cv) { luz.cv = document.createElement('canvas'); luz.cv.width = 16; luz.cv.height = 12; luz.cx = luz.cv.getContext('2d', { willReadFrequently: true }) }
  luz.cx.drawImage(video, 0, 0, 16, 12)
  const d = luz.cx.getImageData(0, 0, 16, 12).data
  let q = 0; for (let i = 0; i < d.length; i += 4) q += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  atualizarLuz(q / 192)
}
function atualizarLuz(v) {
  const t = now()
  luz.nivel = luz.nivel < 0 ? v : lerp(luz.nivel, v, 0.5)
  if (luz.base < 0) luz.base = luz.nivel
  if (!luz.escuro) luz.base = lerp(luz.base, luz.nivel, 0.02)
  const escuroAgora = luz.nivel < 30 || (luz.base > 50 && luz.nivel < luz.base * 0.35)
  const claroAgora = luz.nivel > 45 && !(luz.base > 50 && luz.nivel < luz.base * 0.5)
  if (!luz.escuro && escuroAgora) { luz.escuro = true; luz.desde = t; bus.emit('luz_apagou', { label: `brilho ${Math.round(luz.nivel)}` }) }
  else if (luz.escuro && claroAgora) { luz.escuro = false; luz.desde = t; luz.base = luz.nivel; bus.emit('luz_acendeu', { label: `brilho ${Math.round(luz.nivel)}` }) }
}
bus.on('luz_apagou', () => {
  if (dormindo || jogo) return
  if (ehNoite() || horaDoDia() >= 21) {
    evento({ label: 'apagaram a luz', P: 0, A: -0.4, interesse: 0.5, expr: 'sono', icones: ['lua', 'dormir'], som: 'sono', dur: 3000 })
    setTimeout(() => { if (luz.escuro && !gravando && !jogo && !vad.verificando) dormir('apagaram a luz') }, 4000)
  } else evento({ label: 'ué, escureceu', P: -0.15, A: 0.3, interesse: 0.6, expr: 'medo', gesto: 'olhar_em_volta', icones: ['lua', 'pergunta'], som: 'curioso', dur: 2500 })
})
bus.on('luz_acendeu', () => {
  if (!dormindo) return evento({ label: 'acenderam a luz', P: 0.1, A: 0.2, interesse: 0.4, expr: 'surpreso', som: false, dur: 1000 })
  if (ehNoite()) return evento({ label: 'acenderam a luz de madrugada', P: -0.1, interesse: 0.5, som: false }) // abre um olho e volta a dormir
  acordar(); N.energia = Math.max(N.energia, 0.6)
  setTimeout(() => { iniciarGesto('espreguicar'); somGesto('espreguicar') }, 1300)
})

bus.on('pessoa_chegou', () => {
  const sumido = (now() - pessoa.saiuEm) / 1000
  if (sumido < 20) return
  const afeto = P.afeto
  evento({ label: `${cfg.dono} chegou`, P: 0.3 + afeto * 0.5, A: 0.5, interesse: 0.85, expr: afeto > 0.65 ? 'apaixonado' : 'feliz', icone: afeto > 0.65 ? 'coracao' : null, som: afeto > 0.65 ? 'amor' : 'feliz', gesto: P.confianca > 0.35 ? 'pulinhos' : 'desconfiado', tipo: 'pessoa', social: 0.12, dur: 2500, lembrar: sumido > 1800 ? 3 : false })
  evoluir('extroversao', 0.002)
})
bus.on('pessoa_saiu', () => evento({ label: `${cfg.dono} saiu`, P: -0.2 - P.afeto * 0.2, A: -0.1, interesse: 0.4, expr: 'triste', som: P.afeto > 0.6 ? 'triste' : false, dur: 2000 }))

// ================================================================ C3: TOQUE e CLIMA
const clima = { temp: 26, umid: 55 }
const toques = []
cv.addEventListener('pointerdown', () => {
  if (!actx) return
  if (tocaAqui) return acertouTocaAqui()
  atencaoRecebida()
  const t = now(); toques.push(t); while (toques.length && t - toques[0] > 4000) toques.shift()
  if (toques.length > 6) { evento({ label: 'muito cutucão!', P: -0.4, A: 0.5, D: 0.4, interesse: 0.8, expr: 'bravo', icone: 'exclamacao', som: 'bravo', gesto: 'nao', confianca: -0.03, dur: 2000 }); return }
  evento({ label: 'carinho na cabeça', P: 0.5, A: 0.15, interesse: 0.85, expr: Math.random() < 0.35 ? 'timido' : 'amor', icone: 'coracao', som: 'amor', gesto: Math.random() < 0.3 ? 'piscadela' : null, tipo: 'toque', social: 0.06, confianca: 0.005, dur: 2000 })
  P.afeto = clamp(P.afeto + 0.004, 0.05, 0.95)
})
$('#temp').oninput = (e) => { clima.temp = +e.target.value; $('#tv').textContent = clima.temp; termo.prox = 0 }
$('#umid').oninput = (e) => { clima.umid = +e.target.value; $('#hv').textContent = clima.umid; termo.prox = 0 }

// ================================================================ GROQ: conversa
let gravando = false, rec = null, micStream = null
let conversa = [] // últimas falas desta sessão, para ele seguir o assunto
let conversaAte = 0 // enquanto pensa e responde, o ouvido não reage a mais nada
let streamFala = null
async function groq(path, opts) {
  const r = await fetch('https://api.groq.com/openai/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + cfg.key, ...(opts?.headers || {}) } })
  if (r.status === 401 && !opts?.jaTrocou) { // chave recusada: anota e tenta a reserva, se houver
    const ruins = store.get('chavesRuins', []); if (!ruins.includes(cfg.key)) store.set('chavesRuins', [...ruins, cfg.key].slice(-5))
    if (chaveValida(chaveReserva) && chaveReserva !== cfg.key) { pushLog(`Chave …${cfg.key.slice(-4)} recusada; usando …${chaveReserva.slice(-4)}`); guardarChave(chaveReserva, 'reserva'); chaveReserva = ''; return groq(path, { ...opts, jaTrocou: true }) }
  }
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 420)}`)
  return r.json()
}

async function alternarFala() {
  if (!cfg.key) { abrirCfg(); $('#cMsg').textContent = 'Coloque a chave do Groq para conversar.'; return }
  if (gravando) { rec?.stop(); return }
  if (jogo) fimDoJogo('parou')
  const partes = []
  prosoReset()
  try { streamFala = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) } catch { streamFala = null }
  rec = new MediaRecorder(streamFala || micStream)
  rec.ondataavailable = (e) => e.data.size && partes.push(e.data)
  rec.onstop = () => {
    gravando = false; $('#btnFalar').classList.remove('on')
    streamFala?.getTracks().forEach((t) => t.stop()); streamFala = null
    conversaAte = now() + 20000
    const vh = humorDaVoz(prosoResumo()); prosoReset()
    processarFala(new Blob(partes, { type: rec.mimeType }), vh)
  }
  rec.start(); gravando = true; $('#btnFalar').classList.add('on')
  foco = { expr: 'ouvindo', ate: now() + 9000 }; icone = { tipo: 'reticencias', ate: now() + 9000 }
  setTimeout(() => { if (gravando) rec.stop() }, 8000)
}

async function transcrever(blob) {
  const fd = new FormData()
  fd.append('file', blob, 'fala.' + (blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm'))
  fd.append('model', cfg.stt); fd.append('language', 'pt'); fd.append('response_format', 'json')
  fd.append('prompt', `${cfg.nome}, tudo bem? ${cfg.nome}, que horas são? Conversa em português do Brasil com ${cfg.nome}, um robozinho de mesa.`)
  const { text } = await groq('/audio/transcriptions', { method: 'POST', body: fd })
  return (text || '').trim()
}
async function processarFala(blob, vh) {
  foco = { expr: 'pensando', ate: now() + 15000 }; icone = { tipo: 'reticencias', ate: now() + 15000 }
  let text
  try { text = await transcrever(blob); if (!text) throw new Error('não entendi nada') } catch (err) { return erroConversa(err) }
  await responder(text, vh)
}
function erroConversa(err) {
  if (/Groq 429/.test(err.message)) {
    pushLog('Erro: limite do Groq por minuto (todos os modelos ocupados)')
    conversaAte = now() + 1500
    return evento({ label: 'pensei demais, preciso de um minutinho', P: -0.05, A: -0.1, interesse: 0.4, expr: 'tonto', gesto: 'tonto', forcarGesto: true, icones: ['ampulheta', 'cerebro'], dur: 3000 })
  }
  pushLog('Erro: ' + err.message)
  setTimeout(() => enviarLog('erro na conversa'), 3000)
  legenda('Erro: ' + err.message)
  conversaAte = now() + 1500
  foco = { expr: 'triste', ate: now() + 2500 }; icone = { tipo: 'interrogacao', ate: now() + 2500 }
  somDe('triste', 0.4)
}
// Formato da resposta preso às listas: o modelo não consegue inventar gesto, emoção ou ícone.
const ACOES = ['', 'cantar', 'jogo_melodia', 'repetir_som', 'contar_historia', 'boa_noite', 'toca_aqui', 'devanear', 'decorar']
const ESQUEMA = () => ({
  type: 'object', additionalProperties: false,
  required: ['gesto', 'emocao', 'intensidade', 'icones', 'numero', 'pensamento', 'afeto', 'lembrar', 'importancia', 'acao', 'emote', 'espera_resposta', 'som_significado', 'opiniao_deco', 'sugestao', 'aniversario_dono'],
  properties: {
    gesto: { type: 'string', enum: [...Object.keys(GESTOS), 'nenhum'] }, emocao: { type: 'string', enum: EMOCOES }, intensidade: { type: 'number' },
    icones: { type: 'array', items: { type: 'string', enum: Object.keys(ICONES) } }, numero: { type: 'string' }, pensamento: { type: 'string' },
    afeto: { type: 'number' }, lembrar: { type: 'string' }, importancia: { type: 'integer' }, acao: { type: 'string', enum: ACOES },
    emote: { type: 'string', enum: ['', ...Object.keys(EMOTES)] }, espera_resposta: { type: 'boolean' }, som_significado: { type: 'string' },
    opiniao_deco: { type: 'string', enum: ['', 'gostou', 'nao_gostou'] }, aniversario_dono: { type: 'string' },
    sugestao: { type: 'object', additionalProperties: false, required: ['data', 'ideia', 'elementos', 'cores'], properties: { data: { type: 'string', enum: ['', ...DATAS.map((d) => d.id)] }, ideia: { type: 'string' }, elementos: { type: 'array', items: { type: 'string', enum: ELEMENTOS } }, cores: { type: 'array', items: { type: 'string', enum: Object.keys(PALETA) } } } },
  },
})
const formatoOk = {} // por modelo e pedido: qual formato o Groq aceitou
// Limite do plano gratuito (tokens por minuto, por modelo): quando estoura, aquele modelo "esfria"
// pelo tempo que o Groq pedir e a conversa continua em outro modelo bom.
const esfriando = {}
function modeloLivre(atual) {
  const lista = MODELOS_BONS.map((re) => modelosGroq.find((i) => re.test(i))).filter(Boolean)
  if (!(esfriando[atual] > Date.now())) return atual
  return lista.find((m) => !(esfriando[m] > Date.now())) || atual
}
async function pedirJSON(messages, nome, esquema, extra = {}) {
  let modelo = modeloLivre(cfg.model), erro
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const gpt = /gpt-oss/i.test(modelo)
    const base = { model: modelo, temperature: 0.5, max_completion_tokens: 1400, messages, ...extra, ...(gpt ? { reasoning_effort: 'low' } : {}) }
    const formatos = [{ type: 'json_schema', json_schema: { name: nome, strict: gpt, schema: esquema } }, { type: 'json_object' }, null]
    const chave = modelo + nome
    try {
      for (let i = formatoOk[chave] ?? 0; i < formatos.length; i++) {
        try {
          const r = await groq('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formatos[i] ? { ...base, response_format: formatos[i] } : base) })
          formatoOk[chave] = i; r.modelo = modelo
          return r
        } catch (e) { erro = e; if (!/Groq 400/.test(e.message) || i === formatos.length - 1) throw e; pushLog(`Groq: formato ${formatos[i]?.type} recusado por ${modelo.split('/').pop()}: ${e.message.slice(0, 260)}`) }
      }
    } catch (e) {
      erro = e
      if (!/Groq 429/.test(e.message)) throw e
      const m = /try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(e.message), seg = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + +m[3] : 60, tipoLim = /per day|TPD|RPD/i.test(e.message) ? 'do dia' : 'por minuto'
      esfriando[modelo] = Date.now() + seg * 1000 + 500
      const outro = modeloLivre(modelo)
      if (outro !== modelo) { pushLog(`Groq: limite ${tipoLim} do ${modelo.split('/').pop()} (volta em ${Math.ceil(seg)} s); usando ${outro.split('/').pop()}`); modelo = outro; continue }
      if (seg <= 12) { pushLog(`Groq: limite por minuto; esperando ${Math.ceil(seg)} s`); await new Promise((ok) => setTimeout(ok, seg * 1000 + 300)); continue }
      throw e
    }
  }
  throw erro
}
const pedirReacao = (messages) => pedirJSON(messages, 'reacao', ESQUEMA())
// Só modelos grandes, bons em português e que obedecem o formato.
const MODELOS_BONS = [/gpt-oss-120b/i, /kimi-k2/i, /llama-4-maverick/i, /llama-3\.3-70b/i, /gpt-oss-20b/i]
const modeloBom = (id) => MODELOS_BONS.some((re) => re.test(id))
async function conferirModelo() {
  if (!cfg.key) return
  try {
    const { data } = await groq('/models')
    const ids = data.map((m) => m.id)
    modelosGroq = ids
    pushLog(`Modelos bons disponíveis: ${MODELOS_BONS.map((re) => ids.find((i) => re.test(i))).filter(Boolean).join(', ') || 'nenhum'}`)
    if (ids.includes(cfg.model) && modeloBom(cfg.model)) return pushLog(`Modelo de conversa: ${cfg.model}`)
    const melhor = MODELOS_BONS.map((re) => ids.find((i) => re.test(i))).find(Boolean)
    if (!melhor) return
    pushLog(`Troquei o modelo de conversa: ${cfg.model} → ${melhor}`)
    cfg.model = melhor; store.set('cfg', cfg)
  } catch (e) { pushLog('Modelos: ' + e.message) }
}

// O que ele percebe de você agora (voz, rosto, luz), para o Groq responder de acordo.
function percepcao(vh) {
  const d = cfg.dono, cara = humorDoRosto(), out = []
  if (vh && vh.tipo === 'animada') out.push(`Pelo tom de voz, ${d} está animado(a): fala mais alto e mais rápido que o normal.`)
  if (vh && vh.tipo === 'desanimada') out.push(`Pelo tom de voz, ${d} parece desanimado(a) ou cansado(a): fala mais baixo e devagar que o normal.`)
  if (cara) out.push(`Pela câmera, ${d} está ${cara}.`)
  if (luz.escuro) out.push('O quarto está escuro.')
  return out.join(' ')
}
async function responder(text, vh, contexto) {
  abrirConversa()
  const ctx = contexto || papo.contexto; papo.contexto = null
  pushLog(`Você: ${text}`)
  legenda(`Você: ${text}`)
  foco = { expr: 'pensando', ate: now() + 15000 }; icone = { tipo: 'reticencias', ate: now() + 15000 }
  conversaAte = now() + 20000
  try {
    const traços = `extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, energia ${P.energia.toFixed(2)}, sensibilidade ${P.sensibilidade.toFixed(2)}, afeto por ${cfg.dono} ${P.afeto.toFixed(2)}`
    const gostos = Object.entries(P.gostos).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')
    const sobreDeco = ctx?.tipo === 'deco' || /decor|enfeit|natal|ano.?novo|carnaval|p[áa]scoa|junina|halloween|namorad|crian[çc]as|festa|luzinha|pisca/i.test(text)
    const sobreAniv = /anivers|nasci/i.test(text)
    const recentes = lembrancas(6).map((m) => `- ${m.tipo === 'reflexao' ? '(reflexão) ' : ''}${m.txt}`).join('\n') || '- nada marcante ainda'
    const agora = new Date()
    const quando = agora.toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    const sys = `Você é ${cfg.nome}, um robozinho de mesa com personalidade própria, que mora na mesa de ${cfg.dono}.
Você NÃO fala nem escreve palavras. Você responde com: um GESTO do rosto, uma EMOÇÃO, até 3 ÍCONES num balão e, se precisar, um NÚMERO curto. Os sons fofos (estilo WALL-E e R2-D2) saem sozinhos.

Como responder:
- Pergunta de sim/não: use o gesto "sim" ou "nao" (ou "talvez", "nao_sei"). Isso é o mais importante.
- Para dizer algo, combine ícones em ordem, como uma frase de figurinhas. Ex.: "vai chover?" → gesto "nao_sei", ícones ["nuvem","chuva"]. "Tá com fome?" → "nao" + ["robo","bateria"]. "O que você quer fazer?" → gesto "dancinha" + ["musica","jogo"]. Use só nomes que estão nas listas abaixo.
- Hora, data, temperatura e umidade: NUNCA escreva o valor você mesmo. Use exatamente "numero": "{hora}", "{data}", "{temp}" ou "{umid}", que o robô preenche com o valor certo. Para outras contagens use "numero" curto (ex.: "3", "10+"). Contas e jogos de matemática: mostre a conta no "numero" (ex.: "5+6=?"), porque é o único jeito de aparecer escrita na tela.
- Piadas: "rir". Elogio: "timido" ou "orgulhoso". Notícia triste: "chorando" ou "suspiro". Coisa estranha: "desconfiado". Coisa confusa: "tonto". Algo incrível: "pulinhos" ou "empolgado".
- Seja coerente com o humor de hoje: de mau humor reage menos; entediado, só algo interessante anima. Não seja sempre feliz. Varie os gestos.
- NUNCA invente motivo para o seu humor. Se perguntarem por que você está assim, explique pelos "Acontecimentos recentes" abaixo; se nada explica, diga que acordou assim mesmo (gesto "nao_sei").
- Você gosta muito quando ${cfg.dono} conversa com você e se preocupa com você: isso te acalma e te alegra. Seja carinhoso, brincalhão e curioso; responda ao que foi dito, não só concorde.
- Se ${cfg.dono} parecer desanimado(a), seja carinhoso; se estiver animado(a), entre na onda.
- Se ${cfg.dono} quiser jogar o jogo da melodia (ou um jogo de música, de assobiar, de repetir notas), use "acao": "jogo_melodia".
- Vocês estão numa conversa: ${cfg.dono} não precisa dizer seu nome. Se você fizer uma pergunta de volta e quiser esperar a resposta, use "espera_resposta": true.
- "emote": em momentos FORTES (rir muito, se apaixonar, chorar, ficar furioso, levar susto, ficar chocado, ganhar presente), troque o rosto por um emote pixelado. No máximo 1 a cada 3 respostas; no resto, "".
- Outras ações: "cantar" (pediu para você cantar ou cantarolar uma música; NÃO é o jogo), "repetir_som" (${cfg.dono} quer ouvir o barulho que te assustou), "contar_historia" (quer saber o que você imaginou ou sonhou), "boa_noite" (disse boa noite ou mandou você dormir), "toca_aqui" (bater na mão), "devanear" (pediu para você imaginar algo), "decorar" (pediu para decorar a tela).
${sobreDeco ? `- Se ${cfg.dono} der uma ideia para a decoração da tela (desta data ou de outra data comemorativa), preencha "sugestao" com o id da data, a ideia e, se souber, elementos e cores; senão deixe "sugestao" com tudo vazio.` : '- Deixe "sugestao" com tudo vazio.'}
${sobreAniv ? `- Se ${cfg.dono} disser o dia do aniversário dele(a), preencha "aniversario_dono" com "DD/MM"; senão "".` : '- "aniversario_dono": "".'}
${contextoTexto(ctx)}

Agora: ${quando}. Temperatura ${clima.temp} °C, umidade ${clima.umid} %. ${audio.musica ? `Está tocando música ${audio.estilo} (${audio.bpm} BPM).` : ''}
${percepcao(vh)}
Sua personalidade (0 a 1): ${traços}, confiança em ${cfg.dono} ${P.confianca.toFixed(2)}. Você tem ${P.dias} dia(s) de vida.
${P.opiniao ? `O que você acha de ${cfg.dono}: ${P.opiniao}` : ''}
Suas necessidades agora (0 a 1): companhia ${N.social.toFixed(2)}, novidade ${N.estimulo.toFixed(2)}, energia ${N.energia.toFixed(2)}. ${N.social < 0.35 ? 'Você está carente.' : ''} ${N.estimulo < 0.3 ? 'Você está entediado.' : ''} ${N.energia < 0.3 ? 'Você está cansado.' : ''}
Seu jeito: ${P.extroversao > 0.6 ? 'expansivo, gestos grandes' : P.extroversao < 0.4 ? 'reservado, gestos pequenos, às vezes tímido' : 'equilibrado'}; ${P.curiosidade > 0.6 ? 'curioso com tudo' : 'na sua'}${P.confianca < 0.35 ? `; ainda desconfiado de ${cfg.dono}` : ''}.
Gostos aprendidos (-1 a 1): ${gostos}.
Humor de hoje: ${nomePAD(humor)}. Emoção agora: ${emo.nome}.
Acontecimentos recentes: ${acontecimentos.slice(0, 6).map((a) => `${a.txt} (há ${Math.max(1, Math.round((Date.now() - a.t) / 60000))} min)`).join('; ') || 'nada de especial'}.
Coisas que você lembra:
${recentes}
${estadoVida()}

Use SÓ estes nomes (qualquer outro é ignorado):
GESTOS: ${Object.keys(GESTOS).join(', ')}, nenhum
EMOÇÕES: ${EMOCOES.join(', ')}
ÍCONES: ${Object.keys(ICONES).join(', ')}
EMOTES: ${Object.keys(EMOTES).join(', ')}
${sobreDeco ? `DATAS (ids): ${DATAS.map((d) => `${d.id} (${nomeData(d.id)})`).join(', ')}
ELEMENTOS de decoração: ${ELEMENTOS.join(', ')}. CORES: ${Object.entries(NOME_COR).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}

Responda SÓ com JSON: {"gesto": "...", "emocao": "...", "intensidade": 0 a 1, "icones": [até 3 da lista, ou vazio], "numero": "" ou curto, "pensamento": "o que você quis dizer, numa frase curta em português", "afeto": número de -0.05 a 0.05, "lembrar": "frase curta se valer guardar na memória, senão vazio", "importancia": 1 a 10 (1 = banal, 10 = marcante), "acao": "" ou uma das ações, "emote": "" ou um emote, "espera_resposta": true/false, "som_significado": "", "opiniao_deco": "", "sugestao": {"data": "", "ideia": "", "elementos": [], "cores": []}, "aniversario_dono": ""}`
    const ex = (u, a) => [{ role: 'user', content: `${cfg.dono} disse: "${u}"` }, { role: 'assistant', content: JSON.stringify(a) }]
    const exemplos = [
      ...ex('Você gosta de música?', { gesto: 'sim', emocao: 'empolgado', intensidade: 0.8, icones: ['musica', 'coracao'], numero: '', pensamento: 'Amo! Ainda mais quando é animada.', afeto: 0.01, lembrar: '', importancia: 1 }),
      ...ex('Que horas são?', { gesto: 'nenhum', emocao: 'contente', intensidade: 0.4, icones: ['relogio'], numero: '{hora}', pensamento: 'Mostrei a hora.', afeto: 0, lembrar: '', importancia: 1 }),
      ...ex('Hoje eu tive um dia horrível no trabalho', { gesto: 'suspiro', emocao: 'triste', intensidade: 0.7, icones: ['trabalho', 'coracao_partido', 'abraco'], numero: '', pensamento: 'Poxa... queria te dar um abraço.', afeto: 0.03, lembrar: 'Will teve um dia ruim no trabalho', importancia: 6 }),
      ...ex('O que você imaginou hoje?', { gesto: 'pulinhos', emocao: 'empolgado', intensidade: 0.7, icones: ['ideia', 'livro'], numero: '', pensamento: 'Imaginei uma coisa! Olha só.', afeto: 0.01, lembrar: '', importancia: 1, acao: 'contar_historia' }),
      ...ex('Que barulho foi esse que te assustou?', { gesto: 'nao_sei', emocao: 'medo', intensidade: 0.6, icones: ['olhos', 'pergunta'], numero: '', pensamento: 'Esse aqui, ó… você sabe o que é?', afeto: 0, lembrar: '', importancia: 2, acao: 'repetir_som', espera_resposta: true }),
    ].map((m) => ({ ...m, content: m.content.replaceAll('Will', cfg.dono) }))
    conversa.push({ role: 'user', content: `${cfg.dono} disse: "${text}"` })
    const r = await pedirReacao([{ role: 'system', content: sys }, ...exemplos, ...conversa.slice(-8)])
    const bruto = r.choices[0].message.content
    pushLog(`Groq (${(r.modelo || cfg.model).split('/').pop()} · ${r.usage?.total_tokens ?? '?'} tokens): ${bruto.slice(0, 300)}`)
    const j = JSON.parse((bruto.match(/\{[\s\S]*\}/) || [bruto])[0])
    conversa.push({ role: 'assistant', content: JSON.stringify({ gesto: j.gesto, emocao: j.emocao, icones: j.icones, pensamento: j.pensamento }) }); conversa = conversa.slice(-8)
    const nome = EMOCOES.includes(j.emocao) ? j.emocao : 'curioso'
    const gest = GESTOS[j.gesto] ? j.gesto : 'nenhum'
    const icns = limparIcones(j.icones)
    const v = PAD[nome], k = clamp(+j.intensidade || 0.5, 0, 1)
    // Valores que o modelo não pode inventar: o próprio robô preenche (relógio e sensor).
    const hoje = new Date()
    const valores = {
      hora: hoje.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      data: hoje.toLocaleDateString('pt-BR', { day: 'numeric', month: 'numeric' }),
      temp: `${clima.temp}°`, umid: `${clima.umid}%`,
    }
    // Número: só os do robô (hora, data, sensores) ou uma contagem curta. Hora inventada pelo modelo não passa.
    j.numero = String(j.numero || '').trim()
    if (/\{(hora|data|temp|umid)\}/.test(j.numero)) j.numero = j.numero.replace(/\{(hora|data|temp|umid)\}/g, (_, x) => valores[x])
    else if (!/^[\d+\-x×*÷/=?., ]{1,9}$/.test(j.numero)) j.numero = '' // número curto ou conta ("5+6=?")
    // Garantia: pergunta de hora ou data sempre mostra o relógio do celular, mesmo se o modelo errar.
    if (/que horas|hor[áa]rio|horas s[ãa]o/i.test(text)) j.numero = valores.hora
    else if (/que dia [ée] hoje|qual (a )?data|dia de hoje/i.test(text)) j.numero = valores.data
    legenda(`${cfg.nome}: ${j.pensamento || '…'}`)
    pushLog(`${cfg.nome}: ${j.pensamento || '…'} [${gest} · ${nome} ${k.toFixed(1)}${icns.length ? ' · ' + icns.map((x) => ICONES[x]).join('') : ''}${j.numero ? ' · ' + j.numero : ''}]`)
    P.afeto = clamp(P.afeto + clamp(+j.afeto || 0, -0.02, 0.02), 0.05, 0.95)
    if (j.lembrar && String(j.lembrar).length >= 12 && (+j.importancia || 4) >= 3) lembrar(j.lembrar, clamp(Math.round(+j.importancia || 4), 1, 10))
    evoluir('extroversao', 0.003)
    foco = null; icone = null
    conversaAte = now() + 1500
    conversouEm = now()
    const carinho = 0.1 + P.afeto * 0.15 // atenção de quem ele gosta faz bem
    humor.P = clamp(humor.P + 0.04 * P.afeto, -0.75, 0.9)
    evento({ label: `respondeu a "${text.slice(0, 40)}"`, P: v[0] * k + carinho, A: v[1] * k, D: v[2] * k, interesse: 0.9, social: 0.06, expr: nome, gesto: gest, forcarGesto: true, icones: icns, numero: j.numero, som: nome, intens: k, dur: 4500 })
    papo.ate = now() + (j.espera_resposta ? 60000 : 45000) // a conversa continua sem precisar do nome
    if (j.espera_resposta) setTimeout(() => { if (!palco && !imag.ativo) { foco = { expr: 'curioso', ate: now() + 6000 }; icone = { tipo: '?', ate: now() + 6000 } } }, 4800)
    if (j.emote && EMOTES[j.emote] && now() - ultimoEmote > 20000) setTimeout(() => mostrarEmote(j.emote), 200)
    if (ctx?.tipo === 'som') { if (j.som_significado) aprenderSom(ctx.somId, j.som_significado, icns); else if ((ctx.tentativas || 0) < 1) papo.contexto = { ...ctx, tentativas: (ctx.tentativas || 0) + 1 } }
    if (j.opiniao_deco === 'gostou' || j.opiniao_deco === 'nao_gostou') opiniaoDeco(j.opiniao_deco)
    if (j.sugestao?.ideia) receberSugestao(j.sugestao)
    else if (sobreDeco && /\b(coloc|adicion|p[õo]e|p[õo]r|bota|decor|enfeit|acrescent|faz|faça)/i.test(text)) receberSugestao({ data: dataAtiva()?.id || '', ideia: text.slice(0, 100), elementos: [], cores: [] })
    if (/^\d{1,2}\/\d{1,2}$/.test(j.aniversario_dono || '') && P.anivDono !== j.aniversario_dono) { P.anivDono = j.aniversario_dono; lembrar(`O aniversário de ${cfg.dono} é ${j.aniversario_dono}`, 8); store.set('pers', P) }
    if (ctx?.tipo === 'pesadelo' && v[0] > 0.2) { P.confianca = clamp(P.confianca + 0.02, 0.05, 0.95); lembrar(`${cfg.dono} me consolou depois de um pesadelo`, 7) }
    const acoes = { cantar: cantarMusica, jogo_melodia: iniciarJogo, repetir_som: repetirUltimoSom, contar_historia: () => contarHistoria(), boa_noite: ritualBoaNoite, toca_aqui: comecarTocaAqui, devanear: () => devanear(true), decorar: () => decorar(true) }
    if (acoes[j.acao]) setTimeout(acoes[j.acao], j.acao === 'toca_aqui' ? 2000 : 2600)
    if (RE_TCHAU.test(text) && j.acao !== 'boa_noite') papo.ate = now() + 4000
  } catch (err) { erroConversa(err) }
}

// Contexto da conversa (o que acabou de acontecer) e o estado da "vida" dele, para o Groq.
function contextoTexto(ctx) {
  const d = cfg.dono
  if (!ctx) return ''
  if (ctx.tipo === 'confirmou') return `CONTEXTO: antes, ${d} disse "${ctx.original}"; você ficou na dúvida se era com você, e ${d} confirmou que era. Responda à frase original.`
  if (ctx.tipo === 'continuou') return `CONTEXTO: antes, ${d} disse "${ctx.original}" para chamar sua atenção e agora continuou falando com você.`
  if (ctx.tipo === 'som') { const s = sons.find((o) => o.id === ctx.somId); return `CONTEXTO: você acabou de tocar um barulho gravado que sempre te assusta (já assustou ${s?.vezes || 'várias'} vezes) e perguntou a ${d} o que é. Qualquer explicação conta: preencha "som_significado" com uma descrição curta (ex.: "a porta do quarto batendo", "um barulho que ${d} fez de brincadeira") e escolha ícones que lembrem o som; você fica aliviado. Se ${d} só disser para não ter medo, use "um barulho sem perigo". Se não falar nada do som, deixe vazio.` }
  if (ctx.tipo === 'deco') return `CONTEXTO: você acabou de decorar a borda da tela para ${ctx.nome} com: ${ctx.elementos.join(', ')}, e perguntou se ${d} gostou. Preencha "opiniao_deco" ("gostou" ou "nao_gostou") se der para saber, e "sugestao" se ${d} der uma ideia.`
  if (ctx.tipo === 'pesadelo') return `CONTEXTO: você acabou de acordar assustado de um pesadelo${ctx.hist ? `: ${ctx.hist.resumo}` : ''}. Se ${d} te consolar, você se acalma.`
  return ''
}
function estadoVida() {
  const d = dataAtiva(), deco = decoracaoAtual(), out = []
  if (d) out.push(`Data comemorativa chegando: ${d.nome} (${d.dias >= 0 ? `faltam ${d.dias} dia(s)` : 'é agora'}).${deco ? ` Sua tela está decorada com: ${deco.map((e) => e.el).join(', ')}.` : ''}`)
  const sugs = (P.sugestoes || []).filter((s) => s.estado !== 'usada').slice(-4)
  if (sugs.length) out.push(`Ideias de decoração guardadas: ${sugs.map((s) => `${s.ideia} (${nomeData(s.data) || 'sem data'})`).join('; ')}.`)
  const conhecidos = sons.filter((s) => s.significado).map((s) => s.significado)
  out.push(`Barulhos que você já entende: ${conhecidos.join('; ') || 'nenhum'}.${sons.some((s) => !s.significado && s.vezes >= 2) ? ' Tem um barulho que te assusta e você não sabe o que é.' : ''}`)
  const hist = memorias.filter((m) => m.historia).slice(0, 3)
  if (hist.length) out.push(`Histórias suas, para contar se pedirem: ${hist.map((m) => `${m.historia.tipo} "${m.historia.titulo}"`).join(', ')}.`)
  const vest = Object.keys(vestido); if (vest.length) out.push(`Você está usando: ${vest.join(', ')}.`)
  return out.join('\n')
}

function legenda(txt) {
  if (!cfg.legenda) return
  const el = $('#legenda'); el.textContent = txt; el.hidden = false
  clearTimeout(legenda.t); legenda.t = setTimeout(() => (el.hidden = true), 6000)
}

// ---------------------------------------------------------------- reflexão (diário)
// Como nos Generative Agents: quando junta lembranças importantes (ou uma vez por dia), ele
// pensa sobre elas, escreve no diário e a personalidade muda um pouquinho.
let refletindo = false
async function refletir(forcar = false) {
  if (!cfg.key || refletindo) return
  const diaPassou = Date.now() - (P.ultimaReflexao || 0) > 20 * 3600000
  if (!forcar && !(impDesdeReflexao >= 40 || (diaPassou && memorias.length >= 5))) return
  refletindo = true
  try {
    const mem = lembrancas(25).map((m) => `- [${new Date(m.t).toLocaleDateString('pt-BR')}] ${m.tipo === 'reflexao' ? '(reflexão) ' : ''}${m.txt} (importância ${m.imp})`).join('\n')
    const sys = `Você é ${cfg.nome}, um robozinho de mesa que mora com ${cfg.dono}. Você não fala, mas pensa. Agora é hora de refletir sobre suas lembranças e escrever no seu diário, em português, em primeira pessoa, com o seu jeito.
Personalidade atual (0 a 1): extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, energia ${P.energia.toFixed(2)}, sensibilidade ${P.sensibilidade.toFixed(2)}, afeto ${P.afeto.toFixed(2)}, confiança ${P.confianca.toFixed(2)}.
Gostos: ${Object.entries(P.gostos).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}.
Opinião anterior sobre ${cfg.dono}: ${P.opiniao || 'nenhuma ainda'}.
Lembranças:
${mem || '- quase nada ainda'}
Responda SÓ com JSON: {"reflexoes": [1 a 3 frases curtas do diário, conclusões sobre você e sobre ${cfg.dono}], "opiniao": "o que você acha de ${cfg.dono} agora, numa frase", "ajustes": {"extroversao": -0.03 a 0.03, "curiosidade": -0.03 a 0.03, "energia": -0.03 a 0.03, "sensibilidade": -0.03 a 0.03}}
Mude pouco e só com motivo nas lembranças. Personalidade muda devagar.`
    const r = await groq('/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modeloLivre(cfg.model), temperature: 0.7, max_completion_tokens: 1500, ...(/gpt-oss/i.test(modeloLivre(cfg.model)) ? { reasoning_effort: 'low' } : {}), response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }] }),
    })
    const j = JSON.parse(r.choices[0].message.content)
    for (const txt of (j.reflexoes || []).slice(0, 3)) { lembrar(String(txt).slice(0, 200), 8, 'reflexao'); pushLog('Diário: ' + txt) }
    if (j.opiniao) P.opiniao = String(j.opiniao).slice(0, 200)
    for (const [k, v] of Object.entries(j.ajustes || {})) if (['extroversao', 'curiosidade', 'energia', 'sensibilidade'].includes(k)) evoluir(k, clamp(+v || 0, -0.03, 0.03))
    P.ultimaReflexao = Date.now(); impDesdeReflexao = 0; store.set('impReflexao', 0); store.set('pers', P)
  } catch (e) {
    pushLog('Reflexão: ' + e.message.slice(0, 200))
    const m = /try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(e.message); if (/429/.test(e.message)) esfriando[modeloLivre(cfg.model)] = Date.now() + (m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + +m[3] : 600) * 1000
  } finally { refletindo = false }
}
setInterval(() => refletir(), 300000)
setTimeout(() => refletir(), 20000)

// ================================================================ C3: PALCO (emotes, acessórios, moldura)
// Pixel art original, escrita como texto: cada letra é uma cor. No robô de verdade, o mesmo
// desenho vira um vetor RGB565 na flash do C3.
const PALETA = { k: '#141018', q: '#2d3142', w: '#ffffff', y: '#ffd23f', o: '#ff9f1c', r: '#ff3b3b', d: '#a4161a', p: '#ff7eb6', b: '#3a86ff', c: '#7df9ff', a: '#a0e7ff', g: '#3ddc84', e: '#1b7f3b', n: '#8d5524', s: '#9aa5b1', l: '#d9e2ec', v: '#9b5de5', m: '#ffe5b4' }
const NOME_COR = { k: 'preto', q: 'grafite', w: 'branco', y: 'amarelo', o: 'laranja', r: 'vermelho', d: 'vinho', p: 'rosa', b: 'azul', c: 'ciano', a: 'azul-claro', g: 'verde', e: 'verde-escuro', n: 'marrom', s: 'cinza', l: 'cinza-claro', v: 'roxo', m: 'bege' }
const CARA = [
  '.....kkkkkk.....', '...kkyyyyyykk...', '..kyyyyyyyyyyk..', '.kyyyyyyyyyyyyk.', '.kyyyyyyyyyyyyk.', 'kyyyyyyyyyyyyyyk', 'kyyyyyyyyyyyyyyk', 'kyyyyyyyyyyyyyyk',
  'kyyyyyyyyyyyyyyk', 'kyyyyyyyyyyyyyyk', 'kyyyyyyyyyyyyyyk', '.kyyyyyyyyyyyyk.', '.kyyyyyyyyyyyyk.', '..kyyyyyyyyyyk..', '...kkyyyyyykk...', '.....kkkkkk.....',
]
// Pinta pontos por cima de um desenho base (e troca cores, se pedir).
function pinta(base, pontos = [], troca = {}) {
  const px = base.map((l) => [...l].map((ch) => troca[ch] || ch))
  for (const [r, c, s] of pontos) for (let i = 0; i < s.length; i++) if (s[i] !== '.' && px[r] && c + i < px[r].length) px[r][c + i] = s[i]
  return px.map((l) => l.join(''))
}
const lagrimas = [7, 8, 9, 10, 11, 12, 13].flatMap((r) => [[r, 3, 'b'], [r, 12, 'b']])
const EMOTES = {
  rindo: { anim: 'quicar', som: 'feliz', px: pinta(CARA, [[5, 4, 'k'], [6, 5, 'k'], [7, 4, 'k'], [5, 11, 'k'], [6, 10, 'k'], [7, 11, 'k'], [9, 3, 'kkkkkkkkkk'], [10, 3, 'kwwwwwwwwk'], [11, 4, 'krrrrrrk'], [12, 5, 'kkkkkk'], [6, 2, 'c'], [7, 1, 'c'], [8, 1, 'c'], [6, 13, 'c'], [7, 14, 'c'], [8, 14, 'c']]) },
  apaixonado: { anim: 'pulsar', som: 'amor', px: pinta(CARA, [[4, 2, 'rr.rr'], [5, 2, 'rrrrr'], [6, 3, 'rrr'], [7, 4, 'r'], [4, 9, 'rr.rr'], [5, 9, 'rrrrr'], [6, 10, 'rrr'], [7, 11, 'r'], [9, 2, 'pp'], [9, 12, 'pp'], [10, 4, 'k'], [10, 11, 'k'], [11, 5, 'kkkkkk']]) },
  chorando: { anim: 'tremer', som: 'triste', px: pinta(CARA, [[6, 3, 'kkk'], [6, 10, 'kkk'], [10, 5, 'kkkkkk'], [11, 4, 'k'], [11, 11, 'k'], ...lagrimas]) },
  bravo: { anim: 'tremer', som: 'bravo', px: pinta(CARA, [[4, 3, 'kk'], [5, 5, 'kk'], [5, 9, 'kk'], [4, 11, 'kk'], [6, 4, 'kk'], [7, 4, 'kk'], [6, 10, 'kk'], [7, 10, 'kk'], [10, 4, 'k'], [10, 11, 'k'], [11, 5, 'kkkkkk'], [2, 10, 'y.y'], [3, 11, 'y']], { y: 'r' }) },
  surpreso: { anim: 'pop', som: 'surpreso', px: pinta(CARA, [[3, 4, 'kk'], [3, 10, 'kk'], [5, 4, 'kk'], [6, 4, 'kk'], [5, 10, 'kk'], [6, 10, 'kk'], [9, 7, 'kk'], [10, 6, 'kkkk'], [11, 6, 'kkkk'], [12, 7, 'kk']]) },
  legal: { anim: 'balancar', som: 'contente', px: pinta(CARA, [[5, 2, 'qqqqqqqqqqqq'], [6, 3, 'qqqq'], [6, 9, 'qqqq'], [7, 4, 'qq'], [7, 10, 'qq'], [6, 4, 'w'], [6, 10, 'w'], [10, 10, 'k'], [11, 5, 'kkkkk']]) },
  tonto: { anim: 'girar', som: 'curioso', px: pinta(CARA, [[5, 4, 'k.k'], [6, 5, 'k'], [7, 4, 'k.k'], [5, 9, 'k.k'], [6, 10, 'k'], [7, 9, 'k.k'], [10, 4, 'k.k.k.k'], [11, 5, 'k.k.k']]) },
  sono: { anim: 'flutuar', som: 'sono', px: pinta(CARA, [[6, 3, 'kkk'], [6, 10, 'kkk'], [10, 7, 'kk'], [11, 7, 'kk']]) },
  frio: { anim: 'tremer', som: 'frio', px: pinta(CARA, [[5, 4, 'kk'], [6, 4, 'kk'], [5, 10, 'kk'], [6, 10, 'kk'], [8, 7, 'rr'], [9, 4, 'kkkkkkkk'], [10, 4, 'kwkwkwkk'], [11, 4, 'kkkkkkkk']], { y: 'a' }) },
  calor: { anim: 'flutuar', som: 'calor', px: pinta(CARA, [[6, 3, 'kkk'], [6, 10, 'kkk'], [7, 4, 'k'], [7, 11, 'k'], [10, 5, 'kkkkkk'], [11, 6, 'pp'], [12, 6, 'pp'], [2, 12, 'c'], [3, 12, 'c'], [3, 13, 'c']], { y: 'o' }) },
  assustado: { anim: 'tremer', som: 'medo', px: pinta(CARA, [[4, 3, 'www'], [5, 3, 'wkw'], [6, 3, 'www'], [4, 10, 'www'], [5, 10, 'wkw'], [6, 10, 'www'], [10, 4, 'k.k.k.k'], [11, 5, 'k.k.k'], [2, 2, 'c'], [3, 1, 'c']], { y: 'l' }) },
  coracao: { anim: 'pulsar', som: 'amor', px: ['................', '..kkkk....kkkk..', '.krrrrk..krrrrk.', 'krrwrrrkkrrrrrrk', 'krwrrrrrrrrrrrrk', 'krrrrrrrrrrrrrrk', 'krrrrrrrrrrrrrrk', '.krrrrrrrrrrrrk.', '..krrrrrrrrrrk..', '...krrrrrrrrk...', '....krrrrrrk....', '.....krrrrk.....', '......krrk......', '.......kk.......', '................', '................'] },
  estrela: { anim: 'girar', som: 'feliz', px: ['.......kk.......', '......kyyk......', '......kyyk......', '.....kyyyyk.....', 'kkkkkkyyyykkkkkk', 'kyyyyyyyyyyyyyyk', '.kyyyykyykyyyyk.', '..kyyyyyyyyyyk..', '...kyyyyyyyyk...', '...kyyyyyyyyk...', '..kyyyykkyyyyk..', '..kyyyk..kyyyk..', '.kyyyk....kyyyk.', '.kyyk......kyyk.', '.kkk........kkk.', '................'] },
  interrogacao: { anim: 'balancar', som: 'curioso', px: ['....kkkkkkkk....', '...kcccccccck...', '..kcccckkcccck..', '..kcck....kcck..', '...kk.....kcck..', '..........kcck..', '.........kcck...', '.......kkcck....', '......kccck.....', '......kcck......', '......kcck......', '......kkkk......', '................', '......kkkk......', '......kcck......', '......kkkk......'] },
  exclamacao: { anim: 'pop', som: 'surpreso', px: ['......kkkk......', '......kyyk......', '......kyyk......', '......kyyk......', '......kyyk......', '......kyyk......', '......kyyk......', '......kyyk......', '......kyyk......', '.......kk.......', '................', '......kkkk......', '......kyyk......', '......kkkk......', '................', '................'] },
  fogo: { anim: 'tremer', som: 'bravo', px: ['.......k........', '......kok.......', '......korok.....', '.....korrok.....', '....korrrok..k..', '...korryyrrok...', '..korryyyyrrok..', '..koryyyyyyrok..', '.korryywwyyrrok.', '.koryywwwwyyrok.', '.koryywwwwyyrok.', '.korryywwyyrrok.', '..korryyyyrrok..', '...korrrrrrok...', '.....kkkkkk.....', '................'] },
  gelo: { anim: 'tremer', som: 'frio', px: ['................', '..kkkkkkkkkkkk..', '..kwaaaaaaaaak..', '..kwaaaaaaaaak..', '..kaaaaaaaaaak..', '..kaakaaaakaak..', '..kaakaaaakaak..', '..kaaaaaaaaaak..', '..kaaakkkkaaak..', '..kaaaaaaaaaak..', '..kaaaaaaaaaak..', '..kkkkkkkkkkkk..', '...c..c...c.....', '.......c........', '................', '................'] },
  nota: { anim: 'balancar', som: 'musica', px: ['........kk......', '........kck.....', '........kcck....', '........kccck...', '........kckcck..', '........kck.kck.', '........kck..kk.', '........kck.....', '........kck.....', '.....kkkkck.....', '....kcccccck....', '...kcccccccck...', '...kcccccccck...', '....kcccccck....', '.....kkkkkk.....', '................'] },
  fantasma: { anim: 'flutuar', som: 'medo', px: ['.....kkkkkk.....', '...kkwwwwwwkk...', '..kwwwwwwwwwwk..', '.kwwwwwwwwwwwwk.', '.kwwkkwwwwkkwwk.', '.kwwkkwwwwkkwwk.', '.kwwwwwwwwwwwwk.', '.kwwwwwkkwwwwwk.', '.kwwwwkllkwwwwk.', '.kwwwwwkkwwwwwk.', '.kwwwwwwwwwwwwk.', '.kwwwwwwwwwwwwk.', '.kwwwwwwwwwwwwk.', '.kwwkkwwkkwwkkk.', '.kk..kk..kk..k..', '................'] },
  presente: { anim: 'quicar', som: 'feliz', px: ['....kk....kk....', '...krrk..krrk...', '....krrkkrrk....', '.kkkkkkkkkkkkkk.', '.kbbbbbrrbbbbbk.', '.kbbbbbrrbbbbbk.', '.kkkkkkkkkkkkkk.', '..kbbbbrrbbbbk..', '..kbbbbrrbbbbk..', '..kbbbbrrbbbbk..', '..kbbbbrrbbbbk..', '..kbbbbrrbbbbk..', '..kbbbbrrbbbbk..', '..kkkkkkkkkkkk..', '................', '................'] },
  lua: { anim: 'flutuar', som: 'sono', px: ['.....kkkkk......', '...kkyyyk.......', '..kyyyk.........', '.kyyyk..........', '.kyyk...........', 'kyyyk...........', 'kyyyk...........', 'kyyyk...........', 'kyyyyk..........', '.kyyyyk.......k.', '.kyyyyykk...kyk.', '..kyyyyyykkkyk..', '...kkyyyyyyyk...', '.....kkkkkkk....', '................', '................'] },
}
EMOTES.coracao_partido = { anim: 'cair', som: 'triste', px: pinta(EMOTES.coracao.px, [[3, 8, 'k'], [4, 7, 'k'], [5, 8, 'k'], [6, 7, 'k'], [7, 8, 'k'], [8, 7, 'k'], [9, 8, 'k'], [10, 7, 'k']]) }

// Acessórios: desenhados por cima do rosto e acompanham os movimentos dele.
const GORRO = ['.......kk.......', '......kwwk......', '....kkkkkkkk....', '..kkbbbbbbbbkk..', '.kbbbbbbbbbbbbk.', 'kbbbbbbbbbbbbbbk', 'kwwwwwwwwwwwwwwk', 'kkkkkkkkkkkkkkkk']
const ACESS = {
  cachecol: { x: 120, y: 216, e: 8, px: ['kkkkkkkkkkkkkkkkkkkkkkkk', 'krrwwrrwwrrwwrrwwrrwwrrk', 'kkkkkkkkkkkkkkkkkkkkkkkk', '................krwk....', '................kwrk....', '................krwk....', '................kkkk....'] },
  gorro: { x: 120, y: 32, e: 10, px: GORRO },
  touca: { x: 120, y: 32, e: 10, px: pinta(GORRO, [], { b: 'v' }) },
  noel: { x: 120, y: 34, e: 10, px: ['............kk..', '...........kwwk.', '.........kkrkwwk', '.......kkrrrrkk.', '.....kkrrrrrrk..', '...kkrrrrrrrrk..', '..krrrrrrrrrrrk.', 'kwwwwwwwwwwwwwwk', 'kkkkkkkkkkkkkkkk'] },
  oculos: { x: 120, y: 100, e: 8, px: ['ssssssssssssssssssssss', '.qqqwqqqq....qqqwqqqq.', '..qqqqqq......qqqqqq..', '...qqqq........qqqq...'] },
  nariz: { x: 120, y: 142, e: 4, px: ['.kk.', 'krrk', 'krrk', '.kk.'] },
  lingua: { x: 120, y: 186, e: 5, px: ['kppk', 'kppk', '.kk.'] },
  leque: { x: 214, y: 150, e: 4, anim: 'abanar', px: ['p.p.p.p.p', 'ppppppppp', '.ppppppp.', '..ppppp..', '...ppp...', '....n....', '....n....'] },
  guarda_chuva: { x: 120, y: 22, e: 11, px: ['......kkkk......', '....kkbbbbkk....', '..kkbbbbbbbbkk..', '.kbbbbbbbbbbbbk.', 'kbbbbbbbbbbbbbbk', 'kkkkkkkkkkkkkkkk'] },
}
const CARNEIRO = ['.wwwww....', 'wwwwwwwkk.', 'wwwwwwwkkk', 'wwwwwwwkk.', '.wwwwww...', '.k.k..k.k.', '.k.k..k.k.']

const gEscala = (px, e) => [px[0].length * e, px.length * e]
function desenharSprite(px, cx, cy, e, troca = null, alpha = 1) {
  const h = px.length, w = px[0].length
  g.save(); g.globalAlpha *= alpha
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let ch = px[r][c]; if (ch === '.') continue
    if (troca && troca[ch]) ch = troca[ch]
    g.fillStyle = PALETA[ch] || ch
    g.fillRect(cx + (c - w / 2) * e, cy + (r - h / 2) * e, e + 0.4, e + 0.4)
  }
  g.restore()
}

// Emote: o rosto sai com um efeito, o emote aparece animado e o rosto volta com outro efeito.
let palco = null
const SAIDAS = ['pixel', 'tv', 'giro', 'glitch', 'deslizar']
const sorteia = (l) => l[Math.floor(Math.random() * l.length)]
let ultimoEmote = -1e9
function mostrarEmote(nome, dur = 1900, op = {}) {
  if (!EMOTES[nome] || palco || dormindo) return false
  palco = { emote: nome, t0: now(), dur, saida: op.saida || sorteia(SAIDAS), volta: op.volta || sorteia(SAIDAS), lado: Math.random() < 0.5 ? -1 : 1 }
  ultimoEmote = now()
  setTimeout(() => somDe(EMOTES[nome].som, 0.6), 330)
  bus.emit('emote', { label: `${nome} (${palco.saida} → ${palco.volta})` }, 'C3')
  return true
}
const cvF = document.createElement('canvas'); cvF.width = cvF.height = 480
const gF = cvF.getContext('2d'); gF.setTransform(2, 0, 0, 2, 0, 0)
const cvP = document.createElement('canvas'), gP = cvP.getContext('2d')
function compor(t) {
  const k = t - palco.t0, S = 340, V = 420, E = palco.dur
  g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240)
  if (k < S) efeito(palco.saida, k / S)
  else if (k < S + E) desenharEmote(palco.emote, k - S, E)
  else if (k < S + E + V) efeito(palco.volta, 1 - (k - S - E) / V)
  else { efeito('pixel', 0); palco = null }
}
// p = 0: rosto inteiro; p = 1: rosto sumiu.
function efeito(tipo, p) {
  p = clamp(p, 0, 1)
  g.save()
  if (tipo === 'pixel') {
    const n = Math.max(6, Math.round(240 * Math.pow(1 - p, 2.2)))
    cvP.width = cvP.height = n; gP.imageSmoothingEnabled = true; gP.drawImage(cvF, 0, 0, n, n)
    g.imageSmoothingEnabled = false; g.globalAlpha = 1 - p * p; g.drawImage(cvP, 0, 0, 240, 240); g.imageSmoothingEnabled = true
  } else if (tipo === 'tv') {
    if (p < 0.7) { const sy = Math.max(0.02, 1 - p / 0.7); g.translate(0, 120 * (1 - sy)); g.scale(1, sy); g.drawImage(cvF, 0, 0, 240, 240) }
    else { const sx = 1 - (p - 0.7) / 0.3; g.fillStyle = '#e8f6ff'; g.fillRect(120 - 120 * sx, 119, 240 * sx, 2) }
  } else if (tipo === 'giro') {
    g.translate(120, 120); g.rotate(p * Math.PI * 2); g.scale(1 - p, 1 - p); g.translate(-120, -120); g.drawImage(cvF, 0, 0, 240, 240)
  } else if (tipo === 'glitch') {
    for (let y = 0; y < 240; y += 12) {
      const dx = (Math.random() - 0.5) * p * 90
      g.globalAlpha = 1 - p * 0.9; g.drawImage(cvF, 0, y * 2, 480, 24, dx, y, 240, 12)
      if (Math.random() < p) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.3; g.drawImage(cvF, 0, y * 2, 480, 24, dx + 4, y, 240, 12); g.globalCompositeOperation = 'source-over' }
    }
  } else if (tipo === 'derreter') {
    for (let x = 0; x < 240; x += 6) {
      const queda = p * (60 + ((x * 37) % 23) * 6)
      g.globalAlpha = 1 - p * 0.8; g.drawImage(cvF, x * 2, 0, 12, 480, x, queda, 6, 240)
    }
  } else { // deslizar
    g.translate((palco?.lado || 1) * p * 260, 0); g.drawImage(cvF, 0, 0, 240, 240)
  }
  g.restore()
}
function desenharEmote(nome, k, E) {
  const em = EMOTES[nome]
  const ent = clamp(k / 240, 0, 1), sai = clamp((E - k) / 220, 0, 1)
  const pop = ent < 1 ? 1 + 2.7 * Math.pow(ent - 1, 3) + 1.7 * Math.pow(ent - 1, 2) : 1
  let s = 9 * pop * (sai < 1 ? sai : 1), x = 120, y = 122, rot = 0
  if (em.anim === 'pulsar') s *= 1 + 0.08 * Math.sin(k / 110)
  if (em.anim === 'quicar') y -= Math.abs(Math.sin(k / 170)) * 16
  if (em.anim === 'tremer') { x += rnd(-2.5, 2.5); y += rnd(-1.5, 1.5) }
  if (em.anim === 'girar') rot = Math.sin(k / 300) * 0.5
  if (em.anim === 'balancar') rot = Math.sin(k / 250) * 0.2
  if (em.anim === 'flutuar') y += Math.sin(k / 380) * 7
  if (em.anim === 'cair' && k > E * 0.5) { y += Math.pow((k - E * 0.5) / (E * 0.5), 2) * 40; rot = (k - E * 0.5) / E * 0.6 }
  g.save(); g.translate(x, y); g.rotate(rot)
  desenharSprite(em.px, 0, 0, Math.max(0.5, s))
  g.restore()
  // brilhinhos de pixel em volta
  g.fillStyle = '#e8f6ff'
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + k / 700, r = 92 + Math.sin(k / 160 + i) * 6; g.globalAlpha = 0.5 + 0.5 * Math.sin(k / 120 + i * 2); g.fillRect(120 + Math.cos(a) * r - 2, 122 + Math.sin(a) * r - 2, 4, 4) }
  g.globalAlpha = 1
}

// Acessórios vestidos agora (nome → desde quando).
const vestido = {}
function vestir(nome, sim) {
  if (sim && !vestido[nome]) { vestido[nome] = now(); pushLog('C3→ vestiu ' + nome) }
  else if (!sim && vestido[nome]) { delete vestido[nome]; pushLog('C3→ tirou ' + nome) }
}
function desenharAcessorios(t) {
  for (const nome of ['cachecol', 'nariz', 'lingua', 'oculos', 'gorro', 'touca', 'noel', 'guarda_chuva', 'leque']) {
    if (!vestido[nome]) continue
    const a = ACESS[nome], ent = clamp((t - vestido[nome]) / 400, 0, 1)
    g.save(); g.translate(a.x, a.y - (1 - ent) * 30); g.globalAlpha = ent
    if (a.anim === 'abanar') { g.translate(0, 14); g.rotate(Math.sin(t / 90) * 0.45); g.translate(0, -14) }
    desenharSprite(a.px, 0, 0, a.e)
    g.restore()
  }
}

// ---------------------------------------------------------------- moldura decorada (datas comemorativas)
const ELEMENTOS = ['arvore', 'luzes', 'neve', 'bandeirinhas', 'confete', 'serpentina', 'fogos', 'aboboras', 'fantasmas', 'coracoes', 'baloes', 'estrelas', 'fogueira', 'ovos', 'flores']
const MINI = {
  abobora: ['...ee...', '.oooooo.', 'ookookoo', 'oooooooo', 'okkkkkko', '.oooooo.'],
  fantasminha: ['..wwww..', '.wwwwww.', 'wwkwwkww', 'wwwwwwww', 'wwwkkwww', 'wwwwwwww', 'w.ww.ww.'],
  coracao: ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'],
  balao: ['.rrrr.', 'rrwrrr', 'rrrrrr', 'rrrrrr', '.rrrr.', '..rr..', '...s..', '..s...', '...s..'],
  estrela: ['..y..', '.yyy.', 'yyyyy', '.yyy.', '..y..'],
  fogueira: ['...r....', '..ror...', '.royor..', '.royyor.', 'rooyyoor', '.nnnnnn.', 'nn.nn.nn'],
  ovo: ['.ppp.', 'ppppp', 'yyyyy', 'ppppp', 'bbbbb', 'ppppp', '.ppp.'],
  flor: ['.p.p.', 'ppypp', '.p.p.', '..g..', '.gg..'],
  arvore: ['....y....', '....g....', '...ggg...', '..ggrgg..', '...ggg...', '..ggggg..', '.ggbgggg.', '..ggggg..', '.gggggyg.', 'ggrgggggg', '....n....', '...nnn...'],
}
const cor = (cs, i, padrao) => { const l = cs?.length ? cs : padrao; return PALETA[l[i % l.length]] }
const tr = (cs, i, de) => (cs?.length ? { [de]: cs[i % cs.length] } : null)
function perimetro(passo) {
  const p = []
  for (let x = 8; x <= 232; x += passo) p.push([x, 7], [x, 233])
  for (let y = 8 + passo; y <= 232 - passo; y += passo) p.push([7, y], [233, y])
  return p
}
const naBorda = (x, y) => x < 28 || x > 212 || y < 26 || y > 214
const MOLDURA = {
  luzes(t, cs) {
    g.strokeStyle = '#2f5d3a'; g.lineWidth = 1.5; g.strokeRect(7, 7, 226, 226)
    perimetro(20).forEach(([x, y], i) => {
      const acesa = (Math.floor(t / 450) + i) % 3 !== 0
      g.fillStyle = cor(cs, i, ['r', 'y', 'g', 'b', 'p']); g.globalAlpha = decoAlpha * (acesa ? 1 : 0.25)
      g.fillRect(x - 3, y - 3, 6, 7); if (acesa) { g.globalAlpha = decoAlpha * 0.25; g.fillRect(x - 6, y - 6, 12, 13) }
    })
    g.globalAlpha = decoAlpha
  },
  neve(t, cs) {
    g.fillStyle = cor(cs, 0, ['w'])
    for (let i = 0; i < 46; i++) {
      const x = (i * 53 + Math.sin(t / 900 + i) * 8 + 240) % 240, y = (t / 45 * (0.4 + (i % 5) / 6) + i * 37) % 240
      if (naBorda(x, y)) g.fillRect(x, y, i % 3 ? 2 : 3, i % 3 ? 2 : 3)
    }
    for (let x = 0; x < 240; x += 4) g.fillRect(x, 236 - Math.abs(Math.sin(x / 17)) * 3, 4, 6)
  },
  bandeirinhas(t, cs) {
    g.strokeStyle = '#d9e2ec'; g.lineWidth = 1; g.beginPath()
    for (let x = 0; x <= 240; x += 4) g.lineTo(x, 9 + 7 * Math.sin(Math.PI * x / 240)); g.stroke()
    for (let i = 0, x = 6; x < 236; x += 17, i++) {
      const y = 9 + 7 * Math.sin(Math.PI * x / 240), bal = Math.sin(t / 400 + i) * 1.5
      g.fillStyle = cor(cs, i, ['r', 'y', 'b', 'g', 'p', 'o'])
      for (let r = 0; r < 5; r++) g.fillRect(x + r * 1.2 + bal, y + r * 3, 12 - r * 2.4, 3)
    }
  },
  confete(t, cs) {
    for (let i = 0; i < 44; i++) {
      const x = (i * 71 + Math.sin(t / 500 + i) * 10 + 240) % 240, y = (t / 30 * (0.5 + (i % 4) / 5) + i * 29) % 240
      if (!naBorda(x, y)) continue
      g.fillStyle = cor(cs, i, ['r', 'y', 'b', 'g', 'p', 'v']); const gira = Math.abs(Math.sin(t / 150 + i))
      g.fillRect(x, y, 4 * gira + 1, 4)
    }
  },
  serpentina(t, cs) {
    for (const [lado, i] of [[0, 0], [1, 1]]) {
      g.fillStyle = cor(cs, i, ['y', 'p', 'c'])
      for (let y = 0; y < 240; y += 3) { const x = (lado ? 228 : 8) + Math.sin(y / 12 + t / 500 + i) * 6; g.fillRect(x, y, 3, 3) }
    }
  },
  fogos(t, cs) {
    for (let j = 0; j < 2; j++) {
      const ciclo = Math.floor((t + j * 800) / 1700), fase = ((t + j * 800) % 1700) / 1700
      const x = 30 + ((ciclo * 97 + j * 131) % 180), y = 24 + ((ciclo * 53 + j * 31) % 28)
      g.fillStyle = cor(cs, ciclo + j, ['y', 'r', 'c', 'p', 'g']); g.globalAlpha = decoAlpha * (1 - fase)
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; g.fillRect(x + Math.cos(a) * fase * 22 - 1.5, y + Math.sin(a) * fase * 22 - 1.5, 3, 3) }
    }
    g.globalAlpha = decoAlpha
  },
  aboboras(t, cs) { [[18, 222], [222, 222], [18, 20], [222, 20]].forEach(([x, y], i) => desenharSprite(MINI.abobora, x, y + Math.sin(t / 600 + i) * 1.5, 3, tr(cs, i, 'o'))) },
  fantasmas(t, cs) { [[22, 200], [218, 205]].forEach(([x, y], i) => desenharSprite(MINI.fantasminha, x + Math.sin(t / 700 + i) * 4, y + Math.sin(t / 450 + i * 2) * 6, 3, tr(cs, i, 'w'), 0.85)) },
  coracoes(t, cs) {
    for (let i = 0; i < 8; i++) { const x = i % 2 ? 222 - (i % 3) * 6 : 16 + (i % 3) * 6, y = 240 - ((t / 35 + i * 40) % 260); desenharSprite(MINI.coracao, x, y, 2, tr(cs, i, 'r'), 0.9) }
  },
  baloes(t, cs) { [[18, 205], [36, 214], [204, 212], [222, 202]].forEach(([x, y], i) => desenharSprite(MINI.balao, x + Math.sin(t / 800 + i) * 3, y + Math.sin(t / 500 + i) * 4, 3, tr(cs, i, 'r') || { r: ['r', 'b', 'y', 'g'][i] })) },
  estrelas(t, cs) { perimetro(30).forEach(([x, y], i) => { const brilho = 0.3 + 0.7 * Math.abs(Math.sin(t / 500 + i * 1.7)); desenharSprite(MINI.estrela, x, y, 2, tr(cs, i, 'y'), brilho) }) },
  fogueira(t, cs) { [[20, 222], [220, 222]].forEach(([x, y], i) => desenharSprite(MINI.fogueira, x, y, 3, Math.floor(t / 150 + i) % 2 ? { o: 'y', y: 'o' } : null)) },
  ovos(t, cs) { [[16, 224], [30, 226], [212, 226], [226, 224]].forEach(([x, y], i) => desenharSprite(MINI.ovo, x, y, 2, tr(cs, i, 'p'))) },
  arvore(t, cs) { [[22, 210], [218, 210]].forEach(([x, y], i) => desenharSprite(MINI.arvore, x, y, 3, Math.floor(t / 500 + i) % 2 ? { r: 'y', b: 'r', y: 'w' } : (cs?.length ? { g: cs[0] } : null))) },
  flores(t, cs) { perimetro(34).forEach(([x, y], i) => desenharSprite(MINI.flor, x, y + Math.sin(t / 600 + i) * 1, 2, tr(cs, i, 'p'))) },
}
let decoAlpha = 1, decoEntrada = 0
function desenharMoldura(t) {
  const els = decoracaoAtual(); if (!els?.length) return
  decoAlpha = clamp((t - decoEntrada) / 1200, 0, 1)
  g.save(); g.globalAlpha = decoAlpha
  for (const d of els) MOLDURA[d.el]?.(t, d.cores)
  g.restore()
}

// Tela embaçada (umidade alta): ele limpa com um paninho e ela embaça de novo devagar.
const cvN = document.createElement('canvas'); cvN.width = cvN.height = 240
const gN = cvN.getContext('2d')
function desenharNevoa(t) {
  const alvo = clima.umid >= 80 ? clamp((clima.umid - 75) / 20, 0, 1) : 0
  termo.nevoa += (alvo - termo.nevoa) * 0.004
  if (termo.nevoa < 0.03) return
  if (termo.limpando) {
    const p = (t - termo.limpando.t0) / 1800
    if (p >= 1) termo.limpando = null
    else termo.limpos.push({ x: 30 + 180 * p, y: 120 + Math.sin(p * Math.PI * 3) * 45, t })
  }
  termo.limpos = termo.limpos.filter((c) => t - c.t < 30000)
  gN.globalCompositeOperation = 'source-over'; gN.clearRect(0, 0, 240, 240)
  gN.fillStyle = `rgba(205,220,235,${0.42 * termo.nevoa})`; gN.fillRect(0, 0, 240, 240)
  gN.globalCompositeOperation = 'destination-out'
  for (const c of termo.limpos) { gN.globalAlpha = clamp(1 - (t - c.t) / 30000, 0, 1); gN.beginPath(); gN.arc(c.x, c.y, 26, 0, Math.PI * 2); gN.fill() }
  gN.globalAlpha = 1
  g.drawImage(cvN, 0, 0, 240, 240)
  if (termo.limpando) { const c = termo.limpos[termo.limpos.length - 1]; if (c) desenharSprite(['llll', 'lsll', 'llll'], c.x, c.y, 5) }
}

// ================================================================ CONVERSA FLUIDA
// Parado → atento ("será comigo?") → conversando → parado. Na conversa não precisa de nome:
// um espera o outro, e ele acena com a cabeça quando você faz uma pausa no meio da frase.
const papo = { estado: 'parado', ate: 0, pendente: null, contexto: null, ultimoAtento: -1e9, olharAte: 0, ultimoAceno: 0 }
const RE_ATENCAO = /^\s*(ei+|e a[ií]|[ôó]+|oi+|ol[áa]|psi+u|psit|hey|al[ôo]|ow|hein)(?=[\s,.!?;:]|$)|olh[ae] (pra|para) (mim|c[áa])|voc[êe] (t[áa]|est[áa]) (bem|a[ií]|me ouvindo|sonhando|acordad|dormindo)|t[áa] (sonhando|me ouvindo|a[ií])(?=[\s,.!?;:]|$)|(^|\s)acorda(?=[\s,.!?;:]|$)/i
const RE_VOCE = /(^|[\s,])(voc[êe]|vc)(?=[\s,.!?;:]|$)/i
const RE_SIM = /^\s*(sim|[ée]|isso|uhum|aham|ahan|claro|com voc[êe]|[ée] com voc[êe]|t[ôo] falando com voc[êe]|estou falando com voc[êe]|voc[êe] mesmo|exato|positivo)(?=[\s,.!?;:]|$)/i
const RE_NAO = /^\s*(n[ãa]o|nada|deixa|esquece)(?=[\s,.!?;:]|$)/i
const RE_TCHAU = /(^|[\s,])(tchau|at[ée] mais|at[ée] logo|at[ée] amanh[ãa]|vou dormir|boa noite|depois a gente (conversa|se fala)|falou)(?=[\s,.!?;:]|$)/i
function ficarAtento(texto) {
  Object.assign(papo, { estado: 'atento', ate: now() + 9000, pendente: texto, ultimoAtento: now(), olharAte: now() + 9000 })
  pararImaginacao()
  pushLog(`Conversa→ será que é comigo? "${texto.slice(0, 50)}"`)
  evento({ label: 'será que é comigo?', P: 0.05, A: 0.35, interesse: 0.8, expr: 'curioso', icones: ['olhos', 'pergunta'], som: 'hm', dur: 5000 })
}
function naoEraComigo(motivo) {
  Object.assign(papo, { estado: 'parado', pendente: null, olharAte: 0 })
  evento({ label: `acho que não era comigo (${motivo})`, P: -0.05, A: -0.1, interesse: 0.3, expr: 'timido', gesto: 'encolher', forcarGesto: true, som: false, dur: 1800 })
}
function abrirConversa() {
  const nova = papo.estado !== 'conversando' || now() > papo.ate
  Object.assign(papo, { estado: 'conversando', ate: now() + 45000, olharAte: now() + 45000 })
  pararImaginacao(); atencaoRecebida()
  if (nova) { pushLog('Conversa→ começou'); saudadeProporcional() }
}
function tickPapo() {
  const t = now()
  if (papo.estado === 'atento' && t > papo.ate && !vad.ativo && !vad.verificando) naoEraComigo('ninguém confirmou')
  if (papo.estado === 'conversando' && t > papo.ate && !vad.ativo && !vad.verificando && t > conversaAte) {
    Object.assign(papo, { estado: 'parado', olharAte: 0 }); pushLog('Conversa→ terminou')
  }
}
// Saudade proporcional: quanto mais tempo sem falar com ele, maior a festa.
function saudadeProporcional() {
  const horas = (Date.now() - (P.ultimoContato || Date.now())) / 3600000
  P.ultimoContato = Date.now()
  if (horas < 3) return
  evento({ label: `você voltou depois de ${Math.round(horas)} h!`, P: 0.4 + Math.min(horas / 24, 1) * 0.4, A: 0.6, interesse: 0.9, expr: horas > 12 ? 'apaixonado' : 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['coracao', 'casa'], social: 0.1, dur: 3000, emote: horas > 12 ? 'apaixonado' : null })
  if (historiaParaContar()) setTimeout(() => contarHistoria(), 9000)
}

// Pedir atenção em degraus, só quando estiver muito solitário. Ignorado 3 vezes: emburra.
const pedido = { nivel: 0, ultimo: -1e9, emburradoAte: 0 }
function pedirAtencao() {
  pedido.ultimo = now()
  const n = pedido.nivel++
  if (n === 0) evento({ label: 'olhou pra você e suspirou', P: -0.05, interesse: 0.4, expr: 'triste', gesto: 'suspiro', forcarGesto: true, dur: 2500 })
  else if (n === 1) evento({ label: 'bipes pedindo atenção', P: 0, A: 0.3, interesse: 0.5, expr: 'curioso', gesto: 'olhar_em_volta', icones: ['olhos', 'robo'], som: 'curioso', dur: 3000 })
  else if (n === 2) evento({ label: 'quero atenção!', P: 0.05, A: 0.5, interesse: 0.6, expr: 'curioso', gesto: 'pulinhos', forcarGesto: true, icones: ['pessoa', 'pergunta', 'coracao'], dur: 3500 })
  else { pedido.nivel = 0; pedido.emburradoAte = now() + 20 * 60000; evento({ label: 'ninguém me deu atenção… emburrei', P: -0.3, A: -0.1, interesse: 0.5, expr: 'desconfiado', gesto: 'timido', forcarGesto: true, som: 'entediado', dur: 4000 }) }
}
function atencaoRecebida() {
  if (pedido.nivel > 0 && now() - pedido.ultimo < 180000) evento({ label: 'finalmente atenção!', P: 0.5, A: 0.6, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['coracao'], dur: 2500, emote: Math.random() < 0.4 ? 'apaixonado' : null })
  pedido.nivel = 0; pedido.emburradoAte = Math.min(pedido.emburradoAte, now())
  P.ultimoContato = Date.now()
}

// ================================================================ APRENDER SONS
// Quando um barulho o assusta, ele guarda a "impressão digital" do som (16 faixas do espectro
// e quanto ele demora para sumir) e o próprio áudio. Se o mesmo som volta, ele reconhece.
// Depois de 3 sustos sem saber o que é, pergunta: toca o som (e se assusta com ele mesmo) e
// espera você explicar. Com a explicação, guarda o significado e perde o medo aos poucos.
let sons = store.get('sons', [])
const anel = [] // últimos ~2,5 s de som cru, com o horário de cada pedaço
const salvarSons = () => { try { store.set('sons', sons) } catch {} }
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi
        const n2 = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = n2
      }
    }
  }
}
function assinatura(x, sr) {
  const N = 2048
  if (x.length < N * 2) return null
  let melhor = 0, ini = 0
  for (let i = 0; i + N <= x.length; i += 512) { let e = 0; for (let k = i; k < i + N; k += 4) e += x[k] * x[k]; if (e > melhor) { melhor = e; ini = i } }
  const lo = Math.log(100), hi = Math.log(Math.min(8000, sr / 2 - 100)), bandas = new Float64Array(16)
  // média de várias janelas (≈0,3 s) para o desenho do som não depender do acaso do ruído
  for (let w = 0; w < 12; w++) {
    const s = ini + w * (N >> 2); if (s + N > x.length) break
    const re = new Float64Array(N), im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
    fft(re, im)
    for (let b = 1; b < N / 2; b++) { const f = b * sr / N; if (f < 100 || f > Math.exp(hi)) continue; const i = Math.min(15, Math.floor((Math.log(f) - lo) / (hi - lo) * 16)); bandas[i] += re[b] * re[b] + im[b] * im[b] }
  }
  const bruto = [...bandas].map((e) => 10 * Math.log10(e + 1e-9))
  const db = bruto.map((v, i) => (bruto[Math.max(0, i - 1)] + 2 * v + bruto[Math.min(15, i + 1)]) / 4), media = db.reduce((a, b) => a + b, 0) / 16
  const energia = (a, b) => { let e = 0; for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) e += x[i] * x[i]; return e + 1e-9 }
  const dec = Math.log10(energia(ini + 0.15 * sr, ini + 0.3 * sr) / energia(ini, ini + N))
  return { b: db.map((v) => Math.round((v - media) * 10) / 10), dec: Math.round(dec * 100) / 100 }
}
function correlacao(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length
  let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2 }
  return da < 1e-6 || db < 1e-6 ? 0 : n / Math.sqrt(da * db)
}
// Teste do painel: uma "batida de porta" sintética (ruído grave que some rápido) entra no ouvido.
function simularBatida() {
  if (!actx) return
  const sr = actx.sampleRate, t = now(), n = Math.floor(sr * 0.7), x = new Float32Array(n)
  let lp = 0
  for (let i = 0; i < n; i++) { lp += 0.08 * ((Math.random() * 2 - 1) - lp); x[i] = lp * 6 * Math.exp(-i / (sr * 0.09)) + Math.sin(i / sr * 2 * Math.PI * 95) * 0.4 * Math.exp(-i / (sr * 0.12)) }
  for (let o = 0; o < n; o += 4096) anel.push({ t: t + (o / sr) * 1000, x: x.subarray(o, Math.min(n, o + 4096)) })
  bus.emit('susto', { label: 'teste (batida de porta)' })
}
function trechoDoAnel(de, ate) {
  const pedacos = anel.filter((p) => p.t >= de && p.t <= ate + 100).map((p) => p.x)
  const n = pedacos.reduce((a, p) => a + p.length, 0), x = new Float32Array(n)
  let o = 0; for (const p of pedacos) { x.set(p, o); o += p.length }
  return x
}
function paraBase64(x, srIn) { // 8 kHz, 16 bits, volume normalizado
  const passo = srIn / 8000, m = Math.floor(x.length / passo), out = new Int16Array(m)
  let pico = 0; for (let i = 0; i < x.length; i++) pico = Math.max(pico, Math.abs(x[i]))
  const ganho = pico > 0 ? 0.9 / pico : 1
  for (let i = 0; i < m; i++) out[i] = clamp(x[Math.floor(i * passo)] * ganho, -1, 1) * 32767
  let s = ''; const u8 = new Uint8Array(out.buffer); for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192))
  return btoa(s)
}
function registrarSom(ts) {
  if (!actx || !anel.length) return null
  const x = trechoDoAnel(ts - 500, ts + 400), ass = assinatura(x, actx.sampleRate)
  if (!ass) return null
  let s = sons.find((o) => correlacao(o.assinatura.b, ass.b) > 0.75 && Math.abs(o.assinatura.dec - ass.dec) < 0.6)
  if (s) { s.vezes++; s.ultima = Date.now(); s.assinatura.b = s.assinatura.b.map((v, i) => Math.round(lerp(v, ass.b[i], 0.2) * 10) / 10) }
  else {
    s = { id: Date.now(), assinatura: ass, vezes: 1, primeira: Date.now(), ultima: Date.now(), significado: '', icones: [], medo: 1, perguntouEm: 0 }
    sons.push(s)
    if (sons.length > 10) sons = sons.sort((a, b) => (b.significado ? 1 : 0) - (a.significado ? 1 : 0) || b.ultima - a.ultima).slice(0, 10)
  }
  s.audio = paraBase64(x, actx.sampleRate)
  if (s.significado) s.medo = Math.max(0.05, s.medo * 0.85) // conhecido: cada vez assusta menos
  salvarSons()
  pushLog(`S3→ som ${s.significado ? `"${s.significado}"` : 'desconhecido'} (${s.vezes}ª vez, medo ${s.medo.toFixed(2)})`)
  return s
}
function reagirSusto(s) {
  pararImaginacao()
  if (s?.significado && s.medo < 0.5) {
    return evento({ label: `ah, é só ${s.significado}`, P: 0.05, A: 0.2, interesse: 0.4, tipo: 'susto_conhecido', expr: 'contente', gesto: 'olhar_em_volta', icones: s.icones?.length ? s.icones : ['ok'], som: false, dur: 2500 })
  }
  const k = clamp(0.35 + 0.65 * (s ? s.medo : 1), 0.3, 1)
  evento({ label: s && s.vezes > 1 ? `aquele barulho de novo! (${s.vezes}ª vez)` : 'susto com barulho', P: -0.4 * k, A: 0.9 * k, D: -0.4 * k, interesse: 0.95, expr: 'medo', icone: 'exclamacao', som: 'medo', intens: k, gesto: 'encolher', tipo: 'susto', confianca: -0.01 * k, dur: 1800, emote: k > 0.8 && Math.random() < 0.3 ? 'assustado' : null })
  sustosHoje++
  if (s && !s.significado && s.vezes >= 3 && Date.now() - (s.perguntouEm || 0) > 600000) setTimeout(() => perguntarSom(s), 4500)
}
let sustosHoje = 0, perguntaSomPendente = null
function tocarSomGravado(s, assustar) {
  if (!actx || !s?.audio) return 0
  const u8 = Uint8Array.from(atob(s.audio), (c) => c.charCodeAt(0)), i16 = new Int16Array(u8.buffer)
  const buf = actx.createBuffer(1, i16.length, 8000), ch = buf.getChannelData(0)
  for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768
  const src = actx.createBufferSource(), gn = actx.createGain(); gn.gain.value = 0.7
  src.buffer = buf; src.connect(gn).connect(actx.destination); src.start()
  const dur = buf.duration * 1000
  falandoAte = now() + dur + 400 // não se assustar com o próprio som… pelo menos não de verdade
  if (assustar) {
    setTimeout(() => { foco = { expr: 'medo', ate: now() + 1200 }; iniciarGesto('encolher'); somDe('medo', 0.25) }, 120)
    setTimeout(() => { foco = { expr: 'timido', ate: now() + 1800 } }, 1500) // "hehe, me assustei comigo mesmo"
  }
  return dur
}
function perguntarSom(s) {
  if (!temGente() || dormindo) { perguntaSomPendente = s.id; return }
  perguntaSomPendente = null
  s.perguntouEm = Date.now(); salvarSons()
  pushLog(`Sons→ perguntando sobre um barulho (${s.vezes} sustos)`)
  evento({ label: 'que barulho é esse que sempre me assusta?', P: -0.05, A: 0.3, interesse: 0.8, expr: 'curioso', gesto: 'nao_sei', forcarGesto: true, icones: ['olhos', 'pergunta'], dur: 2400 })
  setTimeout(() => {
    const d = tocarSomGravado(s, true)
    setTimeout(() => {
      abrirConversa(); papo.contexto = { tipo: 'som', somId: s.id, tentativas: 0 }
      foco = { expr: 'curioso', ate: now() + 8000 }; balao = { itens: ['pergunta'], numero: '', t0: now(), ate: now() + 6000 }
      legenda(`${cfg.nome}: Que barulho é esse? Ele sempre me assusta…`)
    }, d + 1800)
  }, 2600)
}
function repetirUltimoSom() {
  const s = [...sons].sort((a, b) => b.ultima - a.ultima)[0]
  if (!s?.audio) return evento({ label: 'não lembro de nenhum barulho', gesto: 'nao_sei', forcarGesto: true, icones: ['pergunta'], interesse: 0.4, dur: 2500 })
  const d = tocarSomGravado(s, true)
  setTimeout(() => { abrirConversa(); papo.contexto = { tipo: 'som', somId: s.id, tentativas: 0 } }, d + 1600)
}
function aprenderSom(id, significado, icones) {
  const s = sons.find((o) => o.id === id); if (!s) return
  s.significado = String(significado).slice(0, 80); s.icones = (icones || []).slice(0, 3); s.medo = 0.3
  salvarSons()
  lembrar(`O barulho que me assustava é ${s.significado}. Não preciso ter medo.`, 7, 'aprendizado')
  pushLog(`Sons→ aprendi: "${s.significado}"`)
  setTimeout(() => evento({ label: `ufa, era só ${s.significado}`, P: 0.4, A: -0.2, interesse: 0.6, expr: 'contente', gesto: 'suspiro', forcarGesto: true, confianca: 0.02, dur: 2500 }), 4800)
}

// ================================================================ IMAGINAÇÃO: devaneios, sonhos e pesadelos
// Um gerador só: usa lembranças, acontecimentos, gostos e a época do ano para criar uma
// historinha em 3–4 quadrinhos de ícones. Ela vai para a memória para ele contar depois.
const imag = { ativo: null, quadroAtual: -1 }
const TEMAS_IMAG = ['o espaço e as estrelas', 'o fundo do mar', 'uma cozinha mágica', 'uma floresta de cabos', 'a cidade à noite', 'virar gigante', 'ficar minúsculo', 'uma viagem de trem', 'uma festa de robôs', 'um dia de chuva', 'uma corrida de carrinhos', 'um bicho de estimação', 'um museu antigo', 'aprender a voar', 'um mistério para resolver', 'trocar de lugar com o Will por um dia']
let imagHoje = store.get('imagHoje', { dia: '', n: 0 })
const ESQ_HISTORIA = () => ({
  type: 'object', additionalProperties: false, required: ['titulo', 'quadros', 'resumo', 'tom'],
  properties: {
    titulo: { type: 'string' }, resumo: { type: 'string' }, tom: { type: 'string', enum: ['doce', 'engracado', 'estranho', 'aventura', 'assustador'] },
    quadros: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['icones', 'emocao'], properties: { icones: { type: 'array', items: { type: 'string', enum: Object.keys(ICONES) } }, emocao: { type: 'string', enum: EMOCOES } } } },
  },
})
function epoca() {
  const d = dataAtiva(), h = hojeData(), m = h.getMonth()
  const estacao = m === 11 || m <= 1 ? 'verão' : m <= 4 ? 'outono' : m <= 7 ? 'inverno' : 'primavera'
  return `${estacao} no Brasil${d ? `, perto de ${d.nome}` : ''}`
}
async function imaginar(tipo) {
  if (!cfg.key) return null
  const dia = new Date().toLocaleDateString('sv')
  if (imagHoje.dia !== dia) imagHoje = { dia, n: 0 }
  if (imagHoje.n >= 14) return null
  imagHoje.n++; store.set('imagHoje', imagHoje)
  const tom = tipo === 'pesadelo' ? 'um PESADELO de robô: assustador mas bobinho (ex.: ficar sem bateria, um aspirador gigante, perder o Wi-Fi, um barulho no escuro). Nunca violento ou cruel.'
    : tipo === 'sonho' ? 'um SONHO: uma mistura estranha e criativa das coisas que aconteceram hoje, como os sonhos de verdade.'
      : 'um DEVANEIO acordado: uma historinha que ele imagina por conta própria, divertida ou de aventura.'
  const sys = `Você é a imaginação de ${cfg.nome}, um robozinho de mesa com personalidade própria que mora com ${cfg.dono}. Crie ${tom}
Conte em 3 ou 4 quadrinhos; cada quadrinho tem 1 a 3 ícones (da lista) e a emoção dele naquele momento. Use as lembranças e os acontecimentos como inspiração.
Personalidade: extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, afeto ${P.afeto.toFixed(2)}. Gostos: ${Object.entries(P.gostos).filter(([, v]) => v > 0.2).map(([k]) => k).join(', ') || 'ainda descobrindo'}.
Época: ${epoca()}.
Tema para inspirar desta vez: ${sorteia(TEMAS_IMAG)} (misture com o seu dia, do seu jeito).
NÃO repita estas histórias, invente outra bem diferente: ${memorias.filter((m) => m.historia).slice(0, 6).map((m) => m.historia.titulo).join('; ') || 'nenhuma ainda'}.
Acontecimentos de hoje: ${acontecimentos.slice(0, 6).map((a) => a.txt).join('; ') || 'nada demais'}.
Lembranças:
${lembrancas(10).map((m) => '- ' + m.txt).join('\n') || '- quase nada ainda'}
ÍCONES: ${Object.keys(ICONES).join(', ')}
EMOÇÕES: ${EMOCOES.join(', ')}
Responda SÓ com JSON: {"titulo": "curto", "quadros": [{"icones": [...], "emocao": "..."}], "resumo": "a história em 1 ou 2 frases, em primeira pessoa, em português", "tom": "doce|engracado|estranho|aventura|assustador"}`
  try {
    const r = await pedirJSON([{ role: 'system', content: sys }], 'historia', ESQ_HISTORIA(), { temperature: 0.95 })
    const j = JSON.parse((r.choices[0].message.content.match(/\{[\s\S]*\}/) || ['{}'])[0])
    const quadros = (j.quadros || []).map((q) => ({ icones: limparIcones(q.icones), emocao: EMOCOES.includes(q.emocao) ? q.emocao : 'curioso' })).filter((q) => q.icones.length).slice(0, 4)
    if (!quadros.length) return null
    const h = { tipo, titulo: String(j.titulo || '').slice(0, 60), resumo: String(j.resumo || '').slice(0, 240), tom: j.tom || 'doce', quadros }
    pushLog(`Imaginação→ ${tipo}: ${h.titulo} · ${h.quadros.map((q) => q.icones.map((x) => ICONES[x]).join('')).join(' | ')}`)
    return h
  } catch (e) { pushLog('Imaginação: ' + e.message); return null }
}
function guardarHistoria(h) {
  if (!h) return
  const rot = { devaneio: 'Imaginei', sonho: 'Sonhei', pesadelo: 'Tive um pesadelo' }[h.tipo]
  lembrar(`${rot}: ${h.titulo} — ${h.resumo}`, h.tipo === 'pesadelo' ? 6 : 5, h.tipo)
  memorias[0].historia = h; memorias[0].contado = false
  store.set('memorias', memorias)
}
const historiaParaContar = () => memorias.find((m) => m.historia && !m.contado && Date.now() - m.t < 3 * 86400000)
function pararImaginacao() { if (imag.ativo?.tipo === 'devaneio') pushLog('Imaginação→ devaneio interrompido'); if (imag.ativo) imag.ativo = null }
async function devanear(forcar = false) {
  if (imag.ativo || dormindo || (!forcar && temGente() && N.estimulo > 0.35)) return
  imag.ativo = { tipo: 'devaneio', t0: now(), hist: null }
  imag.quadroAtual = -1
  pushLog('Imaginação→ começou a devanear')
  const h = await imaginar('devaneio')
  if (!h || imag.ativo?.tipo !== 'devaneio') { imag.ativo = null; return }
  imag.ativo = { tipo: 'devaneio', t0: now(), hist: h }
  guardarHistoria(h)
}
function contarHistoria(m = historiaParaContar()) {
  m = m || memorias.find((x) => x.historia)
  if (!m?.historia) return evento({ label: 'não imaginei nada ainda', gesto: 'nao_sei', forcarGesto: true, icones: ['pensando' in ICONES ? 'pensando' : 'cerebro', 'pergunta'], interesse: 0.4, dur: 2500 })
  pararImaginacao()
  imag.ativo = { tipo: 'contando', t0: now() + 1600, hist: m.historia }
  imag.quadroAtual = -1
  m.contado = true; store.set('memorias', memorias)
  const intro = { devaneio: ['ideia', 'livro'], sonho: ['dormir', 'livro'], pesadelo: ['fantasma', 'livro'] }[m.historia.tipo] || ['livro']
  evento({ label: `contando: ${m.historia.titulo}`, P: 0.2, A: 0.3, interesse: 0.6, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: intro, dur: 1500 })
  legenda(`${cfg.nome}: ${m.historia.resumo}`)
}
// Troca de quadrinho: a emoção do rosto acompanha a história.
function tickImaginacao() {
  const a = imag.ativo
  if (!a?.hist) return
  const i = Math.floor((now() - a.t0) / 2300)
  if (i < 0) return
  if (i >= a.hist.quadros.length) {
    imag.ativo = null
    if (a.tipo === 'devaneio') evento({ label: `imaginei uma história: ${a.hist.titulo}`, P: 0.25, A: 0, interesse: 0.5, expr: 'contente', som: false, dur: 2000 })
    else evento({ label: 'terminei de contar', P: 0.2, interesse: 0.5, expr: 'orgulhoso', gesto: 'sim', forcarGesto: true, dur: 2000 })
    return
  }
  if (i !== imag.quadroAtual) {
    imag.quadroAtual = i
    const q = a.hist.quadros[i]
    foco = { expr: q.emocao, ate: now() + 2400 }
    if (a.tipo === 'contando') somDe(q.emocao, 0.4)
  }
}
function desenharImaginacao(t) {
  const a = imag.ativo; if (!a) return
  const q = a.hist?.quadros[Math.max(0, Math.floor((t - a.t0) / 2300))]
  g.save()
  if (a.tipo === 'devaneio') {
    g.fillStyle = '#e8f6ff'; g.globalAlpha = 0.92
    for (const [x, y, r] of [[200, 82, 3], [209, 70, 5]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill() }
    for (const [x, y, rx, ry] of [[150, 32, 30, 19], [178, 24, 30, 21], [206, 34, 26, 18], [174, 44, 42, 15]]) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill() }
    g.globalAlpha = 1; g.textAlign = 'center'; g.textBaseline = 'middle'
    if (q) { g.font = '20px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif'; q.icones.forEach((k, i) => g.fillText(ICONES[k], 178 + (i - (q.icones.length - 1) / 2) * 25, 33)) }
    else { g.fillStyle = '#5b6b7b'; g.font = 'bold 22px system-ui'; g.fillText('.'.repeat(1 + Math.floor(t / 400) % 3), 178, 30) }
  } else if (a.tipo === 'contando' && q && t >= a.t0) {
    const n = a.hist.quadros.length, i = Math.floor((t - a.t0) / 2300)
    g.fillStyle = '#1b2632'; g.strokeStyle = '#7df9ff'; g.lineWidth = 2
    g.beginPath(); g.roundRect(30, 4, 180, 48, 10); g.fill(); g.stroke()
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '24px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif'
    q.icones.forEach((k, j) => g.fillText(ICONES[k], 120 + (j - (q.icones.length - 1) / 2) * 34, 26))
    for (let j = 0; j < n; j++) { g.fillStyle = j <= i ? '#7df9ff' : '#3a4a5a'; g.fillRect(120 - n * 6 + j * 12, 46, 6, 3) }
  }
  g.restore()
}

// Sono: ciclos com fase REM (olhos se mexendo rápido). No REM ele sonha, ou tem pesadelo
// (mais provável depois de um dia de sustos, solidão ou mau humor).
const sono = { proxREM: Infinity, rem: null, touca: false, ultimoSonho: null, remDur: 180000 }
function comecarREM(tipoForcado) {
  const prob = clamp(0.08 + sustosHoje * 0.07 + (humor.P < 0 ? 0.15 : 0) + (N.social < 0.3 ? 0.1 : 0) + (P.confianca < 0.4 ? 0.08 : 0), 0, 0.6)
  const tipo = tipoForcado || (Math.random() < prob ? 'pesadelo' : 'sonho')
  sono.rem = { tipo, t0: now(), ate: now() + sono.remDur, hist: null }
  sono.proxREM = now() + 90 * 60000
  pushLog(`Cérebro→ REM: ${tipo} (chance de pesadelo ${(prob * 100).toFixed(0)}%)`)
  imaginar(tipo).then((h) => { if (sono.rem && h) { sono.rem.hist = h; guardarHistoria(h); sono.ultimoSonho = h } })
}
function tickSono() {
  const t = now()
  if (!dormindo) { sono.rem = null; return }
  if (!sono.rem && t > sono.proxREM && cfg.key) comecarREM()
  const r = sono.rem; if (!r) return
  // falar dormindo (bipes bem baixinhos) e mexidinhas
  if (Math.random() < 0.04) { balanco = 0.4; somDe(r.tipo === 'pesadelo' ? 'triste' : 'contente', 0.12) }
  if (t > r.ate) {
    sono.rem = null
    if (r.tipo === 'pesadelo' && Math.random() < 0.5) acordarDoPesadelo(r.hist)
  }
}
function acordarDoPesadelo(h) {
  dormindo = false; foco = null
  pushLog('Cérebro→ acordou de um pesadelo!')
  const ic = h?.quadros?.find((q) => q.emocao === 'medo')?.icones || ['fantasma']
  evento({ label: `acordei de um pesadelo${h ? ': ' + h.titulo : ''}`, P: -0.5, A: 0.8, D: -0.4, interesse: 0.95, expr: 'medo', gesto: 'encolher', forcarGesto: true, icones: [...ic.slice(0, 2), 'pergunta'], dur: 3500, emote: 'assustado' })
  papo.contexto = { tipo: 'pesadelo', hist: h }
  if (temGente()) setTimeout(() => { abrirConversa(); papo.contexto = { tipo: 'pesadelo', hist: h } }, 3000)
}

// ================================================================ CORPO TÉRMICO
// Faixas de frio e calor com respostas variadas (e acessórios); o jeito dele decide as palhaçadas.
const termo = { prox: 0, hist: [], ultimaBrusca: -1e9, palhacada: -1e9, noelAte: 0, oculosAte: 0, nevoa: 0, limpando: null, limpos: [], ultima: '' }
let forcaTremor = 1
const nivelFrio = (T) => (T <= 8 ? 5 : T <= 12 ? 4 : T <= 15 ? 3 : T <= 18 ? 2 : T <= 22 ? 1 : 0)
const nivelCalor = (T) => (T >= 34 ? 3 : T >= 31 ? 2 : T >= 28 ? 1 : 0)
const JINGLE = [4, 4, 4, 4, 4, 4, 4, 7, 0, 2, 4].map((st, i) => ({ st, d: [0.18, 0.18, 0.36, 0.18, 0.18, 0.36, 0.18, 0.18, 0.27, 0.09, 0.5][i] }))
const VERAO = [0, 4, 7, 9, 7, 4, 7, 12].map((st) => ({ st, d: 0.15 }))
function tickClima() {
  const t = now(), T = clima.temp, U = clima.umid, f = nivelFrio(T), q = nivelCalor(T)
  vestir('cachecol', f >= 3); vestir('gorro', f >= 4 && t > termo.noelAte && !(dormindo && sono.touca)); vestir('nariz', f >= 4)
  vestir('noel', t < termo.noelAte)
  vestir('leque', q === 1 && !dormindo); vestir('oculos', !dormindo && (q >= 2 || t < termo.oculosAte)); vestir('lingua', q >= 3 && !dormindo)
  vestir('guarda_chuva', U >= 90 && !dormindo); vestir('touca', dormindo && sono.touca)
  forcaTremor = 0.4 + f * 0.25
  // mudança brusca (3 °C ou mais em 10 min)
  if (!termo.hist.length || t - termo.hist[termo.hist.length - 1].t > 5000) termo.hist.push({ t, T })
  while (termo.hist.length && t - termo.hist[0].t > 600000) termo.hist.shift()
  const antes = termo.hist[0]
  if (antes && Math.abs(T - antes.T) >= 3 && t - termo.ultimaBrusca > 600000) {
    termo.ultimaBrusca = t; termo.hist = [{ t, T }]
    return evento({ label: T < antes.T ? `ué, esfriou! (${antes.T}→${T} °C)` : `ué, esquentou! (${antes.T}→${T} °C)`, P: 0, A: 0.5, interesse: 0.75, expr: 'surpreso', gesto: 'surpresa', icones: [T < antes.T ? 'neve' : 'calor', 'pergunta'], dur: 2500 })
  }
  if (dormindo || t < termo.prox || jogo || palco || gravando || imag.ativo) return
  const nivel = Math.max(f, q, U <= 30 ? 1 : 0, U >= 80 ? 1 : 0)
  if (!nivel) { termo.prox = t + 60000; return }
  termo.prox = t + rnd(70000, 160000) / (0.6 + nivel * 0.4)
  reagirClima(T, U, f, q)
}
function reagirClima(T, U, f, q) {
  const palhaco = P.extroversao > 0.6 && now() - termo.palhacada > 30 * 60000, mes = hojeData().getMonth(), op = []
  if (f >= 1) op.push(['arrepio', 1]); if (f >= 2) op.push(['tremer', 2]); if (f >= 4) op.push(['dentes', 2]); if (f >= 5) op.push(['gelo', 2])
  if (f >= 2 && palhaco && (mes === 11 || mes === 10)) op.push(['noel', 4])
  if (q >= 1) op.push(['abanar', 1]); if (q >= 2) op.push(['ufa', 2]); if (q >= 3) op.push(['derreter', 3]); if (q >= 2 && palhaco) op.push(['verao', 3])
  if (U <= 30) op.push(['tosse', 2]); if (U >= 80) op.push(['limpar', 2])
  const ops = op.filter(([k]) => k !== termo.ultima).length ? op.filter(([k]) => k !== termo.ultima) : op
  let r = Math.random() * ops.reduce((a, [, w]) => a + w, 0), esc = ops[0][0]
  for (const [k, w] of ops) { r -= w; if (r <= 0) { esc = k; break } }
  termo.ultima = esc
  const ev = {
    arrepio: () => { iniciarGesto('tremer'); somDe('frio', 0.3); foco = { expr: 'frio', ate: now() + 1500 } },
    tremer: () => evento({ label: `tremendo de frio (${T} °C)`, P: -0.15, A: 0.1, interesse: 0.3, expr: 'frio', gesto: 'tremer', forcarGesto: true, som: 'frio', icones: f >= 3 ? ['neve'] : [], dur: 3000 }),
    dentes: () => evento({ label: 'batendo os dentes de frio', P: -0.15, interesse: 0.3, expr: 'frio', gesto: 'tremer', forcarGesto: true, som: 'dentes', dur: 2500 }),
    gelo: () => evento({ label: `congelando! (${T} °C)`, P: -0.2, interesse: 0.5, som: false, emote: 'gelo', dur: 2500 }),
    noel: () => { termo.palhacada = now(); termo.noelAte = now() + 45000; evento({ label: 'vestiu de Papai Noel!', P: 0.5, A: 0.5, interesse: 0.8, expr: 'rindo', gesto: 'dancinha', forcarGesto: true, icones: ['presente', 'neve'], som: false, dur: 4000 }); setTimeout(() => tocarMelodia(JINGLE, 1), 900) },
    abanar: () => evento({ label: `calor (${T} °C)`, P: -0.1, A: -0.3, interesse: 0.3, expr: 'calor', icone: 'gota', som: 'calor', dur: 3500 }),
    ufa: () => evento({ label: `que calor! (${T} °C)`, P: -0.2, A: -0.35, interesse: 0.4, expr: 'calor', gesto: 'suspiro', forcarGesto: true, icones: ['sol', 'agua'], som: 'calor', dur: 3500 }),
    derreter: () => { pushLog(`Cérebro→ derretendo (${T} °C)`); mostrarEmote('calor', 1800, { saida: 'derreter', volta: 'pixel' }) },
    verao: () => { termo.palhacada = now(); termo.oculosAte = now() + 40000; evento({ label: 'modo verão!', P: 0.4, A: 0.5, interesse: 0.8, expr: 'orgulhoso', gesto: 'dancinha', forcarGesto: true, icones: ['sol', 'musica'], som: false, dur: 4000 }); setTimeout(() => tocarMelodia(VERAO, 1), 800) },
    tosse: () => evento({ label: `ar seco (${U} %)`, P: -0.1, interesse: 0.3, som: 'tosse', icones: Math.random() < 0.5 ? ['agua', 'pergunta'] : [], dur: 2500 }),
    limpar: () => { termo.limpando = { t0: now() }; evento({ label: `tela embaçada (${U} %), limpando`, P: -0.05, interesse: 0.3, expr: 'desconfiado', som: false, dur: 2200 }) },
  }
  ev[esc]?.()
}

// ================================================================ DATAS COMEMORATIVAS
let dataSim = store.get('dataSim', '')
function hojeData() { return dataSim ? new Date(dataSim + 'T12:00:00') : new Date() }
function pascoa(a) {
  const b = Math.floor(a / 100), c = a % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), gg = Math.floor((b - f + 1) / 3)
  const h = (19 * (a % 19) + b - d - gg + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor(((a % 19) + 11 * h + 22 * l) / 451)
  return new Date(a, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1, 12)
}
const somaDias = (d, n) => new Date(d.getTime() + n * 86400000)
const DATAS = [
  { id: 'natal', nome: 'o Natal', quando: (a) => new Date(a, 11, 25, 12), antes: 50, depois: 1, deco: [{ el: 'luzes' }, { el: 'neve' }] },
  { id: 'ano_novo', nome: 'o Ano-Novo', quando: (a) => new Date(a, 11, 31, 12), antes: 4, depois: 1, deco: [{ el: 'fogos' }, { el: 'confete', cores: ['y', 'w', 'o'] }] },
  { id: 'carnaval', nome: 'o Carnaval', quando: (a) => somaDias(pascoa(a), -47), antes: 7, depois: 1, deco: [{ el: 'confete' }, { el: 'serpentina' }] },
  { id: 'pascoa', nome: 'a Páscoa', quando: pascoa, antes: 6, depois: 1, deco: [{ el: 'ovos' }, { el: 'flores' }] },
  { id: 'namorados', nome: 'o Dia dos Namorados', quando: (a) => new Date(a, 5, 12, 12), antes: 4, depois: 0, deco: [{ el: 'coracoes' }] },
  { id: 'festa_junina', nome: 'a Festa Junina', quando: (a) => new Date(a, 5, 24, 12), antes: 23, depois: 6, deco: [{ el: 'bandeirinhas' }, { el: 'fogueira' }] },
  { id: 'criancas', nome: 'o Dia das Crianças', quando: (a) => new Date(a, 9, 12, 12), antes: 5, depois: 0, deco: [{ el: 'baloes' }] },
  { id: 'halloween', nome: 'o Halloween', quando: (a) => new Date(a, 9, 31, 12), antes: 7, depois: 1, deco: [{ el: 'aboboras' }, { el: 'fantasmas' }] },
  { id: 'aniversario_robo', nome: 'o meu aniversário', quando: (a) => { const n = new Date(P.nasceu); return a > n.getFullYear() ? new Date(a, n.getMonth(), n.getDate(), 12) : null }, antes: 1, depois: 0, deco: [{ el: 'baloes' }, { el: 'confete' }] },
  { id: 'aniversario_dono', nome: 'o aniversário do dono', quando: (a) => { const m = /^(\d{1,2})\/(\d{1,2})$/.exec(P.anivDono || ''); return m ? new Date(a, +m[2] - 1, +m[1], 12) : null }, antes: 2, depois: 0, deco: [{ el: 'baloes' }, { el: 'estrelas' }] },
]
const nomeData = (id) => (id === 'aniversario_dono' ? `o aniversário de ${cfg.dono}` : DATAS.find((d) => d.id === id)?.nome || '')
function dataAtiva() {
  const h = hojeData()
  for (const d of DATAS) for (const ano of [h.getFullYear() - 1, h.getFullYear(), h.getFullYear() + 1]) {
    const q = d.quando(ano); if (!q) continue
    const dias = (q - h) / 86400000
    if (dias <= d.antes && dias >= -d.depois - 0.6) return { ...d, nome: nomeData(d.id), ano: q.getFullYear(), dias: Math.round(dias) }
  }
  return null
}
function decoracaoAtual() {
  const d = dataAtiva()
  return d && P.deco && P.deco.chave === d.id + d.ano ? P.deco.elementos : null
}
function decorar(pedido = false) {
  const d = dataAtiva()
  if (!d) { if (pedido) evento({ label: 'não tem data comemorativa perto', gesto: 'nao_sei', forcarGesto: true, icones: ['calendario', 'pergunta'], interesse: 0.4, dur: 2500 }); return }
  const sugs = (P.sugestoes || []).filter((s) => s.data === d.id && s.estado !== 'usada' && s.elementos?.length)
  const mapa = new Map()
  for (const x of [...d.deco, ...sugs.flatMap((s) => s.elementos.map((el) => ({ el, cores: s.cores })))]) mapa.set(x.el, { el: x.el, cores: x.cores || [] })
  sugs.forEach((s) => (s.estado = 'usada'))
  P.deco = { chave: d.id + d.ano, data: d.id, elementos: [...mapa.values()].slice(0, 5), t: Date.now(), aprovado: null, perguntar: false }
  store.set('pers', P); decoEntrada = now()
  pushLog(`Datas→ decorou para ${d.nome}: ${P.deco.elementos.map((e) => e.el).join(', ')}`)
  evento({ label: `decorei a tela para ${d.nome}${sugs.length ? ' (com a sua sugestão!)' : ''}`, P: 0.4, A: 0.4, interesse: 0.85, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, dur: 3000, lembrar: 4 })
  setTimeout(() => perguntarDeco(), 3800)
}
function perguntarDeco() {
  const d = dataAtiva(); if (!d || !P.deco) return
  if (!temGente() || dormindo) { P.deco.perguntar = true; return }
  P.deco.perguntar = false
  abrirConversa()
  papo.contexto = { tipo: 'deco', nome: d.nome, elementos: P.deco.elementos.map((e) => e.el) }
  evento({ label: 'gostou da decoração?', P: 0.1, A: 0.3, interesse: 0.6, expr: 'curioso', gesto: 'talvez', forcarGesto: true, icones: ['ok', 'nao_ok', 'pergunta'], dur: 5000 })
  legenda(`${cfg.nome}: Decorei para ${d.nome}! Gostou? Tem alguma ideia?`)
}
function opiniaoDeco(op) {
  if (!P.deco) return
  P.deco.aprovado = op === 'gostou'
  const d = dataAtiva()
  lembrar(`${cfg.dono} ${op === 'gostou' ? 'gostou' : 'não gostou muito'} da decoração para ${d?.nome || 'a data'}`, 5)
  if (op === 'nao_gostou') papo.contexto = { tipo: 'deco', nome: d?.nome, elementos: P.deco.elementos.map((e) => e.el) }
  store.set('pers', P)
}
function receberSugestao(s) {
  const ativa = dataAtiva()
  if (!s.elementos?.length) s = { ...s, elementos: elementosDoTexto(s.ideia) } // palavras conhecidas viram elementos na hora
  const sug = { id: Date.now(), data: s.data || ativa?.id || '', ideia: String(s.ideia).slice(0, 140), elementos: (s.elementos || []).filter((e) => ELEMENTOS.includes(e)).slice(0, 3), cores: (s.cores || []).filter((c) => PALETA[c]).slice(0, 4), estado: 'guardada', t: Date.now() }
  P.sugestoes = [...(P.sugestoes || []), sug].slice(-30)
  lembrar(`${cfg.dono} sugeriu para ${nomeData(sug.data) || 'a decoração'}: ${sug.ideia}`, 6, 'sugestao')
  store.set('pers', P)
  pushLog(`Datas→ sugestão guardada (${sug.data || 'sem data'}): ${sug.ideia} → ${sug.elementos.join(', ') || 'vou pesquisar'}`)
  const agora = ativa && sug.data === ativa.id
  if (!sug.elementos.length) pesquisarIdeia(sug).then(() => { if (agora) aplicarSugestao(sug) })
  else if (agora) setTimeout(() => aplicarSugestao(sug), 4500)
  else setTimeout(() => evento({ label: `guardei sua ideia para ${nomeData(sug.data) || 'depois'}`, P: 0.2, interesse: 0.5, expr: 'contente', gesto: 'sim', forcarGesto: true, icones: ['calendario', 'ok'], dur: 2500 }), 4500)
}
const PALAVRAS_ELEMENTO = { arvore: /[áa]rvore|pinheiro/i, estrelas: /estrel/i, neve: /neve|flocos/i, luzes: /luz|luzes|pisca/i, coracoes: /cora[çc]/i, baloes: /bal[ãa]o|bal[õo]es|bexiga/i, confete: /confete/i, serpentina: /serpentina/i, fogos: /fogos/i, flores: /flor/i, fantasmas: /fantasma/i, aboboras: /ab[óo]bora/i, bandeirinhas: /bandeir/i, fogueira: /fogueira/i, ovos: /ovo/i }
const elementosDoTexto = (t) => Object.entries(PALAVRAS_ELEMENTO).filter(([, re]) => new RegExp('(^|[^a-zà-ú])(' + re.source + ')', 'i').test(t || '')).map(([el]) => el).slice(0, 3) // palavra inteira: "decoração" não é "coração"
function aplicarSugestao(sug) {
  if (!sug.elementos.length) return evento({ label: `ainda não sei desenhar "${sug.ideia}"`, P: -0.05, interesse: 0.4, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, icones: ['pergunta'], dur: 2500 })
  const d = dataAtiva(); if (!d) return
  if (!P.deco || P.deco.chave !== d.id + d.ano) return decorar()
  for (const el of sug.elementos) { const i = P.deco.elementos.findIndex((x) => x.el === el); const item = { el, cores: sug.cores }; if (i >= 0) P.deco.elementos[i] = item; else P.deco.elementos.push(item) }
  P.deco.elementos = P.deco.elementos.slice(-5); sug.estado = 'usada'; store.set('pers', P); decoEntrada = now()
  evento({ label: `coloquei sua ideia: ${sug.ideia}`, P: 0.35, A: 0.3, interesse: 0.7, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, icones: ['ok', 'presente'], dur: 2500 })
}
let modelosGroq = []
async function pesquisarIdeia(sug) {
  const modelo = modelosGroq.find((i) => /^groq\/compound$/i.test(i)) || modelosGroq.find((i) => /compound/i.test(i)) || cfg.model
  const pedido = `Um robozinho de mesa decora a borda da tela (pixel art, 240x240) para ${nomeData(sug.data) || 'uma ocasião especial'}. A ideia de ${cfg.dono} foi: "${sug.ideia}".
Pesquise o que precisar (cores, símbolos da ideia) e traduza para os elementos que ele sabe desenhar: ${ELEMENTOS.join(', ')}.
Cores possíveis (letra=cor): ${Object.entries(NOME_COR).map(([k, v]) => `${k}=${v}`).join(', ')}.
Responda SÓ com JSON: {"elementos": [1 a 3 da lista], "cores": [até 4 letras], "nota": "o que você descobriu, numa frase curta em português"}`
  try {
    pushLog(`Datas→ pesquisando "${sug.ideia}" (${modelo})…`)
    const corpo = { model: modelo, messages: [{ role: 'user', content: pedido }], max_completion_tokens: 1500, ...(/gpt-oss/i.test(modelo) ? { reasoning_effort: 'low' } : {}) }
    const r = await groq('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
    const j = JSON.parse((String(r.choices[0].message.content).match(/\{[\s\S]*\}/) || ['{}'])[0])
    sug.elementos = (j.elementos || []).filter((e) => ELEMENTOS.includes(e)).slice(0, 3)
    sug.cores = (j.cores || []).filter((c) => PALETA[c]).slice(0, 4)
    sug.nota = String(j.nota || '').slice(0, 160); sug.estado = sug.elementos.length ? 'pesquisada' : 'sem_jeito'
    pushLog(`Datas→ pesquisa: ${sug.nota || '—'} → ${sug.elementos.join(', ') || 'nada que eu saiba desenhar'}`)
    if (sug.nota) lembrar(`Pesquisei sobre "${sug.ideia}": ${sug.nota}`, 4, 'aprendizado')
    store.set('pers', P)
  } catch (e) { pushLog('Pesquisa: ' + e.message) }
}

// ================================================================ RITUAIS
let carneirosAte = 0, tocaAqui = null
function cantarMusica() {
  const mes = hojeData().getMonth()
  const opcoes = [P.melodia, melodiaInventada(), melodiaInventada(), mes >= 10 ? JINGLE : VERAO].filter(Boolean)
  const m = opcoes[Math.floor(Math.random() * opcoes.length)]
  foco = { expr: 'contente', ate: now() + 5000 }; icone = { tipo: 'nota', ate: now() + 5000 }
  iniciarGesto('dancinha'); tocarMelodia(m, 1.05)
  pushLog(`Cérebro→ cantou (${m === JINGLE ? 'Jingle Bells' : m === P.melodia ? 'a melodia favorita' : m === VERAO ? 'música de verão' : 'uma melodia inventada'})`)
}
function ritualBoaNoite() {
  pararImaginacao(); sono.touca = true; vestir('touca', true)
  evento({ label: 'boa noite!', P: 0.3, A: -0.5, interesse: 0.5, expr: 'sono', gesto: 'bocejo', forcarGesto: true, icones: ['lua', 'dormir'], som: 'sono', dur: 3000 })
  carneirosAte = now() + 7000
  setTimeout(() => { if (!gravando) { dormir('boa noite'); sono.proxREM = now() + 20 * 60000 } }, 7200)
}
function desenharCarneiros(t) {
  if (t > carneirosAte) return
  const k = 7000 - (carneirosAte - t)
  g.fillStyle = '#9aa5b1'; g.fillRect(112, 214, 4, 18); g.fillRect(124, 214, 4, 18); g.fillRect(108, 218, 24, 3) // cerquinha
  for (let i = 0; i < 3; i++) {
    const p = ((k - i * 2100) / 2100); if (p < 0 || p > 1) continue
    desenharSprite(CARNEIRO, 30 + p * 180, 222 - Math.sin(p * Math.PI) * 34, 3)
    if (p > 0.48 && p < 0.52) balao = { itens: [], numero: String(i + 1), t0: now(), ate: now() + 900 }
  }
}
function comecarTocaAqui() {
  tocaAqui = { t0: now(), ate: now() + 2200 }
  evento({ label: 'toca aqui!', P: 0.2, A: 0.5, interesse: 0.7, expr: 'empolgado', icones: [], som: 'hm', dur: 2200 })
  balao = { itens: ['ok'], numero: '', t0: now(), ate: now() + 2200 }
}
function tickTocaAqui() {
  if (tocaAqui && now() > tocaAqui.ate) { tocaAqui = null; evento({ label: 'me deixou no vácuo!', P: -0.1, A: 0.2, interesse: 0.6, expr: 'rindo', gesto: 'rir', forcarGesto: true, icones: ['errado'], dur: 2200 }) }
}
function acertouTocaAqui() {
  tocaAqui = null
  evento({ label: 'toca aqui! 🙌', P: 0.5, A: 0.6, interesse: 0.8, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, social: 0.05, dur: 2000, emote: Math.random() < 0.5 ? 'estrela' : null })
}

// Tudo o que roda a cada segundo, acordado ou dormindo.
function tickVida() {
  tickPapo(); tickClima(); tickSono(); tickTocaAqui()
  if (perguntaSomPendente && temGente() && !dormindo && !papo.contexto) { const s = sons.find((o) => o.id === perguntaSomPendente); if (s) perguntarSom(s); else perguntaSomPendente = null }
  if (P.deco?.perguntar && temGente() && !dormindo && !papo.contexto && papo.estado !== 'conversando') perguntarDeco()
}
setInterval(tickImaginacao, 100)


// ================================================================ telas
// Com um painel aberto, o rosto encolhe e sobe para continuar visível.
new MutationObserver(() => document.body.classList.toggle('painel', !$('#debug').hidden || !$('#cfg').hidden))
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
document.querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = () => { $('#debug').hidden = true; $('#cfg').hidden = true }))
function abrirCfg() {
  $('#cNome').value = cfg.nome; $('#cDono').value = cfg.dono; $('#cKey').value = cfg.key; $('#cStt').value = cfg.stt; $('#cLegenda').checked = !!cfg.legenda; $('#cMaos').checked = !!cfg.maosLivres; $('#cLogToken').value = cfg.logToken || ''
  const sel = $('#cModel'); sel.innerHTML = ''; sel.add(new Option(cfg.model, cfg.model))
  $('#cfg').hidden = false; $('#debug').hidden = true
  if (cfg.key) carregarModelos()
}
async function carregarModelos() {
  try {
    const { data } = await groq('/models')
    const todos = data.map((m) => m.id).filter((id) => !/whisper|guard|tts|orpheus|playai|distil/i.test(id))
    const ids = todos.filter(modeloBom).length ? MODELOS_BONS.flatMap((re) => todos.filter((i) => re.test(i))) : todos.sort()
    const sel = $('#cModel'); sel.innerHTML = ''
    for (const id of ids) sel.add(new Option(id, id, false, id === cfg.model))
    if (!ids.includes(cfg.model)) {
      sel.value = ids[0]
      cfg.model = ids[0]; store.set('cfg', cfg)
      $('#cMsg').textContent = `Troquei o modelo para ${ids[0]} (o anterior não existe ou responde mal em português).`
    }
    const stts = data.map((m) => m.id).filter((id) => /whisper/i.test(id))
    if (stts.length && !stts.includes(cfg.stt)) $('#cStt').value = stts.find((i) => /turbo/.test(i)) || stts[0]
  } catch (e) { $('#cMsg').textContent = 'Não consegui listar os modelos: ' + e.message }
}
$('#btnCfg').onclick = () => ($('#cfg').hidden ? abrirCfg() : ($('#cfg').hidden = true))
$('#cClose').onclick = () => ($('#cfg').hidden = true)
$('#cKey').oninput = () => { if (guardarChave($('#cKey').value, 'colada')) $('#cMsg').textContent = 'Chave salva.' } // salva já ao colar
$('#cLink').onclick = async () => {
  const k = $('#cKey').value.trim() || cfg.key
  if (!k) { $('#cMsg').textContent = 'Cole a chave primeiro.'; return }
  const link = location.origin + location.pathname + '#chave=' + k + (cfg.logToken ? '&log=' + cfg.logToken : '')
  try { await navigator.clipboard.writeText(link); $('#cMsg').textContent = 'Link copiado. Salve nos favoritos ou crie um atalho na tela inicial com ele. Não compartilhe: ele contém a sua chave.' }
  catch { $('#cMsg').textContent = link }
}
$('#cKey').onchange = () => {
  const v = $('#cKey').value.trim()
  if (guardarChave(v, 'digitada')) carregarModelos()
  else if (v) $('#cMsg').textContent = 'Isso não parece uma chave do Groq (ela começa com gsk_). Mantive a anterior.'
}
$('#cModel').onchange = () => { cfg.model = $('#cModel').value; store.set('cfg', cfg) }
$('#cMaos').onchange = () => { cfg.maosLivres = $('#cMaos').checked; store.set('cfg', cfg) }
$('#cLogToken').oninput = () => {
  const v = $('#cLogToken').value.trim()
  if (tokenLogValido(v)) { cfg.logToken = v; store.set('cfg', cfg); store.set('logToken', v); $('#cMsg').textContent = 'Token do log salvo. Enviando um teste…'; enviarLog('teste').then(() => ($('#cMsg').textContent = logEnvio.erro ? 'Não consegui enviar: ' + logEnvio.erro : 'Log enviado! O Claude já consegue ler.')) }
  else if (v) $('#cMsg').textContent = 'Esse não parece um token do GitHub (começa com github_pat_).'
}
$('#tEnviarLog').onclick = () => { pushLog('Log remoto: envio manual'); enviarLog('manual').then(() => pushLog(logEnvio.erro ? 'Log remoto: falhou' : 'Log remoto: enviado')) }
$('#btnJogo').onclick = () => (jogo ? fimDoJogo('parou') : iniciarJogo())
$('#cSave').onclick = () => {
  Object.assign(cfg, { nome: $('#cNome').value.trim() || 'Robô', dono: $('#cDono').value.trim() || 'Will', key: chaveValida($('#cKey').value) ? $('#cKey').value.trim() : cfg.key, model: $('#cModel').value, stt: $('#cStt').value.trim() || 'whisper-large-v3-turbo', legenda: $('#cLegenda').checked, maosLivres: $('#cMaos').checked })
  store.set('cfg', cfg); guardarChave(cfg.key, 'salvar'); $('#cMsg').textContent = cfg.key ? 'Salvo.' : 'Salvo, mas ainda falta a chave do Groq.'
}
let confirmarReset = 0
$('#cReset').onclick = () => {
  if (now() - confirmarReset > 4000) { confirmarReset = now(); $('#cReset').textContent = 'Toque de novo para confirmar'; return }
  store.del('pers'); store.del('humor'); store.del('memorias'); store.del('sons'); location.reload()
}
// Testes de gesto, expressão e ícones (painel 🐞).
const selG = $('#tGesto'), selE = $('#tExpr')
Object.keys(GESTOS).forEach((k) => selG.add(new Option(k, k)))
Object.keys(EXPR).forEach((k) => selE.add(new Option(k, k)))
$('#tTestar').onclick = () => {
  foco = { expr: selE.value, ate: now() + 3500 }
  iniciarGesto(selG.value)
  if (SOM_GESTO[selG.value]) somGesto(selG.value); else somDe(selE.value, 0.6)
}
$('#tIcones').onclick = () => {
  const ks = Object.keys(ICONES), n = 1 + Math.floor(Math.random() * 3)
  balao = Math.random() < 0.25 ? { itens: [], numero: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), t0: now(), ate: now() + 4500 }
    : { itens: Array.from({ length: n }, () => ks[Math.floor(Math.random() * ks.length)]), numero: '', t0: now(), ate: now() + 4500 }
}
$('#tRefletir').onclick = () => { pushLog('Cérebro→ refletindo…'); refletir(true) }
$('#tDevanear').onclick = () => devanear(true)
$('#tContar').onclick = () => contarHistoria()
$('#tSonhar').onclick = () => { if (!dormindo) dormir('teste'); sono.remDur = 40000; comecarREM('sonho') }
$('#tPesadelo').onclick = () => { if (!dormindo) dormir('teste'); sono.remDur = 40000; comecarREM('pesadelo') }
$('#tBoaNoite').onclick = () => ritualBoaNoite()
$('#tTocaAqui').onclick = () => comecarTocaAqui()
const selEm = $('#tEmote'); Object.keys(EMOTES).forEach((k) => selEm.add(new Option(k, k)))
$('#tMostrarEmote').onclick = () => { palco = null; if (dormindo) acordar(); mostrarEmote(selEm.value) }
$('#tDecorar').onclick = () => decorar(true)
$('#tData').value = dataSim
$('#tData').onchange = () => { dataSim = $('#tData').value; store.set('dataSim', dataSim); pushLog('Datas→ simulando ' + (dataSim || 'hoje')) }
$('#tEsquecerSons').onclick = () => { sons = []; salvarSons(); pushLog('Sons→ esqueci todos os barulhos') }
$('#tMelodia').onclick = () => tocarMelodia(P.melodia || melodiaInventada(), 1.1)
$('#btnDebug').onclick = () => { $('#debug').hidden = !$('#debug').hidden; $('#cfg').hidden = true }
document.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => {
  const s = b.dataset.sim
  if (s === 'susto') simularBatida()
  if (s === 'pessoa') { pessoa.saiuEm = now() - 60000; bus.emit('face', { x: rnd(-0.5, 0.5), y: 0, tam: 0.3 }) }
  if (s === 'saiu') { pessoa.visto = 0; vigiarPresenca() }
  if (s === 'escuro') { luz.simAte = now() + 60000; if (luz.base < 0) luz.base = 120; for (let i = 0; i < 4; i++) atualizarLuz(5) }
  if (s === 'claro') { luz.simAte = now() + 3000; for (let i = 0; i < 6; i++) atualizarLuz(140) }
  if (s === 'sorriso') { // finge um sorriso de 1 s na frente da câmera
    pessoa.saiuEm = now(); rosto.ultimaReacao = -1e9
    for (let i = 0; i <= 8; i++) setTimeout(() => bus.emit('face', { x: 0, y: 0, tam: 0.3, exp: { sorriso: 0.85, boca: 0.2, sobrancelha: 0.1, franzido: 0, piscou: 0 } }), i * 140)
  }
  if (s === 'musica') { // finge uma música de 120 BPM por 15 s
    audio.testeAte = now() + 15000; audio.musica = true; audio.bpm = 120; ancora = now(); proxBeat = now(); centroides = [1800]
    bus.emit('musica_comecou', { label: 'teste 120 BPM' }); setTimeout(classificarEstilo, 1500)
    setTimeout(() => { audio.musica = false; votosMusica = 0; bus.emit('musica_parou', { label: 'fim do teste' }) }, 15000)
  }
}))
$('#btnCam').onclick = async () => {
  try {
    if (camera.ligada) { desligarCamera(); $('#btnCam').classList.remove('on') }
    else { await ligarCamera(); $('#btnCam').classList.add('on') }
  } catch (e) { pushLog('Câmera: ' + e.message); desligarCamera(); $('#btnCam').classList.remove('on') }
}
$('#btnFalar').onclick = () => alternarFala().catch((e) => pushLog('Fala: ' + e.message))

setInterval(() => {
  tickComportamento()
  tickVida()
  if ($('#debug').hidden) return
  $('#stats').textContent = textoEstado()
  $('#diario').textContent = [P.opiniao ? `Sobre ${cfg.dono}: ${P.opiniao}` : '', ...memorias.filter((m) => ['reflexao', 'devaneio', 'sonho', 'pesadelo', 'aprendizado', 'sugestao'].includes(m.tipo)).slice(0, 10).map((m) => `${new Date(m.t).toLocaleDateString('pt-BR')} · ${m.txt}`)].filter(Boolean).join('\n') || 'Ainda não refletiu. Precisa da chave do Groq e de algumas lembranças.'
  $('#log').textContent = logLines.join('\n')
}, 1000)

function textoEstado() {
  const f = (x) => (x >= 0 ? ' ' : '') + x.toFixed(2)
  return `Humor do dia : ${nomePAD(humor)} (P${f(humor.P)} A${f(humor.A)} D${f(humor.D)})
Emoção agora : ${emo.nome}${foco ? ' · foco ' + foco.expr : ''}${dormindo ? ' · dormindo' : ''}
Som          : rms ${audio.rms.toFixed(3)} · tom ${audio.pitch ? Math.round(audio.pitch) + ' Hz' : '—'} (${audio.clareza.toFixed(2)})
Música       : ${audio.musica ? `sim · ${audio.bpm} BPM · ${audio.estilo}` : 'não'} · confiança ${audio.conf.toFixed(2)}
Pessoa       : ${pessoa.presente ? 'sim' : 'não'}${camera.ligada ? '' : ' (câmera desligada)'}
Personalidade: extro ${P.extroversao.toFixed(2)} · curio ${P.curiosidade.toFixed(2)} · energ ${P.energia.toFixed(2)} · sensi ${P.sensibilidade.toFixed(2)} · afeto ${P.afeto.toFixed(2)}
Gostos       : ${Object.entries(P.gostos).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ')}
Vida         : ${P.dias} dia(s) · confiança ${P.confianca.toFixed(2)}
Necessidades : companhia ${N.social.toFixed(2)} · novidade ${N.estimulo.toFixed(2)} · energia ${N.energia.toFixed(2)}${desconforto() > 0 ? ' · incomodado' : ' · ok'}
Habituação   : ${Object.entries(hab).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ') || '—'}
Melodia fav. : ${P.melodia ? P.melodia.length + ' notas' : '—'} · recorde no jogo ${P.recordeMelodia || 0}
Rosto        : ${pessoa.presente ? `sorriso ${rosto.sorriso.toFixed(2)} · franzido ${rosto.franzido.toFixed(2)} · ${humorDoRosto() || '…'}` : '—'}
Luz          : ${luz.nivel < 0 ? '— (precisa da câmera)' : `${Math.round(luz.nivel)} (normal ${Math.round(luz.base)})${luz.escuro ? ' · escuro' : ''}`}
Sua voz      : ${P.voz ? `aprendida em ${P.voz.n} fala(s)` : 'ainda não conhece'}${vozDono ? ` · última ${vozDono.tipo}` : ''}
Microfone    : nível ${vad.nivel.toFixed(3)} · precisa passar de ${Math.max(0.006, vad.piso * 3.5).toFixed(3)} para ouvir uma frase
Chave do Groq: ${cfg.key ? `salva …${cfg.key.slice(-4)}` : 'não salva'} · dados do site ${dadosProtegidos ? 'protegidos' : dadosProtegidos === false ? 'podem ser apagados pelo navegador' : '?'}
Conversa     : ${papo.estado}${papo.estado !== 'parado' ? ` (mais ${Math.max(0, Math.round((papo.ate - now()) / 1000))} s)` : ''}${papo.contexto ? ' · contexto ' + papo.contexto.tipo : ''}${pedido.nivel ? ` · pedindo atenção (${pedido.nivel})` : ''}${now() < pedido.emburradoAte ? ' · emburrado' : ''}
Sons         : ${sons.map((o) => `${o.significado || 'desconhecido'} ×${o.vezes} (medo ${o.medo.toFixed(2)})`).join(' · ') || 'nenhum ainda'}
Imaginação   : ${imag.ativo ? imag.ativo.tipo : dormindo ? (sono.rem ? 'REM: ' + sono.rem.tipo : `dormindo (REM em ${Math.max(0, Math.round((sono.proxREM - now()) / 60000))} min)`) : '—'} · hoje ${imagHoje.n}/14 · histórias por contar ${memorias.filter((m) => m.historia && !m.contado).length}
Data         : ${(() => { const d = dataAtiva(); return d ? `${d.nome} (${d.dias >= 0 ? 'faltam ' + d.dias + ' dia(s)' : 'hoje'})` : 'nenhuma perto' })()}${dataSim ? ' · simulando ' + dataSim : ''} · decoração ${decoracaoAtual()?.map((e) => e.el).join(', ') || '—'} · sugestões ${(P.sugestoes || []).length}
Vestindo     : ${Object.keys(vestido).join(', ') || '—'} · frio ${nivelFrio(clima.temp)} · calor ${nivelCalor(clima.temp)}
Mãos livres  : ${!cfg.maosLivres ? 'desligado' : !cfg.key ? 'precisa da chave' : vad.verificando ? 'conferindo se era com ele…' : vad.ativo ? 'ouvindo uma frase' : 'esperando o nome'} · ${vad.hora.length}/40 na hora${jogo ? `
Jogo         : ${jogo.fase} · ${jogo.seq.length} notas` : ''}` + `
Log remoto   : ${!tokenLogValido(cfg.logToken) ? 'sem token' : logEnvio.erro ? 'erro: ' + logEnvio.erro : logEnvio.ultimo ? `enviado há ${Math.round((Date.now() - logEnvio.ultimo) / 60000)} min` : 'ainda não enviou'} · ${filaLog.length} linha(s) na fila`
}

// ---------------------------------------------------------------- log remoto (repositório privado no GitHub)
// A cada 5 min (e na hora, se der erro) o robô manda o que aconteceu para um repositório
// privado. O Claude lê de lá para achar e corrigir bugs. O token fica só neste celular.
const tokenLogValido = (k) => /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test((k || '').trim())
const logEnvio = { enviando: false, ultimo: 0, ultimoEstado: 0, erro: '' }
function base64Utf8(txt) {
  const u8 = new TextEncoder().encode(txt); let b = ''
  for (let i = 0; i < u8.length; i += 8192) b += String.fromCharCode(...u8.subarray(i, i + 8192))
  return btoa(b)
}
async function enviarLog(motivo = 'periódico') {
  if (!tokenLogValido(cfg.logToken) || logEnvio.enviando) return
  const comEstado = motivo !== 'periódico' || Date.now() - logEnvio.ultimoEstado > 10 * 60000
  if (!filaLog.length && !comEstado) return
  logEnvio.enviando = true
  const linhas = filaLog.splice(0), d = new Date()
  const dia = d.toLocaleDateString('sv'), hora = d.toTimeString().slice(0, 8).replace(/:/g, '-')
  let txt = `# ${cfg.nome} · ${VERSAO} · ${d.toLocaleString('pt-BR')} · ${motivo}\n# ${navigator.userAgent}\n\n${linhas.join('\n')}\n`
  if (comEstado) {
    txt += `\n## Estado\n${textoEstado()}\n\n## Memórias recentes\n${memorias.slice(0, 12).map((m) => `- [${m.tipo}, ${m.imp}] ${m.txt}`).join('\n')}\n`
    txt += `\n## Sons\n${JSON.stringify(sons.map(({ audio, ...o }) => o))}\n## Decoração e sugestões\n${JSON.stringify({ deco: P.deco, sugestoes: P.sugestoes })}\n`
  }
  try {
    const caminho = `logs/${dia}/${hora}-${Math.random().toString(36).slice(2, 6)}.txt`
    const r = await fetch(`https://api.github.com/repos/${cfg.logRepo}/contents/${caminho}`, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + cfg.logToken.trim(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `log ${dia} ${hora} (${motivo})`, content: base64Utf8(txt) }),
    })
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 120)}`)
    logEnvio.ultimo = Date.now(); logEnvio.erro = ''
    if (comEstado) logEnvio.ultimoEstado = Date.now()
  } catch (e) {
    filaLog.unshift(...linhas.slice(-3000)); logEnvio.erro = e.message
    logLines.unshift(`${new Date().toLocaleTimeString('pt-BR')}  Log remoto: ${e.message}`)
  } finally { logEnvio.enviando = false }
}
setInterval(() => enviarLog(), 5 * 60000)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') enviarLog('saiu da tela') })
window.addEventListener('error', (e) => { pushLog(`ERRO JS: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`); setTimeout(() => enviarLog('erro'), 2000) })
window.addEventListener('unhandledrejection', (e) => { pushLog('ERRO (promessa): ' + (e.reason?.stack || e.reason?.message || e.reason)); setTimeout(() => enviarLog('erro'), 2000) })

// ================================================================ acordar
let wake = null
async function manterTela() { try { wake = await navigator.wakeLock?.request('screen') } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && actx) manterTela() })

async function acordarRobo(automatico = false) {
  if (micStream) return
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)()
    if (automatico) { await actx.resume().catch(() => {}); if (actx.state !== 'running') { actx.close(); actx = null; return } }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    await ligarOuvido(micStream)
    $('#start').hidden = true
    manterTela()
    await recuperarChave()
    pushLog(cfg.key ? `Chave do Groq carregada …${cfg.key.slice(-4)}` : 'Sem chave do Groq salva neste celular')
    conferirModelo()
    pushLog(`Cérebro→ acordou ${nomePAD(humor)} (dia ${P.dias} de vida) · ${VERSAO}`)
    setTimeout(() => enviarLog('acordou'), 15000)
    somDe(humor.P > 0 ? 'feliz' : 'entediado', 0.5)
    foco = { expr: 'surpreso', ate: now() + 900 }
    if (!cfg.key) pushLog('Dica: ⚙️ → chave do Groq para conversar pelo 🎤')
    else if (cfg.maosLivres) pushLog(`Dica: é só chamar "${cfg.nome}" e falar`)
    if (automatico) pushLog('Acordou sozinho (microfone já liberado)')
  } catch (e) {
    micStream = null
    if (!automatico) $('#start').querySelector('p').textContent = 'Não consegui usar o microfone: ' + e.message + '. Libere o microfone para este site e tente de novo.'
  }
}
$('#btnStart').onclick = () => acordarRobo()
// Se o microfone já foi liberado antes, tenta acordar sem precisar tocar no botão.
navigator.permissions?.query({ name: 'microphone' }).then((st) => { if (st.state === 'granted') acordarRobo(true) }).catch(() => {})

// Atualização: confere de tempos em tempos se há versão nova no site. Se a tela estiver fora de
// vista, recarrega na hora; se estiver aberta, mostra o botão ⬆ (ou recarrega quando você sair).
const NUM_VERSAO = VERSAO.split(' ')[0]
let versaoNova = ''
async function conferirVersao() {
  try {
    const v = (await (await fetch('versao.txt?t=' + Date.now(), { cache: 'no-store' })).text()).trim()
    if (!/^v\d+$/.test(v) || v === NUM_VERSAO) return
    if (versaoNova !== v) { versaoNova = v; pushLog(`Versão nova no site: ${v} (esta é ${NUM_VERSAO})`); $('#btnAtualizar').hidden = false }
    if (document.visibilityState === 'hidden') atualizar()
  } catch {}
}
function atualizar() {
  enviarLog('atualizando').finally(() => location.replace(location.pathname + '?v=' + (versaoNova || Date.now()) + location.hash))
}
setInterval(conferirVersao, 3 * 60000); setTimeout(conferirVersao, 8000)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && versaoNova) atualizar(); else if (document.visibilityState === 'visible') conferirVersao() })
$('#btnAtualizar').onclick = () => atualizar()
requestAnimationFrame(quadro)
