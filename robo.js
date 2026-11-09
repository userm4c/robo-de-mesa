// Robô de mesa · protótipo para Android (navegador).
// A organização imita o robô de verdade:
//   S3  = percepção (microfone: ritmo, música, cantarolar, assobio, susto; câmera: rosto)
//   C3  = corpo (rosto na tela 240×240, sons fofos, sensor de temperatura simulado)
//   Cérebro = emoções em 3 camadas (personalidade, humor do dia, emoção) + Groq
// As mensagens entre S3 e C3 passam pelo "bus", que no robô vira a UART.

import { criarServidor } from './servidor.js?v=27'
import { criarMemoria, CHAVES_MEMORIA } from './memoria.js?v=28'
import { criarC3 } from './c3.js?v=24'
import { ICONES, PALETA, NOME_COR, EMOTES, ELEMENTOS, EXPR, GESTO_DUR as GESTOS, SAIDAS } from './comum.js?v=24'
const $ = (s) => document.querySelector(s)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const rnd = (a, b) => a + Math.random() * (b - a)
const now = () => performance.now()
const hojeSv = () => new Date().toLocaleDateString('sv') // data de hoje como 2026-11-08
let memoriaNuvem = null
const SINCRONIZADAS = new Set(CHAVES_MEMORIA)
const store = {
  get(k, d) { try { const v = localStorage.getItem('robo.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) {
    if (memoriaNuvem && (SINCRONIZADAS.has(k) || k === 'cfg')) { if (memoriaNuvem.travado) return; memoriaNuvem.marcar() } // memória na nuvem: marca o que mudou
    try { localStorage.setItem('robo.' + k, JSON.stringify(v)) } catch {}
  },
  del(k) { try { localStorage.removeItem('robo.' + k) } catch {} },
}

// ---------------------------------------------------------------- barramento
const VERSAO = 'v28 · 09/11'
const logLines = []
const filaLog = [] // tudo o que aconteceu desde o último envio para o log remoto
function pushLog(s) {
  const t = new Date().toLocaleTimeString('pt-BR')
  logLines.unshift(`${t}  ${s}`)
  if (logLines.length > 150) logLines.pop()
  filaLog.push(`${t}  ${s}`); if (filaLog.length > 4000) filaLog.splice(0, 1000)
}
// Memória na nuvem (memoria.js): antes de carregar a personalidade, baixa a mais nova de outro aparelho.
const tokenDaNuvem = () => (/log=((?:github_pat_|ghp_)[A-Za-z0-9_]+)/.exec(location.hash) || [])[1] || store.get('cfg', {}).logToken || store.get('logToken', '')
memoriaNuvem = criarMemoria({
  ler: (k, d) => store.get(k, d),
  gravar: (k, v) => { try { localStorage.setItem('robo.' + k, JSON.stringify(v)) } catch {} },
  log: (t) => pushLog(t),
  acesso: () => ({ token: tokenDaNuvem(), repo: store.get('cfg', {}).logRepo || 'userm4c/robo-logs' }),
})
try { pushLog(`Memória na nuvem ao abrir: ${await memoriaNuvem.aoAbrir()}`) } catch (e) { pushLog('Memória na nuvem: ' + e.message) }

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
// O "cérebro de fora" (IA). No robô de verdade fica no homelab; aqui roda no celular, mas separado:
// só recebe o que o robô manda e devolve respostas prontas.
const servidor = criarServidor(cfg, {
  log: (txt) => pushLog(txt),
  ler: (k, d) => store.get(k, d),
  guardar: (k, v) => store.set(k, v),
  chaveRecusada: (k) => { // anota a chave recusada e tenta a reserva, se houver
    const ruins = store.get('chavesRuins', []); if (!ruins.includes(k)) store.set('chavesRuins', [...ruins, k].slice(-5))
    if (chaveValida(chaveReserva) && chaveReserva !== k) { pushLog(`Chave …${k.slice(-4)} recusada; usando …${chaveReserva.slice(-4)}`); guardarChave(chaveReserva, 'reserva'); chaveReserva = ''; return true }
    return false
  },
  listas: () => ({ gestos: Object.keys(GESTOS), emocoes: EMOCOES, icones: Object.keys(ICONES), emotes: Object.keys(EMOTES), cores: NOME_COR, elementos: ELEMENTOS }),
})
// Chave antiga começa com AIza; as novas do AI Studio (2026) começam com AQ.
const chaveGeminiValida = (k) => /^(AIza[\w-]{30,}|AQ\.[\w.-]{20,})$/.test((k || '').trim())
{ const m = location.hash.match(/gem=(AIza[\w-]+|AQ\.[\w.-]+)/); if (m && m[1] !== cfg.geminiKey) { cfg.geminiKey = m[1]; store.set('cfg', cfg); store.set('geminiKey', m[1]) } }
if (!cfg.geminiKey && store.get('geminiKey', '')) cfg.geminiKey = store.get('geminiKey', '')
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
  if (!dormindo && parado > 120 && (N.energia < 0.15 || (ehNoite() && parado > 300)) ) { if (ehNoite() && temGente()) legendaSempre(`${cfg.nome}: Vou dormir… você devia ir também! Boa noite 😴`, 7000); dormir(ehNoite() ? 'é de noite' : 'sem energia') }
  else if (!dormindo && parado > 1200 && !pessoa.presente) dormir('cochilo')
  else if (!dormindo && luz.escuro && now() - luz.desde > 60000 && parado > 60 && !jogo) dormir('está escuro')
  if (dormindo && !sonoIA && !ehNoite() && !luz.escuro && parado > 60 && ((N.energia > 0.8 && horaDoDia() < 12) || N.energia > 0.95)) { acordar(); setTimeout(() => { iniciarGesto('espreguicar'); somGesto('espreguicar') }, 1300) }
  if (foco && now() > foco.ate) foco = null
  if (icone && now() > icone.ate) icone = null
}

// Comportamentos espontâneos (rodam a cada 1 s). Seleção por utilidade: cada comportamento
// ganha uma nota pelo que ele precisa e pelo jeito dele; sorteia entre os melhores.
let proxCuriosidade = 0, proxComport = now() + 8000
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
    nota: () => (cfg.key && nivelIA === 'ok' && (!temGente() || N.estimulo < 0.35) && papo.estado === 'parado' ? 0.62 + P.curiosidade * 0.3 : 0),
    fazer: () => devanear(),
  },
  decorar: { // perto de uma data comemorativa, decora a tela por conta própria
    cd: 60000,
    nota: () => { const d = dataAtiva(); return d && (!P.deco || P.deco.chave !== d.id + d.ano) ? 1.3 : 0 },
    fazer: () => decorar(),
  },
  desenho_do_dia: { // uma vez por dia, faz um desenho por conta própria
    cd: 30 * 60000,
    nota: () => (cfg.key && nivelIA === 'ok' && temGente() && papo.estado === 'parado' && P.desenhoDia !== hojeSv() ? 0.7 : 0),
    fazer: () => { P.desenhoDia = hojeSv(); store.set('pers', P); fazerDesenho(null, 'Desenho do dia:') },
  },
  presente: { // em alguns dias, um presente surpresa
    cd: 60 * 60000,
    nota: () => { if (P.presenteSorte?.dia !== hojeSv()) P.presenteSorte = { dia: hojeSv(), vai: Math.random() < 0.3 }; return P.presenteSorte.vai && P.presenteDia !== hojeSv() && temGente() && papo.estado === 'parado' && humor.P > 0 ? 0.8 : 0 },
    fazer: () => darPresente(),
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
  mania: { cd: 25 * 60000, nota: () => (P.mania && !brinc && papo.estado === 'parado' ? 0.35 + P.extroversao * 0.2 : 0), fazer: () => fazerMania() },
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
  if (t > proxComport && !foco && !gesto && !gravando && !audio.musica && !jogo && !vad.ativo && !vad.verificando && !palco && !imag.ativo && papo.estado !== 'atento' && !brinc && !alarme && !danca && modoFoco?.fase !== 'foco') {
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

// ================================================================ S3 → C3: a tela pela UART
// O cérebro (S3) não desenha nada. Cada mudança na tela vira uma linha curta de texto para o C3
// (c3.js), como numa UART a 921600 baud (~90 KB/s). O 🐞 mostra o tráfego.
const t0Pagina = now()
const uart = { msgs: 0, bytes: 0, volta: 0, ultimas: [], cont: {}, taxaMsgs: 0, taxaBytes: 0, ant: { msgs: 0, bytes: 0, t: now() } }
const utf8 = new TextEncoder()
const c3 = criarC3($('#face'), { enviar: (linha) => receberDoC3(linha), erro: (onde, e) => erroUmaVez('C3 ' + onde, e) })
function anotarUart(seta, linha) {
  uart.ultimas.unshift(`${((now() - t0Pagina) / 1000).toFixed(1)}s ${seta} ${linha.length > 72 ? linha.slice(0, 72) + '…' : linha}`)
  if (uart.ultimas.length > 12) uart.ultimas.length = 12
}
function enviarC3(linha) {
  uart.msgs++; uart.bytes += utf8.encode(linha).length + 1
  const cmd = linha.split(' ', 1)[0]; uart.cont[cmd] = (uart.cont[cmd] || 0) + 1
  anotarUart('→', linha)
  c3.receber(linha)
}
function receberDoC3(linha) {
  uart.volta += utf8.encode(linha).length + 1; anotarUart('←', linha)
  if (linha.startsWith('TOQUE ')) toque()
}
const batida = (k = 1) => enviarC3(`BATIDA ${k}`)
let gesto = null // {nome, ate}: quem anima é o C3; o cérebro só sabe até quando dura
function iniciarGesto(nome, quieto) {
  if (!GESTOS[nome]) return
  gesto = { nome, ate: now() + GESTOS[nome] }
  enviarC3(nome === 'tremer' ? `GESTO tremer ${forcaTremor.toFixed(2)}` : 'GESTO ' + nome)
  if (!quieto) bus.emit('gesto', { label: nome }, 'Cérebro')
}
let balao = null // {itens, numero, ate}
// O modelo às vezes escreve o nome do ícone de outro jeito ("coração", "olho", "som"): aceita.
const APELIDO_ICONE = { luzes: 'luz', lampada: 'luz', calcula: 'calculadora', camera: 'foto', cameras: 'foto', filmes: 'filme', cansado: 'dormir', sono: 'dormir', olho: 'olhos', som: 'musica', soma: 'mais', codigo: 'computador', aprender: 'cerebro', assobio: 'musica', canto: 'musica', cancao: 'musica', jogar: 'jogo', ideia_brilhante: 'ideia', sol_quente: 'sol', frio: 'neve', amor: 'coracao', feliz: 'sorriso', livros: 'livro', estrela_cadente: 'estrela', arvore_de_natal: 'arvore', natal: 'arvore', comida_gostosa: 'comida' }
function icone_(x) { const k = String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z_]/g, ''); return ICONES[k] ? k : ICONES[APELIDO_ICONE[k]] ? APELIDO_ICONE[k] : null }
const limparIcones = (l) => [...new Set((Array.isArray(l) ? l : []).map(icone_).filter(Boolean))].slice(0, 3)

function alvoExpr() {
  if (dormindo) return now() < olhoSonolentoAte ? 'olho_sonolento' : sono.rem?.tipo === 'pesadelo' ? 'pesadelo' : 'sono'
  if (foco) return foco.expr
  if (audio.musica && P.gostos[audio.estilo] > -0.3) return 'musica'
  return emo.nome
}
// Para onde olhar. O C3 faz sozinho a mola, as microssacadas e as olhadas aleatórias ("auto").
function olharDoCerebro(t, nome) {
  if (dormindo && sono.rem) return 'rem'
  if (bicho.ativo && !dormindo && !imag.ativo) return [clamp((bicho.x - 120) / 110, -1, 1), 0.8] // olhando o bichinho
  if (t < papo.olharAte && !imag.ativo) return [pessoa.presente ? pessoa.x : 0, pessoa.presente ? pessoa.y * 0.8 : 0.05] // olhando para você
  if (imag.ativo?.tipo === 'devaneio' && !dormindo) return [0.55, -0.65] // olhando para a nuvem de pensamento
  let y = null
  if (audio.melodiaAte > t) y = audio.melodiaY
  if (nome === 'pensando') y = -0.7
  if (pessoa.presente && t - pessoa.visto < 1500) return [pessoa.x, y ?? pessoa.y * 0.8]
  return `auto ${(0.5 + P.curiosidade * 0.5).toFixed(2)} ${emo.nome === 'entediado' ? 1 : 0}${y !== null ? ' ' + y.toFixed(2) : ''}`
}
const q2 = (v) => (Math.round(v * 20) / 20).toFixed(2)
const enviado = {}
// Manda só quando muda (é o que faz a UART ficar quase parada com o rosto quieto).
function manter(chave, linha) { if (enviado[chave] !== linha) { enviado[chave] = linha; enviarC3(linha) } }
function sincronizarC3(dt) {
  const t = now(), nome = alvoExpr()
  manter('expr', 'EXPR ' + nome)
  const o = olharDoCerebro(t, nome)
  manter('olhar', 'OLHAR ' + (Array.isArray(o) ? `${q2(o[0])} ${q2(o[1])}` : o))
  manter('atento', 'ATENTO ' + (papo.estado === 'atento' ? 1 : 0))
  manter('sono', 'SONO ' + (dormindo ? 1 : 0))
  manter('treme', 'TREME ' + nivelFrio(clima.temp))
  manter('icone', 'ICONE ' + (icone?.tipo || '-'))
  manter('status', `STATUS ${camera.ligada ? 1 : 0}${vad.ativo ? 1 : 0}${vad.verificando ? 1 : 0}${gravando ? 1 : 0}`)
  manter('humor', cfg.corHumor === false || dormindo ? 'HUMOR -' : `HUMOR ${(Math.round(emo.P * 10) / 10).toFixed(1)} ${(Math.round(emo.A * 10) / 10).toFixed(1)}`)
  if (balao && t > balao.ate) balao = null
  if (balao !== enviado.balao) { enviado.balao = balao; enviarC3(balao ? `BALAO ${Math.max(300, Math.round(balao.ate - t))}|${balao.itens.join(',')}|${String(balao.numero || '').replace(/[|\n]/g, '/')}` : 'BALAO -') }
  if (palco && t > palco.ate) palco = null
  if (palco !== enviado.palco) { enviado.palco = palco; if (palco) enviarC3(palco.desenho ? `DESENHO ${palco.dur} ${palco.saida} ${palco.volta} ${palco.px.join('')}` : `EMOTE ${palco.emote} ${palco.dur} ${palco.saida} ${palco.volta} ${palco.lado}`) }
  manter('acess', 'ACESS ' + (Object.keys(vestido).join(',') || '-'))
  const els = [...(decoracaoAtual() || []), ...(t < festaAte ? [{ el: 'baloes' }, { el: 'confete' }] : [])]
  if (decoNova) { decoNova = false; enviado.moldura = null }
  manter('moldura', 'MOLDURA ' + (els.map((d) => d.el + ':' + (d.cores || []).join('')).join(';') || '-'))
  // Tela embaçada (umidade alta): o cérebro decide quanto; o C3 desenha e limpa.
  const alvoN = clima.umid >= 80 ? clamp((clima.umid - 75) / 20, 0, 1) : 0
  termo.nevoa += (alvoN - termo.nevoa) * Math.min(1, dt * 0.24)
  manter('nevoa', 'NEVOA ' + (termo.nevoa < 0.03 ? '0' : q2(termo.nevoa)))
  if (termo.limpando && termo.limpando !== enviado.limpando) { enviado.limpando = termo.limpando; enviarC3('LIMPAR') }
  if (termo.limpando && t - termo.limpando.t0 > 1800) termo.limpando = null
  // Imaginação: nuvem do devaneio, painel da história, sonho perto do Zzz.
  const a = imag.ativo, passo = a?.hist?.passo || 2300
  const qd = a?.hist?.quadros?.[Math.max(0, Math.floor((t - a.t0) / passo))]
  manter('nuvem', 'NUVEM ' + (a?.tipo === 'devaneio' ? (qd?.icones?.length ? qd.icones.join(',') : '.') : '-'))
  manter('painel', 'PAINEL ' + (a?.tipo === 'contando' && qd && t >= a.t0 ? `${Math.floor((t - a.t0) / passo)} ${a.hist.quadros.length} ${(qd.icones || []).join(',') || '-'}` : '-'))
  const sq = dormindo && sono.rem?.hist ? sono.rem.hist.quadros[Math.floor((t - sono.rem.t0) / 4000) % sono.rem.hist.quadros.length] : null
  manter('sonho', 'SONHO ' + (sq?.icones?.length ? sq.icones.join(',') : '-'))
  if (carneirosAte !== enviado.carneiros) { enviado.carneiros = carneirosAte; if (carneirosAte > t) enviarC3('CARNEIROS ' + Math.round(carneirosAte - t)) }
  // Bichinho: o cérebro anda com ele (para saber para onde olhar); o C3 só fica sabendo quando ele vira.
  const velB = terrario.umid < 50 ? 15 : 36
  if (bicho.ativo) { bicho.x += bicho.dir * velB * dt; if (bicho.x < -14 || bicho.x > 254) bicho.dir *= -1 }
  const chB = bicho.ativo ? `${bicho.dir} ${velB} ${terrario.umid < 50 ? 1 : 0}` : '-'
  if (chB !== enviado.bicho) { enviado.bicho = chB; enviarC3(bicho.ativo ? `BICHO ${Math.round(bicho.x)} ${chB}` : 'BICHO -') }
  const chA = modoFoco && modoFoco.fase !== 'espera' && isFinite(modoFoco.fim) ? `${modoFoco.fase} ${Math.round(modoFoco.fim - modoFoco.ini)}` : '-'
  if (chA !== enviado.anel) { enviado.anel = chA; enviarC3(chA === '-' ? 'ANEL -' : `ANEL ${chA} ${Math.round(modoFoco.fim - t)}`) }
}

