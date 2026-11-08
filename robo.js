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
const logLines = []
function pushLog(s) {
  const t = new Date().toLocaleTimeString('pt-BR')
  logLines.unshift(`${t}  ${s}`)
  if (logLines.length > 60) logLines.pop()
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
const cfg = Object.assign({ nome: 'Robô', dono: 'Will', key: '', model: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3-turbo', legenda: false, maosLivres: true }, store.get('cfg', {}))

// ================================================================ CÉREBRO
// Personalidade: muda devagar (semanas). Humor do dia: sorteado ao acordar.
// Emoção: reação rápida a cada evento, que decai até o humor.
const PERS_PADRAO = { extroversao: 0.6, curiosidade: 0.7, energia: 0.6, sensibilidade: 0.5, afeto: 0.5, gostos: { calma: 0, animada: 0, pesada: 0, cantarolar: 0, assobio: 0 }, nasceu: Date.now(), dias: 0 }
let P = Object.assign(structuredClone(PERS_PADRAO), { confianca: 0.5, melodia: null, opiniao: '', ultimaReflexao: 0 }, store.get('pers', {}))
P.gostos = Object.assign({}, PERS_PADRAO.gostos, P.gostos)
let memorias = store.get('memorias', []).map((m) => ({ imp: 3, ...m }))

// Necessidades (inspirado nos "drives" do Kismet, do MIT): cada uma tem uma faixa boa.
// Fora da faixa, ele fica incomodado e procura um jeito de voltar (chamar atenção, inventar
// brincadeira, cochilar). Dentro da faixa, fica contente.
const N = Object.assign({ social: 0.6, estimulo: 0.5, energia: 0.8 }, store.get('necess', {}))
const FAIXA = { social: [0.35, 0.9], estimulo: [0.3, 0.85], energia: [0.25, 1] }
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
  N.estimulo = clamp(N.estimulo + 0.06 * (e.interesse || 0) * Math.min(1, ganho), 0, 1)
  if (e.social) N.social = clamp(N.social + e.social, 0, 1)
  if (e.confianca) P.confianca = clamp(P.confianca + e.confianca, 0.05, 0.95)
  imp.P = clamp(imp.P + (e.P || 0) * ganho, -1.6, 1.6)
  imp.A = clamp(imp.A + (e.A || 0) * ganho, -1.6, 1.6)
  imp.D = clamp(imp.D + (e.D || 0) * ganho, -1.6, 1.6)
  humor.A = clamp(humor.A + 0.04 * (e.interesse || 0), -1, 1) // coisas acontecendo acordam
  ultimoEvento = now()
  if (dormindo && (e.interesse || 0) < 0.6) { // abre um olho sonolento e volta a dormir
    olhoSonolentoAte = now() + 1500
    return
  }
  if (dormindo && ehNoite()) { imp.P -= 0.3; imp.D += 0.2 } // acordar de madrugada deixa rabugento
  acordar()
  if (e.expr && ganho > 0.45) foco = { expr: e.expr, ate: now() + (e.dur || 2500) }
  if (e.icone) icone = { tipo: e.icone, ate: now() + (e.dur || 2500) + 500 }
  if (e.icones?.length || e.numero) balao = { itens: (e.icones || []).filter((k) => ICONES[k]).slice(0, 3), numero: String(e.numero || '').slice(0, 6), t0: now(), ate: now() + Math.max(4500, e.dur || 0) }
  const fezGesto = e.gesto && e.gesto !== 'nenhum' && GESTOS[e.gesto] && (ganho > 0.45 || e.forcarGesto)
  if (fezGesto) iniciarGesto(e.gesto)
  if (fezGesto && SOM_GESTO[e.gesto]) somGesto(e.gesto)
  else if (e.som !== false && ganho > 0.45) somDe(e.som || e.expr || nomePAD(emoAtual()), clamp((e.intens ?? 0.6) * ganho, 0.15, 1))
  if (e.lembrar) lembrar(e.label, typeof e.lembrar === 'number' ? e.lembrar : 5)
  bus.emit('emocao', { label: `${e.label} (ganho ${ganho.toFixed(2)})` }, 'Cérebro')
}
function emoAtual() { return { P: clamp(humor.P + imp.P, -1, 1), A: clamp(humor.A + imp.A, -1, 1), D: clamp(humor.D + imp.D, -1, 1) } }

let dormindo = false, olhoSonolentoAte = 0
function acordar() { if (dormindo) { dormindo = false; foco = { expr: 'surpreso', ate: now() + 1200 }; pushLog('Cérebro→ acordou') } }
function dormir(motivo) { if (!dormindo) { dormindo = true; foco = null; iniciarGesto('suspiro'); somDe('sono', 0.5); pushLog('Cérebro→ dormiu · ' + motivo) } }
function horaDoDia() { const d = new Date(); return d.getHours() + d.getMinutes() / 60 }
function ehNoite() { const h = horaDoDia(); return h >= 23 || h < 7 }
// Quanto cada necessidade está fora da faixa boa (0 = tudo certo).
function desconforto() {
  let d = 0
  for (const k of Object.keys(FAIXA)) { const [lo, hi] = FAIXA[k]; if (N[k] < lo) d += (lo - N[k]) / lo; else if (N[k] > hi) d += (N[k] - hi) / (1 - hi) }
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

  // Necessidades andam com o tempo. Extrovertido sente falta de gente mais rápido;
  // curioso enjoa mais rápido da mesmice.
  N.social = clamp(N.social - dt / (pessoa.presente ? 9000 : 2400) * (0.5 + P.extroversao), 0, 1)
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
  chamar_atencao: { // carente e você por perto
    cd: 60000,
    nota: () => (pessoa.presente && N.social < FAIXA.social[0] ? 0.9 + P.extroversao * 0.4 : 0),
    fazer: () => evento({ label: 'quero atenção!', P: 0.1, A: 0.4, interesse: 0.5, expr: 'curioso', gesto: 'pulinhos', icones: ['olhos', 'robo'], som: 'curioso', dur: 3500 }),
  },
  saudade: { // carente e sozinho
    cd: 180000,
    nota: () => (!pessoa.presente && N.social < 0.25 ? 0.7 : 0),
    fazer: () => evento({ label: 'cadê todo mundo?', P: -0.25, A: -0.1, interesse: 0.4, expr: 'triste', gesto: 'olhar_em_volta', icones: ['pessoa', 'pergunta'], som: 'triste', dur: 3500 }),
  },
  pedir_musica: { // entediado com você por perto
    cd: 300000,
    nota: () => (pessoa.presente && N.estimulo < FAIXA.estimulo[0] && !audio.musica ? 0.6 + (P.gostos.animada + 1) * 0.2 : 0),
    fazer: () => evento({ label: 'pediu música', P: 0.15, A: 0.3, interesse: 0.5, expr: 'curioso', gesto: 'talvez', icones: ['musica', 'seta_cima'], som: 'curioso', dur: 3500 }),
  },
  pensar_na_vida: {
    cd: 400000,
    nota: () => 0.1 + P.curiosidade * 0.15,
    fazer: () => { foco = { expr: 'pensando', ate: now() + 3000 }; icone = { tipo: 'reticencias', ate: now() + 3000 } },
  },
  quero_espaco: { // atenção demais (Kismet: "sobrecarregado")
    cd: 120000,
    nota: () => (N.social > FAIXA.social[1] + 0.03 ? 0.8 + (1 - P.extroversao) * 0.4 : 0),
    fazer: () => { evento({ label: 'muita atenção, quero um tempinho', P: -0.05, A: -0.1, interesse: 0.3, expr: 'timido', gesto: 'timido', som: false, dur: 3500 }); N.social -= 0.05 },
  },
  sobrecarregado: { // novidade demais de uma vez
    cd: 120000,
    nota: () => (N.estimulo > FAIXA.estimulo[1] + 0.05 ? 0.85 : 0),
    fazer: () => { evento({ label: 'coisa demais acontecendo', P: -0.15, A: 0.2, interesse: 0.3, expr: 'tonto', gesto: 'tonto', som: 'neutro', dur: 2500 }); N.estimulo -= 0.08 },
  },
  cochilar: { cd: 600000, nota: () => (N.energia < 0.3 && !pessoa.presente ? 0.8 : 0), fazer: () => dormir('cansado') },
  nada: { cd: 0, nota: () => 0.55, fazer: () => {} },
}
function escolherComportamento() {
  const t = now()
  const ops = Object.entries(COMPORTAMENTOS).filter(([k, c]) => t - (ultimaVez[k] || -1e9) > c.cd).map(([k, c]) => [k, Math.max(0, c.nota())])
  // Softmax com temperatura: quase sempre o melhor, às vezes uma surpresa.
  const pesos = ops.map(([, v]) => Math.exp(v / 0.15)), soma = pesos.reduce((a, b) => a + b, 0)
  let r = Math.random() * soma
  for (let i = 0; i < ops.length; i++) { r -= pesos[i]; if (r <= 0) return ops[i][0] }
  return 'nada'
}

function tickComportamento() {
  if (dormindo) return
  const t = now()
  if (t > proxComport && !foco && !gesto && !gravando && !audio.musica && !jogo && !vad.ativo && !vad.verificando) {
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
  // Clima (SHT40 simulado), a cada 2 min.
  if (t - ultimoClima > 120000) {
    ultimoClima = t
    if (clima.temp >= 30) evento({ label: `calor (${clima.temp} °C)`, P: -0.15, A: -0.35, interesse: 0.3, expr: 'calor', icone: 'gota', som: false, dur: 4000 })
    else if (clima.temp <= 18) evento({ label: `frio (${clima.temp} °C)`, P: -0.2, A: 0.1, interesse: 0.3, expr: 'frio', som: false, dur: 4000 })
    if (clima.umid <= 30) evento({ label: `ar seco (${clima.umid} %)`, P: -0.1, interesse: 0.3, som: 'tosse', dur: 1500 })
  }
}

setInterval(() => { store.set('pers', P); store.set('necess', N); store.set('humor', { dia: humor.dia, P: humor.P, A: humor.A, D: humor.D }) }, 10000)

// ================================================================ C3: ROSTO
const cv = $('#face'), g = cv.getContext('2d')
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
  pergunta: '❓', raio: '⚡', bateria: '🔋', wifi: '📶', seta_cima: '⬆️', seta_baixo: '⬇️', mais: '➕', menos: '➖', fantasma: '👻',
}
let balao = null // {itens, numero, ate}
const olhar = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, mx: 0, my: 0, proxSacada: 0, proxMicro: 0 }
let piscar = 0, proxPiscar = now() + 3000, balanco = 0, inclinacao = 0

function alvoExpr() {
  if (dormindo) return now() < olhoSonolentoAte ? 'olho_sonolento' : 'sono'
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
  const alvoIncl = nome === 'curioso' ? 0.12 : nome === 'musica' ? Math.sin(t / 400) * 0.04 : 0
  inclinacao = lerp(inclinacao, alvoIncl, vo)

  g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240)
  g.save()
  let ox = olhar.x * 20 + (ge.ox || 0), oy = olhar.y * 14 + cur.dy - balanco * 9 + (ge.oy || 0)
  if (nome === 'frio') ox += rnd(-1.5, 1.5)
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
  g.restore()

  if (dormindo) desenharIcone('zzz', t)
  else if (icone) desenharIcone(icone.tipo, t)
  else if (nome === 'musica') desenharIcone('nota', t)
  if (balao && t > balao.ate) balao = null
  if (balao) desenharBalao(t)
  if (camera.ligada) { g.fillStyle = '#ff4d4d'; g.beginPath(); g.arc(14, 14, 4, 0, Math.PI * 2); g.fill() } // câmera ligada
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
    tipo = sc > 1.6 ? 'animada' : sc < -1.6 ? 'desanimada' : 'neutra'
  }
  const a = b ? Math.max(0.15, 1 / (b.n + 1)) : 1
  P.voz = b ? { med: lerp(b.med, r.med, a), dp: lerp(b.dp, r.dp, a), rms: lerp(b.rms, r.rms, a), taxa: lerp(b.taxa, r.taxa, a), n: b.n + 1 } : { ...r, n: 1 }
  vozDono = { tipo, s: sc, t: now() }
  pushLog(`S3→ voz ${tipo}${b && b.n >= 3 ? ` (${sc.toFixed(1)})` : ` (aprendendo sua voz ${P.voz.n}/3)`}`)
  if (tipo === 'desanimada') imp.P -= 0.12 // contágio: fica um pouco junto com você
  if (tipo === 'animada') imp.A += 0.2
  return vozDono
}