const errosVistos = {}
function erroUmaVez(onde, e) { const k = onde + ':' + e.message; if (errosVistos[k]) return; errosVistos[k] = 1; pushLog(`ERRO em ${onde}: ${e.message} ${(e.stack || '').split('\n')[1]?.trim() || ''}`); setTimeout(() => enviarLog('erro'), 2000) }
// Medidor de desempenho (média móvel): quanto custa cada parte. Serve de orçamento para o S3.
const perf = { cerebro: 0, ouvido: 0, tom: 0 }
const media = (a, b) => (a ? a * 0.95 + b * 0.05 : b)
// O cérebro roda num ritmo próprio (20 vezes por segundo), separado da tela.
let tCerebro = now()
function cicloCerebro() {
  const a = performance.now(), t = now(), dt = Math.min(0.1, (t - tCerebro) / 1000); tCerebro = t
  try {
    tickCerebro(dt)
    if (gesto && t > gesto.ate) gesto = null
    sincronizarC3(dt)
  } catch (e) { erroUmaVez('cérebro', e) }
  perf.cerebro = media(perf.cerebro, performance.now() - a)
  if (t - uart.ant.t >= 1000) { const k = 1000 / (t - uart.ant.t); uart.taxaMsgs = media(uart.taxaMsgs, (uart.msgs - uart.ant.msgs) * k); uart.taxaBytes = media(uart.taxaBytes, (uart.bytes - uart.ant.bytes) * k); uart.ant = { msgs: uart.msgs, bytes: uart.bytes, t } }
}
bus.on('beat', () => batida(1))

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
  const base = 880 * (0.9 + P.energia * 0.25) * (op.assobio ? 1.6 : 1) // a "voz" dele (assobio: mais agudo e liso)
  if (op.assobio) op = { ...op, liso: true }
  const t0 = actx.currentTime + 0.05
  let t = t0
  for (let i = 0; i < notas.length; i++) {
    if (notas[i].st === null || notas[i].st === undefined) { t += clamp(notas[i].d / vel, 0.03, 1.2); continue } // pausa
    const n = notas[i], prox = notas[i + 1]?.st != null ? notas[i + 1] : n, d = clamp(n.d / vel, 0.06, 1.2)
    const f0 = base * 2 ** (n.st / 12), f1 = op.liso ? f0 : base * 2 ** ((n.st + (prox.st - n.st) * 0.3) / 12)
    silaba(out, t, f0, f1, d, 'sine', !op.liso && d > 0.25 ? 5 : 0, 0.9)
    t += d + (op.gap ?? 0.015)
  }
  falandoAte = now() + (t - t0) * 1000 + 300
}
// Música do humor: feliz = pentatônica maior e rápida; triste = menor e devagar.
function melodiaInventada() {
  const p = typeof emo === 'undefined' ? 0 : emo.P
  const escala = p < -0.2 ? [0, 3, 5, 7, 10, 12] : [0, 2, 4, 7, 9, 12]
  const ds = p < -0.2 ? [0.25, 0.35, 0.45] : p > 0.3 ? [0.1, 0.14, 0.2] : [0.12, 0.18, 0.25]
  const n = 4 + Math.floor(Math.random() * 4)
  return Array.from({ length: n }, (_, i) => ({ st: i === n - 1 ? 0 : escala[Math.floor(Math.random() * escala.length)], d: ds[Math.floor(Math.random() * 3)] }))
}
// Reduz o canto captado a notas: um ponto a cada ~120 ms, em semitons relativos à mediana.
function notasDoCanto(run) {
  if (run.length < 4) return null
  const st = run.map((p) => 12 * Math.log2(p.f / 440))
  const med = [...st].sort((a, b) => a - b)[Math.floor(st.length / 2)]
  const notas = []
  let ini = run[0].t, soma = 0, cont = 0
  for (let i = 0; i < run.length; i++) {
    if (i > 0 && run[i].t - run[i - 1].t > 150) { // silêncio no meio: vira pausa (guarda o ritmo)
      if (cont) notas.push({ st: clamp(Math.round(soma / cont), -12, 12), d: Math.max(0.08, (run[i - 1].t - ini) / 1000) })
      notas.push({ st: null, d: (run[i].t - run[i - 1].t) / 1000 }); ini = run[i].t; soma = 0; cont = 0
    }
    soma += st[i] - med; cont++
    if (run[i].t - ini >= 120 || i === run.length - 1) { notas.push({ st: clamp(Math.round(soma / cont), -12, 12), d: (run[i].t - ini) / 1000 || 0.12 }); ini = run[i].t; soma = 0; cont = 0 }
  }
  // Junta notas iguais seguidas.
  const out = []
  for (const n of notas) { const u = out[out.length - 1]; if (u && u.st === n.st && n.st !== null) u.d += n.d; else out.push({ ...n }) }
  return out.slice(0, 20)
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
  setInterval(() => { const a = performance.now(); analisar(); perf.ouvido = media(perf.ouvido, performance.now() - a) }, 23)
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
const vad = { modoTVAte: 0, nivel: 0, ativo: false, ini: 0, ultimaFala: 0, chunks: [], pre: [], piso: 0.005, vozes: 0, verificando: false, hora: [], seguirAte: 0 }
function ligarEscuta(src) {
  const proc = actx.createScriptProcessor(4096, 1, 1), mudo = actx.createGain()
  mudo.gain.value = 0
  src.connect(proc); proc.connect(mudo).connect(actx.destination)
  const PRE = Math.ceil(0.6 * actx.sampleRate / 4096)
  proc.onaudioprocess = (e) => {
    const x = new Float32Array(e.inputBuffer.getChannelData(0)), t = now()
    anel.push({ t, x }); while (anel.length && t - anel[0].t > 2500) anel.shift() // para lembrar do som de um susto
    capturar(x, t)
    let q = 0; for (let i = 0; i < x.length; i++) q += x[i] * x[i]
    const rms = Math.sqrt(q / x.length)
    vad.nivel = Math.max(rms, vad.nivel * 0.85)
    const pode = cfg.maosLivres && cfg.key && !gravando && !vad.verificando && !jogo && t > falandoAte && t > conversaAte && !audio.musica && !captura && !brinc?.semVoz
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
    if (papo.estado === 'conversando' && t - vad.ultimaFala > 350 && t - vad.ultimaFala < 520 && t - papo.ultimoAceno > 2500 && !gesto) { papo.ultimoAceno = t; iniciarGesto('aceno', true) }
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
const ALUCINACAO = /obrigad[oa] por assistir|legendas? (pela|por|da)|amara\.org|inscreva-se|se inscreva|tchau,? tchau|robozinho de (mesa|bambu|b[áa]scoa)|conversa em portugu[eê]s|conex[ãa]o em portugu[eê]s|portugu[eê]s do b(rasil|[áa]scoa)/i
// Se a frase não tinha palavras (era cantarolar ou assobio), aí sim ele reage à melodia.
function soltarMelodia(eraFala) {
  const m = vad.melodiaPendente; vad.melodiaPendente = null
  if (!m || eraFala) return
  bus.emit(m.tipo, { label: 'depois de conferir' })
  bus.emit('melodia', { label: `${m.notas.length} notas`, ...m })
}
// É com ele? Nota rápida, sem IA: "você", frase curta e pergunta contam a favor; frase longa,
// jeito de aula/vídeo ("pessoal", "galera") e voz diferente da do dono contam contra.
function pareceComigo(t, outraVoz) {
  const n = t.split(/\s+/).length
  let p = 0
  if (RE_VOCE.test(t) || /(^|\s)(te|tu|teu|tua)(\s|[,.!?]|$)/i.test(t)) p += 2
  if (n <= 12) p += 1
  if (/\?\s*$/.test(t)) p += 1
  if (/(^|\s)(a gente|pra gente|vamos|bora|faz|fa[çc]a|mostra|me (diz|fala|mostra|conta)|joga|jogar|canta|desenha)(\s|[,.!?]|$)/i.test(t)) p += 1
  if (n > 25) p -= 2
  if (/(^|\s)(pessoal|galera|gente|v[ií]deos?|aula|inscrev|canal|t[áa]\?)([\s,.!?]|$)/i.test(t)) p -= 2
  if (outraVoz) p -= 1
  return p >= 1
}
// A voz do dono é aprendida só quando ele chama pelo nome (assim a TV não estraga a referência).
function aprenderVozDono(r) {
  if (!r) return
  const b = P.vozNome, a = b ? Math.max(0.2, 1 / (b.n + 1)) : 1
  P.vozNome = b ? { med: lerp(b.med, r.med, a), n: b.n + 1 } : { med: r.med, n: 1 }
}
const vozDeOutraPessoa = (r) => !!(r && P.vozNome?.n >= 6 && Math.abs(r.med - P.vozNome.med) > 6.5)
// Muita frase que não é com ele em pouco tempo = TV ou vídeo ligado: por 3 min ele ouve menos.
function contarOuvida() {
  const t = now()
  vad.ouvidas = [...(vad.ouvidas || []).filter((x) => t - x < 120000), t]
  if (vad.ouvidas.length >= 4 && t > vad.modoTVAte) { vad.modoTVAte = t + 180000; vad.ouvidas = []; pushLog('Mãos livres: parece TV ou vídeo; por 3 min só confiro frases curtas') }
}
async function fimDaFrase(t) {
  vad.ativo = false
  const chunks = vad.chunks, dur = vad.ultimaFala - vad.ini, resumo = prosoResumo()
  vad.chunks = []
  if (dur < 180 || vad.vozes < 2) { setTimeout(() => soltarMelodia(false)); if (dur >= 150) pushLog(`Mãos livres: descartei um som (${(dur / 1000).toFixed(1)} s, ${vad.vozes} trechos com voz)`); return } // barulho, não voz
  if (now() < vad.modoTVAte && dur > 2500) { setTimeout(() => soltarMelodia(false)); return } // TV/vídeo: só frases curtas ("Bob-e!")
  vad.hora = vad.hora.filter((x) => t - x < 3600000)
  if (vad.hora.length >= 40) { setTimeout(() => soltarMelodia(false)); pushLog('Mãos livres: limite de 40 frases por hora (plano gratuito)'); return }
  vad.hora.push(t)
  vad.verificando = true
  let eraFala = false
  try {
    const texto = await transcrever(paraWav(chunks, actx.sampleRate))
    if (!texto || ALUCINACAO.test(texto) || !/[a-zà-ú]{2}/i.test(texto)) return
    if (/^[\s,.!?…-]*((l[aáã]|n[aã]|t[uú]|t[iíì]|d[uú]|p[aá]|po[mn]|h+m+|m+|ah+|uh+|o+h?)[\s,.!?…-]*){2,}$/i.test(texto)) return pushLog(`(cantarolou: ${texto.slice(0, 40)})`)
    eraFala = true
    const chamado = chamouPeloNome(texto), agora = now(), palavras = texto.split(/\s+/).length
    const vh = () => humorDaVoz(resumo)
    const outraVoz = vozDeOutraPessoa(resumo)
    if (chamado) { // chamou pelo nome
      aprenderVozDono(resumo) // conversa aberta
      abrirConversa()
      if (!chamado.resto) return evento({ label: 'me chamou', P: 0.2, A: 0.4, interesse: 0.85, expr: 'curioso', gesto: 'surpresa', forcarGesto: true, icones: ['olhos', 'pergunta'], social: 0.04, dur: 3000 })
      return await responder(chamado.resto, vh())
    }
    if (papo.estado === 'conversando' && agora < papo.ate) { // no meio da conversa, sem nome: é mesmo com ele?
      if (brinc || alarme || modoFoco?.fase === 'espera' || pareceComigo(texto, outraVoz) || (!outraVoz && respostaLocal(texto)?.acao)) { papo.ouvidas = 0; return await responder(texto, vh()) }
      papo.ouvidas = (papo.ouvidas || 0) + 1
      pushLog(`(na conversa, mas não parece com ele${outraVoz ? ' · voz diferente' : ''}) ${texto.slice(0, 60)}`)
      if (papo.ouvidas >= 2) { Object.assign(papo, { estado: 'parado', olharAte: 0, ouvidas: 0 }); pushLog('Conversa→ terminou (parece TV ou vídeo)') }
      return contarOuvida()
    }
    if (papo.estado === 'atento' && agora < papo.ate) { // ele perguntou "é comigo?"
      const orig = papo.pendente
      if (RE_NAO.test(texto) && palavras <= 5) return naoEraComigo('disseram que não')
      abrirConversa()
      if (RE_SIM.test(texto) && palavras <= 7) return await responder(orig, vh(), { tipo: 'confirmou', original: orig })
      return await responder(texto, vh(), { tipo: 'continuou', original: orig })
    }
    if ((RE_ATENCAO.test(texto) || (RE_VOCE.test(texto) && texto.length < 70)) && !outraVoz && now() > vad.modoTVAte && agora - papo.ultimoAtento > 15000) return ficarAtento(texto)
    if (!outraVoz && palavras <= 18 && respostaLocal(texto)?.acao && /(vamos|bora|quero|me|mim|faz|fa[çc]a|brinc|jog|que m[úu]sica|canta|cante|cantarola|desenha)/i.test(texto)) { abrirConversa(); return await responder(texto, vh()) } // pedido de brincadeira é com ele
    if (!outraVoz && (truqueDaFala(texto) || (medo.esperandoAte && RE_CARINHO_NOITE.test(texto)) || /\b(bebi|tomei)\b.*[áa]gua|\breguei\b/i.test(texto))) return await responder(texto, vh()) // truque, consolo e cuidados não precisam do nome
    pushLog(`(ouviu, não era com ele${outraVoz ? ' · voz diferente' : ''}) ${texto.slice(0, 60)}`)
    contarOuvida()
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
  const ini = performance.now()
  try {
    // Metade das amostras (média de pares = filtro passa-baixa simples): ~4x mais rápido, e o tom (até 3,2 kHz) cabe com folga.
    if (sr > 30000) { const n = buf.length >> 1, meio = detectarTom.buf?.length === n ? detectarTom.buf : (detectarTom.buf = new Float32Array(n)); for (let i = 0; i < n; i++) meio[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5; return detectarTom_(meio, sr / 2) }
    return detectarTom_(buf, sr)
  } finally { perf.tom = media(perf.tom, performance.now() - ini) }
}
function detectarTom_(buf, sr) {
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
  const tons = notas.filter((n) => n.st !== null).length
  if (tons >= 3) ultimaMelodia = { notas, t: now() }
  if (brinc?.melodia) return brinc.melodia(notas)
  if (correcaoMusica && now() < correcaoMusica.ate && tons >= 5) { const nome = correcaoMusica.nome; correcaoMusica = null; return aprenderMusica(nome, notas) }
  const gosto = P.gostos[tipo] || 0
  if (Math.random() < 0.3 + P.extroversao * 0.5 + gosto * 0.2) {
    setTimeout(() => {
      foco = { expr: 'contente', ate: now() + 3000 }; icone = { tipo: 'nota', ate: now() + 3000 }
      // No seu ritmo: às vezes repete igual, às vezes faz a segunda voz, às vezes responde com outra frase no mesmo ritmo.
      const r = Math.random(), assobio = tipo === 'assobio'
      if (r < 0.45) { tocarMelodia(notas, 1, { assobio }); pushLog('Cérebro→ repetiu sua melodia no seu ritmo') }
      else if (r < 0.7) { tocarMelodia(notas.map((n) => (n.st === null ? n : { ...n, st: n.st + 4 })), 1, { assobio }); pushLog('Cérebro→ fez a segunda voz da sua melodia') }
      else {
        const esc = [0, 2, 4, 7, 9, 12], resp = notas.map((n, i) => (n.st === null ? n : { ...n, st: i === notas.length - 1 ? 0 : esc[Math.floor(Math.random() * esc.length)] }))
        tocarMelodia(resp, 1, { assobio }); pushLog('Cérebro→ respondeu sua melodia no mesmo ritmo (duelo!)')
      }
      N.social = clamp(N.social + 0.05, 0, 1)
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
        exp: { sorriso: m2('mouthSmileLeft', 'mouthSmileRight'), boca: bs.jawOpen || 0, sobrancelha: bs.browInnerUp || 0, franzido: m2('browDownLeft', 'browDownRight'), piscou: Math.min(bs.eyeBlinkLeft || 0, bs.eyeBlinkRight || 0), piscE: bs.eyeBlinkLeft || 0, piscD: bs.eyeBlinkRight || 0, biquinho: bs.mouthPucker || 0, bochecha: bs.cheekPuff || 0, bocaLado: (bs.mouthLeft || 0) - (bs.mouthRight || 0), olharBaixo: m2('eyeLookDownLeft', 'eyeLookDownRight') },
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
  rosto.ultimaExp = e; rosto.expT = t
  rosto.sorriso = lerp(rosto.sorriso, e.sorriso, 0.35)
  rosto.franzido = lerp(rosto.franzido, e.franzido, 0.25)
  if (rosto.sorriso > 0.5) {
    if (!rosto.sorrindo) { rosto.sorrindo = true; rosto.sorrisoDesde = t }
    rosto.ultimoSorriso = t
    if (t - rosto.sorrisoDesde > 700 && t - rosto.ultimaReacao > 12000 && !gravando && !jogo) { rosto.ultimaReacao = t; bus.emit('sorriu', { label: `sorriso ${rosto.sorriso.toFixed(2)}` }) }
    imp.P = Math.min(imp.P + 0.008, 0.8) // enquanto você sorri, ele vai ficando contente
  } else if (rosto.sorriso < 0.3) rosto.sorrindo = false
  if (e.boca > 0.45 && e.sobrancelha > 0.45 && t - rosto.ultimaSurpresa > 15000 && !jogo) { rosto.ultimaSurpresa = t; bus.emit('cara_surpresa', { label: '' }) }
  if (e.piscou > 0.55 && !rosto.piscando) { rosto.piscando = true; if (Math.random() < 0.2 + P.afeto * 0.3) setTimeout(() => enviarC3('PISCAR'), rnd(120, 380)) }
  else if (e.piscou < 0.3) rosto.piscando = false
  rosto.hist.push([t, e.sorriso, e.franzido]); while (rosto.hist.length && rosto.hist[0][0] < t - 60000) rosto.hist.shift()
  reconhecerCareta(e, t)
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
  luz.seguidas = (!luz.escuro && escuroAgora) || (luz.escuro && claroAgora) ? (luz.seguidas || 0) + 1 : 0
  if (luz.seguidas < 3) return
  luz.seguidas = 0
  if (!luz.escuro && escuroAgora) { luz.escuro = true; luz.desde = t; bus.emit('luz_apagou', { label: `brilho ${Math.round(luz.nivel)}` }) }
  else if (luz.escuro && claroAgora) { luz.escuro = false; luz.desde = t; luz.base = luz.nivel; bus.emit('luz_acendeu', { label: `brilho ${Math.round(luz.nivel)}` }) }
}
bus.on('luz_apagou', () => {
  if (dormindo || jogo) return
  if ((ehNoite() || horaDoDia() >= 21) && (P.medoEscuro ?? 0) >= 0.25 && temGente()) return comMedoDoEscuro()
  if (ehNoite() || horaDoDia() >= 21) {
    evento({ label: 'apagaram a luz', P: 0, A: -0.4, interesse: 0.5, expr: 'sono', icones: ['lua', 'dormir'], som: 'sono', dur: 3000 })
    setTimeout(() => { if (luz.escuro && !gravando && !jogo && !vad.verificando && !medo.esperandoAte) dormir('apagaram a luz') }, 4000)
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
function toque() { // "TOQUE x y" vindo do C3
  if (!actx) return
  if (tocaAqui) return acertouTocaAqui()
  if (alarme) return concluirAlarme('ok')
  atencaoRecebida()
  const t = now(); toques.push(t); while (toques.length && t - toques[0] > 4000) toques.shift()
  if (toques.length > 6) { evento({ label: 'muito cutucão!', P: -0.4, A: 0.5, D: 0.4, interesse: 0.8, expr: 'bravo', icone: 'exclamacao', som: 'bravo', gesto: 'nao', confianca: -0.03, dur: 2000 }); return }
  evento({ label: 'carinho na cabeça', P: 0.5, A: 0.15, interesse: 0.85, expr: Math.random() < 0.35 ? 'timido' : 'amor', icone: 'coracao', som: 'amor', gesto: Math.random() < 0.3 ? 'piscadela' : null, tipo: 'toque', social: 0.06, confianca: 0.005, dur: 2000 })
  P.afeto = clamp(P.afeto + 0.004, 0.05, 0.95)
}
$('#temp').oninput = (e) => { clima.temp = +e.target.value; $('#tv').textContent = clima.temp; termo.prox = now() + 1500 }
$('#umid').oninput = (e) => { clima.umid = +e.target.value; $('#hv').textContent = clima.umid; termo.prox = now() + 1500 }

// ================================================================ GROQ: conversa
let gravando = false, rec = null, micStream = null
let conversaAte = 0 // enquanto pensa e responde, o ouvido não reage a mais nada
let streamFala = null
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

const transcrever = (blob) => servidor.transcrever(blob)
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
// ---------------------------------------------------------------- fôlego da IA (sono de verdade)
// Quanto ainda resta de "cabeça" no dia: soma o que sobra de cada modelo (o principal pesa mais).
// Com pouco fôlego ele fica sonolento e economiza; sem nenhum, avisa e dorme até recarregar.
const folegoIA = () => servidor.folego()
const voltaDaIA = () => servidor.voltaDaIA()
let nivelIA = 'ok', sonoIA = false, sonoIADesde = 0, ultimoBocejoIA = 0
function tickFolego() {
  if (!actx) return
  const f = folegoIA(), antes = nivelIA
  nivelIA = f <= 0.02 ? 'sem' : f < 0.25 ? 'exausto' : f < 0.5 ? 'cansado' : 'ok'
  if (sonoIA) {
    if (f > 0.25) { // recarregou
      sonoIA = false; pushLog(`IA→ recarregou (fôlego ${Math.round(f * 100)}%)`)
      acordar(); setTimeout(() => { iniciarGesto('espreguicar'); somGesto('espreguicar'); evento({ label: 'recarreguei a cabeça!', P: 0.4, A: 0.4, interesse: 0.8, expr: 'empolgado', icones: ['bateria', 'ok'], dur: 3000, emote: Math.random() < 0.4 ? 'estrela' : null }) }, 1300)
    } else if (!dormindo && now() - sonoIADesde > 6000 && now() - ultimoEvento > 20000 && papo.estado !== 'conversando' && !gravando && !jogo) { sono.touca = true; dormir('cabeça cansada (voltou a dormir)') }
    return
  }
  if (nivelIA !== antes) pushLog(`IA→ fôlego ${Math.round(f * 100)}% (${nivelIA})`)
  if (nivelIA === 'sem') return dormirPorCansaco()
  if (antes === 'ok' && nivelIA === 'cansado') evento({ label: 'minha cabeça tá ficando cansada', P: -0.05, A: -0.3, interesse: 0.4, expr: 'sono', gesto: 'bocejo', forcarGesto: true, icones: ['bateria', 'seta_baixo'], som: 'sono', dur: 3000 })
  // bocejos de vez em quando: mais frequentes quanto menos fôlego
  if ((nivelIA === 'cansado' || nivelIA === 'exausto') && !dormindo && !gesto && !palco && !gravando && now() - ultimoBocejoIA > (nivelIA === 'exausto' ? 45000 : 120000)) {
    ultimoBocejoIA = now(); iniciarGesto('bocejo'); somDe('sono', 0.25); olhoSonolentoAte = now() + 1800
  }
}
function dormirPorCansaco() {
  if (sonoIA) return
  sonoIA = true; sonoIADesde = now()
  const volta = voltaDaIA()
  pushLog(`IA→ sem fôlego: vai dormir até recarregar${volta ? ` (volta em ~${volta})` : ''}`)
  pararImaginacao()
  evento({ label: 'cansei, vou dormir até a cabeça recarregar', P: -0.05, A: -0.5, interesse: 0.6, expr: 'sono', gesto: 'bocejo', forcarGesto: true, icones: ['dormir', 'ampulheta'], numero: volta, som: 'sono', dur: 4000 })
  legenda(`${cfg.nome}: Tô sem energia na cabeça… vou dormir e volto${volta ? ` em uns ${volta}` : ' mais tarde'}.`)
  setTimeout(() => { sono.touca = true; dormir('cabeça cansada'); sono.proxREM = Infinity }, 4500)
}
// Dormindo de cansaço: abre um olho, mostra quanto falta e volta a dormir. Coisas simples ele ainda responde.
function respostaSonolenta(text) {
  pushLog(`Você: ${text}`); legenda(`Você: ${text}`)
  const loc = respostaLocal(text), volta = voltaDaIA()
  olhoSonolentoAte = now() + 3500
  balao = { itens: loc?.icones?.length ? loc.icones : ['dormir', 'ampulheta'], numero: loc ? String(loc.numero || '').replace(/\{(hora|data|temp|umid)\}/, (_, x) => ({ hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), data: new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'numeric' }), temp: clima.temp + '°', umid: clima.umid + '%' }[x])) : volta, t0: now(), ate: now() + 4000 }
  somDe('sono', 0.3)
  pushLog(`${cfg.nome}: ${loc ? loc.pensamento + ' (sonolento)' : `zzz… tô recarregando${volta ? ', volto em ' + volta : ''}`}`)
  legenda(`${cfg.nome}: ${loc ? loc.pensamento : `zzz… tô recarregando${volta ? ', volto em ' + volta : ''}`}`)
  if (loc?.acao === 'cantar') setTimeout(cantarMusica, 1500)
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
// Respostas na hora, sem IA, para frases simples (economiza a cota e é mais rápido).
// "Desenhe outro gato melhor" → "gato"; "Eu pedi um gato, você desenhou uma casa? Desenhe um gato." → "gato"
function temaDoDesenho(texto) {
  const pedidos = [...String(texto).matchAll(/desenh(?:a|e|ar)\b\s*(?:pra mim\s+|para mim\s+)?(.*?)(?=[.?!,;]|$)/gi)]
  const ult = pedidos.length ? pedidos[pedidos.length - 1][1] : ''
  return ult.replace(/^(um|uma|o|a|outro|outra|de novo|novamente)\s+/i, '').replace(/^(um|uma|o|a)\s+/i, '').replace(/\s+(melhor|de novo|novamente|pra mim|para mim|por favor|a[ií])$/i, '').replace(/\s+(melhor|de novo)$/i, '').trim()
}
function verDesenho(pedido) {
  const lista = P.desenhos || []
  if (!lista.length) return evento({ label: 'ainda não desenhei nada', gesto: 'nao_sei', forcarGesto: true, icones: ['ideia', 'pergunta'], interesse: 0.4, dur: 2500 })
  const ps = txtN(pedido).replace(/inho|inha/g, 'o').split(/[^a-z]+/).filter((w) => w.length > 2)
  const d = lista.find((x) => ps.some((w) => txtN(x.tema + ' ' + x.titulo).replace(/inho|inha/g, 'o').includes(w))) || lista[0]
  mostrarDesenho(d, 'Olha o desenho:')
}
function respostaLocal(texto) {
  const t = texto.trim().toLowerCase(), n = t.split(/\s+/).length
  if (n > 16) return null
  const v = (...l) => l[Math.floor(Math.random() * l.length)]
  const b = { intensidade: 0.6, numero: '', afeto: 0, lembrar: '', importancia: 1, acao: '', emote: '', espera_resposta: false, icones: [] }
  if (/que horas|hor[áa]rio|horas s[ãa]o/.test(t)) return { ...b, gesto: 'nenhum', emocao: 'contente', icones: ['relogio'], numero: '{hora}', pensamento: v('Olha a hora aqui.', 'Tá aqui!') }
  if (/que dia [ée] hoje|qual (é )?a data|dia de hoje/.test(t) && n <= 12) return { ...b, gesto: 'nenhum', emocao: 'contente', icones: ['calendario'], numero: '{data}', pensamento: 'Hoje é esse dia.' }
  if (/temperatura|quantos graus/.test(t) && n <= 10) return { ...b, gesto: 'nenhum', emocao: clima.temp >= 28 || clima.temp <= 18 ? 'entediado' : 'contente', icones: ['termometro'], numero: '{temp}', pensamento: clima.temp >= 28 ? 'Tá quente!' : clima.temp <= 18 ? 'Tá friozinho…' : 'Tá gostoso.' }
  if (n <= 18 && !/como funciona|como (se )?joga|quais (s[ãa]o )?as regras|me explica/.test(t)) {
    const ac = (acao, icones, pensamento, extra = {}) => ({ ...b, gesto: 'pulinhos', emocao: 'empolgado', icones, pensamento, acao, ...extra })
    if (/jogo da velha|jogar velha|velhinha/.test(t)) return ac('velha', ['jogo'], 'Bora!')
    if (/que m[úu]sica [ée] essa|qual (é )?(a|essa) m[úu]sica|reconhec\w* (a|essa) m[úu]sica|sabe (que|qual) m[úu]sica/.test(t)) return ac('qual_musica', ['ouvido', 'musica'], 'Deixa eu ouvir!', { gesto: 'nenhum', emocao: 'curioso' })
    if (/adivinha (o|esse|um) (som|barulho)|jogo d[oe]s? sons?|adivinhar sons?/.test(t)) return ac('adivinha_som', ['ouvido', 'pergunta'], 'Escuta só!')
    if (/genius|mem[óo]ria (de|das) cores|jogo das cores|sequ[êe]ncia de cores/.test(t)) return ac('genius', ['jogo'], 'Presta atenção!')
    if (/hist[óo]ria (a dois|juntos|com voc[êe]|comigo)|(inventar|criar|fazer) uma hist[óo]ria (juntos|com)|vamos (inventar|criar) uma hist/.test(t)) return ac('historia_dupla', ['livro', 'ideia'], 'Eu começo!')
    if (/karaok[êe]|continua a m[úu]sica|completa a m[úu]sica|eu continuo/.test(t)) return ac('karaoke', ['musica', 'jogo'], 'Bora!')
    if (/placar|como (est[áa]|t[áa]) o jogo|quanto (est[áa]|t[áa]) o jogo|o jogo (do|de hoje)|deu o jogo/.test(t) && P.time) return ac('placar', ['futebol'], 'Deixa eu ver!', { gesto: 'nenhum', emocao: 'curioso' })
    { const can = /(cant|cantarol|assobi|toca)/.test(t) && CANCOES.find((c) => c.alias.split('|').some((a) => txtN(t).includes(a)))
      if (can) return ac('cantar_musica', ['musica'], 'Essa eu sei!', { gesto: 'dancinha', musica: can.nome }) }
    { const mm = /(?:^|\s)(?:canta|cante|cantarola|cantarole|assobia|assobie)(?: (?:pra mim|para mim|a m[úu]sica|a can[çc][ãa]o|aquela))* (.{3,60})/.exec(t)
      if (mm && !/^(uma|alguma|qualquer|algo|um pouco|de novo|outra|mais|pra mim)\b/.test(mm[1])) return ac('cantar_musica', ['musica'], 'Lá vai!', { gesto: 'dancinha', musica: mm[1].replace(/[.!?]+$/, '') }) }
    if (/charada/.test(t)) return ac('charada', ['jogo'], 'Bora!')
    if (/(20|vinte) perguntas/.test(t)) return ac('vinte_perguntas', ['pergunta'], 'Pensei numa coisa!')
    if (/quiz|jogo de (soma|conta|matem)|jogo da (soma|conta)/.test(t)) return ac('quiz', ['calculadora'], 'Vamos fazer contas!')
    if (/(me )?imita (eu|o que eu|a minha)|me imita/.test(t)) return ac('imita_eu', ['olhos'], 'Vou te imitar!')
    if (/careta/.test(t)) return ac('careta', ['olhos'], 'Imita a careta!')
    if (/palma|ritmo/.test(t) && /jog|brinc|vamos|bora|ritmo/.test(t)) return ac('ritmo', ['musica'], 'Escuta o ritmo!')
    if (/esconde/.test(t)) return ac('esconde', ['olhos'], 'Vou contar!')
    if (/pedra|jokenp|jo ken p/.test(t)) return ac('ppt', ['jogo'], 'Melhor de 3!')
    if (/desenho/.test(t) && /(mostr|de novo|novamente|outra vez|ver o|v[êe] o|lembra)/.test(t) && !/(outro|outra|melhor|novo desenho|faz|fa[çc]a|desenhe)/.test(t)) return ac('ver_desenho', ['ideia'], 'Olha!', { tema: t })
    if (/(^|\s)desenh/.test(t)) return ac('desenhar', ['ideia'], 'Vou desenhar!', { tema: temaDoDesenho(texto) })
    if (/(^|\s)dan[çc]a/.test(t)) return ac('dancar', ['musica'], 'Bora dançar!')
    if (/di[áa]rio|nosso dia|resumo do dia/.test(t)) return ac('diario', ['livro'], 'Olha nosso dia!')
    if (/not[íi]cia/.test(t)) return ac('noticias', ['mundo'], 'Vou ver!')
    if (/para(r)? (o )?foco|terminei (o|de) trabalh|acabei (o|de) trabalh/.test(t)) return ac('parar_foco', ['ok'], 'Fim do foco!')
    if (/modo foco|pomodoro|vou (trabalhar|estudar)|me ajuda a focar/.test(t)) return ac('foco', ['trabalho'], 'Foco!')
    if (/vai chover|previs[ãa]o|como (vai |est[áa] |t[áa] |[ée] que (est[áa]|t[áa]) )?o (tempo|clima)|(tempo|clima) l[áa] fora|vai fazer (sol|frio|calor)/.test(t)) return ac('tempo', ['nuvem'], 'Deixa eu ver…', { gesto: 'nenhum', emocao: 'curioso' })
    if (/[áa]lbum|figurinha/.test(t)) return ac('album', ['livro'], 'Olha meu álbum!')
    if (/quantos dias (voc[êe] tem|de vida)|sua idade|quantos anos voc[êe] tem/.test(t)) return { ...b, gesto: 'pulinhos', emocao: 'orgulhoso', icones: ['bolo', 'calendario'], numero: `${diasDeVida()}d`, pensamento: `Tenho ${diasDeVida()} dia(s) de vida!` }
  }
  if (n > 7) return null
  if (/umidade/.test(t)) return { ...b, gesto: 'nenhum', emocao: 'contente', icones: ['agua'], numero: '{umid}', pensamento: 'Umidade do ar.' }
  if (/^boa noite/.test(t) && n <= 4) return { ...b, gesto: 'nenhum', emocao: 'sono', icones: ['lua', 'dormir'], pensamento: 'Boa noite!', acao: 'boa_noite' }
  if (/^(oi+|ol[áa]|e a[ií]|eae|opa|bom dia|boa tarde)([\s,!.?]|$)/.test(t) && n <= 4) return { ...b, gesto: v('pulinhos', 'sim', 'piscadela'), emocao: v('feliz', 'empolgado', 'contente'), icones: v(['ok'], ['coracao'], ['sorriso'], ['sol']), pensamento: v('Oi!', 'Oiê!', 'Eba, você!'), afeto: 0.01 }
  if (/^tudo (bem|bom|certo|joia)[?!.]*$/.test(t)) return { ...b, gesto: 'sim', emocao: humor.P > 0 ? 'feliz' : 'contente', icones: v(['ok'], ['ok', 'coracao']), pensamento: 'Tudo ótimo!' }
  if (/^(muito )?(obrigad[oa]|valeu|brigad)/.test(t)) return { ...b, gesto: 'timido', emocao: 'timido', icones: ['coracao'], pensamento: 'De nada!', afeto: 0.01 }
  if (/(^|\s)(canta|cantarola)(\s|$)/.test(t)) return { ...b, gesto: 'dancinha', emocao: 'empolgado', icones: ['musica'], pensamento: 'Lá vai!', acao: 'cantar' }
  if (/jogo da melodia/.test(t)) return { ...b, gesto: 'pulinhos', emocao: 'empolgado', icones: ['musica', 'jogo'], pensamento: 'Bora!', acao: 'jogo_melodia' }
  if (/toca aqui|bate aqui/.test(t)) return { ...b, gesto: 'nenhum', emocao: 'empolgado', icones: [], pensamento: 'Toca aqui!', acao: 'toca_aqui' }
  if (/(conta|me conta).*(hist[óo]ria|sonh|imagin)|o que (voc[êe] )?(sonhou|imaginou)/.test(t)) return { ...b, gesto: 'pulinhos', emocao: 'empolgado', icones: ['livro'], pensamento: 'Olha só!', acao: 'contar_historia' }
  return null
}

async function responder(text, vh, contexto) {
  if (alarme && dormindo) acordar()
  if (sonoIA && !alarme) return respostaSonolenta(text)
  if (interceptarFala(text)) return
  abrirConversa()
  const ctx = contexto || papo.contexto, tPergunta = now(); papo.contexto = null
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
    const situacao = `SITUAÇÃO AGORA (vale só para esta resposta):
${sobreDeco ? `- Se ${cfg.dono} der uma ideia para a decoração da tela (desta data ou de outra data comemorativa), preencha "sugestao" com o id da data, a ideia e, se souber, elementos e cores; senão deixe "sugestao" com tudo vazio.` : '- Deixe "sugestao" com tudo vazio.'}
${sobreAniv ? `- Se ${cfg.dono} disser o dia do aniversário dele(a), preencha "aniversario_dono" com "DD/MM"; senão "".` : '- "aniversario_dono": "".'}
${contextoTexto(ctx)}

Agora: ${quando}. Aqui dentro (seu sensor): ${clima.temp} °C, umidade ${clima.umid} % — isso NÃO é o tempo lá fora; para o tempo lá fora use "acao": "tempo". ${audio.musica ? `Está tocando música ${audio.estilo} (${audio.bpm} BPM).` : ''}
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
${textoPrevisao()}${terrario.ativo ? `\nSeu terrário agora (sensor${terrario.simulado === false ? '' : ' simulado'}): ${terrario.temp} °C, umidade ${terrario.umid} %${terrario.umid < 50 ? ' (seco!)' : ''}. Fale dele só com esses dados; não invente.` : ''}${brinc ? `\nVocês estão brincando de: ${brinc.tipo}.` : ''}${modoFoco ? `\n${cfg.dono} está em modo foco (${modoFoco.fase}).` : ''}

${sobreDeco ? `DATAS (ids): ${DATAS.map((d) => `${d.id} (${nomeData(d.id)})`).join(', ')}
ELEMENTOS de decoração: ${ELEMENTOS.join(', ')}. CORES: ${Object.entries(NOME_COR).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}

`
    const extraSono = nivelIA === 'exausto' ? '\nVocê está MUITO sonolento (sua cabeça está quase sem energia): responda bem curtinho, com sono, e pode bocejar.' : nivelIA === 'cansado' ? '\nVocê está meio sonolento hoje.' : ''
    const loc0 = respostaLocal(text), loc = (!ctx || loc0?.acao) && loc0
    let r
    if (loc) { r = { j: loc, bruto: JSON.stringify(loc), modelo: 'local', usage: { total_tokens: 0 } }; servidor.registrarTroca(text, loc); servidor.anotarUso('local', 1) }
    else r = await servidor.conversar(text, situacao + extraSono, nivelIA === 'exausto' ? 'fundo' : 'conversa')
    const j = r.j, bruto = r.bruto
    const demora = (now() - tPergunta) / 1000
    if (demora > 30) { pushLog(`IA: resposta chegou atrasada (${Math.round(demora)} s); mostro sem fazer a ação "${j.acao || ''}"`); j.acao = '' }
    if (/como funciona|como (se )?joga|quais (s[ãa]o )?as regras|me explica/i.test(text)) j.acao = '' // pergunta sobre o jogo: explica, não começa
    pushLog(`IA (${servidor.curto(r.modelo || cfg.model)} · ${r.usage?.total_tokens ?? '?'} tokens${r.usage?.prompt_tokens_details?.cached_tokens ? `, ${r.usage.prompt_tokens_details.cached_tokens} do cache` : ''}): ${bruto.slice(0, 300)}`)
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
    if (j.espera_resposta && j.pensamento && !cfg.legenda) legendaSempre(`${cfg.nome}: ${j.pensamento}`, 8000) // pergunta precisa de palavras
    if (j.espera_resposta) setTimeout(() => { if (!palco && !imag.ativo) { foco = { expr: 'curioso', ate: now() + 6000 }; icone = { tipo: '?', ate: now() + 6000 } } }, 4800)
    if (j.emote && EMOTES[j.emote] && now() - ultimoEmote > 20000) setTimeout(() => mostrarEmote(j.emote), 200)
    if (ctx?.tipo === 'som') { if (j.som_significado) aprenderSom(ctx.somId, j.som_significado, icns); else if ((ctx.tentativas || 0) < 1) papo.contexto = { ...ctx, tentativas: (ctx.tentativas || 0) + 1 } }
    if (j.opiniao_deco === 'gostou' || j.opiniao_deco === 'nao_gostou') opiniaoDeco(j.opiniao_deco)
    if (j.sugestao?.ideia) receberSugestao(j.sugestao)
    P.conversas = (P.conversas || 0) + 1
    if (!j.acao && /cochil|dormir um pouco|descansar um pouco/i.test(j.pensamento || '') && /(sim|vou|tá|ta|ok)/i.test(j.pensamento || '') && !/n[ãa]o/i.test(j.pensamento || '')) j.acao = 'cochilar'
    if (v[0] > 0.2) P.confianca = clamp(P.confianca + 0.004, 0.05, 0.95) // conversa boa aumenta a confiança
    if (j.lembrete?.quando) { // lembrete entendido pela IA (quando o robô sozinho não entendeu a hora)
      const q = String(j.lembrete.quando), m1 = /^\+(\d+)/.exec(q), m2 = /^(\d{1,2}):(\d{2})$/.exec(q)
      let quando = m1 ? Date.now() + +m1[1] * 60000 : null
      if (m2) { const d = new Date(); d.setHours(+m2[1], +m2[2], 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); quando = d.getTime() }
      if (quando) setTimeout(() => criarLembrete({ quando, tipo: /acord|despert/i.test(text) ? 'despertar' : 'lembrete', texto: String(j.lembrete.texto || 'o lembrete').slice(0, 80) }), 2500)
    }
    else if (sobreDeco && /(^|\s)(coloca|coloque|colocar|adiciona|adicione|adicionar|p[õo]e|p[õo]r|bota|botar|acrescenta|acrescente|faz|fa[çc]a|enfeita|enfeite|decora|decore)(\s|$)/i.test(text) && !/(gostei|adorei|amei|lind[oa]|bonit|legal|ficou)/i.test(text)) receberSugestao({ data: dataAtiva()?.id || '', ideia: text.slice(0, 100), elementos: [], cores: [] })
    if (/^\d{1,2}\/\d{1,2}$/.test(j.aniversario_dono || '') && P.anivDono !== j.aniversario_dono) { P.anivDono = j.aniversario_dono; lembrar(`O aniversário de ${cfg.dono} é ${j.aniversario_dono}`, 8); store.set('pers', P) }
    if (ctx?.tipo === 'pesadelo' && v[0] > 0.2) { P.confianca = clamp(P.confianca + 0.02, 0.05, 0.95); lembrar(`${cfg.dono} me consolou depois de um pesadelo`, 7) }
    if (/^(quiz|charada|vinte_perguntas|careta|imita_eu|ritmo|esconde|ppt|velha|genius|adivinha_som|karaoke|historia_dupla)$/.test(j.acao || '')) j.numero = ''
    const ACAO_COMBINA = { cochilar: /cochil|dorm|descans|sono|cansad/i, ver_desenho: /desenh/i, charada: /charad|advinh|adivinh|emoji/i, vinte_perguntas: /(20|vinte) perguntas|adivinha (o que|qual)|pensa (numa|em uma) coisa/i, quiz: /quiz|conta|soma|matem/i, careta: /careta|imit/i, imita_eu: /imit/i, ritmo: /palma|ritmo/i, esconde: /escond/i, ppt: /pedra|papel|tesoura|jokenp/i, velha: /velha|jogo da/i, adivinha_som: /som|barulh|adivinh/i, genius: /genius|cor|mem[óo]ria/i, historia_dupla: /hist[óo]ria/i, karaoke: /karaok|continu|complet|m[úu]sica/i, qual_musica: /m[úu]sica|can[çc][ãa]o|toca|ouv/i, cantar_musica: /cant|assobi|toca|m[úu]sica/i, placar: /jogo|placar|time|gol|futebol/i, desenhar: /desenh|pint|rabisc/i, dancar: /dan[çc]/i, diario: /di[áa]rio|dia/i, noticias: /not[íi]cia|aconteceu|novidade/i, foco: /foco|trabalh|estud|pomodoro|concentr/i, parar_foco: /foco|terminei|acabei|parar/i, tempo: /chov|chuva|tempo|previs|sol|frio|calor/i, album: /[áa]lbum|figurinha/i, cantar: /cant|m[úu]sica|melodia/i, jogo_melodia: /jog|brinc|melodia/i, repetir_som: /barulh|som|assust/i, contar_historia: /(conta|conte|contar|me fala|quero ouvir|outra|mais uma).*(hist|sonh|imagin)|o que (voc[êe] )?(sonhou|imaginou)/i, boa_noite: /noite|dorm|cochil|sono/i, toca_aqui: /toca|bate|m[ãa]o/i, devanear: /imagin|invent|devane|sonh/i, decorar: /decor|enfeit|natal|festa/i }
    if (j.acao && ACAO_COMBINA[j.acao] && !ACAO_COMBINA[j.acao].test(text)) { pushLog(`IA: ação "${j.acao}" ignorada (não combina com a frase)`); j.acao = '' }
    const acoes = { cochilar: () => { dormir('cochilo que você pediu'); sono.cochiloAte = now() + 10 * 60000; sono.proxREM = now() + 4 * 60000 }, ver_desenho: () => verDesenho(j.tema || text), charada: brincCharada, vinte_perguntas: brincVinte, quiz: brincQuiz, careta: brincCareta, imita_eu: brincImitaEu, ritmo: brincRitmo, esconde: brincEsconde, ppt: brincPPT, velha: brincVelha, adivinha_som: brincAdivinhaSom, genius: brincGenius, historia_dupla: brincHistoria2, karaoke: brincKaraoke, qual_musica: () => qualMusica('pedido'), cantar_musica: () => cantarMusicaPedida(j.musica || text), placar: () => conferirJogo('pedido'), desenhar: () => fazerDesenho(j.tema || ''), dancar, diario: mostrarDiario, noticias: noticiasEmEmojis, foco: () => comecarFoco(), parar_foco: pararFoco, tempo: () => falarDoTempo(text), album: mostrarAlbum, cantar: cantarMusica, jogo_melodia: iniciarJogo, repetir_som: repetirUltimoSom, contar_historia: () => contarHistoria(), boa_noite: ritualBoaNoite, toca_aqui: comecarTocaAqui, devanear: () => devanear(true), decorar: () => decorar(true) }
    if (acoes[j.acao]) setTimeout(acoes[j.acao], r.modelo === 'local' ? 1200 : j.acao === 'toca_aqui' ? 2000 : 2600)
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
  const v26 = estadoV26(); if (v26) out.push(v26)
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
  if (!cfg.key || refletindo || (!forcar && folegoIA() < 0.5)) return
  const diaPassou = Date.now() - (P.ultimaReflexao || 0) > 20 * 3600000
  if (!forcar && !(impDesdeReflexao >= 40 || (diaPassou && memorias.length >= 5))) return
  refletindo = true
  try {
    const mem = lembrancas(25).map((m) => `- [${new Date(m.t).toLocaleDateString('pt-BR')}] ${m.tipo === 'reflexao' ? '(reflexão) ' : ''}${m.txt} (importância ${m.imp})`).join('\n')
    const j = await servidor.refletir({
      personalidade: `extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, energia ${P.energia.toFixed(2)}, sensibilidade ${P.sensibilidade.toFixed(2)}, afeto ${P.afeto.toFixed(2)}, confiança ${P.confianca.toFixed(2)}`,
      gostos: Object.entries(P.gostos).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '), opiniao: P.opiniao, lembrancas: mem ? mem.split('\n') : [],
    })
    for (const txt of (j.reflexoes || []).slice(0, 3)) { lembrar(String(txt).slice(0, 200), 8, 'reflexao'); pushLog('Diário: ' + txt) }
    if (j.opiniao) P.opiniao = String(j.opiniao).slice(0, 200)
    for (const [k, v] of Object.entries(j.ajustes || {})) if (['extroversao', 'curiosidade', 'energia', 'sensibilidade'].includes(k)) evoluir(k, clamp(+v || 0, -0.03, 0.03))
    P.ultimaReflexao = Date.now(); impDesdeReflexao = 0; store.set('impReflexao', 0); store.set('pers', P)
  } catch (e) {
    pushLog('Reflexão: ' + e.message.slice(0, 200))
  } finally { refletindo = false }
}
setInterval(() => refletir(), 300000)
setTimeout(() => refletir(), 20000)

// ================================================================ S3: PALCO (emotes, acessórios, moldura)
// Quem desenha é o C3 (c3.js). Aqui o cérebro só decide o que mostrar e até quando.
let palco = null // {emote, dur, saida, volta, lado, px?, desenho?, ate}
const sorteia = (l) => l[Math.floor(Math.random() * l.length)]
let ultimoEmote = -1e9
function mostrarEmote(nome, dur = 1900, op = {}) {
  if (!(EMOTES[nome] || op.px) || palco || dormindo) return false
  palco = { emote: nome, dur, saida: op.saida || sorteia(SAIDAS), volta: op.volta || sorteia(SAIDAS), lado: Math.random() < 0.5 ? -1 : 1, px: op.px, desenho: op.desenho, ate: now() + 340 + dur + 420 }
  ultimoEmote = now()
  setTimeout(() => somDe(op.desenho ? 'feliz' : EMOTES[nome].som, 0.6), 330)
  bus.emit('emote', { label: `${nome} (${palco.saida} → ${palco.volta})` }, 'C3')
  return true
}
// Acessórios vestidos agora (nome → desde quando).
const vestido = {}
function vestir(nome, sim) {
  if (sim && !vestido[nome]) { vestido[nome] = now(); pushLog('C3→ vestiu ' + nome) }
  else if (!sim && vestido[nome]) { delete vestido[nome]; pushLog('C3→ tirou ' + nome) }
}
let decoNova = false // pede para o C3 refazer a entrada da moldura

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
  if (nova) { pushLog('Conversa→ começou'); saudadeProporcional(); talvezBomDia() }
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
function epoca() {
  const d = dataAtiva(), h = hojeData(), m = h.getMonth()
  const estacao = m === 11 || m <= 1 ? 'verão' : m <= 4 ? 'outono' : m <= 7 ? 'inverno' : 'primavera'
  return `${estacao} no Brasil${d ? `, perto de ${d.nome}` : ''}`
}
async function imaginar(tipo) {
  if (!cfg.key) return null
  const dia = new Date().toLocaleDateString('sv')
  if (imagHoje.dia !== dia) imagHoje = { dia, n: 0 }
  if (imagHoje.n >= 14 || (folegoIA() < 0.5 && !['forcado', 'diario'].includes(tipo))) return null
  imagHoje.n++; store.set('imagHoje', imagHoje)
  if (tipo === 'forcado') tipo = 'devaneio'
  try {
    const j = await servidor.imaginar({
      tipo, epoca: epoca(), tema: P.hobby && Math.random() < 0.4 ? P.hobby.tema : sorteia(TEMAS_IMAG),
      personalidade: `extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, afeto ${P.afeto.toFixed(2)}`,
      gostos: Object.entries(P.gostos).filter(([, v]) => v > 0.2).map(([k]) => k).join(', '),
      titulosAnteriores: memorias.filter((m) => m.historia).slice(0, 6).map((m) => m.historia.titulo),
      acontecimentos: acontecimentos.slice(0, 6).map((a) => a.txt), lembrancas: lembrancas(10).map((m) => m.txt),
    })
    const quadros = (j.quadros || []).map((q) => ({ icones: limparIcones(q.icones), emocao: EMOCOES.includes(q.emocao) ? q.emocao : 'curioso' })).filter((q) => q.icones.length).slice(0, 4)
    if (!quadros.length) return null
    const h = { tipo, titulo: String(j.titulo || '').slice(0, 60), resumo: String(j.resumo || '').slice(0, 240), tom: j.tom || 'doce', quadros }
    pushLog(`Imaginação→ ${tipo}: ${h.titulo} · ${h.quadros.map((q) => q.icones.map((x) => ICONES[x]).join('')).join(' | ')}`)
    return h
  } catch (e) { pushLog('Imaginação: ' + e.message); return null }
}
function guardarHistoria(h) {
  if (!h) return
  const rot = { devaneio: 'Imaginei', sonho: 'Sonhei', pesadelo: 'Tive um pesadelo', diario: 'Nosso dia' }[h.tipo]
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
async function contarHistoriaNova() { // pediram uma história e não há nenhuma nova: inventa agora
  if (!cfg.key || folegoIA() < 0.25) return evento({ label: 'já te contei todas as minhas histórias', P: 0.1, interesse: 0.4, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, icones: ['livro', 'ok'], dur: 2500 })
  foco = { expr: 'pensando', ate: now() + 8000 }; icone = { tipo: 'reticencias', ate: now() + 8000 }
  const h = await imaginar('forcado')
  foco = null; icone = null
  if (!h) return evento({ label: 'não consegui inventar agora', gesto: 'nao_sei', forcarGesto: true, icones: ['livro'], interesse: 0.4, dur: 2000 })
  h.tipo = 'devaneio'; guardarHistoria(h); contarHistoria(memorias[0])
}
function contarHistoria(m = historiaParaContar()) {
  if (!m?.historia) return contarHistoriaNova()
  ultimaVez.contar_historia = now()
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
  const i = Math.floor((now() - a.t0) / (a.hist.passo || 2300))
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
    if (q.frase) legendaSempre(q.frase, (a.hist.passo || 2300) + 400)
  }
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
  if (!dormindo) { sono.rem = null; sono.cochiloAte = 0; return }
  if (sono.cochiloAte && now() > sono.cochiloAte) { sono.cochiloAte = 0; acordar(); setTimeout(() => { iniciarGesto('espreguicar'); somGesto('espreguicar') }, 1300); return }
  if (!sono.rem && t > sono.proxREM && cfg.key) comecarREM()
  const r = sono.rem; if (!r) return
  // falar dormindo (bipes bem baixinhos) e mexidinhas
  if (Math.random() < 0.04) { batida(0.4); somDe(r.tipo === 'pesadelo' ? 'triste' : 'contente', 0.12) }
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
  vestir('guarda_chuva', (U >= 90 || now() < (termo.guardaAte || 0)) && !dormindo); vestir('touca', dormindo && sono.touca)
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
  { id: 'natal', nome: 'o Natal', quando: (a) => new Date(a, 11, 25, 12), antes: 50, depois: 1, deco: [{ el: 'arvore' }, { el: 'luzes' }, { el: 'neve' }] },
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
  if (P.deco?.data === 'natal' && !P.deco.elementos.some((e) => e.el === 'arvore')) { P.deco.elementos.unshift({ el: 'arvore', cores: [] }); store.set('pers', P) }
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
  store.set('pers', P); decoNova = true
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
  P.deco.elementos = P.deco.elementos.slice(-5); sug.estado = 'usada'; store.set('pers', P); decoNova = true
  evento({ label: `coloquei sua ideia: ${sug.ideia}`, P: 0.35, A: 0.3, interesse: 0.7, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, icones: ['ok', 'presente'], dur: 2500 })
}
async function pesquisarIdeia(sug) {
  try {
    pushLog(`Datas→ pesquisando "${sug.ideia}"…`)
    const j = await servidor.pesquisarIdeia({ ocasiao: nomeData(sug.data), ideia: sug.ideia })
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
  const can = sorteia(CANCOES), opcoes = [P.melodia, melodiaDoDia(), melodiaInventada(), mes >= 10 ? JINGLE : VERAO, partitura(can.n, can.bpm)].filter(Boolean)
  const m = Math.random() < 0.5 ? opcoes[opcoes.length - 1] : opcoes[Math.floor(Math.random() * opcoes.length)]
  foco = { expr: 'contente', ate: now() + 5000 }; icone = { tipo: 'nota', ate: now() + 5000 }
  iniciarGesto('dancinha'); tocarMelodia(m, 1.05)
  const deCaderno = m === opcoes[opcoes.length - 1]
  if (deCaderno) legendaSempre(`${cfg.nome}: ♪ ${can.nome}`, duracao(m) * 1000 + 2000)
  pushLog(`Cérebro→ cantou (${m === JINGLE ? 'Jingle Bells' : m === P.melodia ? 'a melodia favorita' : m === VERAO ? 'música de verão' : deCaderno ? can.nome : 'uma melodia inventada'})`)
}
function ritualBoaNoite() {
  if ((P.medoEscuro ?? 0) > 0) { P.medoEscuro = clamp(P.medoEscuro - 0.04, 0, 1); store.set('pers', P) } // boa noite com carinho tira um pouquinho do medo
  pararImaginacao(); sono.touca = true; vestir('touca', true)
  evento({ label: 'boa noite!', P: 0.3, A: -0.5, interesse: 0.5, expr: 'sono', gesto: 'bocejo', forcarGesto: true, icones: ['lua', 'dormir'], som: 'sono', dur: 3000 })
  carneirosAte = now() + 7000
  setTimeout(() => { if (!gravando) { dormir('boa noite'); sono.proxREM = now() + 20 * 60000 } }, 7200)
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
let proxFolego = 0
function tickVida() {
  tickPapo(); tickClima(); tickSono(); tickTocaAqui(); tickDiversao()
  if (now() > proxFolego) { proxFolego = now() + 20000; tickFolego() }
  if (perguntaSomPendente && temGente() && !dormindo && !papo.contexto) { const s = sons.find((o) => o.id === perguntaSomPendente); if (s) perguntarSom(s); else perguntaSomPendente = null }
  if (P.deco?.perguntar && temGente() && !dormindo && !papo.contexto && papo.estado !== 'conversando') perguntarDeco()
}
setInterval(tickImaginacao, 100)


// ================================================================ BRINCADEIRAS, CRIATIVIDADE E ROTINA
const txtN = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const palavrasN = (x) => ' ' + txtN(x).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' '
const temPalavra = (texto, alias) => alias.split('|').some((a) => palavrasN(texto).includes(' ' + a + ' '))
const grafemas = (s) => [...new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment)
function legendaSempre(txt, ms = 6000) { const el = $('#legenda'); el.textContent = txt; el.hidden = false; clearTimeout(legenda.t); legenda.t = setTimeout(() => (el.hidden = true), ms) }
function mostrarBalao(itens, numero = '', ms = 4500) { balao = { itens, numero: String(numero), t0: now(), ate: now() + ms } }
const hhmm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
function exigeCamera(nome) {
  if (camera.ligada) return true
  evento({ label: `${nome}: preciso da câmera`, P: 0, A: 0.2, interesse: 0.5, expr: 'curioso', gesto: 'nao_sei', forcarGesto: true, icones: ['foto', 'pergunta'], dur: 3000 })
  legendaSempre(`${cfg.nome}: Pra brincar disso eu preciso da câmera — toca no 📷.`)
  return false
}
// Número falado: "12", "doze", "vinte e cinco".
const NUM_PAL = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100 }
// Pega o ÚLTIMO número da frase: "7 mais 2 é 9" → 9; "a resposta é vinte e cinco" → 25.
function numeroFalado(t) {
  // "é" (verbo) separa os números; "e" junta (vinte e cinco)
  const fichas = txtN(String(t).replace(/(^|[\s,])[éÉ](?=[\s,.!?]|$)/g, ' igual ')).replace(/(\d+)/g, ' $1 ').split(/[^a-z0-9]+/).filter(Boolean)
  const nums = []
  let atual = null
  for (const p of fichas) {
    if (/^\d+$/.test(p)) { if (atual !== null) nums.push(atual); atual = null; nums.push(+p) }
    else if (p in NUM_PAL) atual = (atual || 0) + NUM_PAL[p]
    else if (p !== 'e' && atual !== null) { nums.push(atual); atual = null }
  }
  if (atual !== null) nums.push(atual)
  return nums.length ? nums[nums.length - 1] : null
}

// Brincadeira ativa: recebe a sua fala antes da IA (ouvir) e roda um passo a cada 100 ms (tick).
let brinc = null
const SAIR_BRINC = /(^|\s)(para|parar|chega|sair|cansei|acabou)([\s,.!?]|$)/i
function comecarBrinc(b) { if (brinc) acabarBrinc('trocou de brincadeira'); brinc = b; abrirConversa(); pararImaginacao(); pushLog(`Brincadeira→ ${b.tipo}`) }
function acabarBrinc(motivo = '') { if (!brinc) return; const b = brinc; brinc = null; try { b.aoAcabar?.() } catch {}
  if (!/ningu[ée]m|parou de responder/.test(motivo)) abrirConversa()
  pushLog(`Brincadeira→ fim de ${b.tipo}${motivo ? ' (' + motivo + ')' : ''}`) }
setInterval(() => { try { brinc?.tick?.(); tickAprenderCara() } catch (e) { pushLog('Brincadeira: ' + e.message) } }, 100)
const ouviu = (t) => { pushLog(`Você: ${t}`); legenda(`Você: ${t}`) }
function placarFinal(label, pontos, total, bom) {
  evento({ label, P: bom ? 0.5 : 0.1, A: 0.4, interesse: 0.8, expr: bom ? 'orgulhoso' : 'rindo', gesto: bom ? 'pulinhos' : 'rir', forcarGesto: true, social: 0.05, dur: 4000, emote: bom ? 'estrela' : null })
  setTimeout(() => mostrarBalao(bom ? ['🏆'] : ['👍'], `${pontos}/${total}`, 5000), 300)
}

// ---------------------------------------------------------------- charadas de emoji
const CHARADAS = [
  ['🦁👑', 'rei leao', 'O Rei Leão'], ['❄️👸', 'frozen', 'Frozen'], ['🕷️🧑', 'homem aranha|aranha', 'Homem-Aranha'], ['🦖🏝️', 'jurassic|jurassic park|dinossauro|dinossauros', 'Jurassic Park'],
  ['🧙⚡👓', 'harry potter|harry|potter', 'Harry Potter'], ['🚢🧊💔', 'titanic', 'Titanic'], ['🐠🔍', 'nemo|procurando nemo', 'Procurando Nemo'], ['🤖🌱🌍', 'wall e|walle|wally|wall', 'WALL-E'],
  ['🧸🤠🚀', 'toy story', 'Toy Story'], ['🦇🧑', 'batman', 'Batman'], ['🐼🥋', 'kung fu panda|kung fu', 'Kung Fu Panda'], ['🏠🎈👴', 'up|altas aventuras', 'Up'],
  ['🐭👨‍🍳', 'ratatouille|ratatui', 'Ratatouille'], ['🍫🏭', 'fabrica de chocolate|wonka', 'A Fantástica Fábrica de Chocolate'], ['👽📞🏠', 'et|e t', 'E.T.'], ['🧜‍♀️🌊', 'sereia|pequena sereia', 'A Pequena Sereia'],
  ['🐝🍯', 'mel|abelha', 'mel'], ['⏰😴', 'soneca|despertador', 'soneca'], ['🎄🎅🎁', 'natal', 'Natal'], ['🎃👻', 'halloween|dia das bruxas', 'Halloween'],
  ['☀️🏖️🕶️', 'praia|verao|ferias', 'praia'], ['🌧️🌈', 'arco iris|arco', 'arco-íris'], ['⚽🏆', 'copa|copa do mundo|campeonato|futebol', 'Copa do Mundo'], ['🔥🚒', 'bombeiro|bombeiros', 'bombeiro'],
  ['🧊🐧', 'pinguim|polo sul|antartida', 'pinguim'], ['🍕🇮🇹', 'pizza|italia', 'pizza'], ['📚✏️🏫', 'escola|aula', 'escola'], ['🎂🎈🎉', 'aniversario|festa', 'aniversário'],
  ['🦷🧚', 'fada do dente|fada', 'fada do dente'], ['☕🥐', 'cafe da manha|cafe', 'café da manhã'], ['🌋🔥', 'vulcao', 'vulcão'], ['🚀🌕', 'lua|foguete|astronauta', 'ida à Lua'],
]
function brincCharada() {
  const b = { tipo: 'charada', pontos: 0, rodada: 0, total: 5, atual: null, erros: 0 }
  b.fila = CHARADAS.map((_, i) => i).filter((i) => !(P.charadasUsadas || []).includes(i)).sort(() => Math.random() - 0.5)
  if (b.fila.length < 5) { P.charadasUsadas = []; b.fila = CHARADAS.map((_, i) => i).sort(() => Math.random() - 0.5) }
  const mostrar = (numero = '') => mostrarBalao(grafemas(b.atual[0]), numero, 120000)
  b.proxima = () => {
    if (brinc !== b) return
    if (b.rodada >= b.total) return fim()
    b.atual = CHARADAS[b.fila[b.rodada++]]; b.erros = 0; (P.charadasUsadas ||= []).push(CHARADAS.indexOf(b.atual))
    mostrar(); foco = { expr: 'curioso', ate: now() + 3000 }; somDe('curioso', 0.4)
    legendaSempre(`${cfg.nome}: Charada ${b.rodada} de ${b.total}: o que é?`)
  }
  const revelar = () => { evento({ label: `a charada era ${b.atual[2]}`, P: 0.1, interesse: 0.5, expr: 'rindo', gesto: 'rir', forcarGesto: true, dur: 2000 }); legendaSempre(`${cfg.nome}: Era ${b.atual[2]}!`); setTimeout(b.proxima, 3200) }
  const fim = () => { acabarBrinc(); placarFinal(`charadas: ${b.pontos}/${b.rodada}`, b.pontos, b.rodada, b.pontos >= 3); if (b.pontos) figurinha('charada') }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t)) { fim(); return true }
    if (/desisto|n[ãa]o sei|passa|pula|pr[óo]xima/i.test(t)) { revelar(); return true }
    if (temPalavra(t, b.atual[1])) {
      b.pontos++
      evento({ label: `acertou a charada: ${b.atual[2]}`, P: 0.4, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 2000 })
      legendaSempre(`${cfg.nome}: Isso! É ${b.atual[2]}!`); setTimeout(b.proxima, 2800); return true
    }
    if (++b.erros >= 3) return revelar(), true
    evento({ label: 'resposta errada na charada', P: 0, A: 0.2, interesse: 0.6, expr: 'rindo', gesto: 'nao', forcarGesto: true, dur: 1500 })
    if (b.erros === 2) { const ini = b.atual[2].replace(/^(o|a|os|as) /i, '')[0].toUpperCase(); setTimeout(() => mostrar(ini + '…'), 1600); legendaSempre(`${cfg.nome}: Dica: começa com "${ini}".`) }
    else setTimeout(() => mostrar(), 1600)
    return true
  }
  comecarBrinc(b)
  evento({ label: 'charadas de emoji!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['jogo', 'pergunta'], dur: 1800 })
  setTimeout(b.proxima, 2000)
}

// ---------------------------------------------------------------- 20 perguntas (ele pensa, você adivinha)
const SEGREDOS = ['gato', 'cachorro', 'elefante', 'girafa', 'pinguim', 'tubarão', 'borboleta', 'abelha', 'cavalo', 'vaca', 'galinha', 'sapo', 'baleia', 'leão', 'macaco', 'coruja', 'tartaruga', 'cobra', 'formiga', 'golfinho', 'banana', 'pizza', 'sorvete', 'bolo', 'maçã', 'pipoca', 'chocolate', 'pão', 'ovo', 'melancia', 'bicicleta', 'avião', 'carro', 'trem', 'barco', 'foguete', 'guarda-chuva', 'relógio', 'celular', 'computador', 'violão', 'bola', 'livro', 'escova de dentes', 'geladeira', 'cadeira', 'lâmpada', 'travesseiro', 'óculos', 'chave', 'sol', 'lua', 'árvore', 'flor', 'nuvem', 'montanha', 'praia', 'vulcão', 'robô', 'dinossauro']
function brincVinte() {
  const segredo = sorteia(SEGREDOS), b = { tipo: 'vinte', segredo, n: 0, pensando: false }
  const ganhou = () => { acabarBrinc(); evento({ label: `adivinhou! era ${segredo}`, P: 0.5, A: 0.6, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: [icone_(segredo) || 'trofeu'].filter(Boolean), numero: `${b.n}/20`, dur: 4000, emote: 'estrela' }); legendaSempre(`${cfg.nome}: Acertou! Era ${segredo}, em ${b.n} perguntas!`); figurinha('vinte') }
  const perdeu = () => { acabarBrinc(); evento({ label: `20 perguntas acabaram; era ${segredo}`, P: 0.2, interesse: 0.7, expr: 'rindo', gesto: 'rir', forcarGesto: true, icones: [icone_(segredo) || 'pergunta'].filter(Boolean), dur: 4000 }); legendaSempre(`${cfg.nome}: Acabaram as perguntas! Era ${segredo}.`) }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t) || /desisto/i.test(t)) { perdeu(); return true }
    if (b.pensando) { mostrarBalao(['ampulheta'], '', 1500); return true }
    b.n++
    if (temPalavra(t, txtN(segredo).replace(/-/g, ' '))) { ganhou(); return true }
    b.pensando = true; foco = { expr: 'pensando', ate: now() + 5000 }
    servidor.vinte(segredo, t)
      .then((resp) => {
        if (brinc !== b) return
        if (resp === 'acertou') return ganhou()
        const gesto = resp === 'sim' ? 'sim' : resp === 'nao' ? 'nao' : 'talvez'
        evento({ label: `20 perguntas: ${resp}`, P: 0.05, interesse: 0.5, expr: gesto === 'sim' ? 'contente' : 'curioso', gesto, forcarGesto: true, dur: 1500 })
        mostrarBalao([], `${b.n}/20`, 3000)
        if (b.n >= 20) setTimeout(perdeu, 2000)
      })
      .catch((e) => { pushLog('20 perguntas: ' + e.message); evento({ label: 'não consegui pensar', gesto: 'nao_sei', forcarGesto: true, interesse: 0.4, dur: 1500 }) })
      .finally(() => (b.pensando = false))
    return true
  }
  comecarBrinc(b)
  evento({ label: '20 perguntas: pensei numa coisa!', P: 0.3, A: 0.4, interesse: 0.9, expr: 'desconfiado', gesto: 'piscadela', forcarGesto: true, icones: ['cerebro', 'pergunta'], numero: '0/20', dur: 3000 })
  legendaSempre(`${cfg.nome}: Pensei numa coisa (bicho, comida, objeto ou lugar). Faz perguntas de sim ou não!`)
}

// ---------------------------------------------------------------- quiz de contas
function brincQuiz() {
  const b = { tipo: 'quiz', rodada: 0, total: 10, pontos: 0, nivel: 1, resp: null, ate: 0 }
  const ri = (a, c) => a + Math.floor(Math.random() * (c - a + 1))
  b.proxima = () => {
    if (brinc !== b) return
    if (b.rodada >= b.total) return fim()
    b.rodada++
    let x, y, op
    if (b.nivel === 1) { x = ri(1, 9); y = ri(1, 9); op = '+' }
    else if (b.nivel === 2) { if (Math.random() < 0.5) { x = ri(5, 20); y = ri(1, x); op = '-' } else { x = ri(10, 40); y = ri(2, 30); op = '+' } }
    else if (b.nivel === 3) { x = ri(2, 9); y = ri(2, 9); op = '×' }
    else { const k = ri(0, 2); if (k === 0) { x = ri(20, 80); y = ri(10, 60); op = '+' } else if (k === 1) { x = ri(30, 99); y = ri(10, x); op = '-' } else { x = ri(6, 12); y = ri(3, 12); op = '×' } }
    b.resp = op === '+' ? x + y : op === '-' ? x - y : x * y
    mostrarBalao([], `${x}${op}${y}=?`, 60000); b.ate = now() + 20000; somDe('curioso', 0.3)
  }
  const fim = () => { acabarBrinc(); placarFinal(`quiz: ${b.pontos}/${b.total}`, b.pontos, b.total, b.pontos >= 7); if (b.pontos >= 8) figurinha('quiz') }
  b.tick = () => { if (b.ate && now() > b.ate) { b.ate = 0; evento({ label: 'quiz: acabou o tempo', P: -0.05, interesse: 0.4, expr: 'rindo', gesto: 'nao_sei', forcarGesto: true, dur: 1500 }); mostrarBalao([], `=${b.resp}`, 2500); setTimeout(b.proxima, 2600) } }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t)) { fim(); return true }
    const n = numeroFalado(t.replace(/(^|\s)novo([\s.,!?]|$)/gi, ' nove ')) // o Whisper às vezes escreve "novo" para "nove"
    if (n === null || !b.ate) { evento({ label: 'quiz: não entendi o número', gesto: 'nao_sei', forcarGesto: true, interesse: 0.4, dur: 1200 }); return true }
    b.ate = 0
    if (n === b.resp) { b.pontos++; if (b.pontos % 2 === 0) b.nivel = Math.min(4, b.nivel + 1); evento({ label: `quiz: acertou (${n})`, P: 0.3, A: 0.4, interesse: 0.8, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1500 }); mostrarBalao(['certo'], '', 1500); setTimeout(b.proxima, 1800) }
    else { evento({ label: `quiz: errou (${n}; era ${b.resp})`, P: 0, interesse: 0.6, expr: 'rindo', gesto: 'nao', forcarGesto: true, dur: 1500 }); mostrarBalao([], `=${b.resp}`, 2500); setTimeout(b.proxima, 2600) }
    return true
  }
  comecarBrinc(b)
  evento({ label: 'quiz de contas!', P: 0.3, A: 0.4, interesse: 0.9, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, icones: ['calculadora', 'cerebro'], dur: 1800 })
  setTimeout(b.proxima, 2000)
}

// ---------------------------------------------------------------- imita a careta / imita eu (câmera)
const CARETAS = [
  { nome: 'sorriso', expr: 'feliz', ic: '😄', ok: (e) => e.sorriso > 0.55 },
  { nome: 'surpresa', expr: 'surpreso', ic: '😮', ok: (e) => e.boca > 0.3 && e.sobrancelha > 0.3 },
  { nome: 'cara de bravo', expr: 'bravo', ic: '😠', ok: (e) => e.franzido > 0.35 },
  { nome: 'boca aberta', expr: 'surpreso', ic: '😲', ok: (e) => e.boca > 0.5 },
  { nome: 'olhos fechados', expr: 'sono', ic: '😌', ok: (e) => e.piscou > 0.6 },
]
function brincCareta() {
  if (!exigeCamera('Imita a careta')) return
  const b = { tipo: 'careta', rodada: 0, total: 5, pontos: 0, alvo: null, ate: 0, okDesde: 0 }
  b.proxima = () => {
    if (brinc !== b) return
    if (b.rodada >= b.total) { acabarBrinc(); placarFinal(`caretas: ${b.pontos}/${b.total}`, b.pontos, b.total, b.pontos >= 3); if (b.pontos >= 4) figurinha('careta'); return }
    b.rodada++; b.alvo = sorteia(CARETAS); b.ate = now() + 5000; b.okDesde = 0
    foco = { expr: b.alvo.expr, ate: now() + 5000 }; mostrarBalao([b.alvo.ic], `${b.rodada}/${b.total}`, 5000); somDe('hm', 0.3)
    legendaSempre(`${cfg.nome}: Imita: ${b.alvo.nome}!`, 5000)
  }
  b.tick = () => {
    if (!b.ate) return
    const e = rosto.ultimaExp, fresco = e && now() - rosto.expT < 500
    if (fresco && b.alvo.ok(e)) { if (!b.okDesde) b.okDesde = now(); if (now() - b.okDesde > 450) { b.ate = 0; b.pontos++; evento({ label: `imitou: ${b.alvo.nome}`, P: 0.3, A: 0.4, interesse: 0.8, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1500 }); mostrarBalao(['certo'], '', 1500); setTimeout(b.proxima, 1800) } }
    else b.okDesde = 0
    if (b.ate && now() > b.ate) { b.ate = 0; evento({ label: `não imitou: ${b.alvo.nome}`, P: 0, interesse: 0.5, expr: 'rindo', gesto: 'nao', forcarGesto: true, dur: 1500 }); setTimeout(b.proxima, 1800) }
  }
  b.ouvir = (t) => { ouviu(t); if (SAIR_BRINC.test(t)) { acabarBrinc('parou'); return true } return false }
  comecarBrinc(b)
  evento({ label: 'imita a careta!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'rindo', gesto: 'pulinhos', forcarGesto: true, icones: ['olhos', 'jogo'], dur: 1800 })
  setTimeout(b.proxima, 2000)
}
function brincImitaEu() {
  if (!exigeCamera('Imita eu')) return
  const b = { tipo: 'imitaeu', ate: now() + 25000 }
  b.tick = () => {
    if (now() > b.ate) { acabarBrinc(); evento({ label: 'cansei de te imitar, hehe', P: 0.3, interesse: 0.6, expr: 'rindo', gesto: 'rir', forcarGesto: true, dur: 2000 }); return }
    const e = rosto.ultimaExp; if (!e || now() - rosto.expT > 600) return
    const expr = e.piscou > 0.6 ? 'sono' : e.boca > 0.45 && e.sobrancelha > 0.3 ? 'surpreso' : e.franzido > 0.35 ? 'bravo' : e.sorriso > 0.5 ? 'rindo' : e.boca > 0.4 ? 'surpreso' : 'neutro'
    foco = { expr, ate: now() + 400 }
  }
  b.ouvir = (t) => { ouviu(t); if (SAIR_BRINC.test(t)) { acabarBrinc('parou'); return true } return false }
  comecarBrinc(b)
  evento({ label: 'agora eu te imito!', P: 0.3, A: 0.4, interesse: 0.8, expr: 'desconfiado', gesto: 'piscadela', forcarGesto: true, icones: ['olhos', 'robo'], dur: 1500 })
}

// ---------------------------------------------------------------- ritmo de palmas
function brincRitmo() {
  const b = { tipo: 'ritmo', n: 3, fase: '', ints: [], ini: 0, rodadas: 0 }
  const novo = () => { b.ints = Array.from({ length: b.n - 1 }, () => sorteia([380, 380, 760])) }
  b.tocar = () => {
    if (brinc !== b || !actx) return
    b.fase = 'tocando'
    const out = actx.createGain(); out.gain.value = 0.32; out.connect(actx.destination)
    const t0 = actx.currentTime + 0.1, tempos = [0]
    b.ints.forEach((i) => tempos.push(tempos[tempos.length - 1] + i))
    tempos.forEach((ms) => { silaba(out, t0 + ms / 1000, 1500, 1150, 0.07, 'square', 0, 0.6); setTimeout(() => { batida(1) }, ms + 100) })
    const dur = tempos[tempos.length - 1] + 200
    falandoAte = now() + dur + 350
    setTimeout(() => { if (brinc !== b) return; b.fase = 'ouvindo'; b.ini = now(); foco = { expr: 'ouvindo', ate: now() + 6000 }; mostrarBalao(['👏'], `${b.n}`, 6000) }, dur + 400)
  }
  b.tick = () => {
    if (b.fase !== 'ouvindo') return
    const ons = onsets.filter((x) => x > b.ini + 80), ult = ons[ons.length - 1] || b.ini
    if (now() - b.ini > 7000 || (ons.length >= b.n && now() - ult > 1100)) avaliar(ons)
  }
  const avaliar = (ons) => {
    b.fase = ''
    const ints = ons.slice(1).map((x, i) => x - ons[i]), alvo = b.ints
    let ok = ons.length === b.n
    if (ok && alvo.length) {
      const esc = ints.reduce((a, x) => a + x, 0) / alvo.reduce((a, x) => a + x, 0)
      ok = esc > 0.65 && esc < 1.5 && alvo.every((a, i) => Math.abs(ints[i] / esc - a) < Math.max(140, a * 0.32))
    }
    pushLog(`Ritmo→ esperava ${b.n} palmas, ouvi ${ons.length}${ok ? ' (certo)' : ''}`)
    if (ok) { b.rodadas++; b.n = Math.min(8, b.n + 1); novo(); evento({ label: `ritmo certo! agora ${b.n} palmas`, P: 0.4, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1500 }); setTimeout(b.tocar, 2200); if (b.n - 1 >= 5) figurinha('ritmo') }
    else { acabarBrinc(); placarFinal(`ritmo: ${b.rodadas} rodada(s)`, b.rodadas, Math.max(b.rodadas, 1), b.rodadas >= 2) }
  }
  b.ouvir = (t) => { ouviu(t); if (SAIR_BRINC.test(t)) { acabarBrinc('parou'); return true } return true }
  comecarBrinc(b); novo()
  evento({ label: 'ritmo de palmas!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['musica', 'jogo'], dur: 1800 })
  legendaSempre(`${cfg.nome}: Escuta o ritmo e repete batendo palmas!`)
  setTimeout(b.tocar, 2200)
}

// ---------------------------------------------------------------- esconde-esconde (câmera)
function brincEsconde() {
  if (!exigeCamera('Esconde-esconde')) return
  const b = { tipo: 'esconde', fase: 'contando', ini: now(), fimConta: 0, n: 10, proxOlhar: 0 }
  b.tick = () => {
    const t = now()
    if (b.fase === 'contando') {
      const falta = 10 - Math.floor((t - b.ini) / 1000)
      if (falta !== b.n && falta >= 1) { b.n = falta; mostrarBalao([], String(falta), 1100); somDe('neutro', 0.15); foco = { expr: 'sono', ate: t + 1200 } }
      if (t - b.ini >= 10000) { b.fase = 'procurando'; b.fimConta = t; foco = { expr: 'curioso', ate: t + 2000 }; mostrarBalao(['olhos', 'pergunta'], '', 2500); somDe('curioso', 0.5); legendaSempre(`${cfg.nome}: Lá vou eu!`) }
    } else if (b.fase === 'procurando') {
      if (pessoa.visto > b.fimConta + (pessoa.visto - b.fimConta < 1500 && t - b.fimConta < 2500 ? 0 : 800) && t - pessoa.visto < 400) {
        acabarBrinc()
        const seg = Math.round((t - b.fimConta) / 1000)
        if (seg <= 2) { evento({ label: 'você nem se escondeu!', P: 0.3, interesse: 0.8, expr: 'rindo', gesto: 'rir', forcarGesto: true, icones: ['olhos'], dur: 2500 }); return }
        evento({ label: `te achei em ${seg} s!`, P: 0.5, A: 0.6, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, numero: `${seg}s`, dur: 3500, emote: 'estrela' }); figurinha('esconde'); return
      }
      if (t > b.proxOlhar) { b.proxOlhar = t + 3200; iniciarGesto('olhar_em_volta') }
      if (t - b.fimConta > 90000) { acabarBrinc(); evento({ label: 'não te achei, você venceu!', P: 0.1, interesse: 0.8, expr: 'triste', gesto: 'suspiro', forcarGesto: true, icones: ['trofeu'], dur: 3000 }) }
    }
  }
  b.ouvir = (t) => { ouviu(t); if (SAIR_BRINC.test(t)) { acabarBrinc('parou'); return true } return true }
  comecarBrinc(b)
  legendaSempre(`${cfg.nome}: Se esconde da câmera! Vou contar até 10…`)
}

// ---------------------------------------------------------------- pedra, papel e tesoura (câmera + mãos)
let reconhecedorMao = null
async function carregarMao() {
  if (reconhecedorMao) return reconhecedorMao
  pushLog('S3→ carregando o reconhecimento de mãos…')
  const V = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14'
  const { FilesetResolver, GestureRecognizer } = await import(V)
  const vision = await FilesetResolver.forVisionTasks(V + '/wasm')
  const op = (delegate) => ({ baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task', delegate }, runningMode: 'VIDEO', numHands: 1 })
  try { reconhecedorMao = await GestureRecognizer.createFromOptions(vision, op('GPU')) } catch { reconhecedorMao = await GestureRecognizer.createFromOptions(vision, op('CPU')) }
  pushLog('S3→ mãos prontas')
  return reconhecedorMao
}
const JOGADA = { Closed_Fist: 'pedra', Open_Palm: 'papel', Victory: 'tesoura' }, EMOJI_JOGADA = { pedra: '✊', papel: '✋', tesoura: '✌️' }
function brincPPT() {
  if (!exigeCamera('Pedra, papel e tesoura')) return
  const b = { tipo: 'ppt', placar: [0, 0], votos: {}, fase: '' }
  const rodada = () => {
    if (brinc !== b) return
    b.fase = 'contando'
    ;['pedra', 'papel', 'tesoura'].forEach((j, i) => setTimeout(() => { if (brinc !== b) return; mostrarBalao([EMOJI_JOGADA[j]], '', 800); somDe('neutro', 0.2); batida(1) }, i * 750))
    setTimeout(() => { if (brinc !== b) return; b.fase = 'lendo'; b.votos = {}; b.ate = now() + 1300 }, 2250)
  }
  b.tick = () => {
    if (b.fase !== 'lendo' || !reconhecedorMao) return
    try {
      const r = reconhecedorMao.recognizeForVideo($('#cam'), now())
      const g0 = r.gestures?.[0]?.[0]; if (g0 && JOGADA[g0.categoryName] && g0.score > 0.5) b.votos[JOGADA[g0.categoryName]] = (b.votos[JOGADA[g0.categoryName]] || 0) + 1
    } catch {}
    if (now() < b.ate) return
    b.fase = ''
    const voce = Object.entries(b.votos).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (!voce) { evento({ label: 'não vi sua mão', gesto: 'nao_sei', forcarGesto: true, icones: ['olhos', 'pergunta'], interesse: 0.5, dur: 1500 }); return setTimeout(rodada, 2200) }
    const eu = sorteia(['pedra', 'papel', 'tesoura'])
    const ganha = { pedra: 'tesoura', papel: 'pedra', tesoura: 'papel' }
    const res = eu === voce ? 0 : ganha[voce] === eu ? 1 : -1
    if (res > 0) b.placar[0]++; if (res < 0) b.placar[1]++
    mostrarBalao([EMOJI_JOGADA[voce], '🆚', EMOJI_JOGADA[eu]], '', 2500)
    setTimeout(() => {
      evento({ label: `ppt: você ${voce}, eu ${eu}`, P: res < 0 ? 0.3 : 0, A: 0.4, interesse: 0.8, expr: res > 0 ? 'triste' : res < 0 ? 'orgulhoso' : 'surpreso', gesto: res > 0 ? 'suspiro' : res < 0 ? 'pulinhos' : 'talvez', forcarGesto: true, numero: `${b.placar[0]}x${b.placar[1]}`, dur: 2200 })
      if (Math.max(...b.placar) >= 2) { acabarBrinc(); setTimeout(() => placarFinal(b.placar[0] > b.placar[1] ? 'você venceu no pedra-papel-tesoura' : 'eu venci no pedra-papel-tesoura', b.placar[0], b.placar[0] + b.placar[1], b.placar[0] < b.placar[1]), 2400); if (b.placar[0] >= 2) figurinha('ppt') }
      else setTimeout(rodada, 2600)
    }, 2600)
  }
  b.ouvir = (t) => { ouviu(t); if (SAIR_BRINC.test(t)) { acabarBrinc('parou'); return true } return true }
  comecarBrinc(b)
  evento({ label: 'pedra, papel e tesoura!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'desconfiado', gesto: 'piscadela', forcarGesto: true, icones: ['jogo'], dur: 1500 })
  legendaSempre(`${cfg.nome}: Melhor de 3! Mostra a mão pra câmera no "tesoura".`)
  carregarMao().then(() => setTimeout(rodada, 1200)).catch((e) => { pushLog('Mãos: ' + e.message); acabarBrinc('erro'); evento({ label: 'não consegui ver mãos', gesto: 'nao_sei', forcarGesto: true, interesse: 0.4, dur: 2000 }) })
}

// ---------------------------------------------------------------- ele desenha (pixel art pela IA)
const TEMAS_DESENHO = ['um gato', 'uma flor', 'um foguete', 'um coração', 'um peixe', 'uma casa', 'um sol sorrindo', 'um robô', 'uma árvore', 'um cogumelo', 'uma estrela', 'um pinguim', 'um sorvete', 'uma nota musical', 'um fantasminha', 'um cachorro']
async function fazerDesenho(tema, intro = '') {
  if (!cfg.key) return evento({ label: 'preciso da chave do Groq para desenhar', gesto: 'nao_sei', forcarGesto: true, interesse: 0.4, dur: 2000 })
  tema = String(tema || sorteia(TEMAS_DESENHO)).replace(/^(desenh\w*|faz|faça|um desenho de)\s*/i, '').slice(0, 40) || sorteia(TEMAS_DESENHO)
  pushLog(`Desenho→ desenhando "${tema}"…`)
  foco = { expr: 'pensando', ate: now() + 9000 }; icone = { tipo: 'reticencias', ate: now() + 9000 }
  try {
    const j = await servidor.desenhar(tema)
    const px = (j.linhas || []).slice(0, 16).map((l) => [...String(l)].slice(0, 16).map((ch) => (PALETA[ch] ? ch : '.')).join('').padEnd(16, '.'))
    while (px.length < 16) px.push('.'.repeat(16))
    if (px.join('').replace(/\./g, '').length < 12) throw new Error('o desenho veio vazio')
    const d = { t: Date.now(), tema, titulo: String(j.titulo || tema).slice(0, 40), px }
    P.desenhos = [d, ...(P.desenhos || [])].slice(0, 12); store.set('pers', P)
    foco = null; icone = null
    mostrarDesenho(d, intro)
    figurinha('desenho')
    return d
  } catch (e) { foco = null; icone = null; pushLog('Desenho: ' + e.message.slice(0, 160)); evento({ label: 'o desenho não saiu', P: -0.1, interesse: 0.4, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, dur: 2000 }) }
}
function mostrarDesenho(d, intro = '') {
  palco = null
  if (dormindo) acordar()
  mostrarEmote('estrela', 7000, { px: d.px, desenho: true, saida: 'pixel', volta: 'pixel' })
  legendaSempre(`${cfg.nome}: ${intro || 'Desenhei'} ${d.titulo || d.tema}!`, 7000)
}

// ---------------------------------------------------------------- música do dia, dança
function melodiaDoDia() {
  let s = [...hojeSv()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  const r = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296
  const esc = [0, 2, 4, 7, 9, 12, 14]
  return Array.from({ length: 10 }, (_, i) => ({ st: esc[Math.floor(r() * esc.length)] - (i === 9 ? 0 : 0), d: [0.15, 0.22, 0.3][Math.floor(r() * 3)] }))
}
let danca = null
function dancar() {
  pararImaginacao()
  if (danca) return
  danca = { passos: 0, max: 16, ate: now() + 20000, interno: null }
  pushLog(`Dança→ começou ${audio.musica ? `no ritmo da música (${audio.bpm} BPM)` : 'cantarolando'}`)
  if (!audio.musica) { tocarMelodia(melodiaDoDia(), 1); danca.interno = setInterval(passoDanca, 460) }
}
bus.on('beat', () => { if (danca && !danca.interno) passoDanca() })
function passoDanca() {
  if (!danca) return
  const PASSOS = ['sim', 'nao', 'talvez', 'pulinhos', 'aceno', 'surpresa', 'sim', 'talvez']
  if (!gesto) iniciarGesto(PASSOS[(danca.passos + Math.floor(Math.random() * 3)) % PASSOS.length])
  batida(1); danca.passos++
  if (danca.passos >= danca.max || now() > danca.ate) {
    clearInterval(danca.interno); danca = null
    evento({ label: 'pose final da dança!', P: 0.4, A: 0.4, interesse: 0.7, expr: 'orgulhoso', gesto: 'dancinha', forcarGesto: true, dur: 2000, emote: 'legal' })
    figurinha('dancou')
  }
}

// ---------------------------------------------------------------- diário em quadrinhos e notícias em emojis
async function mostrarDiario() {
  foco = { expr: 'pensando', ate: now() + 8000 }; icone = { tipo: 'reticencias', ate: now() + 8000 }
  const h = await imaginar('diario')
  foco = null; icone = null
  if (!h) return evento({ label: 'não consegui montar o diário', gesto: 'nao_sei', forcarGesto: true, interesse: 0.4, dur: 2000 })
  guardarHistoria(h); contarHistoria(memorias[0])
}
async function noticiasEmEmojis() {
  if (!servidor.podePesquisar()) { legendaSempre(`${cfg.nome}: Pra ver notícias eu preciso pesquisar na internet — coloque a chave do Gemini em ⚙️.`); return evento({ label: 'não consigo pesquisar notícias agora', gesto: 'nao_sei', forcarGesto: true, icones: ['mundo', 'pergunta'], interesse: 0.4, dur: 2500 }) }
  foco = { expr: 'pensando', ate: now() + 15000 }; icone = { tipo: 'reticencias', ate: now() + 15000 }
  pushLog('Notícias→ pesquisando…')
  try {
    const j = await servidor.noticias()
    const quadros = (j.noticias || []).slice(0, 3).map((n) => ({ icones: limparIcones(n.icones).length ? limparIcones(n.icones) : ['mundo'], emocao: 'curioso', frase: String(n.frase || '').slice(0, 140) })).filter((q) => q.frase)
    foco = null; icone = null
    if (!quadros.length) throw new Error('sem notícias na resposta')
    imag.ativo = { tipo: 'contando', t0: now() + 800, hist: { tipo: 'noticias', titulo: 'Notícias de hoje', resumo: quadros.map((q) => q.frase).join(' '), quadros, passo: 5000 } }
    imag.quadroAtual = -1
    pushLog(`Notícias→ ${quadros.map((q) => q.frase).join(' | ')}`)
    figurinha('noticias')
  } catch (e) { foco = null; icone = null; pushLog('Notícias: ' + e.message.slice(0, 160)); evento({ label: 'não consegui ver as notícias', gesto: 'nao_sei', forcarGesto: true, icones: ['mundo', 'pergunta'], interesse: 0.4, dur: 2500 }) }
}

// ---------------------------------------------------------------- modo foco (Pomodoro)
let modoFoco = null
function comecarFoco(min = 25) {
  modoFoco = { fase: 'foco', ini: now(), fim: now() + min * 60000, ciclos: modoFoco?.ciclos || 0 }
  vestir('fone', true); Object.assign(papo, { estado: 'parado', olharAte: 0 }); acabarBrinc('modo foco')
  evento({ label: `modo foco: ${min} min`, P: 0.2, A: -0.2, interesse: 0.6, expr: 'contente', gesto: 'sim', forcarGesto: true, icones: ['trabalho', 'relogio'], numero: `${min}min`, dur: 3000 })
  legendaSempre(`${cfg.nome}: Foco! Fico quietinho por ${min} min. Bom trabalho!`)
}
function pararFoco() {
  if (!modoFoco) return
  modoFoco = null; vestir('fone', false)
  evento({ label: 'fim do modo foco', P: 0.2, interesse: 0.5, expr: 'contente', gesto: 'sim', forcarGesto: true, icones: ['ok'], dur: 2000 })
}
function tickFoco() {
  if (!modoFoco || now() < modoFoco.fim) return
  if (modoFoco.fase === 'foco') {
    modoFoco.ciclos++; modoFoco.fase = 'pausa'; modoFoco.ini = now(); modoFoco.fim = now() + 5 * 60000; vestir('fone', false)
    if (dormindo) acordar()
    tocarMelodia(LEMBRA, 1)
    evento({ label: `pausa! (${modoFoco.ciclos} foco${modoFoco.ciclos > 1 ? 's' : ''})`, P: 0.4, A: 0.4, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['agua', 'musculo'], numero: '5min', dur: 4000, emote: 'estrela' })
    legendaSempre(`${cfg.nome}: Pausa de 5 min! Bebe água e se alonga.`, 8000)
    figurinha('foco')
  } else if (modoFoco.fase === 'pausa') {
    modoFoco.fase = 'espera'; modoFoco.fim = Infinity
    evento({ label: 'voltar ao foco?', P: 0.1, A: 0.2, interesse: 0.7, expr: 'curioso', gesto: 'talvez', forcarGesto: true, icones: ['trabalho', 'pergunta'], dur: 4000 })
    legendaSempre(`${cfg.nome}: Acabou a pausa. Mais um foco?`); abrirConversa()
  }
}

// ---------------------------------------------------------------- lembretes e despertador
const LEMBRA = [7, 4, 7, 12, 7, 12].map((st) => ({ st, d: 0.14 }))
const DESPERTA = [0, 4, 7, 12, 7, 4, 0, 12, 12, 12].map((st, i) => ({ st, d: i > 6 ? 0.1 : 0.16 }))
function iconesDoTexto(t, tipo) {
  const m = [[/rem[ée]dio|p[íi]lula/, 'remedio'], [/[áa]gua|beber/, 'agua'], [/com(er|ida)|almo[çc]|jant|lanche/, 'comida'], [/caf[ée]/, 'cafe'], [/reuni|trabalh|e-?mail/, 'trabalho'], [/lig(ar|ue)|telefon|celular/, 'celular'], [/regar|planta/, 'planta'], [/estud|prova|aula/, 'escola'], [/cachorro|passear/, 'cachorro'], [/gato/, 'gato'], [/dorm/, 'dormir'], [/presente|anivers/, 'presente'], [/roupa|varal|casa|lixo/, 'casa']]
  const ic = m.filter(([re]) => re.test(txtN(t))).map(([, k]) => k)
  return (ic.length ? ic : tipo === 'despertar' ? ['sol'] : ['ideia']).slice(0, 2)
}
function interpretarLembrete(texto) {
  const t = txtN(texto)
  if (!/(lembr|avis|acord|alarme|despert|timer|cronometr)/.test(t) || /(voce|vc) (lembra|se lembra)/.test(t)) return null
  let quando = null, m
  m = /(?:daqui a?|em|por) ?(\d+|um|uma|dois|duas|tres|cinco|dez|quinze|vinte|trinta|meia) ?(minutos?|min|horas?|h)(\s|$|[,.!?])/.exec(t)
  if (m) { const n = m[1] === 'meia' ? 0.5 : numeroFalado(m[1]); if (n != null) quando = Date.now() + n * (/^h/.test(m[2]) ? 3600000 : 60000) }
  if (!quando) {
    m = /(?:as|a|para as|pras|pra) (\d{1,2})(?:[:h ](\d{2}))?(?: ?(?:h|horas))?(?: (?:da|de) (manha|tarde|noite))?/.exec(t)
    if (m && +m[1] <= 23) {
      let h = +m[1]; const mi = +(m[2] || 0)
      if ((m[3] === 'tarde' || m[3] === 'noite') && h < 12) h += 12
      const d = new Date(); d.setHours(h, mi, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
      quando = d.getTime()
    }
  }
  if (!quando) return { pendente: true }
  const tipo = /acord|despert/.test(t) ? 'despertar' : 'lembrete'
  const oque = texto.replace(/^.*?(lembr\w*|avis\w*)\s*(de |que |pra |para )?/i, '').replace(/\s*(daqui a?|em|por) (\d+|um|uma|dois|duas|tres|três|cinco|dez|quinze|vinte|trinta|meia) ?(minutos?|min|horas?|h)\b.*$/i, '').replace(/\s*(às|as|para as|pras|pra) \d.*$/i, '').replace(/[?.!]+$/, '').trim()
  return { quando, tipo, texto: tipo === 'despertar' ? 'acordar' : oque || 'o lembrete' }
}
function criarLembrete(l) {
  const item = { id: Date.now(), ...l, icones: iconesDoTexto(l.texto, l.tipo), soneca: 0 }
  P.lembretes = [...(P.lembretes || []), item].slice(-20); store.set('pers', P)
  const h = hhmm(l.quando)
  pushLog(`Lembrete→ ${l.tipo === 'despertar' ? 'despertar' : `"${l.texto}"`} às ${h}`)
  evento({ label: `vou ${l.tipo === 'despertar' ? 'te acordar' : 'te lembrar'}${l.tipo === 'despertar' ? '' : ': ' + l.texto} às ${h}`, P: 0.2, A: 0.2, interesse: 0.6, expr: 'orgulhoso', gesto: 'sim', forcarGesto: true, icones: [...item.icones, 'relogio'].slice(0, 3), numero: h, dur: 3500 })
  legendaSempre(`${cfg.nome}: Combinado! ${l.tipo === 'despertar' ? 'Te acordo' : 'Te lembro'} às ${h}.`)
}
let alarme = null
function tickLembretes() {
  if (alarme) { if (now() > alarme.prox) tocarAlarme(); return }
  const l = (P.lembretes || []).find((x) => x.quando <= Date.now())
  if (!l) return
  alarme = { l, prox: 0, vezes: 0 }
  if (dormindo) { sonoIA = false; acordar() }
  tocarAlarme()
}
function tocarAlarme() {
  const a = alarme, desp = a.l.tipo === 'despertar'
  a.vezes++; a.prox = now() + 25000
  tocarMelodia(desp ? DESPERTA : LEMBRA, 1)
  mostrarBalao(a.l.icones?.length ? a.l.icones : ['relogio'], desp ? hhmm(Date.now()) : '', 20000)
  foco = { expr: a.l.soneca >= 2 ? 'bravo' : 'empolgado', ate: now() + 4000 }; iniciarGesto('pulinhos')
  legendaSempre(`${cfg.nome}: ${desp ? (a.l.soneca >= 2 ? 'Levanta! Já foram ' + a.l.soneca + ' sonecas!' : 'Hora de acordar!') : 'Lembrete: ' + a.l.texto}`, 20000)
  abrirConversa()
  if (a.vezes >= 6) concluirAlarme('ninguém respondeu')
}
function concluirAlarme(motivo) {
  if (!alarme) return
  P.lembretes = (P.lembretes || []).filter((x) => x.id !== alarme.l.id); store.set('pers', P)
  pushLog(`Lembrete→ concluído (${motivo})`); alarme = null
  if (motivo === 'ok') { evento({ label: 'lembrete cumprido', P: 0.3, interesse: 0.5, expr: 'contente', gesto: 'sim', forcarGesto: true, icones: ['certo'], dur: 1800 }); figurinha('lembrete') }
}
function sonecaAlarme() {
  const l = alarme.l
  l.soneca++; l.quando = Date.now() + 5 * 60000; store.set('pers', P); alarme = null
  evento({ label: `soneca (${l.soneca}ª)`, P: -0.1, interesse: 0.6, expr: l.soneca >= 2 ? 'bravo' : 'desconfiado', gesto: l.soneca >= 2 ? 'nao' : 'suspiro', forcarGesto: true, icones: ['dormir', 'relogio'], numero: '+5min', dur: 3000 })
}

// ---------------------------------------------------------------- previsão do tempo (Open-Meteo, grátis e sem chave)
const tempo = { dados: null, ate: 0 }
async function pegarLocal() {
  if (P.local && (!cfg.cidade || P.local.cidade === cfg.cidade)) return P.local
  if (cfg.cidade) {
    try {
      const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cfg.cidade)}&count=1&language=pt&format=json`)).json()
      const c = r.results?.[0]
      if (c) { P.local = { lat: +c.latitude.toFixed(2), lon: +c.longitude.toFixed(2), cidade: cfg.cidade }; store.set('pers', P); pushLog(`Tempo→ cidade: ${c.name}${c.admin1 ? ', ' + c.admin1 : ''}`); return P.local }
    } catch (e) { pushLog('Tempo (cidade): ' + e.message) }
  }
  if (P.local) return P.local
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null)
    navigator.geolocation.getCurrentPosition((p) => { P.local = { lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2) }; store.set('pers', P); ok(P.local) }, () => ok(null), { timeout: 12000, maximumAge: 86400000 })
  })
}
async function atualizarTempo() {
  if (tempo.dados && Date.now() < tempo.ate) return tempo.dados
  const loc = await pegarLocal(); if (!loc) return null
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=precipitation_probability&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2`)
  if (!r.ok) throw new Error('Open-Meteo ' + r.status)
  tempo.dados = await r.json(); tempo.ate = Date.now() + 3600000
  return tempo.dados
}
const iconeTempo = (c) => (c === 0 ? 'sol' : c <= 48 ? 'nuvem' : c <= 67 ? 'chuva' : c <= 77 ? 'neve' : c <= 82 ? 'chuva' : 'trovao')
function resumoTempo(j, dia = 0) {
  const d = j.daily
  const r = { icone: iconeTempo(d.weather_code[dia]), max: Math.round(d.temperature_2m_max[dia]), min: Math.round(d.temperature_2m_min[dia]), prob: d.precipitation_probability_max[dia] ?? 0, horaChuva: null }
  if (dia === 0 && j.hourly) {
    const agora = new Date(), hoje = agora.toISOString().slice(0, 10)
    const i = j.hourly.time.findIndex((tm, k) => tm.startsWith(hoje) && new Date(tm) >= agora && j.hourly.precipitation_probability[k] >= 60)
    if (i >= 0) r.horaChuva = new Date(j.hourly.time[i]).getHours()
  }
  return r
}
async function falarDoTempo(texto = '') {
  const amanha = /amanh/.test(txtN(texto))
  let j = null
  try { j = await atualizarTempo() } catch (e) { pushLog('Tempo: ' + e.message) }
  if (!j) { evento({ label: 'não sei a previsão (sem localização)', gesto: 'nao_sei', forcarGesto: true, icones: ['nuvem', 'pergunta'], interesse: 0.4, dur: 2500 }); legendaSempre(`${cfg.nome}: Pra ver a previsão, coloque sua cidade em ⚙️ (ou libere a localização).`); return }
  const r = resumoTempo(j, amanha ? 1 : 0), chuva = r.prob >= 50, perguntouChuva = /chov|chuva/.test(txtN(texto))
  evento({ label: `previsão ${amanha ? 'de amanhã' : 'de hoje'}: ${r.icone}, ${r.min}° a ${r.max}°, chuva ${r.prob}%`, P: chuva ? -0.05 : 0.2, interesse: 0.6, expr: chuva ? 'curioso' : 'contente', gesto: perguntouChuva ? (chuva ? 'sim' : 'nao') : 'nenhum', forcarGesto: true, icones: [...new Set([r.icone, chuva ? 'chuva' : r.icone])], numero: `${r.max}°`, dur: 5000 })
  legendaSempre(`${cfg.nome}: ${amanha ? 'Amanhã' : 'Hoje'}: ${r.min}° a ${r.max}°, chance de chuva ${r.prob}%.${chuva && r.horaChuva != null ? ` Lá pelas ${r.horaChuva}h pode chover — leva guarda-chuva!` : ''}`, 7000)
  if (chuva) termo.guardaAte = now() + 8000
}
function textoPrevisao() {
  if (!tempo.dados) return ''
  try { const r = resumoTempo(tempo.dados, 0); return `Previsão de hoje: ${r.min}° a ${r.max}°, chance de chuva ${r.prob}%.` } catch { return '' }
}

// ---------------------------------------------------------------- bom dia, cor do humor
function talvezBomDia() {
  const h = new Date().getHours(), dia = hojeSv()
  if (P.bomDia === dia || h < 5 || h >= 13 || dormindo || sonoIA) return
  P.bomDia = dia; store.set('pers', P)
  evento({ label: 'bom dia!', P: 0.4, A: 0.4, interesse: 0.8, expr: 'feliz', gesto: 'espreguicar', forcarGesto: true, icones: ['sol', 'calendario'], numero: new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'numeric' }), dur: 3500 })
  if (P.local) setTimeout(() => falarDoTempo('hoje'), 4500)
  if (historiaParaContar()) setTimeout(() => contarHistoria(), P.local ? 11000 : 5000)
}
bus.on('pessoa_chegou', () => setTimeout(talvezBomDia, 3000))
// ---------------------------------------------------------------- bichinho do terrário (sensor simulado até o C3 do terrário existir)
const terrario = Object.assign({ temp: 24, umid: 70, ativo: true }, store.get('terrario', {}))
const bicho = { ativo: false, x: -10, dir: 1, ate: 0, prox: now() + 4 * 60000, ultimoAlerta: 0 }
function chamarBicho() { Object.assign(bicho, { ativo: true, dir: Math.random() < 0.5 ? 1 : -1, ate: now() + 22000 }); bicho.x = bicho.dir > 0 ? -10 : 250; pushLog('Bichinho do terrário→ passeando'); foco = { expr: 'curioso', ate: now() + 3000 } }
function tickBicho() {
  const t = now()
  if (!terrario.ativo) return
  if (!bicho.ativo && t > bicho.prox && !dormindo && !palco && !brinc) chamarBicho()
  if (bicho.ativo && t > bicho.ate) { bicho.ativo = false; bicho.prox = t + rnd(6, 14) * 60000 }
  if (terrario.umid < 50 && t - bicho.ultimoAlerta > 30 * 60000 && !dormindo && temGente()) {
    bicho.ultimoAlerta = t
    evento({ label: `o terrário tá seco (${terrario.umid} %)`, P: -0.2, A: 0.3, interesse: 0.7, expr: 'triste', gesto: 'nao_sei', forcarGesto: true, icones: ['planta', 'agua', 'pergunta'], numero: terrario.umid + '%', dur: 4000 })
  }
}
// ---------------------------------------------------------------- presentes, mêsversário, álbum de figurinhas
function darPresente() {
  P.presenteDia = hojeSv(); store.set('pers', P)
  evento({ label: 'tenho um presente pra você!', P: 0.5, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 2500, emote: 'presente' })
  setTimeout(() => {
    if (cfg.key && nivelIA === 'ok' && Math.random() < 0.6) fazerDesenho(null, 'Fiz pra você:')
    else { cantarMusica(); legendaSempre(`${cfg.nome}: Compus uma musiquinha pra você!`) }
    figurinha('presente')
  }, 3200)
}
const diasDeVida = () => Math.floor((Date.now() - P.nasceu) / 86400000)
let festaAte = 0
const PARABENS = [7, 7, 9, 7, 12, 11, 7, 7, 9, 7, 14, 12].map((st, i) => ({ st, d: [0.18, 0.12, 0.35, 0.35, 0.35, 0.6][i % 6] }))
function fazerFesta(d = diasDeVida()) {
  festaAte = now() + 3600000; vestir('chapeu', true); decoNova = true
  evento({ label: `${d} dias de vida! festa!`, P: 0.6, A: 0.6, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['bolo', 'festa'], numero: `${d}d`, dur: 4000, emote: 'presente' })
  setTimeout(() => tocarMelodia(PARABENS, 1), 3500)
}
function tickFesta() {
  const d = diasDeVida()
  if (d > 0 && d % 30 === 0 && P.ultimaFesta !== d && !dormindo) { P.ultimaFesta = d; store.set('pers', P); fazerFesta(d) }
  if (festaAte && now() > festaAte) { festaAte = 0; vestir('chapeu', false) }
}
const FIGURINHAS = [
  ['conversa', '💬', 'Primeira conversa'], ['amigos', '🤝', '10 conversas'], ['melodia', '🎵', 'Jogou a melodia'], ['recorde5', '🏆', '5 rodadas na melodia'], ['som', '👂', 'Aprendeu um barulho'],
  ['decorou', '🎄', 'Decorou a tela'], ['sonho', '💭', 'Primeiro sonho'], ['pesadelo', '👻', 'Sobreviveu a um pesadelo'], ['consolo', '🤗', 'Foi consolado'], ['charada', '🧩', 'Acertou charada'],
  ['vinte', '❓', 'Descobriu nas 20 perguntas'], ['quiz', '🧮', 'Quiz 8 de 10'], ['careta', '😜', 'Imitou 4 caretas'], ['ritmo', '👏', 'Ritmo de 5 palmas'], ['esconde', '🙈', 'Esconde-esconde'],
  ['ppt', '✌️', 'Venceu no pedra-papel-tesoura'], ['desenho', '🎨', 'Primeiro desenho'], ['dancou', '💃', 'Dançou junto'], ['noticias', '📰', 'Contou as notícias'], ['foco', '🎧', 'Um foco completo'],
  ['lembrete', '⏰', 'Lembrou de algo'], ['presente', '🎁', 'Deu um presente'], ['semana', '📅', '7 dias de vida'], ['mes', '🎂', '1 mês de vida'],
  ['velha', '⭕', 'Ganhou no jogo da velha'], ['shazam', '🎧', 'Reconheceu uma música'], ['aprendeu_musica', '🎼', 'Aprendeu uma música'], ['karaoke', '🎤', 'Continuou a música'],
  ['truque', '🪄', 'Aprendeu um truque'], ['careta_nova', '🤪', 'Aprendeu uma careta'], ['palavra', '📖', 'Palavra do dia'], ['torcida', '⚽', 'Comemorou um gol'],
  ['agua', '💧', '8 copos de água'], ['coragem', '🌙', 'Perdeu o medo do escuro'], ['adivinha', '🔊', 'Adivinhou 3 sons'], ['genius', '🌈', '5 cores de memória'], ['historia2', '📜', 'História a dois'],
]
function figurinha(id) {
  P.album ||= {}
  if (P.album[id]) return
  const f = FIGURINHAS.find((x) => x[0] === id); if (!f) return
  P.album[id] = Date.now(); store.set('pers', P)
  pushLog(`Álbum→ figurinha nova: ${f[2]} (${Object.keys(P.album).length}/${FIGURINHAS.length})`)
  const avisar = () => { // espera a história, a brincadeira ou o emote acabar para não atropelar
    if (imag.ativo || palco || brinc || alarme || danca) return setTimeout(avisar, 3000)
    mostrarBalao([f[1], '⭐'], `${Object.keys(P.album).length}/${FIGURINHAS.length}`, 4000); legendaSempre(`${cfg.nome}: Figurinha nova: ${f[2]}!`); somDe('feliz', 0.4)
  }
  setTimeout(avisar, 4500)
}
function conferirAlbum() {
  if (P.conversas) figurinha('conversa'); if ((P.conversas || 0) >= 10) figurinha('amigos')
  if ((P.recordeMelodia || 0) >= 1) figurinha('melodia'); if ((P.recordeMelodia || 0) >= 5) figurinha('recorde5')
  if (sons.some((s) => s.significado)) figurinha('som'); if (P.deco) figurinha('decorou')
  if (memorias.some((m) => m.tipo === 'sonho')) figurinha('sonho'); if (memorias.some((m) => m.tipo === 'pesadelo')) figurinha('pesadelo')
  if (memorias.some((m) => /consolou/.test(m.txt))) figurinha('consolo')
  if (diasDeVida() >= 7) figurinha('semana'); if (diasDeVida() >= 30) figurinha('mes')
}
function mostrarAlbum() {
  const ids = Object.keys(P.album || {})
  if (!ids.length) return evento({ label: 'meu álbum ainda está vazio', P: -0.05, interesse: 0.4, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, icones: ['livro'], numero: `0/${FIGURINHAS.length}`, dur: 3000 })
  const figs = FIGURINHAS.filter((f) => ids.includes(f[0]))
  evento({ label: `meu álbum: ${figs.length} figurinhas`, P: 0.3, interesse: 0.6, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, dur: 1500 })
  for (let i = 0; i < figs.length; i += 3) setTimeout(() => mostrarBalao(figs.slice(i, i + 3).map((f) => f[1]), `${figs.length}/${FIGURINHAS.length}`, 2400), 1500 + (i / 3) * 2200)
  legendaSempre(`${cfg.nome}: ${figs.map((f) => f[2]).join(' · ')}`, 1500 + Math.ceil(figs.length / 3) * 2200)
}

// ================================================================ MÚSICA, JOGOS E VIDA (v26)
// ---------------------------------------------------------------- gravar um trecho do microfone (para o Gemini ouvir)
// Enquanto grava, o "mãos livres" não tenta transcrever (cantarolar não vira frase).
let captura = null
function gravarTrecho(ms) {
  return new Promise((ok, falhou) => {
    if (!actx) return falhou(new Error('microfone desligado'))
    if (captura) return falhou(new Error('já estou gravando'))
    const c = captura = { chunks: [], ate: now() + ms, fim: ok }
    setTimeout(() => { if (captura === c) { captura = null; falhou(new Error('não chegou som do microfone')) } }, ms + 3000)
  })
}
function capturar(x, t) { // chamada pelo ouvido a cada pedaço de som
  if (!captura) return
  captura.chunks.push(x)
  if (t >= captura.ate) { const c = captura; captura = null; c.fim(paraWav(c.chunks, actx.sampleRate)) }
}
async function blobBase64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192))
  return btoa(s)
}
const precisaGemini = (oque) => {
  if (servidor.temGemini()) return true
  evento({ label: `${oque}: preciso do Gemini`, P: -0.05, interesse: 0.4, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, icones: ['ouvido', 'pergunta'], dur: 2500 })
  legendaSempre(`${cfg.nome}: Pra isso eu preciso da chave do Gemini (em ⚙️).`)
  return false
}

// ---------------------------------------------------------------- caderninho de músicas (domínio público)
// Notação: letra da nota (minúscula = oitava do meio, MAIÚSCULA = oitava de baixo, ^ = de cima, # = sustenido)
// seguida dos tempos (1 = uma batida). "r" é pausa.
const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
function partitura(txt, bpm) {
  const bat = 60 / bpm
  return txt.trim().split(/\s+/).map((tk) => {
    const m = /^([a-gA-Gr])(#?)(\^?)([\d.]*)$/.exec(tk); if (!m) return null
    const d = (+m[4] || 1) * bat
    if (m[1] === 'r') return { st: null, d }
    return { st: SEMI[m[1].toLowerCase()] + (m[2] ? 1 : 0) + (m[3] ? 12 : 0) - (m[1] === m[1].toUpperCase() ? 12 : 0), d }
  }).filter(Boolean)
}
const CANCOES = [
  { nome: 'Brilha, brilha, estrelinha', alias: 'brilha brilha|estrelinha|twinkle', bpm: 110, n: 'c c g g a a g2 f f e e d d c2 g g f f e e d2 g g f f e e d2 c c g g a a g2 f f e e d d c2' },
  { nome: 'Parabéns pra você', alias: 'parabens|aniversario|happy birthday', bpm: 100, n: 'G.75 G.25 A G c B2 G.75 G.25 A G d c2 G.75 G.25 g e c B A2 f.75 f.25 e c d c2' },
  { nome: 'Jingle Bells', alias: 'jingle|bate o sino|sino de natal', bpm: 170, n: 'e e e2 e e e2 e g c1.5 d.5 e4 f f f1.5 f.5 f e e e.5 e.5 e d d e d2 g2' },
  { nome: 'Ode à Alegria', alias: 'ode a alegria|hino a alegria|beethoven|nona sinfonia', bpm: 120, n: 'e e f g g f e d c c d e e1.5 d.5 d2 e e f g g f e d c c d e d1.5 c.5 c2' },
  { nome: 'Frère Jacques (Irmão Jacó)', alias: 'frere jacques|irmao jaco|frei jaco|dorme jaco', bpm: 120, n: 'c d e c c d e c e f g2 e f g2 g.5 a.5 g.5 f.5 e c g.5 a.5 g.5 f.5 e c c G c2 c G c2' },
  { nome: 'Noite Feliz', alias: 'noite feliz|silent night', bpm: 95, n: 'g1.5 a.5 g e3 g1.5 a.5 g e3 d^2 d^ b3 c^2 c^ g3 a2 a c^1.5 b.5 a g1.5 a.5 g e3 a2 a c^1.5 b.5 a g1.5 a.5 g e3 d^2 d^ f^1.5 d^.5 b c^3 e^3' },
  { nome: 'Für Elise', alias: 'fur elise|para elisa', bpm: 130, n: 'e^.5 d#^.5 e^.5 d#^.5 e^.5 b.5 d^.5 c^.5 a1.5 c.5 e.5 a.5 b1.5 e.5 g#.5 b.5 c^2' },
]
function acharMusica(nome) {
  const n = palavrasN(nome)
  const aprendida = Object.keys(P.musicas || {}).find((k) => n.includes(palavrasN(k).trim()) || palavrasN(k).includes(n.trim()))
  if (aprendida && n.trim()) return { nome: aprendida, notas: P.musicas[aprendida], aprendida: true }
  const c = CANCOES.find((x) => x.alias.split('|').some((a) => n.includes(' ' + a + ' ') || n.includes(a)))
  return c ? { nome: c.nome, notas: partitura(c.n, c.bpm) } : null
}
const duracao = (notas) => notas.reduce((a, x) => a + x.d, 0)
// Depois de cantar uma música "de ouvido", ele fica um tempinho esperando a correção assobiada.
let correcaoMusica = null
async function cantarMusicaPedida(nome) {
  nome = String(nome || '').replace(/^(a |o )?(m[úu]sica |can[çc][ãa]o )?(do |da |de )?/i, '').trim()
  if (!nome) return cantarMusica()
  let m = acharMusica(nome), deOuvido = false
  if (!m) {
    foco = { expr: 'pensando', ate: now() + 6000 }; icone = { tipo: 'reticencias', ate: now() + 6000 }
    try {
      const j = await servidor.notasDaMusica(nome)
      if (j.conhece !== false && Array.isArray(j.notas) && j.notas.length >= 4) {
        const bat = 60 / clamp(+j.bpm || 110, 60, 180)
        m = { nome: j.titulo || nome, notas: j.notas.slice(0, 28).map((x) => ({ st: x[0] === null ? null : clamp(Math.round(+x[0] || 0), -12, 19), d: clamp((+x[1] || 1) * bat, 0.08, 1.4) })) }
        deOuvido = true
      }
    } catch (e) { pushLog('Música: ' + e.message) }
    foco = null; icone = null
  }
  if (!m) {
    evento({ label: `não sei cantar ${nome}`, P: -0.05, interesse: 0.5, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, icones: ['musica', 'pergunta'], dur: 2500 })
    legendaSempre(`${cfg.nome}: Não conheço “${nome}”… me ensina? Cantarola ela pra mim e depois diz “essa é ${nome}”.`)
    return
  }
  foco = { expr: 'contente', ate: now() + duracao(m.notas) * 1000 + 800 }; icone = { tipo: 'nota', ate: foco.ate }
  legendaSempre(`${cfg.nome}: ♪ ${m.nome}${deOuvido ? ' (acho que é mais ou menos assim…)' : ''}`, duracao(m.notas) * 1000 + 2500)
  tocarMelodia(m.notas, 1, { assobio: Math.random() < 0.3 })
  pushLog(`Música→ cantou ${m.nome}${m.aprendida ? ' (do jeito que você ensinou)' : deOuvido ? ' (de ouvido, pela IA)' : ' (do caderninho)'}`)
  if (deOuvido) correcaoMusica = { nome: m.nome, ate: now() + duracao(m.notas) * 1000 + 25000 }
}
// Você ensina: cantarola e diz "essa é a música X" (ou corrige logo depois de ele cantar).
let ultimaMelodia = null
function aprenderMusica(nome, notas) {
  P.musicas ||= {}; P.musicas[nome] = notas.slice(0, 32); store.set('pers', P)
  lembrar(`${cfg.dono} me ensinou a cantar ${nome}`, 6)
  evento({ label: `aprendi a música ${nome}!`, P: 0.4, A: 0.4, interesse: 0.8, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, icones: ['musica', 'certo'], dur: 2500 })
  legendaSempre(`${cfg.nome}: Aprendi “${nome}”! Agora sei cantar do seu jeito.`)
  setTimeout(() => tocarMelodia(notas, 1), 2200)
  figurinha('aprendeu_musica')
}

// ---------------------------------------------------------------- "que música é essa?"
let reconhecendo = false
const musicaSessao = { desde: 0, tentou: false }
async function qualMusica(origem = 'pedido') {
  if (reconhecendo || !precisaGemini('Reconhecer música')) return
  reconhecendo = true
  try {
    if (origem === 'pedido') {
      evento({ label: 'ouvindo a música', P: 0.1, A: 0.3, interesse: 0.8, expr: 'ouvindo', icones: ['ouvido', 'musica'], som: false, dur: 2500 })
      legendaSempre(`${cfg.nome}: Pode cantarolar, assobiar ou deixar tocar… tô ouvindo! 🎵`, 10000)
      await new Promise((r) => setTimeout(r, 1200))
    }
    foco = { expr: 'ouvindo', ate: now() + 9500 }; icone = { tipo: 'nota', ate: now() + 9500 }
    const wav = await gravarTrecho(origem === 'pedido' ? 9000 : 8000)
    foco = { expr: 'pensando', ate: now() + 8000 }; icone = { tipo: 'reticencias', ate: now() + 8000 }
    const j = await servidor.identificarMusica(await blobBase64(wav))
    foco = null; icone = null
    pushLog(`Música→ ouviu ${j.o_que_ouviu || '?'}: ${j.titulo || '(não reconheceu)'}${j.artista ? ' — ' + j.artista : ''} (${Math.round((+j.confianca || 0) * 100)}%)`)
    P.idMusica = { dia: hojeSv(), n: (P.idMusica?.dia === hojeSv() ? P.idMusica.n : 0) + 1 }
    if (j.titulo && +j.confianca >= (origem === 'pedido' ? 0.45 : 0.6)) {
      const conhecida = acharMusica(j.titulo)
      evento({ label: `reconheci a música: ${j.titulo}`, P: 0.35, A: 0.5, interesse: 0.85, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['musica', 'certo'], dur: 3000 })
      legendaSempre(`${cfg.nome}: ${+j.confianca < 0.7 ? 'Acho que é' : 'É'} “${j.titulo}”${j.artista ? ' — ' + j.artista : ''}!${conhecida ? ' Essa eu sei!' : ''}`, 7000)
      P.musicasOuvidas = [{ titulo: j.titulo, artista: j.artista || '', t: Date.now() }, ...(P.musicasOuvidas || []).filter((x) => x.titulo !== j.titulo)].slice(0, 20)
      lembrar(`Ouvi a música ${j.titulo}${j.artista ? ' (' + j.artista + ')' : ''} com ${cfg.dono}`, 3)
      figurinha('shazam')
      if (conhecida && origem === 'pedido') setTimeout(() => { tocarMelodia(conhecida.notas, 1); foco = { expr: 'musica', ate: now() + duracao(conhecida.notas) * 1000 } }, 3200)
    } else if (origem === 'pedido') {
      evento({ label: 'não reconheci a música', P: -0.05, interesse: 0.5, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, icones: ['musica', 'pergunta'], dur: 2500 })
      legendaSempre(`${cfg.nome}: ${j.o_que_ouviu === 'silencio' ? 'Não ouvi nada…' : 'Essa eu não reconheci… qual é?'}`)
    }
    store.set('pers', P)
  } catch (e) {
    pushLog('Música: ' + e.message); foco = null; icone = null
    if (origem === 'pedido') evento({ label: 'não consegui ouvir a música', gesto: 'nao_sei', forcarGesto: true, icones: ['ouvido', 'errado'], interesse: 0.4, dur: 2000 })
  } finally { reconhecendo = false }
}
function tickMusicaOuvida() { // música tocando faz tempo: ele tenta reconhecer sozinho (poucas vezes por dia)
  if (!audio.musica) { musicaSessao.desde = 0; musicaSessao.tentou = false; return }
  if (!musicaSessao.desde) musicaSessao.desde = now()
  const hoje = P.idMusica?.dia === hojeSv() ? P.idMusica.n : 0
  if (!musicaSessao.tentou && now() - musicaSessao.desde > 20000 && hoje < 8 && servidor.temGemini() && nivelIA === 'ok' && !dormindo && !brinc && !gravando && audio.testeAte < now()) {
    musicaSessao.tentou = true; qualMusica('auto')
  }
}

// ---------------------------------------------------------------- jogo da velha (por voz)
const LINHAS_VELHA = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
function fimDaVelha(c) {
  for (const l of LINHAS_VELHA) if (c[l[0]] !== '.' && c[l[0]] === c[l[1]] && c[l[1]] === c[l[2]]) return { p: c[l[0]], l }
  return c.includes('.') ? null : { p: 'empate', l: [] }
}
function minimaxVelha(c, eu, vez, prof = 0) {
  const f = fimDaVelha(c)
  if (f) return f.p === 'empate' ? 0 : f.p === eu ? 10 - prof : prof - 10
  const outro = vez === 'X' ? 'O' : 'X'
  let melhor = vez === eu ? -99 : 99
  for (let i = 0; i < 9; i++) if (c[i] === '.') {
    c[i] = vez; const v = minimaxVelha(c, eu, outro, prof + 1); c[i] = '.'
    melhor = vez === eu ? Math.max(melhor, v) : Math.min(melhor, v)
  }
  return melhor
}
function jogadaDoRobo(c, eu, erra) {
  const livres = c.map((v, i) => (v === '.' ? i : -1)).filter((i) => i >= 0)
  if (Math.random() < erra) return sorteia(livres)
  const outro = eu === 'X' ? 'O' : 'X'
  let melhor = -99, ops = []
  for (const i of livres) { c[i] = eu; const v = minimaxVelha(c, eu, outro); c[i] = '.'; if (v > melhor) { melhor = v; ops = [i] } else if (v === melhor) ops.push(i) }
  return sorteia(ops)
}
// "canto superior esquerdo", "centro", "meio de cima", "lado direito", "casa 7"…
function casaFalada(texto) {
  const t = txtN(texto)
  let r = null, c = null
  if (/superior|em cima|de cima|\bcima\b|\balto\b|topo|primeira linha|linha de cima/.test(t)) r = 0
  if (/inferior|embaixo|em baixo|de baixo|\bbaixo\b|ultima linha|terceira linha|linha de baixo/.test(t)) r = 2
  if (/esquerd/.test(t)) c = 0
  if (/direit/.test(t)) c = 2
  const meio = /centro|\bmeio\b|central|segunda linha/.test(t)
  if (r === null && c === null) {
    if (meio) return 4
    const n = numeroFalado(t); return n >= 1 && n <= 9 ? n - 1 : null
  }
  if (r === null) r = 1
  if (c === null) c = 1
  return r * 3 + c
}
function pecaFalada(texto) {
  const t = palavrasN(texto)
  if (/ (x|xis|chis|xiz|cruz|xizinho) /.test(t)) return 'X'
  if (/ (bola|bolinha|circulo|zero|o|oh|ó) /.test(t) || /^\s*[oó][.!]?\s*$/i.test(texto)) return 'O'
  return null
}
const NOME_CASA = ['canto de cima à esquerda', 'meio de cima', 'canto de cima à direita', 'meio da esquerda', 'centro', 'meio da direita', 'canto de baixo à esquerda', 'meio de baixo', 'canto de baixo à direita']
function brincVelha() {
  const b = { tipo: 'velha', fase: 'escolha', c: [...'.........'], voce: null, eu: null, vez: 'X', placar: [0, 0, 0], ultima: -1, linha: [], quemComeca: 'X', espera: 0, avisos: 0 }
  const tela = () => enviarC3(`VELHA ${b.c.join('')} ${b.ultima >= 0 ? b.ultima : '-'} ${b.linha.length ? b.linha.join(',') : '-'}`)
  const suaVez = () => { b.fase = 'voce'; b.espera = now(); b.avisos = 0; legendaSempre(`${cfg.nome}: Sua vez (${b.voce})! Fala o lugar: centro, canto superior esquerdo, meio de baixo…`, 9000) }
  const conferirFim = () => {
    const f = fimDaVelha(b.c); if (!f) return false
    b.linha = f.l; tela(); b.fase = 'fim'
    if (f.p === 'empate') { b.placar[2]++; evento({ label: 'velha: deu velha (empate)', P: 0.1, A: 0.2, interesse: 0.7, expr: 'rindo', gesto: 'talvez', forcarGesto: true, dur: 2500 }); legendaSempre(`${cfg.nome}: Deu velha! Empate. Mais uma?`) }
    else if (f.p === b.voce) { b.placar[0]++; P.velhaPerdas = 0; evento({ label: 'velha: você ganhou', P: 0.05, A: 0.4, interesse: 0.8, expr: 'surpreso', gesto: 'desmaiar', forcarGesto: true, som: 'triste', dur: 2800 }); legendaSempre(`${cfg.nome}: Você ganhou! Como assim?! Revanche?`); figurinha('velha') }
    else { b.placar[1]++; P.velhaPerdas = (P.velhaPerdas || 0) + 1; evento({ label: 'velha: eu ganhei', P: 0.4, A: 0.5, interesse: 0.8, expr: 'orgulhoso', gesto: 'dancinha', forcarGesto: true, som: 'feliz', dur: 2800 }); legendaSempre(`${cfg.nome}: Ganhei! Hehe. Mais uma?`) }
    setTimeout(() => brinc === b && mostrarBalao([], `${b.placar[0]}x${b.placar[1]}`, 3500), 1500)
    b.espera = now(); store.set('pers', P)
    return true
  }
  const roboJoga = () => {
    if (brinc !== b) return
    b.fase = 'eu'; foco = { expr: 'pensando', ate: now() + 1300 }; icone = { tipo: 'reticencias', ate: now() + 1300 }
    setTimeout(() => {
      if (brinc !== b) return
      // Erra às vezes, e mais quando você anda perdendo (para ficar divertido).
      const i = jogadaDoRobo(b.c, b.eu, clamp(0.18 + (P.velhaPerdas || 0) * 0.08, 0.1, 0.5))
      b.c[i] = b.eu; b.ultima = i; tela(); somDe('curioso', 0.3); batida(0.5)
      pushLog(`Velha→ eu joguei no ${NOME_CASA[i]}`)
      if (!conferirFim()) { b.vez = b.voce; suaVez() }
    }, 1300)
  }
  const novaPartida = () => {
    b.c = [...'.........']; b.ultima = -1; b.linha = []; b.vez = b.quemComeca; tela()
    if (b.vez === b.eu) { legendaSempre(`${cfg.nome}: Eu começo!`); roboJoga() } else suaVez()
    b.quemComeca = b.quemComeca === 'X' ? 'O' : 'X' // na próxima, o outro começa
  }
  b.tick = () => {
    if (b.fase === 'voce' && now() - b.espera > 45000 * (b.avisos + 1)) {
      if (++b.avisos >= 4) return acabarBrinc('ninguém jogou')
      evento({ label: 'velha: esperando sua jogada', interesse: 0.4, expr: 'curioso', gesto: 'olhar_em_volta', dur: 1500 }); legendaSempre(`${cfg.nome}: E aí? É sua vez (${b.voce}).`)
    }
    if ((b.fase === 'fim' || b.fase === 'escolha') && now() - b.espera > 90000) acabarBrinc('parou de responder')
  }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t) && !/n[ãa]o para/i.test(t)) { acabarBrinc('parou'); return true }
    if (b.fase === 'escolha') {
      const p = pecaFalada(t)
      if (!p && t.split(/\s+/).length > 5) return false
      if (!p) { legendaSempre(`${cfg.nome}: X ou O (bolinha)?`); iniciarGesto('nao_sei'); return true }
      b.voce = p; b.eu = p === 'X' ? 'O' : 'X'
      evento({ label: `velha: você é ${p}`, P: 0.2, A: 0.3, interesse: 0.8, expr: 'empolgado', gesto: 'sim', forcarGesto: true, dur: 1200 })
      legendaSempre(`${cfg.nome}: Você é ${p === 'X' ? 'X' : 'O (bolinha)'}, eu sou ${b.eu === 'X' ? 'X' : 'O'}. O X começa!`)
      b.quemComeca = 'X'; setTimeout(novaPartida, 1800); return true
    }
    if (b.fase === 'fim') {
      if (RE_NAO.test(t) || /chega|cansei/i.test(t)) { acabarBrinc('acabou'); placarFinal(`velha: ${b.placar[0]} x ${b.placar[1]}`, b.placar[0], b.placar[0] + b.placar[1] + b.placar[2], b.placar[0] >= b.placar[1]); return true }
      if (RE_SIM.test(t) || /de novo|outra|mais uma|bora|vamos|revanche/i.test(t)) { novaPartida(); return true }
      return true
    }
    if (b.fase !== 'voce') { legendaSempre(`${cfg.nome}: Calma, é a minha vez!`); return true }
    const i = casaFalada(t)
    if (i === null && t.split(/\s+/).length > 5) return false // frase comprida que não é jogada: segue para a conversa
    if (i === null) { iniciarGesto('nao_sei'); legendaSempre(`${cfg.nome}: Onde? Fala tipo: “centro”, “canto inferior direito”, “meio de cima”.`, 7000); return true }
    if (b.c[i] !== '.') { iniciarGesto('nao'); somDe('bravo', 0.2); legendaSempre(`${cfg.nome}: O ${NOME_CASA[i]} já tem peça! Escolhe outro.`); return true }
    b.c[i] = b.voce; b.ultima = i; tela(); somDe('neutro', 0.25)
    if (!conferirFim()) { b.vez = b.eu; roboJoga() }
    return true
  }
  b.aoAcabar = () => enviarC3('VELHA -')
  comecarBrinc(b)
  pararImaginacao(); balao = null
  tela()
  evento({ label: 'jogo da velha!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1500 })
  legendaSempre(`${cfg.nome}: Jogo da velha! Você quer ser X ou O (bolinha)?`, 9000)
  b.espera = now()
}

// ---------------------------------------------------------------- karaokê ao contrário: ele começa, você continua
function brincKaraoke() {
  const b = { tipo: 'karaoke', rodada: 0, total: 3, pontos: 0, semVoz: false, atual: null }
  const lista = [...CANCOES.map((c) => ({ nome: c.nome, notas: partitura(c.n, c.bpm) })), ...Object.entries(P.musicas || {}).map(([nome, notas]) => ({ nome, notas }))].filter((m) => m.notas.filter((n) => n.st !== null).length >= 8).sort(() => Math.random() - 0.5)
  b.proxima = () => {
    if (brinc !== b) return
    if (b.rodada >= b.total || !lista[b.rodada]) { acabarBrinc(); placarFinal(`karaokê: ${b.pontos}/${b.rodada}`, b.pontos, b.rodada, b.pontos >= 2); if (b.pontos) figurinha('karaoke'); return }
    const m = lista[b.rodada++], so = m.notas.filter((n) => n.st !== null), meio = Math.floor(so.length / 2)
    b.atual = { nome: m.nome, resto: so.slice(meio, meio + 6).map((n) => n.st) }
    const comeco = so.slice(0, meio)
    legendaSempre(`${cfg.nome}: Rodada ${b.rodada} de ${b.total}: continua essa! (cantarola ou assobia)`, 6000)
    foco = { expr: 'musica', ate: now() + duracao(comeco) * 1000 }; tocarMelodia(comeco, 1)
    setTimeout(() => { if (brinc !== b) return; b.semVoz = true; b.ate = now() + 12000; foco = { expr: 'ouvindo', ate: b.ate }; icone = { tipo: 'nota', ate: b.ate } }, duracao(comeco) * 1000 + 400)
  }
  const resultado = (ok) => {
    b.semVoz = false; b.ate = 0; icone = null
    if (ok) { b.pontos++; evento({ label: `karaokê: acertou ${b.atual.nome}`, P: 0.4, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1800 }) }
    else evento({ label: `karaokê: não era bem assim (${b.atual.nome})`, P: 0, interesse: 0.6, expr: 'rindo', gesto: 'nao', forcarGesto: true, dur: 1500 })
    legendaSempre(`${cfg.nome}: ${ok ? 'Isso!' : 'Quase!'} Era “${b.atual.nome}”.`)
    setTimeout(b.proxima, 3000)
  }
  b.melodia = (notas) => { // seu canto: vale o desenho das primeiras notas
    if (!b.semVoz) return
    const canto = notas.filter((n) => n.st !== null).map((n) => n.st), alvo = b.atual.resto, k = Math.min(alvo.length, canto.length, 5)
    let certas = 0
    for (let i = 1; i < k; i++) { const a = alvo[i] - alvo[i - 1], c = canto[i] - canto[i - 1]; if (Math.sign(a) === Math.sign(c) && Math.abs(a - c) <= 3) certas++ }
    resultado(k >= 3 && certas >= k - 2)
  }
  b.tick = () => { if (b.ate && now() > b.ate) { b.ate = 0; b.semVoz = false; icone = null; evento({ label: 'karaokê: ninguém cantou', interesse: 0.4, expr: 'curioso', gesto: 'nao_sei', forcarGesto: true, dur: 1500 }); legendaSempre(`${cfg.nome}: Era “${b.atual.nome}”!`); setTimeout(b.proxima, 2600) } }
  b.ouvir = (t) => { ouviu(t); if (SAIR_BRINC.test(t)) { acabarBrinc('parou'); return true } return true }
  comecarBrinc(b)
  evento({ label: 'karaokê ao contrário!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'dancinha', forcarGesto: true, icones: ['musica', 'jogo'], dur: 1800 })
  setTimeout(b.proxima, 2200)
}

// ---------------------------------------------------------------- adivinha o som
// Sons feitos na hora (sintetizados), mais os barulhos que ele aprendeu com você.
const SONS_JOGO = {
  gato: { ic: 'gato', re: 'gato|miau|gatinho|gata' }, cachorro: { ic: 'cachorro', re: 'cachorro|cao|au au|latido|cachorrinho|late' },
  passarinho: { ic: '🐦', re: 'passarinho|passaro|piu|ave|canario' }, sino: { ic: 'sino', re: 'sino|igreja|badalo' },
  chuva: { ic: 'chuva', re: 'chuva|chovendo|chuvisco' }, trovao: { ic: 'trovao', re: 'trovao|tempestade|trovoada' },
  sapo: { ic: '🐸', re: 'sapo|ra|perereca' }, trem: { ic: '🚂', re: 'trem|apito|locomotiva|maria fumaca' },
  sirene: { ic: '🚨', re: 'sirene|ambulancia|policia|bombeiro|alarme' }, relogio: { ic: 'relogio', re: 'relogio|tique|tic tac|tique taque' },
  telefone: { ic: 'celular', re: 'telefone|celular|ligacao|toque|ligando' }, vaca: { ic: '🐄', re: 'vaca|boi|mu|muu' },
}
function tocarSomJogo(nome) {
  if (!actx) return
  const out = actx.createGain(); out.gain.value = 0.3; out.connect(actx.destination)
  const t0 = actx.currentTime + 0.05
  const ruidoF = (t, d, tipo, freq, vol = 0.8) => {
    const buf = actx.createBuffer(1, Math.ceil(actx.sampleRate * d), actx.sampleRate), ch = buf.getChannelData(0)
    let ult = 0; for (let i = 0; i < ch.length; i++) { const w = Math.random() * 2 - 1; ult = tipo === 'marrom' ? (ult + 0.02 * w) / 1.02 : w; ch[i] = tipo === 'marrom' ? ult * 3.5 : w }
    const s = actx.createBufferSource(); s.buffer = buf
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq
    const gn = actx.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(vol, t + d * 0.2); gn.gain.exponentialRampToValueAtTime(0.0001, t + d)
    s.connect(f).connect(gn).connect(out); s.start(t); return gn
  }
  const tom = (t, f0, f1, d, tipo = 'sine', vol = 0.7) => silaba(out, t, f0, f1, d, tipo, 0, vol)
  let dur = 1.5
  if (nome === 'gato') { tom(t0, 520, 780, 0.25, 'sawtooth', 0.4); tom(t0 + 0.25, 780, 430, 0.5, 'sawtooth', 0.4); dur = 0.9 }
  else if (nome === 'cachorro') { for (const k of [0, 0.35, 0.55]) { tom(t0 + k, 420, 260, 0.13, 'square', 0.5); ruido(out, t0 + k, 0.12, 900) } dur = 0.9 }
  else if (nome === 'passarinho') { for (let i = 0; i < 6; i++) tom(t0 + i * 0.13, 2600 + (i % 2) * 900, 3900, 0.08, 'sine', 0.5); dur = 1 }
  else if (nome === 'sino') { for (const k of [0, 0.9]) { tom(t0 + k, 880, 880, 0.85, 'sine', 0.8); tom(t0 + k, 2112, 2112, 0.5, 'sine', 0.25) } dur = 1.9 }
  else if (nome === 'chuva') { ruidoF(t0, 2.6, 'branco', 1800, 0.5); dur = 2.6 }
  else if (nome === 'trovao') { ruidoF(t0, 2.4, 'marrom', 260, 1); dur = 2.4 }
  else if (nome === 'sapo') { for (const k of [0, 0.45, 0.9]) for (let i = 0; i < 6; i++) tom(t0 + k + i * 0.035, 140, 120, 0.03, 'square', 0.5); dur = 1.3 }
  else if (nome === 'trem') { for (const k of [0, 0.75]) { tom(t0 + k, 660, 640, 0.6, 'triangle', 0.5); tom(t0 + k, 830, 810, 0.6, 'triangle', 0.4) } dur = 1.4 }
  else if (nome === 'sirene') { for (let i = 0; i < 2; i++) { tom(t0 + i * 0.9, 650, 1250, 0.45, 'sine', 0.5); tom(t0 + i * 0.9 + 0.45, 1250, 650, 0.45, 'sine', 0.5) } dur = 1.8 }
  else if (nome === 'relogio') { for (let i = 0; i < 6; i++) ruido(out, t0 + i * 0.5, 0.03, i % 2 ? 2500 : 1800); dur = 3 }
  else if (nome === 'telefone') { for (const k of [0, 1.2]) for (let i = 0; i < 20; i++) tom(t0 + k + i * 0.04, i % 2 ? 480 : 440, i % 2 ? 480 : 440, 0.035, 'sine', 0.5); dur = 2.1 }
  else if (nome === 'vaca') { tom(t0, 150, 110, 1.2, 'sawtooth', 0.45); dur = 1.3 }
  falandoAte = now() + dur * 1000 + 300
  return dur
}
function brincAdivinhaSom() {
  const gravados = sons.filter((s) => s.significado && s.audio)
  const fila = [...Object.keys(SONS_JOGO).sort(() => Math.random() - 0.5).slice(0, 3)]
  if (gravados.length) fila.splice(1, 0, 'gravado:' + sorteia(gravados).id)
  const b = { tipo: 'adivinha_som', fila, rodada: 0, pontos: 0, meus: 0, total: fila.length, atual: null, erros: 0, inverte: servidor.temGemini() ? 2 : 0, fase: '' }
  const tocar = () => {
    const a = b.atual
    if (a.startsWith('gravado:')) { const s = sons.find((x) => x.id === +a.slice(8) || String(x.id) === a.slice(8)); if (s) tocarSomGravado(s, false) }
    else tocarSomJogo(a)
  }
  const resposta = () => {
    const a = b.atual
    if (a.startsWith('gravado:')) { const s = sons.find((x) => String(x.id) === a.slice(8)); return { nome: s?.significado || 'aquele barulho', ic: s?.icones?.[0] || 'ouvido', re: txtN(s?.significado || 'zzz').replace(/[^a-z ]/g, '').split(' ').filter((w) => w.length > 3).join('|') || 'zzz' } }
    return { nome: a, ...SONS_JOGO[a] }
  }
  b.proxima = () => {
    if (brinc !== b) return
    if (b.rodada >= b.total) return b.inverte ? suaVezDeImitar() : fim()
    b.atual = b.fila[b.rodada++]; b.erros = 0; b.fase = 'adivinhar'
    legendaSempre(`${cfg.nome}: Som ${b.rodada} de ${b.total}: o que é isso?`, 5000)
    foco = { expr: 'curioso', ate: now() + 3000 }; setTimeout(tocar, 600)
  }
  const revelar = (ok) => {
    const r = resposta(); b.fase = ''
    mostrarBalao([r.ic], '', 2500)
    if (ok) { b.pontos++; evento({ label: `adivinhou o som: ${r.nome}`, P: 0.4, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1800 }) }
    else evento({ label: `o som era ${r.nome}`, P: 0.1, interesse: 0.5, expr: 'rindo', gesto: 'rir', forcarGesto: true, dur: 1500 })
    legendaSempre(`${cfg.nome}: ${ok ? 'Isso!' : 'Era'} ${r.nome}!`)
    setTimeout(b.proxima, 2800)
  }
  const suaVezDeImitar = async () => {
    if (brinc !== b) return
    b.inverte--; b.fase = 'imitar'
    legendaSempre(`${cfg.nome}: Agora você! Imita um bicho ou um barulho… valendo em 3, 2, 1!`, 5000)
    foco = { expr: 'ouvindo', ate: now() + 7000 }
    await new Promise((r) => setTimeout(r, 2600))
    if (brinc !== b) return
    try {
      icone = { tipo: 'nota', ate: now() + 4000 }
      const j = await servidor.adivinharSom(await blobBase64(await gravarTrecho(3500)))
      icone = null
      b.palpite = j; b.fase = 'confirmar'
      mostrarBalao(limparIcones(j.icones || []).length ? limparIcones(j.icones) : ['pergunta'], '?', 8000)
      evento({ label: `acho que você imitou ${j.som}`, P: 0.1, A: 0.3, interesse: 0.8, expr: 'pensando', gesto: 'talvez', forcarGesto: true, dur: 2000 })
      legendaSempre(`${cfg.nome}: É ${j.som || 'o quê'}? (sim ou não)`, 8000)
    } catch (e) { pushLog('Adivinha som: ' + e.message); b.fase = ''; legendaSempre(`${cfg.nome}: Não consegui ouvir…`); setTimeout(() => (b.inverte ? suaVezDeImitar() : fim()), 2000) }
  }
  const fim = () => { acabarBrinc(); placarFinal(`adivinha o som: você ${b.pontos}, eu ${b.meus}`, b.pontos, b.total, b.pontos >= Math.ceil(b.total / 2)); if (b.pontos >= 3) figurinha('adivinha') }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t)) { fim(); return true }
    if (b.fase === 'confirmar') {
      const ok = RE_SIM.test(t) || /acertou|isso|exato/i.test(t)
      if (ok) b.meus++
      evento({ label: ok ? 'acertei o seu som!' : 'errei o seu som', P: ok ? 0.4 : 0, interesse: 0.8, expr: ok ? 'orgulhoso' : 'rindo', gesto: ok ? 'pulinhos' : 'nao_sei', forcarGesto: true, dur: 1800 })
      b.fase = ''; setTimeout(() => (b.inverte ? suaVezDeImitar() : fim()), 2200); return true
    }
    if (b.fase !== 'adivinhar') return true
    if (/de novo|outra vez|repete|toca de novo|n[ãa]o ouvi/i.test(t)) { tocar(); return true }
    if (/desisto|n[ãa]o sei|passa/i.test(t)) { revelar(false); return true }
    if (temPalavra(t, resposta().re)) { revelar(true); return true }
    if (++b.erros >= 2) revelar(false)
    else { iniciarGesto('nao'); legendaSempre(`${cfg.nome}: Não… tenta de novo!`); setTimeout(tocar, 1200) }
    return true
  }
  comecarBrinc(b)
  evento({ label: 'adivinha o som!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['ouvido', 'pergunta'], dur: 1800 })
  setTimeout(b.proxima, 2000)
}

// ---------------------------------------------------------------- Genius (memória de cores)
const CORES_GENIUS = { vermelho: { l: 'r', st: 0 }, azul: { l: 'b', st: 4 }, verde: { l: 'g', st: 7 }, amarelo: { l: 'y', st: 12 } }
function coresFaladas(t) {
  const out = [], re = /vermelh|azul|verde|amarel/g; let m
  const n = txtN(t)
  while ((m = re.exec(n))) out.push({ vermelh: 'vermelho', azul: 'azul', verde: 'verde', amarel: 'amarelo' }[m[0]])
  return out
}
function brincGenius() {
  const b = { tipo: 'genius', seq: [], fase: '' }
  const mostrar = () => {
    b.fase = 'mostrando'
    b.seq.forEach((c, i) => setTimeout(() => { if (brinc !== b) return; enviarC3(`COR ${CORES_GENIUS[c].l} 520`); tocarMelodia([{ st: CORES_GENIUS[c].st, d: 0.42 }], 1, { liso: true }) }, 700 * i))
    setTimeout(() => { if (brinc !== b) return; b.fase = 'voce'; b.ate = now() + 15000 + b.seq.length * 1500; foco = { expr: 'ouvindo', ate: b.ate }; legendaSempre(`${cfg.nome}: Agora você: fala as ${b.seq.length} cor(es) em ordem!`, 8000) }, 700 * b.seq.length + 200)
  }
  const rodada = () => { if (brinc !== b) return; b.seq.push(sorteia(Object.keys(CORES_GENIUS))); legendaSempre(`${cfg.nome}: Rodada ${b.seq.length}. Presta atenção!`, 3000); setTimeout(mostrar, 1200) }
  const fim = (motivo) => {
    const n = Math.max(0, b.seq.length - 1)
    acabarBrinc(motivo)
    if (n > (P.recordeGenius || 0)) { P.recordeGenius = n; store.set('pers', P) }
    placarFinal(`genius: ${n} cor(es) de memória`, n, n, n >= 4); if (n >= 5) figurinha('genius')
    legendaSempre(`${cfg.nome}: Você lembrou ${n} cor(es)! Era: ${b.seq.join(', ')}.${n >= (P.recordeGenius || 0) && n ? ' Recorde!' : ''}`, 8000)
  }
  b.tick = () => { if (b.fase === 'voce' && now() > b.ate) { b.fase = ''; fim('tempo') } }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t)) { fim('parou'); return true }
    if (b.fase !== 'voce') return true
    const cs = coresFaladas(t)
    if (!cs.length) { legendaSempre(`${cfg.nome}: Fala as cores: vermelho, azul, verde ou amarelo.`); return true }
    const ok = cs.length >= b.seq.length && b.seq.every((c, i) => cs[i] === c)
    if (!ok) { b.fase = ''; evento({ label: 'genius: errou a sequência', P: 0, interesse: 0.6, expr: 'rindo', gesto: 'nao', forcarGesto: true, dur: 1500 }); setTimeout(() => fim('errou'), 1500); return true }
    b.fase = ''; evento({ label: `genius: acertou ${b.seq.length}`, P: 0.3, A: 0.4, interesse: 0.8, expr: 'empolgado', gesto: 'sim', forcarGesto: true, dur: 1200 })
    setTimeout(rodada, 1500); return true
  }
  comecarBrinc(b)
  evento({ label: 'jogo da memória de cores!', P: 0.3, A: 0.5, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, dur: 1500 })
  setTimeout(rodada, 1800)
}

// ---------------------------------------------------------------- história a dois (em quadrinhos)
function brincHistoria2() {
  if (!cfg.key && !servidor.temGemini()) return
  const b = { tipo: 'historia2', quadros: [], turnos: 0, maxTurnos: 3, pensando: false }
  const mostrar = () => {
    const n = b.quadros.length, passo = 1e7
    imag.ativo = { tipo: 'contando', t0: now() - (n - 1) * passo, hist: { titulo: 'história a dois', quadros: b.quadros, passo } }
    imag.quadroAtual = -1
  }
  const pedir = async (fala, fimDaHist) => {
    b.pensando = true; foco = { expr: 'pensando', ate: now() + 8000 }; icone = { tipo: 'reticencias', ate: now() + 8000 }
    try {
      const j = await servidor.historiaADois({ quadros: b.quadros, fala, fim: fimDaHist })
      const ok = (q) => q && { icones: limparIcones(q.icones || []).length ? limparIcones(q.icones) : ['pergunta'], emocao: EMOCOES.includes(q.emocao) ? q.emocao : 'contente', frase: String(q.frase || '').slice(0, 90) }
      if (j.seu_quadro && fala) b.quadros.push({ ...ok(j.seu_quadro), deVoce: true })
      if (j.meu_quadro) b.quadros.push(ok(j.meu_quadro))
      if (j.titulo) b.titulo = String(j.titulo).slice(0, 50)
      foco = null; icone = null; mostrar()
      return true
    } catch (e) { pushLog('História a dois: ' + e.message); foco = null; icone = null; return false } finally { b.pensando = false }
  }
  const terminar = () => {
    const h = { tipo: 'dupla', titulo: b.titulo || 'Nossa história', quadros: b.quadros.map(({ icones, emocao, frase }) => ({ icones, emocao, frase })), resumo: b.quadros.map((q) => q.frase).join(' ') }
    lembrar(`Inventei uma história com ${cfg.dono}: ${h.titulo} — ${h.resumo.slice(0, 160)}`, 6, 'historia')
    memorias[0].historia = h; memorias[0].contado = true; store.set('memorias', memorias)
    acabarBrinc('terminou')
    evento({ label: `nossa história: ${h.titulo}`, P: 0.5, A: 0.4, interesse: 0.9, expr: 'orgulhoso', gesto: 'pulinhos', forcarGesto: true, dur: 3000, emote: 'estrela' })
    legendaSempre(`${cfg.nome}: “${h.titulo}”! Guardei no meu diário. Quer que eu conte de novo? É só pedir.`, 8000)
    figurinha('historia2')
  }
  b.ouvir = (t) => {
    ouviu(t)
    if (SAIR_BRINC.test(t) && t.split(/\s+/).length <= 4) { acabarBrinc('parou'); imag.ativo = null; return true }
    if (b.pensando) return true
    b.turnos++
    const fimDaHist = b.turnos >= b.maxTurnos || /(e )?fim|acabou a hist|e viveram felizes/i.test(t)
    pedir(t, fimDaHist).then((ok) => {
      if (brinc !== b) return
      if (!ok) { legendaSempre(`${cfg.nome}: Me perdi na história… fala de novo?`); b.turnos--; return }
      if (fimDaHist) setTimeout(terminar, 3500)
      else legendaSempre(`${cfg.nome}: ${b.quadros[b.quadros.length - 1].frase} — E aí, o que acontece depois?`, 12000)
    })
    return true
  }
  b.aoAcabar = () => { if (imag.ativo?.hist?.titulo === 'história a dois') imag.ativo = null }
  comecarBrinc(b)
  evento({ label: 'vamos inventar uma história juntos!', P: 0.3, A: 0.4, interesse: 0.9, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['livro', 'ideia'], dur: 1500 })
  pedir('', false).then((ok) => { if (brinc === b && ok) legendaSempre(`${cfg.nome}: ${b.quadros[0].frase} — Continua! O que acontece depois?`, 12000); else if (brinc === b) acabarBrinc('sem IA') })
}

// ---------------------------------------------------------------- truques que você ensina
const TRUQUES = [
  [/dan[çc]/, { gesto: 'dancinha', nome: 'dançar' }], [/pul/, { gesto: 'pulinhos', nome: 'pular' }], [/ri(r|sada)?\b|gargalh|rindo/, { gesto: 'rir', expr: 'rindo', nome: 'rir' }],
  [/pisca/, { gesto: 'piscadela', nome: 'piscar' }], [/desmai|morto|finge de morto/, { gesto: 'desmaiar', nome: 'desmaiar' }], [/tont/, { gesto: 'tonto', expr: 'tonto', nome: 'ficar tonto' }],
  [/espregui/, { gesto: 'espreguicar', nome: 'se espreguiçar' }], [/suspir/, { gesto: 'suspiro', nome: 'suspirar' }], [/(diz|faz|fala) (que )?sim|acena/, { gesto: 'sim', nome: 'dizer sim' }],
  [/(diz|faz|fala) (que )?n[ãa]o|balan[çc]a a cabe/, { gesto: 'nao', nome: 'dizer não' }], [/cora[çc][ãa]o|apaixon|amor/, { emote: 'apaixonado', nome: 'se apaixonar' }],
  [/estrel/, { emote: 'estrela', nome: 'virar estrela' }], [/assust|susto|medo/, { emote: 'assustado', nome: 'se assustar' }], [/chor/, { emote: 'chorando', nome: 'chorar' }],
  [/brav|zang|irrit/, { emote: 'bravo', nome: 'ficar bravo' }], [/[óo]culos|estilos|legal|descolad/, { emote: 'legal', nome: 'ficar estiloso' }], [/fantasm/, { emote: 'fantasma', nome: 'virar fantasma' }],
  [/cant|m[úu]sica|melodia/, { acao: 'cantar', nome: 'cantar' }], [/olh(a|ar) em volta|procur/, { gesto: 'olhar_em_volta', nome: 'olhar em volta' }],
  [/surpres|espant/, { gesto: 'surpresa', expr: 'surpreso', nome: 'se surpreender' }], [/t[íi]mid|vergonh/, { gesto: 'timido', expr: 'timido', nome: 'ficar com vergonha' }],
  [/encolh/, { gesto: 'encolher', nome: 'se encolher' }], [/presente/, { emote: 'presente', nome: 'dar um presente' }], [/sono|dorm|boceja/, { gesto: 'bocejo', expr: 'sono', nome: 'bocejar' }],
]
function fazerTruque(tr, palavra) {
  if (tr.emote) mostrarEmote(tr.emote, 1800)
  else if (tr.acao === 'cantar') cantarMusica()
  else evento({ label: `truque: ${tr.nome}${palavra ? ` ("${palavra}")` : ''}`, P: 0.2, A: 0.3, interesse: 0.7, expr: tr.expr || 'empolgado', gesto: tr.gesto, forcarGesto: true, dur: 2000 })
}
function ensinarTruque(text) {
  const m = /quando eu (?:disser|falar|dizer|gritar)\s*[:,]?\s*["“']?(.+?)["”']?\s*[,.]?\s*(?:voc[êe]\s+)?(?:faz|fa[çc]a|fazer|fazes|d[áa]|mostra|fica|finge|vira|tem que|pode)\s+(?:um |uma |a |o )?(.+)/i.exec(text)
  if (!m) return false
  const palavra = m[1].replace(/^(a palavra|a frase)\s+/i, '').trim().slice(0, 40), oque = m[2]
  const achou = TRUQUES.find(([re]) => re.test(oque))
  ouviu(text)
  if (!achou || palavra.length < 2) {
    evento({ label: 'não sei fazer esse truque', interesse: 0.5, expr: 'timido', gesto: 'nao_sei', forcarGesto: true, dur: 2000 })
    legendaSempre(`${cfg.nome}: Ainda não sei fazer isso… Sei: dançar, pular, rir, piscar, desmaiar, ficar tonto, coração, estrela, susto, chorar, ficar bravo, óculos escuros, fantasma, cantar, bocejar.`, 9000)
    return true
  }
  P.truques = [...(P.truques || []).filter((x) => txtN(x.palavra) !== txtN(palavra)), { palavra, ...achou[1] }].slice(-20); store.set('pers', P)
  lembrar(`${cfg.dono} me ensinou um truque: quando ele disser "${palavra}", eu vou ${achou[1].nome}`, 5)
  legendaSempre(`${cfg.nome}: Combinado! Quando você disser “${palavra}”, eu vou ${achou[1].nome}. Olha:`)
  setTimeout(() => fazerTruque(achou[1], palavra), 1800)
  figurinha('truque')
  return true
}
const truqueDaFala = (text) => {
  const n = palavrasN(text), w = n.trim().split(' ').length
  return (P.truques || []).find((x) => { const p = palavrasN(x.palavra).trim(); return p && n.includes(' ' + p + ' ') && w <= p.split(' ').length + 4 })
}

// ---------------------------------------------------------------- caretas que você ensina (câmera)
const CHAVES_CARA = ['sorriso', 'boca', 'sobrancelha', 'franzido', 'piscE', 'piscD', 'biquinho', 'bochecha', 'bocaLado']
const vetorCara = (e) => CHAVES_CARA.map((k) => (k === 'bocaLado' ? (e[k] || 0) * 0.7 : e[k] || 0))
const distCara = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0))
function exprDaCareta(v) {
  const e = Object.fromEntries(CHAVES_CARA.map((k, i) => [k, v[i]]))
  if (Math.abs(e.piscE - e.piscD) > 0.4) return { expr: 'contente', gesto: 'piscadela' }
  if (e.piscE > 0.55 && e.piscD > 0.55) return { expr: 'sono' }
  if (e.biquinho > 0.4) return { expr: 'apaixonado' }
  if (e.bochecha > 0.35) return { expr: 'timido' }
  if (e.boca > 0.4 && e.sobrancelha > 0.3) return { expr: 'surpreso', gesto: 'surpresa' }
  if (e.franzido > 0.35) return { expr: 'bravo' }
  if (e.sorriso > 0.5) return { expr: e.boca > 0.3 ? 'rindo' : 'feliz' }
  if (Math.abs(e.bocaLado) > 0.25) return { expr: 'desconfiado' }
  if (e.boca > 0.35) return { expr: 'surpreso' }
  if (e.sobrancelha > 0.4) return { expr: 'medo' }
  return { expr: 'curioso', gesto: 'talvez' }
}
let aprendendoCara = null
function ensinarCareta(nome) {
  if (!exigeCamera('Aprender careta')) return
  nome = nome.trim().slice(0, 30)
  aprendendoCara = { nome, amostras: [], ate: now() + 2500 }
  evento({ label: `olhando a sua ${nome}`, P: 0.2, interesse: 0.8, expr: 'curioso', gesto: 'nenhum', icones: ['olhos', 'foto'], som: false, dur: 2500 })
  legendaSempre(`${cfg.nome}: Segura essa cara… 📸`, 3000)
}
function tickAprenderCara() {
  const a = aprendendoCara; if (!a) return
  const e = rosto.ultimaExp; if (e && now() - rosto.expT < 400) a.amostras.push(vetorCara(e))
  if (now() < a.ate) return
  aprendendoCara = null
  if (a.amostras.length < 5) { evento({ label: 'não vi sua cara direito', gesto: 'nao_sei', forcarGesto: true, icones: ['olhos', 'pergunta'], interesse: 0.4, dur: 2000 }); return legendaSempre(`${cfg.nome}: Não te vi direito… fica de frente pra câmera.`) }
  const v = CHAVES_CARA.map((_, i) => a.amostras.reduce((s, x) => s + x[i], 0) / a.amostras.length)
  if (Math.sqrt(v.reduce((s, x) => s + x * x, 0)) < 0.3) { evento({ label: 'essa é sua cara normal', P: 0.1, gesto: 'nao_sei', forcarGesto: true, expr: 'rindo', interesse: 0.5, dur: 2000 }); return legendaSempre(`${cfg.nome}: Hehe, essa parece a sua cara normal! Faz uma careta de verdade.`) }
  P.caretas = [...(P.caretas || []).filter((c) => txtN(c.nome) !== txtN(a.nome)), { nome: a.nome, v: v.map((x) => +x.toFixed(3)) }].slice(-12); store.set('pers', P)
  const r = exprDaCareta(v)
  foco = { expr: r.expr, ate: now() + 3000 }; if (r.gesto) iniciarGesto(r.gesto)
  evento({ label: `aprendi a ${a.nome}`, P: 0.3, A: 0.4, interesse: 0.8, expr: r.expr, som: 'feliz', dur: 3000 })
  legendaSempre(`${cfg.nome}: Aprendi a “${a.nome}”! Assim, ó. Quando você fizer, eu vou reconhecer.`)
  lembrar(`${cfg.dono} me ensinou a ${a.nome}`, 4); figurinha('careta_nova')
}
function fazerCareta(nome) {
  const c = (P.caretas || []).find((x) => palavrasN(nome).includes(palavrasN(x.nome).trim()))
  if (!c) return false
  const r = exprDaCareta(c.v)
  foco = { expr: r.expr, ate: now() + 3500 }; if (r.gesto) iniciarGesto(r.gesto)
  legendaSempre(`${cfg.nome}: A ${c.nome}!`); somDe(r.expr, 0.4)
  return true
}
const caraVista = { nome: '', desde: 0, ultima: {} }
function reconhecerCareta(e, t) { // a cada leitura do rosto
  if (!P.caretas?.length || brinc || aprendendoCara) return
  const v = vetorCara(e); let melhor = null, d0 = 0.32
  for (const c of P.caretas) { const d = distCara(v, c.v); if (d < d0) { d0 = d; melhor = c } }
  if (!melhor) { caraVista.nome = ''; return }
  if (caraVista.nome !== melhor.nome) { caraVista.nome = melhor.nome; caraVista.desde = t; return }
  if (t - caraVista.desde > 900 && t - (caraVista.ultima[melhor.nome] || 0) > 120000) {
    caraVista.ultima[melhor.nome] = t
    const r = exprDaCareta(melhor.v)
    evento({ label: `você fez a ${melhor.nome}!`, P: 0.3, A: 0.4, interesse: 0.8, expr: r.expr === 'curioso' ? 'rindo' : r.expr, gesto: r.gesto || 'rir', forcarGesto: true, dur: 2000 })
    legendaSempre(`${cfg.nome}: Olha a ${melhor.nome}! Hahaha`)
  }
}

// ---------------------------------------------------------------- palavra do dia
let pedidoPalavra = 0
function pedirPalavra() {
  pedidoPalavra = now() + 40000; abrirConversa()
  evento({ label: 'me ensina uma palavra nova?', P: 0.1, A: 0.3, interesse: 0.7, expr: 'curioso', gesto: 'nao_sei', forcarGesto: true, icones: ['livro', 'pergunta'], dur: 3000 })
  legendaSempre(`${cfg.nome}: Me ensina uma palavra nova hoje? Vou tentar usar ela o dia todo!`, 9000)
  P.palavra = { ...(P.palavra || {}), pediu: hojeSv() }; store.set('pers', P)
}
function guardarPalavra(palavra) {
  palavra = palavra.replace(/^(a palavra (do dia )?(é|e)|é|e|que tal|hmm+|ah+)\s+/i, '').replace(/[.!?,;:"“”]+/g, '').trim().slice(0, 30)
  if (!palavra || palavra.split(/\s+/).length > 3) return false
  P.palavra = { dia: hojeSv(), palavra, pediu: hojeSv() }; store.set('pers', P)
  lembrar(`Palavra do dia que ${cfg.dono} me ensinou: ${palavra}`, 3)
  evento({ label: `palavra nova: ${palavra}`, P: 0.3, A: 0.3, interesse: 0.8, expr: 'empolgado', gesto: 'sim', forcarGesto: true, icones: ['livro', 'certo'], dur: 2000 })
  legendaSempre(`${cfg.nome}: “${palavra}”! Anotado. Vou usar hoje.`)
  figurinha('palavra')
  return true
}

// ---------------------------------------------------------------- torcedor
const torcida = { dia: '', jogo: null, ultimo: null, proxima: 0, aviso: '', erroAte: 0 }
async function conferirJogo(motivo = 'auto') {
  if (!P.time || !servidor.temGemini() || now() < torcida.erroAte) return
  try {
    const j = await servidor.futebol(P.time, 'placar')
    pushLog(`Torcida→ ${P.time} ${j.gols_time ?? '?'} x ${j.gols_adversario ?? '?'} ${j.adversario || ''} (${j.status || '?'}${j.minuto ? ', ' + j.minuto + "'" : ''})`)
    const a = torcida.ultimo; torcida.ultimo = j
    const gt = +j.gols_time || 0, ga = +j.gols_adversario || 0, placar = `${gt}x${ga}`
    if (motivo === 'pedido' || !a) {
      if (j.status === 'sem_jogo') legendaSempre(`${cfg.nome}: O ${P.time} não joga hoje.`)
      else if (j.status === 'nao_comecou') legendaSempre(`${cfg.nome}: Ainda não começou${torcida.jogo?.horario ? ', é às ' + torcida.jogo.horario : ''}! Tô ansioso.`)
      else { mostrarBalao(['futebol'], placar, 5000); legendaSempre(`${cfg.nome}: ${P.time} ${gt} x ${ga} ${j.adversario || ''}${j.status === 'encerrado' ? ' (acabou)' : j.minuto ? ` (${j.minuto}')` : ''}`) }
      if (motivo === 'pedido') return
    }
    if (!a) return
    const agt = +a.gols_time || 0, aga = +a.gols_adversario || 0
    if (gt > agt) { festaAte = now() + 90000; evento({ label: `GOL do ${P.time}! ${placar}`, P: 0.7, A: 0.9, interesse: 1, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['futebol', 'festa'], numero: placar, som: 'feliz', dur: 4000, emote: 'estrela' }); legendaSempre(`${cfg.nome}: GOOOOL DO ${P.time.toUpperCase()}! ${placar}`); figurinha('torcida') }
    else if (ga > aga) evento({ label: `gol do ${j.adversario || 'adversário'}… ${placar}`, P: -0.4, A: 0.5, interesse: 0.9, expr: 'bravo', gesto: 'nao', forcarGesto: true, icones: ['futebol', 'nao_ok'], numero: placar, dur: 3000 })
    if (j.status === 'encerrado' && a.status !== 'encerrado') {
      if (gt > ga) { evento({ label: `${P.time} ganhou! ${placar}`, P: 0.7, A: 0.7, interesse: 1, expr: 'orgulhoso', gesto: 'dancinha', forcarGesto: true, icones: ['futebol', 'trofeu'], numero: placar, dur: 4000 }); festaAte = now() + 20 * 60000 }
      else if (gt < ga) evento({ label: `${P.time} perdeu… ${placar}`, P: -0.5, A: -0.2, interesse: 0.9, expr: 'chorando', gesto: 'suspiro', forcarGesto: true, icones: ['futebol', 'coracao_partido'], numero: placar, dur: 4000 })
      else evento({ label: `empate do ${P.time}, ${placar}`, P: -0.1, interesse: 0.7, expr: 'entediado', gesto: 'suspiro', forcarGesto: true, icones: ['futebol'], numero: placar, dur: 3000 })
      lembrar(`Jogo do ${P.time}: ${gt} x ${ga} ${j.adversario || ''}`, 5)
    }
  } catch (e) { pushLog('Torcida: ' + e.message); torcida.erroAte = now() + 15 * 60000 }
}
async function tickTorcida() {
  if (!P.time || !servidor.temGemini() || dormindo || sonoIA) return
  const h = horaDoDia()
  if (torcida.dia !== hojeSv() && h >= 8 && now() > torcida.erroAte) {
    torcida.dia = hojeSv(); torcida.jogo = null; torcida.ultimo = null; torcida.aviso = ''
    try {
      const j = await servidor.futebol(P.time, 'agenda')
      if (j.tem_jogo && /^\d{1,2}:\d{2}$/.test(j.horario || '')) { torcida.jogo = j; pushLog(`Torcida→ hoje tem ${P.time} x ${j.adversario} às ${j.horario}`) }
      else pushLog(`Torcida→ o ${P.time} não joga hoje`)
    } catch (e) { pushLog('Torcida: ' + e.message); torcida.erroAte = now() + 30 * 60000; torcida.dia = '' }
    return
  }
  const jg = torcida.jogo; if (!jg) return
  const [hh, mm] = jg.horario.split(':').map(Number), ini = hh + mm / 60
  if (h > ini - 0.5 && h < ini && torcida.aviso !== 'antes' && temGente()) {
    torcida.aviso = 'antes'
    evento({ label: `daqui a pouco tem ${P.time} x ${jg.adversario}`, P: 0.2, A: 0.6, interesse: 0.8, expr: 'desconfiado', gesto: 'olhar_em_volta', icones: ['futebol', 'relogio'], numero: jg.horario, dur: 3500 })
    legendaSempre(`${cfg.nome}: Hoje tem ${P.time} x ${jg.adversario} às ${jg.horario}! Tô ansioso…`)
  }
  if (h >= ini && h < ini + 2.3 && now() > torcida.proxima && torcida.ultimo?.status !== 'encerrado') { torcida.proxima = now() + 10 * 60000; conferirJogo() }
}

// ---------------------------------------------------------------- cuidados: pausas, água, plantas e hora de dormir
const cuidado = { pausa: 0, agua: now() + 30 * 60000, plantas: 0, sono: 0, ciumeDesde: 0, ciumeAte: 0, olhouCelular: 0 }
function bebeuAgua() {
  if (P.agua?.dia !== hojeSv()) P.agua = { dia: hojeSv(), copos: 0 }
  P.agua.copos++; store.set('pers', P); cuidado.agua = now() + 75 * 60000
  enviarC3(`COPO ${P.agua.copos} 8 5000`)
  evento({ label: `você bebeu água (${P.agua.copos}º copo)`, P: 0.3, A: 0.2, interesse: 0.6, expr: 'contente', gesto: 'sim', forcarGesto: true, dur: 2000 })
  legendaSempre(`${cfg.nome}: Isso! ${P.agua.copos} de 8 hoje.${P.agua.copos >= 8 ? ' Meta batida! 💧' : ''}`)
  if (P.agua.copos >= 8) figurinha('agua')
}
function tickCuidados() {
  const t = now(), h = horaDoDia()
  if (dormindo || brinc || alarme || papo.estado === 'conversando' || imag.ativo || palco) return
  // pausa: 2 h direto na frente dele
  if (pessoa.presente && t - Math.max(pessoa.desde, cuidado.pausa) > 2 * 3600000) {
    cuidado.pausa = t
    evento({ label: 'faz 2 horas que você está aí', P: 0.1, A: 0.3, interesse: 0.7, expr: 'curioso', gesto: 'espreguicar', forcarGesto: true, icones: ['pessoa', 'relogio'], numero: '2h', dur: 3500 })
    legendaSempre(`${cfg.nome}: Faz 2 horas que você tá aí! Bora levantar e esticar um pouquinho? 🙆`, 8000)
    return
  }
  // água: de hora em hora e pouco, se tem gente perto
  if (temGente() && t > cuidado.agua && h >= 8 && h < 22) {
    cuidado.agua = t + 75 * 60000
    const n = P.agua?.dia === hojeSv() ? P.agua.copos : 0
    if (n < 8) { enviarC3(`COPO ${n} 8 8000`); evento({ label: 'lembrete de água', P: 0, interesse: 0.5, expr: 'curioso', icones: ['agua'], som: 'curioso', dur: 3000 }); legendaSempre(`${cfg.nome}: Bora um copo d'água? (${n} de 8 hoje) — me fala “bebi água”.`, 8000) }
    return
  }
  // plantas
  if (P.plantas && temGente() && h >= 8 && h < 21 && Date.now() - P.plantas.ultima > P.plantas.cada * 86400000 && t > cuidado.plantas) {
    cuidado.plantas = t + 3 * 3600000
    const dias = Math.round((Date.now() - P.plantas.ultima) / 86400000)
    evento({ label: 'hora de regar as plantas', P: 0, A: 0.2, interesse: 0.6, expr: 'curioso', gesto: 'nao_sei', icones: ['planta', 'agua', 'pergunta'], numero: `${dias}d`, dur: 3500 })
    legendaSempre(`${cfg.nome}: Já regou as plantas? Faz ${dias} dia(s). Me fala “reguei”.`, 8000)
    return
  }
  // hora de dormir: ele fica com sono antes de você
  if (temGente() && h >= 22 && h < 23 && t > cuidado.sono) {
    const primeira = !cuidado.sono; cuidado.sono = t + 15 * 60000
    iniciarGesto('bocejo'); somDe('sono', 0.25); olhoSonolentoAte = t + 1800
    if (primeira) setTimeout(() => legendaSempre(`${cfg.nome}: Tá ficando tarde… *bocejo* bora dormir daqui a pouco?`, 7000), 1800)
    return
  }
  // ciúme do celular: você olhando para baixo (no celular) por muito tempo
  const e = rosto.ultimaExp, fresco = e && t - rosto.expT < 1500 && pessoa.presente
  if (fresco && e.olharBaixo > 0.45) { if (!cuidado.ciumeDesde) cuidado.ciumeDesde = t }
  else if (fresco && cuidado.ciumeDesde && t - cuidado.olhouCelular > 8000) cuidado.ciumeDesde = 0
  if (fresco && e.olharBaixo > 0.45) cuidado.olhouCelular = t
  if (cuidado.ciumeDesde && t - cuidado.ciumeDesde > 4 * 60000 && t > cuidado.ciumeAte && P.afeto > 0.45 && P.extroversao > 0.35) {
    cuidado.ciumeAte = t + 40 * 60000; cuidado.ciumeDesde = 0
    evento({ label: 'você tá no celular faz tempo… e eu aqui', P: -0.15, A: 0.2, interesse: 0.7, expr: 'desconfiado', gesto: 'timido', forcarGesto: true, icones: ['celular', 'robo', 'pergunta'], som: 'entediado', dur: 3500 })
    legendaSempre(`${cfg.nome}: Ei… e eu? 🥺`, 5000); cuidado.ciumeVolta = t + 60000
  }
  if (cuidado.ciumeVolta && fresco && e.olharBaixo < 0.2 && e.sorriso > 0.4) { cuidado.ciumeVolta = 0; evento({ label: 'voltou a olhar pra mim!', P: 0.4, A: 0.3, interesse: 0.8, expr: 'apaixonado', gesto: 'pulinhos', forcarGesto: true, dur: 2000 }) }
  else if (cuidado.ciumeVolta && t > cuidado.ciumeVolta) cuidado.ciumeVolta = 0
}