// ---------------------------------------------------------------- mãos livres
// O S3 guarda sempre o último meio segundo de som. Quando percebe voz, grava a frase inteira
// (com o começo), transcreve e só responde se ouviu o nome dele. Depois de uma resposta, por
// 15 s, dá para continuar a conversa sem repetir o nome.
const vad = { ativo: false, ini: 0, ultimaFala: 0, chunks: [], pre: [], piso: 0.005, vozes: 0, verificando: false, hora: [], seguirAte: 0 }
function ligarEscuta(src) {
  const proc = actx.createScriptProcessor(4096, 1, 1), mudo = actx.createGain()
  mudo.gain.value = 0
  src.connect(proc); proc.connect(mudo).connect(actx.destination)
  const PRE = Math.ceil(0.6 * actx.sampleRate / 4096)
  proc.onaudioprocess = (e) => {
    const x = new Float32Array(e.inputBuffer.getChannelData(0)), t = now()
    let q = 0; for (let i = 0; i < x.length; i++) q += x[i] * x[i]
    const rms = Math.sqrt(q / x.length)
    const pode = cfg.maosLivres && cfg.key && !gravando && !vad.verificando && !jogo && t > falandoAte && t > conversaAte && !audio.musica
    if (!vad.ativo) {
      vad.piso = rms < vad.piso ? vad.piso * 0.9 + rms * 0.1 : vad.piso * 0.995 + rms * 0.005
      vad.pre.push(x); if (vad.pre.length > PRE) vad.pre.shift()
      if (pode && rms > Math.max(0.012, vad.piso * 4)) {
        Object.assign(vad, { ativo: true, ini: t, ultimaFala: t, chunks: vad.pre, pre: [], vozes: 0 })
        prosoReset()
        if (t < vad.seguirAte) foco = { expr: 'ouvindo', ate: t + 4000 }
      }
      return
    }
    vad.chunks.push(x)
    if (rms > Math.max(0.01, vad.piso * 3)) vad.ultimaFala = t
    if (!pode) { vad.ativo = false; vad.chunks = []; return } // ele mesmo fez barulho, ou começou outra coisa
    if (t - vad.ultimaFala > 800 || t - vad.ini > 8000) fimDaFrase(t)
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
  const alvo = nome.join(' '), tol = alvo.length >= 5 ? 1 : 0
  for (let i = 0; i + nome.length <= pal.length; i++) {
    const trecho = norm.slice(i, i + nome.length).join(' ')
    if (trecho === alvo || (tol && distancia(trecho, alvo) <= tol)) {
      const resto = [...pal.slice(0, i), ...pal.slice(i + nome.length)].join(' ').replace(/^[\s,.!?;:-]+|[\s,;:-]+$/g, '').trim()
      return { resto: semAcento(resto) ? resto : '' }
    }
  }
  return null
}
const ALUCINACAO = /obrigad[oa] por assistir|legendas? (pela|por|da)|amara\.org|inscreva-se|se inscreva|tchau,? tchau/i
async function fimDaFrase(t) {
  vad.ativo = false
  const chunks = vad.chunks, dur = vad.ultimaFala - vad.ini, resumo = prosoResumo(), seguindo = vad.ini < vad.seguirAte
  vad.chunks = []
  if (dur < 400 || vad.vozes < 3) return // barulho, não voz
  vad.hora = vad.hora.filter((x) => t - x < 3600000)
  if (vad.hora.length >= 40) { pushLog('Mãos livres: limite de 40 frases por hora (plano gratuito)'); return }
  vad.hora.push(t)
  vad.verificando = true
  try {
    const texto = await transcrever(paraWav(chunks, actx.sampleRate))
    if (!texto || ALUCINACAO.test(texto)) return
    const chamado = chamouPeloNome(texto)
    if (!chamado && !seguindo) { pushLog(`(ouviu, não era com ele) ${texto.slice(0, 60)}`); return }
    const vh = humorDaVoz(resumo)
    if (chamado && !chamado.resto) { // só chamou: ele olha e espera
      vad.seguirAte = now() + 10000
      evento({ label: 'me chamou', P: 0.2, A: 0.4, interesse: 0.85, expr: 'curioso', gesto: 'surpresa', forcarGesto: true, icones: ['olhos', 'pergunta'], social: 0.04, dur: 3000 })
      return
    }
    await responder(chamado ? chamado.resto : texto, vh)
  } catch (e) { pushLog('Mãos livres: ' + e.message) } finally { vad.verificando = false }
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
  const tom = rms > 0.012 ? detectarTom(tbuf, sr) : null
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
bus.on('susto', () => evento({ label: 'susto com barulho', P: -0.4, A: 0.9, D: -0.4, interesse: 0.95, expr: 'medo', icone: 'exclamacao', som: 'medo', gesto: 'encolher', tipo: 'susto', confianca: -0.01, dur: 1800 }))
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
bus.on('assobio', () => { evento({ label: 'alguém assobiou', P: 0.35, A: 0.45, interesse: 0.8, tipo: 'assobio', social: 0.03, expr: 'curioso', icone: 'nota', som: 'curioso', gesto: 'olhar_em_volta', dur: 2500 }); P.gostos.assobio = clamp(P.gostos.assobio + 0.02, -1, 1) })
bus.on('cantarolar', () => { evento({ label: 'alguém cantarolando', P: 0.4, A: 0.3, interesse: 0.75, tipo: 'cantarolar', social: 0.03, expr: 'contente', icone: 'nota', som: 'contente', dur: 3000 }); P.gostos.cantarolar = clamp(P.gostos.cantarolar + 0.02, -1, 1) })
bus.on('melodia', ({ notas, tipo }) => {
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
bus.on('voz', () => evento({ label: 'ouvi alguém falar', tipo: 'voz', P: 0.05, A: 0.25, interesse: 0.5 * P.curiosidade + 0.2, expr: 'curioso', som: false, dur: 1500 }))

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
  const t = now(); toques.push(t); while (toques.length && t - toques[0] > 4000) toques.shift()
  if (toques.length > 6) { evento({ label: 'muito cutucão!', P: -0.4, A: 0.5, D: 0.4, interesse: 0.8, expr: 'bravo', icone: 'exclamacao', som: 'bravo', gesto: 'nao', confianca: -0.03, dur: 2000 }); return }
  evento({ label: 'carinho na cabeça', P: 0.5, A: 0.15, interesse: 0.85, expr: Math.random() < 0.35 ? 'timido' : 'amor', icone: 'coracao', som: 'amor', gesto: Math.random() < 0.3 ? 'piscadela' : null, tipo: 'toque', social: 0.06, confianca: 0.005, dur: 2000 })
  P.afeto = clamp(P.afeto + 0.004, 0.05, 0.95)
})
$('#temp').oninput = (e) => { clima.temp = +e.target.value; $('#tv').textContent = clima.temp; ultimoClima = 0 }
$('#umid').oninput = (e) => { clima.umid = +e.target.value; $('#hv').textContent = clima.umid; ultimoClima = 0 }

// ================================================================ GROQ: conversa
let gravando = false, rec = null, micStream = null
let conversa = [] // últimas falas desta sessão, para ele seguir o assunto
let conversaAte = 0 // enquanto pensa e responde, o ouvido não reage a mais nada
let streamFala = null
async function groq(path, opts) {
  const r = await fetch('https://api.groq.com/openai/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + cfg.key, ...(opts?.headers || {}) } })
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 160)}`)
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
  fd.append('prompt', `Conversa em português do Brasil com ${cfg.nome}, um robozinho de mesa.`)
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
  pushLog('Erro: ' + err.message)
  legenda('Erro: ' + err.message)
  conversaAte = now() + 1500
  foco = { expr: 'triste', ate: now() + 2500 }; icone = { tipo: 'interrogacao', ate: now() + 2500 }
  somDe('triste', 0.4)
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
async function responder(text, vh) {
  pushLog(`Você: ${text}`)
  legenda(`Você: ${text}`)
  foco = { expr: 'pensando', ate: now() + 15000 }; icone = { tipo: 'reticencias', ate: now() + 15000 }
  conversaAte = now() + 20000
  try {
    const traços = `extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, energia ${P.energia.toFixed(2)}, sensibilidade ${P.sensibilidade.toFixed(2)}, afeto por ${cfg.dono} ${P.afeto.toFixed(2)}`
    const gostos = Object.entries(P.gostos).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')
    const recentes = lembrancas(10).map((m) => `- ${m.tipo === 'reflexao' ? '(reflexão) ' : ''}${m.txt}`).join('\n') || '- nada marcante ainda'
    const agora = new Date()
    const quando = agora.toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    const sys = `Você é ${cfg.nome}, um robozinho de mesa com personalidade própria, que mora na mesa de ${cfg.dono}.
Você NÃO fala nem escreve palavras. Você responde com: um GESTO do rosto, uma EMOÇÃO, até 3 ÍCONES num balão e, se precisar, um NÚMERO curto. Os sons fofos (estilo WALL-E e R2-D2) saem sozinhos.

Como responder:
- Pergunta de sim/não: use o gesto "sim" ou "nao" (ou "talvez", "nao_sei"). Isso é o mais importante.
- Para dizer algo, combine ícones em ordem, como uma frase de figurinhas. Ex.: "vai chover?" → gesto "nao_sei", ícones ["nuvem","chuva"]. "Tá com fome?" → "nao" + ["robo","bateria"]. "O que você quer fazer?" → gesto "dancinha" + ["musica","jogo"]. Use só nomes que estão nas listas abaixo.
- Hora, data, temperatura e umidade: NUNCA escreva o valor você mesmo. Use exatamente "numero": "{hora}", "{data}", "{temp}" ou "{umid}", que o robô preenche com o valor certo. Para outras contagens, use "numero" com até 6 caracteres (ex.: "3", "10+").
- Piadas: "rir". Elogio: "timido" ou "orgulhoso". Notícia triste: "chorando" ou "suspiro". Coisa estranha: "desconfiado". Coisa confusa: "tonto". Algo incrível: "pulinhos" ou "empolgado".
- Seja coerente com o humor de hoje: de mau humor reage menos; entediado, só algo interessante anima. Não seja sempre feliz. Varie os gestos.
- Se ${cfg.dono} parecer desanimado(a), seja carinhoso; se estiver animado(a), entre na onda.
- Se ${cfg.dono} quiser jogar o jogo da melodia (ou um jogo de música, de assobiar, de repetir notas), use "acao": "jogo_melodia".

Agora: ${quando}. Temperatura ${clima.temp} °C, umidade ${clima.umid} %. ${audio.musica ? `Está tocando música ${audio.estilo} (${audio.bpm} BPM).` : ''}
${percepcao(vh)}
Sua personalidade (0 a 1): ${traços}, confiança em ${cfg.dono} ${P.confianca.toFixed(2)}. Você tem ${P.dias} dia(s) de vida.
${P.opiniao ? `O que você acha de ${cfg.dono}: ${P.opiniao}` : ''}
Suas necessidades agora (0 a 1): companhia ${N.social.toFixed(2)}, novidade ${N.estimulo.toFixed(2)}, energia ${N.energia.toFixed(2)}. ${N.social < 0.35 ? 'Você está carente.' : ''} ${N.estimulo < 0.3 ? 'Você está entediado.' : ''} ${N.energia < 0.3 ? 'Você está cansado.' : ''}
Seu jeito: ${P.extroversao > 0.6 ? 'expansivo, gestos grandes' : P.extroversao < 0.4 ? 'reservado, gestos pequenos, às vezes tímido' : 'equilibrado'}; ${P.curiosidade > 0.6 ? 'curioso com tudo' : 'na sua'}${P.confianca < 0.35 ? `; ainda desconfiado de ${cfg.dono}` : ''}.
Gostos aprendidos (-1 a 1): ${gostos}.
Humor de hoje: ${nomePAD(humor)}. Emoção agora: ${emo.nome}.
Coisas que você lembra:
${recentes}

GESTOS: ${Object.keys(GESTOS).join(', ')}, nenhum
EMOÇÕES: ${EMOCOES.join(', ')}
ÍCONES: ${Object.keys(ICONES).join(', ')}

Responda SÓ com JSON: {"gesto": "...", "emocao": "...", "intensidade": 0 a 1, "icones": [até 3 da lista, ou vazio], "numero": "" ou curto, "pensamento": "o que você quis dizer, numa frase curta em português", "afeto": número de -0.05 a 0.05, "lembrar": "frase curta se valer guardar na memória, senão vazio", "importancia": 1 a 10 (1 = banal, 10 = marcante), "acao": "" ou "jogo_melodia"}`
    const ex = (u, a) => [{ role: 'user', content: `${cfg.dono} disse: "${u}"` }, { role: 'assistant', content: JSON.stringify(a) }]
    const exemplos = [
      ...ex('Você gosta de música?', { gesto: 'sim', emocao: 'empolgado', intensidade: 0.8, icones: ['musica', 'coracao'], numero: '', pensamento: 'Amo! Ainda mais quando é animada.', afeto: 0.01, lembrar: '', importancia: 1 }),
      ...ex('Que horas são?', { gesto: 'nenhum', emocao: 'contente', intensidade: 0.4, icones: ['relogio'], numero: '{hora}', pensamento: 'Mostrei a hora.', afeto: 0, lembrar: '', importancia: 1 }),
      ...ex('Vai chover hoje?', { gesto: 'nao_sei', emocao: 'curioso', intensidade: 0.5, icones: ['nuvem', 'chuva', 'pergunta'], numero: '', pensamento: 'Não sei, não consigo ver o céu daqui.', afeto: 0, lembrar: '', importancia: 1 }),
      ...ex('Hoje eu tive um dia horrível no trabalho', { gesto: 'suspiro', emocao: 'triste', intensidade: 0.7, icones: ['trabalho', 'coracao_partido', 'abraco'], numero: '', pensamento: 'Poxa... queria te dar um abraço.', afeto: 0.03, lembrar: 'Will teve um dia ruim no trabalho', importancia: 6 }),
      ...ex('Você é muito fofo', { gesto: 'timido', emocao: 'timido', intensidade: 0.8, icones: ['coracao'], numero: '', pensamento: 'Ai, para... (adorei).', afeto: 0.03, lembrar: '', importancia: 3 }),
      ...ex('Quanto é 2 mais 3?', { gesto: 'sim', emocao: 'orgulhoso', intensidade: 0.6, icones: [], numero: '5', pensamento: 'Essa eu sei: 5!', afeto: 0, lembrar: '', importancia: 1 }),
      ...ex('Quer jogar videogame comigo?', { gesto: 'pulinhos', emocao: 'empolgado', intensidade: 0.9, icones: ['jogo', 'ok'], numero: '', pensamento: 'Bora!!', afeto: 0.02, lembrar: '', importancia: 2 }),
      ...ex('Bora jogar o jogo da melodia?', { gesto: 'pulinhos', emocao: 'empolgado', intensidade: 0.9, icones: ['musica', 'jogo'], numero: '', pensamento: 'Eba! Presta atenção nas notas.', afeto: 0.02, lembrar: '', importancia: 2, acao: 'jogo_melodia' }),
      ...ex('Você quer dormir?', { gesto: 'nao', emocao: 'feliz', intensidade: 0.5, icones: ['dormir', 'errado'], numero: '', pensamento: 'Ainda não, tô ligadão.', afeto: 0, lembrar: '', importancia: 1 }),
    ].map((m) => ({ ...m, content: m.content.replaceAll('Will', cfg.dono) }))
    conversa.push({ role: 'user', content: `${cfg.dono} disse: "${text}"` })
    const r = await groq('/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, temperature: 0.7, max_tokens: 300, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, ...exemplos, ...conversa.slice(-10)] }),
    }).catch(async (e) => { // modelo sem modo JSON: tenta de novo sem ele
      if (!/json|response_format/i.test(e.message)) throw e
      return groq('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.model, temperature: 0.7, max_tokens: 300, messages: [{ role: 'system', content: sys }, ...exemplos, ...conversa.slice(-10)] }) })
    })
    const bruto = r.choices[0].message.content
    pushLog('Groq: ' + bruto.slice(0, 300))
    const j = JSON.parse((bruto.match(/\{[\s\S]*\}/) || [bruto])[0])
    conversa.push({ role: 'assistant', content: bruto }); conversa = conversa.slice(-10)
    const nome = EMOCOES.includes(j.emocao) ? j.emocao : 'curioso'
    const gest = GESTOS[j.gesto] ? j.gesto : 'nenhum'
    const icns = Array.isArray(j.icones) ? j.icones.filter((x) => ICONES[x]).slice(0, 3) : []
    const v = PAD[nome], k = clamp(+j.intensidade || 0.5, 0, 1)
    // Valores que o modelo não pode inventar: o próprio robô preenche (relógio e sensor).
    const hoje = new Date()
    const valores = {
      hora: hoje.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      data: hoje.toLocaleDateString('pt-BR', { day: 'numeric', month: 'numeric' }),
      temp: `${clima.temp}°`, umid: `${clima.umid}%`,
    }
    if (j.numero) j.numero = String(j.numero).replace(/\{(hora|data|temp|umid)\}/g, (_, x) => valores[x])
    // Garantia: pergunta de hora ou data sempre mostra o relógio do celular, mesmo se o modelo errar.
    if (/que horas|hor[áa]rio|horas s[ãa]o/i.test(text)) j.numero = valores.hora
    else if (/que dia [ée] hoje|qual (a )?data|dia de hoje/i.test(text)) j.numero = valores.data
    legenda(`${cfg.nome}: ${j.pensamento || '…'}`)
    pushLog(`${cfg.nome}: ${j.pensamento || '…'} [${gest} · ${nome} ${k.toFixed(1)}${icns.length ? ' · ' + icns.map((x) => ICONES[x]).join('') : ''}${j.numero ? ' · ' + j.numero : ''}]`)
    P.afeto = clamp(P.afeto + clamp(+j.afeto || 0, -0.05, 0.05), 0.05, 0.95)
    if (j.lembrar) lembrar(j.lembrar, clamp(Math.round(+j.importancia || 4), 1, 10))
    evoluir('extroversao', 0.003)
    foco = null; icone = null
    conversaAte = now() + 3000
    evento({ label: `respondeu a "${text.slice(0, 40)}"`, P: v[0] * k, A: v[1] * k, D: v[2] * k, interesse: 0.9, social: 0.12, expr: nome, gesto: gest, forcarGesto: true, icones: icns, numero: j.numero, som: nome, intens: k, dur: 4500 })
    vad.seguirAte = now() + 15000 // dá para continuar a conversa sem chamar de novo
    if (j.acao === 'jogo_melodia') setTimeout(iniciarJogo, 2600)
  } catch (err) { erroConversa(err) }
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
      body: JSON.stringify({ model: cfg.model, temperature: 0.7, max_tokens: 400, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }] }),
    })
    const j = JSON.parse(r.choices[0].message.content)
    for (const txt of (j.reflexoes || []).slice(0, 3)) { lembrar(String(txt).slice(0, 200), 8, 'reflexao'); pushLog('Diário: ' + txt) }
    if (j.opiniao) P.opiniao = String(j.opiniao).slice(0, 200)
    for (const [k, v] of Object.entries(j.ajustes || {})) if (['extroversao', 'curiosidade', 'energia', 'sensibilidade'].includes(k)) evoluir(k, clamp(+v || 0, -0.03, 0.03))
    P.ultimaReflexao = Date.now(); impDesdeReflexao = 0; store.set('impReflexao', 0); store.set('pers', P)
  } catch (e) { pushLog('Reflexão: ' + e.message) } finally { refletindo = false }
}
setInterval(() => refletir(), 300000)
setTimeout(() => refletir(), 20000)

// ================================================================ telas
// Com um painel aberto, o rosto encolhe e sobe para continuar visível.
new MutationObserver(() => document.body.classList.toggle('painel', !$('#debug').hidden || !$('#cfg').hidden))
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
document.querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = () => { $('#debug').hidden = true; $('#cfg').hidden = true }))
function abrirCfg() {
  $('#cNome').value = cfg.nome; $('#cDono').value = cfg.dono; $('#cKey').value = cfg.key; $('#cStt').value = cfg.stt; $('#cLegenda').checked = !!cfg.legenda; $('#cMaos').checked = !!cfg.maosLivres
  const sel = $('#cModel'); sel.innerHTML = ''; sel.add(new Option(cfg.model, cfg.model))
  $('#cfg').hidden = false; $('#debug').hidden = true
  if (cfg.key) carregarModelos()
}
async function carregarModelos() {
  try {
    const { data } = await groq('/models')
    const ids = data.map((m) => m.id).filter((id) => !/whisper|guard|tts|orpheus|playai|distil/i.test(id)).sort()
    const sel = $('#cModel'); sel.innerHTML = ''
    for (const id of ids) sel.add(new Option(id, id, false, id === cfg.model))
    if (!ids.includes(cfg.model)) {
      const ordem = [/gpt-oss-120b/i, /llama-3\.3-70b/i, /kimi-k2/i, /llama-4-maverick/i, /qwen3-32b/i, /70b/i, /llama/i]
      sel.value = ordem.map((re) => ids.find((i) => re.test(i))).find(Boolean) || ids[0]
      $('#cMsg').textContent = `O modelo ${cfg.model} não existe mais no Groq. Escolhi ${sel.value}; toque em Salvar.`
    }
    const stts = data.map((m) => m.id).filter((id) => /whisper/i.test(id))
    if (stts.length && !stts.includes(cfg.stt)) $('#cStt').value = stts.find((i) => /turbo/.test(i)) || stts[0]
  } catch (e) { $('#cMsg').textContent = 'Não consegui listar os modelos: ' + e.message }
}
$('#btnCfg').onclick = () => ($('#cfg').hidden ? abrirCfg() : ($('#cfg').hidden = true))
$('#cClose').onclick = () => ($('#cfg').hidden = true)
$('#cKey').onchange = () => { cfg.key = $('#cKey').value.trim(); store.set('cfg', cfg); carregarModelos() }
$('#cModel').onchange = () => { cfg.model = $('#cModel').value; store.set('cfg', cfg) }
$('#cMaos').onchange = () => { cfg.maosLivres = $('#cMaos').checked; store.set('cfg', cfg) }
$('#btnJogo').onclick = () => (jogo ? fimDoJogo('parou') : iniciarJogo())
$('#cSave').onclick = () => {
  Object.assign(cfg, { nome: $('#cNome').value.trim() || 'Robô', dono: $('#cDono').value.trim() || 'Will', key: $('#cKey').value.trim(), model: $('#cModel').value, stt: $('#cStt').value.trim() || 'whisper-large-v3-turbo', legenda: $('#cLegenda').checked, maosLivres: $('#cMaos').checked })
  store.set('cfg', cfg); $('#cMsg').textContent = 'Salvo.'
}
let confirmarReset = 0
$('#cReset').onclick = () => {
  if (now() - confirmarReset > 4000) { confirmarReset = now(); $('#cReset').textContent = 'Toque de novo para confirmar'; return }
  store.del('pers'); store.del('humor'); store.del('memorias'); location.reload()
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
$('#tMelodia').onclick = () => tocarMelodia(P.melodia || melodiaInventada(), 1.1)
$('#btnDebug').onclick = () => { $('#debug').hidden = !$('#debug').hidden; $('#cfg').hidden = true }
document.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => {
  const s = b.dataset.sim
  if (s === 'susto') bus.emit('susto', { label: 'teste' })
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
  if ($('#debug').hidden) return
  const f = (x) => (x >= 0 ? ' ' : '') + x.toFixed(2)
  $('#stats').textContent =
`Humor do dia : ${nomePAD(humor)} (P${f(humor.P)} A${f(humor.A)} D${f(humor.D)})
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
Mãos livres  : ${!cfg.maosLivres ? 'desligado' : !cfg.key ? 'precisa da chave' : vad.verificando ? 'conferindo se era com ele…' : vad.ativo ? 'ouvindo uma frase' : 'esperando o nome'} · ${vad.hora.length}/40 na hora${jogo ? `
Jogo         : ${jogo.fase} · ${jogo.seq.length} notas` : ''}`
  $('#diario').textContent = [P.opiniao ? `Sobre ${cfg.dono}: ${P.opiniao}` : '', ...memorias.filter((m) => m.tipo === 'reflexao').slice(0, 6).map((m) => `${new Date(m.t).toLocaleDateString('pt-BR')} · ${m.txt}`)].filter(Boolean).join('\n') || 'Ainda não refletiu. Precisa da chave do Groq e de algumas lembranças.'
  $('#log').textContent = logLines.join('\n')
}, 1000)

// ================================================================ acordar
let wake = null
async function manterTela() { try { wake = await navigator.wakeLock?.request('screen') } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && actx) manterTela() })

$('#btnStart').onclick = async () => {
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)()
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    await ligarOuvido(micStream)
    $('#start').hidden = true
    manterTela()
    pushLog(`Cérebro→ acordou ${nomePAD(humor)} (dia ${P.dias} de vida)`)
    somDe(humor.P > 0 ? 'feliz' : 'entediado', 0.5)
    foco = { expr: 'surpreso', ate: now() + 900 }
    if (!cfg.key) pushLog('Dica: ⚙️ → chave do Groq para conversar pelo 🎤')
    else if (cfg.maosLivres) pushLog(`Dica: é só chamar "${cfg.nome}" e falar`)
  } catch (e) {
    $('#start').querySelector('p').textContent = 'Não consegui usar o microfone: ' + e.message + '. Libere o microfone para este site e tente de novo.'
  }
}
requestAnimationFrame(quadro)