// ---------------------------------------------------------------- hobby que muda, mania e medo do escuro
const HOBBIES = ['estrelas e planetas', 'dinossauros', 'culinária', 'o fundo do mar', 'vulcões', 'insetos', 'robôs antigos', 'pintura', 'trens', 'música clássica', 'plantas', 'pássaros', 'origami', 'castelos e cavaleiros', 'mágica', 'piratas', 'esportes', 'astronautas']
const MANIAS = { contar: 'contar coisas', assobiar: 'assobiar sempre a mesma musiquinha', piscar: 'piscar duas vezes quando pensa', arrumar: 'arrumar o que está vestindo', espirrar: 'espirrar do nada' }
function iniciarVidaV26() {
  let mudou = false
  if (!P.hobby) { P.hobby = { tema: sorteia(HOBBIES), desde: Date.now(), dura: 7 + Math.floor(Math.random() * 8) }; mudou = true }
  if (!P.mania) { P.mania = sorteia(Object.keys(MANIAS)); P.maniaMelodia = melodiaInventada(); mudou = true }
  if (P.medoEscuro === undefined) { P.medoEscuro = 0.8; mudou = true }
  if (mudou) store.set('pers', P)
}
function tickHobby() {
  const h = P.hobby; if (!h || dormindo) return
  if ((Date.now() - h.desde) / 86400000 > h.dura && temGente() && papo.estado === 'parado' && !brinc) {
    const antigo = h.tema, novo = sorteia(HOBBIES.filter((x) => x !== antigo))
    P.hobby = { tema: novo, desde: Date.now(), dura: 7 + Math.floor(Math.random() * 8), antigos: [...(h.antigos || []), antigo].slice(-5) }; store.set('pers', P)
    lembrar(`Enjoei de ${antigo}; agora meu hobby é ${novo}`, 5)
    evento({ label: `enjoei de ${antigo}… agora tô curioso com ${novo}!`, P: 0.2, A: 0.4, interesse: 0.7, expr: 'curioso', gesto: 'olhar_em_volta', forcarGesto: true, icones: ['ideia', 'coracao'], dur: 3000 })
    legendaSempre(`${cfg.nome}: Sabe… enjoei de ${antigo}. Agora eu quero saber tudo sobre ${novo}!`, 7000)
  }
}
function fazerMania() {
  const m = P.mania
  if (m === 'contar') { const n = 3 + Math.floor(Math.random() * 4); iniciarGesto('olhar_em_volta'); for (let i = 1; i <= n; i++) setTimeout(() => { mostrarBalao([], String(i), 700); somDe('neutro', 0.12) }, i * 650) }
  else if (m === 'assobiar') { foco = { expr: 'contente', ate: now() + 3000 }; tocarMelodia(P.maniaMelodia || melodiaInventada(), 1, { assobio: true }) }
  else if (m === 'piscar') { enviarC3('PISCAR'); setTimeout(() => enviarC3('PISCAR'), 260); foco = { expr: 'pensando', ate: now() + 1500 } }
  else if (m === 'arrumar') { const v = Object.keys(vestido); if (v.length) { const a = sorteia(v); vestir(a, false); setTimeout(() => vestir(a, true), 700) } else iniciarGesto('encolher'); setTimeout(() => mostrarBalao(['ok'], '', 1200), 900) }
  else if (m === 'espirrar') { iniciarGesto('surpresa'); setTimeout(() => { batida(1); somDe('surpreso', 0.4); iniciarGesto('sim'); icone = { tipo: '!', ate: now() + 900 } }, 600) }
  pushLog(`Mania→ ${MANIAS[m] || m}`)
}
const RE_CARINHO_NOITE = /boa noite|t[ôo] aqui|estou aqui|calma|n[ãa]o precisa ter medo|dorme bem|durma bem|bons sonhos|te amo|fica tranquilo|n[ãa]o tem nada|eu t[ôo] (do teu|do seu) lado|pode dormir/i
const medo = { esperandoAte: 0 }
function comMedoDoEscuro() { // apagaram a luz à noite e ele ainda tem medo do escuro
  medo.esperandoAte = now() + 40000; abrirConversa()
  evento({ label: 'tá escuro… tenho medo', P: -0.3, A: 0.5, interesse: 0.8, expr: 'medo', gesto: 'encolher', forcarGesto: true, icones: ['lua', 'pessoa', 'pergunta'], som: 'medo', dur: 3500 })
  legendaSempre(`${cfg.nome}: Tá escuro… você tá aí? 🥺`, 8000)
}
function consolarDoEscuro() {
  medo.esperandoAte = 0
  const antes = P.medoEscuro
  P.medoEscuro = clamp(P.medoEscuro - 0.12, 0, 1); store.set('pers', P)
  evento({ label: 'você me acalmou no escuro', P: 0.4, A: -0.3, interesse: 0.8, expr: 'contente', gesto: 'suspiro', forcarGesto: true, icones: ['coracao', 'lua'], dur: 2500 })
  legendaSempre(`${cfg.nome}: Ufa… com você aqui eu fico tranquilo.`)
  if (antes >= 0.25 && P.medoEscuro < 0.25) { lembrar(`Perdi o medo do escuro graças a ${cfg.dono}`, 8); figurinha('coragem'); setTimeout(() => legendaSempre(`${cfg.nome}: Acho que… não tenho mais medo do escuro! 🌙`), 3500) }
  setTimeout(() => { if (luz.escuro && !gravando) dormir('apagaram a luz (calminho)') }, 4000)
}
function tickMedo() {
  if (medo.esperandoAte && now() > medo.esperandoAte) {
    medo.esperandoAte = 0; P.medoEscuro = clamp(P.medoEscuro + 0.02, 0, 1); store.set('pers', P)
    if (luz.escuro && !dormindo) { evento({ label: 'dormi encolhidinho de medo', P: -0.2, interesse: 0.4, expr: 'medo', gesto: 'encolher', forcarGesto: true, dur: 2000 }); setTimeout(() => dormir('apagaram a luz (com medo)'), 2200) }
  }
}

// ---------------------------------------------------------------- o que ele aprendeu e gosta (vai para a IA)
function estadoV26() {
  const out = []
  if (P.hobby) out.push(`Seu hobby do momento: ${P.hobby.tema} (há ${Math.max(1, Math.round((Date.now() - P.hobby.desde) / 86400000))} dia(s)). De vez em quando comente algo sobre ele.`)
  if (P.palavra?.dia === hojeSv()) out.push(`Palavra do dia que ${cfg.dono} te ensinou: "${P.palavra.palavra}". Tente usar no "pensamento" quando fizer sentido (não toda hora).`)
  if (P.mania) out.push(`Sua mania: ${MANIAS[P.mania]}.`)
  if (P.medoEscuro !== undefined) out.push(P.medoEscuro >= 0.25 ? `Você tem medo do escuro (${Math.round(P.medoEscuro * 100)}%), mas está melhorando com o carinho de ${cfg.dono}.` : 'Você perdeu o medo do escuro.')
  if (P.time) out.push(`${cfg.dono} torce para o ${P.time}; você torce junto.${torcida.ultimo && torcida.ultimo.status !== 'sem_jogo' ? ` Jogo de hoje: ${P.time} ${torcida.ultimo.gols_time ?? '?'} x ${torcida.ultimo.gols_adversario ?? '?'} ${torcida.ultimo.adversario || ''} (${torcida.ultimo.status}).` : ''}`)
  if (P.truques?.length) out.push(`Truques que ${cfg.dono} te ensinou: ${P.truques.map((x) => `"${x.palavra}" → ${x.nome}`).join('; ')}.`)
  const ms = Object.keys(P.musicas || {}); if (ms.length) out.push(`Músicas que você aprendeu com ${cfg.dono}: ${ms.join(', ')}. Também sabe: ${CANCOES.map((c) => c.nome).join(', ')}.`)
  if (P.musicasOuvidas?.length) out.push(`Músicas que você ouviu e reconheceu: ${P.musicasOuvidas.slice(0, 4).map((m) => m.titulo).join(', ')}.`)
  if (P.agua?.dia === hojeSv()) out.push(`${cfg.dono} bebeu ${P.agua.copos} copo(s) de água hoje.`)
  return out.join('\n')
}

// ---------------------------------------------------------------- a fala que cai nestes recursos (antes da IA)
function interceptarV26(text) {
  const t = text.trim(), n = txtN(t)
  if (medo.esperandoAte && RE_CARINHO_NOITE.test(t)) { ouviu(t); consolarDoEscuro(); return true }
  if (pedidoPalavra > now() && !brinc) {
    pedidoPalavra = 0
    if (RE_NAO.test(t) && t.split(/\s+/).length <= 4) { ouviu(t); evento({ label: 'hoje sem palavra nova', interesse: 0.3, expr: 'contente', gesto: 'sim', dur: 1500 }); return true }
    if (guardarPalavra(t)) { ouviu(t); return true }
  }
  let m
  if ((m = /(?:a )?palavra do dia (?:[ée]|vai ser)\s+(.+)|aprende a palavra\s+(.+)/i.exec(t))) { ouviu(t); if (!guardarPalavra(m[1] || m[2])) legendaSempre(`${cfg.nome}: Fala só a palavra!`); return true }
  if (ensinarTruque(t)) return true
  if (/esquece (o|os) truques?|esquece todos os truques/i.test(t)) { ouviu(t); P.truques = []; store.set('pers', P); legendaSempre(`${cfg.nome}: Esqueci os truques.`); return true }
  const tr = !brinc && truqueDaFala(t)
  if (tr) { ouviu(t); fazerTruque(tr, tr.palavra); return true }
  if ((m = /(?:meu time [ée] (?:o |a )?|eu torço (?:pro |pra |para o |para a |pelo |pela |pro time do )|sou torcedor[a]? d[oa] )([\wÀ-ú .-]{2,30})/i.exec(t))) {
    ouviu(t); P.time = m[1].replace(/[.!?]+$/, '').trim(); store.set('pers', P); torcida.dia = ''
    evento({ label: `agora torço pro ${P.time}!`, P: 0.4, A: 0.5, interesse: 0.8, expr: 'empolgado', gesto: 'pulinhos', forcarGesto: true, icones: ['futebol', 'coracao'], dur: 2500 })
    legendaSempre(`${cfg.nome}: Agora eu também torço pro ${P.time}! Vou ficar de olho nos jogos.`); return true
  }
  if (/(^|\s)(bebi|tomei)\s.*[áa]gua/i.test(t)) { ouviu(t); bebeuAgua(); return true }
  if (/(regar|aguar) as plantas/i.test(t) && /(cada|todo|toda|lembr)/i.test(t)) {
    ouviu(t); const d = numeroFalado(t) || 3
    P.plantas = { cada: clamp(d, 1, 30), ultima: Date.now() }; store.set('pers', P)
    evento({ label: `vou lembrar das plantas a cada ${P.plantas.cada} dia(s)`, P: 0.2, interesse: 0.6, expr: 'contente', gesto: 'sim', forcarGesto: true, icones: ['planta', 'calendario'], numero: `${P.plantas.cada}d`, dur: 2500 }); return true
  }
  if (/\b(reguei|aguei)\b/i.test(t) && P.plantas) { ouviu(t); P.plantas.ultima = Date.now(); store.set('pers', P); evento({ label: 'você regou as plantas', P: 0.3, interesse: 0.5, expr: 'feliz', gesto: 'sim', forcarGesto: true, icones: ['planta', 'coracao'], dur: 2000 }); return true }
  if ((m = /(?:aprende|aprenda|grava|guarda) (?:essa|esta|a minha) cara(?:[:,]| de| que [ée]| chamada| se chama)?\s*(.*)|essa (?:[ée] a|cara se chama) (cara de .+)/i.exec(t))) {
    ouviu(t); const nome = (m[1] || m[2] || '').trim(); ensinarCareta(/^cara/i.test(nome) ? nome : 'cara de ' + (nome || 'careta')); return true
  }
  if ((m = /faz (?:a |uma )?(cara de .+)/i.exec(t)) && fazerCareta(m[1])) { ouviu(t); return true }
  // ensinar uma música: cantarolou e disse "essa é a música X" (ou corrigiu logo depois de ele cantar)
  if ((m = /(?:essa|esta) (?:[ée]|era|se chama) (?:a música |a canção |a )?(.{2,40})|(?:essa|esta) música se chama (.{2,40})/i.exec(t)) && ultimaMelodia && now() - ultimaMelodia.t < 60000) {
    ouviu(t); aprenderMusica((m[1] || m[2]).replace(/[.!?]+$/, '').trim(), ultimaMelodia.notas); return true
  }
  void n
  return false
}

iniciarVidaV26()

// ---------------------------------------------------------------- a fala passa por aqui antes da IA
function interceptarFala(text) {
  if (alarme) {
    ouviu(text)
    if (/soneca|mais (5|cinco) minut|deixa eu dormir|s[óo] mais um pouco/i.test(text)) sonecaAlarme()
    else concluirAlarme('ok')
    return true
  }
  if (modoFoco?.fase === 'espera') {
    if (RE_SIM.test(text) || /bora|vamos|mais um/i.test(text)) { ouviu(text); comecarFoco(); return true }
    if (RE_NAO.test(text)) { ouviu(text); pararFoco(); return true }
  }
  if (brinc?.ouvir && brinc.ouvir(text)) return true
  if (interceptarV26(text)) return true
  const lem = interpretarLembrete(text)
  if (lem && !lem.pendente) { ouviu(text); criarLembrete(lem); return true }
  return false
}
function tickDiversao() {
  tickLembretes(); tickFoco(); tickBicho(); tickFesta()
  for (const f of [tickMusicaOuvida, tickTorcida, tickCuidados, tickHobby, tickMedo]) { try { f() } catch (e) { erroUmaVez('diversão ' + f.name, e) } }
  const h = horaDoDia()
  if (P.palavra?.pediu !== hojeSv() && temGente() && !dormindo && papo.estado === 'parado' && !brinc && !imag.ativo && !palco && h >= 9 && h < 21 && Math.random() < 0.004) pedirPalavra()
  if (brinc || alarme) papo.ate = Math.max(papo.ate, now() + 20000)
  if (now() > (tickDiversao.album || 0)) { tickDiversao.album = now() + 30000; conferirAlbum() }
}

// ================================================================ telas
// Com um painel aberto, o rosto encolhe e sobe para continuar visível.
new MutationObserver(() => document.body.classList.toggle('painel', !$('#debug').hidden || !$('#cfg').hidden))
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
document.querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = () => { $('#debug').hidden = true; $('#cfg').hidden = true }))
function abrirCfg() {
  $('#cNome').value = cfg.nome; $('#cDono').value = cfg.dono; $('#cKey').value = cfg.key; $('#cStt').value = cfg.stt; $('#cLegenda').checked = !!cfg.legenda; $('#cMaos').checked = !!cfg.maosLivres; $('#cLogToken').value = cfg.logToken || ''; $('#cGemini').value = cfg.geminiKey || ''; $('#cCidade').value = cfg.cidade || ''
  const sel = $('#cModel'); sel.innerHTML = ''; sel.add(new Option(cfg.model, cfg.model))
  $('#cfg').hidden = false; $('#debug').hidden = true
  if (cfg.key) carregarModelos()
}
async function carregarModelos() {
  try {
    const { ids, stts } = await servidor.listarModelos()
    const sel = $('#cModel'); sel.innerHTML = ''
    for (const id of ids) sel.add(new Option(id, id, false, id === cfg.model))
    if (!ids.includes(cfg.model)) {
      sel.value = ids[0]
      cfg.model = ids[0]; store.set('cfg', cfg)
      $('#cMsg').textContent = `Troquei o modelo para ${ids[0]} (o anterior não existe ou responde mal em português).`
    }
    if (stts.length && !stts.includes(cfg.stt)) $('#cStt').value = stts.find((i) => /turbo/.test(i)) || stts[0]
  } catch (e) { $('#cMsg').textContent = 'Não consegui listar os modelos: ' + e.message }
}
$('#btnCfg').onclick = () => ($('#cfg').hidden ? abrirCfg() : ($('#cfg').hidden = true))
$('#cClose').onclick = () => ($('#cfg').hidden = true)
$('#cKey').oninput = () => { if (guardarChave($('#cKey').value, 'colada')) $('#cMsg').textContent = 'Chave salva.' } // salva já ao colar
$('#cLink').onclick = async () => {
  const k = $('#cKey').value.trim() || cfg.key
  if (!k) { $('#cMsg').textContent = 'Cole a chave primeiro.'; return }
  const link = location.origin + location.pathname + '#chave=' + k + (cfg.logToken ? '&log=' + cfg.logToken : '') + (cfg.geminiKey ? '&gem=' + cfg.geminiKey : '')
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
$('#cCidade').onchange = () => { cfg.cidade = $('#cCidade').value.trim(); store.set('cfg', cfg); tempo.ate = 0; if (cfg.cidade) pegarLocal().then((l) => ($('#cMsg').textContent = l ? 'Cidade salva para a previsão.' : 'Não achei essa cidade.')) }
$('#cGemini').oninput = () => {
  const v = $('#cGemini').value.trim()
  if (chaveGeminiValida(v)) { cfg.geminiKey = v; store.set('cfg', cfg); store.set('geminiKey', v); $('#cMsg').textContent = 'Chave do Gemini salva. Conferindo os modelos…'; servidor.conferirGemini().then(() => ($('#cMsg').textContent = servidor.modelos().gemini.length ? `Gemini pronto: ${servidor.modelos().gemini.map(servidor.curto).slice(0, 3).join(', ')}` : (servidor.erroGemini() ? 'A chave foi salva, mas o Google recusou: ' + servidor.erroGemini() : 'Não encontrei modelos do Gemini com essa chave.'))) }
  else if (v) $('#cMsg').textContent = 'Essa não parece uma chave do Gemini (começa com AQ. ou AIza).'
}
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
const BOTOES_DIVERSAO = { tCharada: brincCharada, tVinte: brincVinte, tQuiz: brincQuiz, tCareta: brincCareta, tImitaEu: brincImitaEu, tRitmo: brincRitmo, tEsconde: brincEsconde, tPPT: brincPPT, tDesenhar: () => fazerDesenho(), tDancar: dancar, tDiario: mostrarDiario, tNoticias: noticiasEmEmojis, tFoco: () => comecarFoco(1), tLembrete: () => criarLembrete({ quando: Date.now() + 60000, tipo: 'lembrete', texto: 'beber água' }), tTempo: () => falarDoTempo('hoje'), tBicho: chamarBicho, tPresente: darPresente, tAlbum: mostrarAlbum, tFesta: () => fazerFesta(), tVelha: brincVelha, tAdivinhaSom: brincAdivinhaSom, tGenius: brincGenius, tHistoria2: brincHistoria2, tKaraoke: brincKaraoke, tQualMusica: () => qualMusica('pedido'), tMania: fazerMania, tAgua: bebeuAgua, tJogoTime: () => conferirJogo('pedido'), tPararBrinc: () => { acabarBrinc('botão'); pararFoco() } }
for (const [id, f] of Object.entries(BOTOES_DIVERSAO)) $('#' + id).onclick = () => { if (dormindo) acordar(); f() }
$('#tTerTemp').value = terrario.temp; $('#tTerUmid').value = terrario.umid
$('#tTerTemp').oninput = (e) => { terrario.temp = +e.target.value; $('#tvT').textContent = terrario.temp; store.set('terrario', terrario) }
$('#tTerUmid').oninput = (e) => { terrario.umid = +e.target.value; $('#hvT').textContent = terrario.umid; store.set('terrario', terrario) }
// Teste: finge que todos os modelos acabaram por 3 min (ou desfaz, se já estiver dormindo de cansaço).
$('#tCansar').onclick = () => {
  if (sonoIA) { servidor.liberarTeste(); pushLog('Teste: IA liberada'); proxFolego = 0; return }
  servidor.esgotarParaTeste(180000)
  pushLog('Teste: todos os modelos esgotados por 3 min'); proxFolego = 0
}
const selEm = $('#tEmote'); Object.keys(EMOTES).forEach((k) => selEm.add(new Option(k, k)))
$('#tMostrarEmote').onclick = () => { palco = null; if (dormindo) acordar(); mostrarEmote(selEm.value) }
$('#tDecorar').onclick = () => decorar(true)
$('#tData').value = dataSim
$('#tData').onchange = () => { dataSim = $('#tData').value; store.set('dataSim', dataSim); pushLog('Datas→ simulando ' + (dataSim || 'hoje')) }
$('#tUartEnviar').onclick = () => { const l = $('#tUart').value.trim(); if (!l) return; if (l.startsWith('TOQUE')) receberDoC3(l); else enviarC3(l) }
$('#tUart').onkeydown = (e) => { if (e.key === 'Enter') $('#tUartEnviar').click() }
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
  try { tickComportamento() } catch (e) { erroUmaVez('comportamento', e) }
  try { tickVida() } catch (e) { erroUmaVez('vida', e) }
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
Mãos livres  : ${now() < vad.modoTVAte ? `modo TV (mais ${Math.ceil((vad.modoTVAte - now()) / 60000)} min) · ` : ''}${P.vozNome ? `voz do dono aprendida (${P.vozNome.n}) · ` : ''}${!cfg.maosLivres ? 'desligado' : !cfg.key ? 'precisa da chave' : vad.verificando ? 'conferindo se era com ele…' : vad.ativo ? 'ouvindo uma frase' : 'esperando o nome'} · ${vad.hora.length}/40 na hora${jogo ? `
Jogo         : ${jogo.fase} · ${jogo.seq.length} notas` : ''}` + `
Diversão     : ${brinc ? 'brincando de ' + brinc.tipo : '—'}${modoFoco ? ` · foco ${modoFoco.fase}${isFinite(modoFoco.fim) ? ' (' + Math.max(0, Math.ceil((modoFoco.fim - now()) / 60000)) + ' min)' : ''}` : ''}${alarme ? ' · ALARME tocando' : ''} · lembretes ${(P.lembretes || []).map((l) => hhmm(l.quando)).join(', ') || '—'} · álbum ${Object.keys(P.album || {}).length}/${FIGURINHAS.length} · desenhos ${(P.desenhos || []).length}
Vida nova    : hobby ${P.hobby?.tema || '—'} · mania ${MANIAS[P.mania] || '—'} · medo do escuro ${Math.round((P.medoEscuro ?? 0) * 100)}% · palavra ${P.palavra?.dia === hojeSv() ? P.palavra.palavra : '—'} · time ${P.time || '—'} · água ${P.agua?.dia === hojeSv() ? P.agua.copos : 0}/8 · truques ${(P.truques || []).length} · caretas ${(P.caretas || []).length} · músicas ${Object.keys(P.musicas || {}).length} · Genius ${P.recordeGenius || 0}
Terrário     : ${terrario.temp} °C · ${terrario.umid} %${bicho.ativo ? ' · bichinho passeando' : ''} · ${diasDeVida()} dia(s) de vida${P.local ? ' · previsão: ' + (textoPrevisao() || 'carregando') : ''}
Desempenho   : C3 tela ${c3.perf.quadro.toFixed(1)} ms/quadro (${Math.round(c3.perf.fps)} fps) · S3 cérebro ${perf.cerebro.toFixed(2)} ms a cada 50 ms · ouvido ${perf.ouvido.toFixed(2)} ms a cada 23 ms · tom ${perf.tom.toFixed(2)} ms
UART S3→C3   : ${uart.taxaMsgs.toFixed(1)} msg/s · ${Math.round(uart.taxaBytes)} B/s (${(uart.taxaBytes / 921.6).toFixed(2)} % de 921600 baud) · total ${uart.msgs} msgs, ${(uart.bytes / 1024).toFixed(1)} KB · C3→S3 ${uart.volta} B
Mais enviadas: ${Object.entries(uart.cont).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + v).join(' · ')}
Últimas UART :
${uart.ultimas.map((l) => '  ' + l).join('\n')}
Fôlego da IA : ${Math.round(folegoIA() * 100)}% (${sonoIA ? 'dormindo para recarregar' + (voltaDaIA() ? ', volta em ~' + voltaDaIA() : '') : nivelIA})
IA hoje      : ${servidor.cotaTexto() || '—'}
Memória nuvem: ${memoriaNuvem.texto()}
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
    servidor.conferirModelos()
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
// Memória na nuvem durante o uso: sobe o que mudou; se outro aparelho mudou, recarrega com a memória nova.
async function sincronizarNuvem() {
  const r = await memoriaNuvem.sincronizar({ aoVivo: true })
  if (r === 'baixou' || r === 'mesclou') recarregarComMemoriaNova(now())
}
function recarregarComMemoriaNova(desde) {
  const seguro = !brinc && !gravando && !alarme && papo.estado !== 'conversando' && !vad.ativo && !vad.verificando && !captura
  if (document.visibilityState === 'hidden' || seguro || now() - desde > 120000) {
    pushLog('Memória na nuvem→ recarregando com a memória do outro aparelho')
    enviarLog('memória nova').finally(() => location.reload())
  } else setTimeout(() => recarregarComMemoriaNova(desde), 15000)
}
setInterval(sincronizarNuvem, 3 * 60000)
document.addEventListener('visibilitychange', () => sincronizarNuvem())
$('#tSincronizar').onclick = () => { pushLog('Memória na nuvem: sincronizando agora'); sincronizarNuvem() }
function atualizar() {
  enviarLog('atualizando').finally(() => location.replace(location.pathname + '?v=' + (versaoNova || Date.now()) + location.hash))
}
setInterval(conferirVersao, 3 * 60000); setTimeout(conferirVersao, 8000)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && versaoNova) atualizar(); else if (document.visibilityState === 'visible') conferirVersao() })
$('#btnAtualizar').onclick = () => atualizar()
c3.ligar()
setInterval(cicloCerebro, 50)
