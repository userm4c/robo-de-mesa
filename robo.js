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
const cfg = Object.assign({ nome: 'Robô', dono: 'Will', key: '', model: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3-turbo' }, store.get('cfg', {}))

// ================================================================ CÉREBRO
// Personalidade: muda devagar (semanas). Humor do dia: sorteado ao acordar.
// Emoção: reação rápida a cada evento, que decai até o humor.
const PERS_PADRAO = { extroversao: 0.6, curiosidade: 0.7, energia: 0.6, sensibilidade: 0.5, afeto: 0.5, gostos: { calma: 0, animada: 0, pesada: 0, cantarolar: 0, assobio: 0 }, nasceu: Date.now(), dias: 0 }
let P = Object.assign(structuredClone(PERS_PADRAO), store.get('pers', {}))
P.gostos = Object.assign({}, PERS_PADRAO.gostos, P.gostos)
let memorias = store.get('memorias', [])

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

function lembrar(txt) {
  memorias.unshift({ t: Date.now(), txt })
  memorias = memorias.slice(0, 40)
  store.set('memorias', memorias)
}
function evoluir(traco, d) { P[traco] = clamp(P[traco] + d, 0.05, 0.95) }

// Evento: {label, P, A, D, interesse (0..1), expr, icone, som, dur, intens}
function evento(e) {
  const entediado = humor.A < -0.35 && emo.P < 0.3
  let ganho = entediado ? (e.interesse > 0.75 ? 1.4 : 0.3) : 1
  ganho *= 0.7 + P.sensibilidade * 0.6
  imp.P = clamp(imp.P + (e.P || 0) * ganho, -1.6, 1.6)
  imp.A = clamp(imp.A + (e.A || 0) * ganho, -1.6, 1.6)
  imp.D = clamp(imp.D + (e.D || 0) * ganho, -1.6, 1.6)
  humor.A = clamp(humor.A + 0.04 * (e.interesse || 0), -1, 1) // coisas acontecendo acordam
  ultimoEvento = now()
  acordar()
  if (e.expr && ganho > 0.45) foco = { expr: e.expr, ate: now() + (e.dur || 2500) }
  if (e.icone) icone = { tipo: e.icone, ate: now() + (e.dur || 2500) + 500 }
  if (e.icones?.length || e.numero) balao = { itens: (e.icones || []).filter((k) => ICONES[k]).slice(0, 3), numero: String(e.numero || '').slice(0, 6), t0: now(), ate: now() + Math.max(4500, e.dur || 0) }
  const fezGesto = e.gesto && e.gesto !== 'nenhum' && GESTOS[e.gesto] && (ganho > 0.45 || e.forcarGesto)
  if (fezGesto) iniciarGesto(e.gesto)
  if (fezGesto && SOM_GESTO[e.gesto]) somGesto(e.gesto)
  else if (e.som !== false && ganho > 0.45) somDe(e.som || e.expr || nomePAD(emoAtual()), clamp((e.intens ?? 0.6) * ganho, 0.15, 1))
  if (e.lembrar) lembrar(e.label)
  bus.emit('emocao', { label: `${e.label} (ganho ${ganho.toFixed(2)})` }, 'Cérebro')
}
function emoAtual() { return { P: clamp(humor.P + imp.P, -1, 1), A: clamp(humor.A + imp.A, -1, 1), D: clamp(humor.D + imp.D, -1, 1) } }

let dormindo = false
function acordar() { if (dormindo) { dormindo = false; foco = { expr: 'surpreso', ate: now() + 1200 } } }

function tickCerebro(dt) {
  const k = Math.exp(-dt / 8) // impulso some em ~8 s
  imp.P *= k; imp.A *= k; imp.D *= k
  const e = emoAtual()
  Object.assign(emo, e)
  emo.nome = nomePAD(e)
  // O humor anda devagar em direção ao que ele sente (≈30 min).
  humor.P += (e.P - humor.P) * dt / 1800
  humor.D += (e.D - humor.D) * dt / 1800
  // Sem nada acontecendo, vai ficando entediado e depois com sono.
  const parado = (now() - ultimoEvento) / 1000
  if (parado > 45) humor.A = clamp(humor.A - dt * 0.0025, -0.95, 1)
  if (parado > 600 && !pessoa.presente && !dormindo) { dormindo = true; somDe('sono', 0.5); pushLog('Cérebro→ dormiu') }
  if (foco && now() > foco.ate) foco = null
  if (icone && now() > icone.ate) icone = null
}

// Comportamentos espontâneos (rodam a cada 1 s).
let proxSuspiro = now() + 90000, proxCuriosidade = 0, ultimoClima = 0
function tickComportamento() {
  if (dormindo) return
  const t = now()
  if (emo.nome === 'entediado' && t > proxSuspiro) { proxSuspiro = t + rnd(60000, 150000); iniciarGesto('suspiro'); somGesto('suspiro'); foco = { expr: 'entediado', ate: t + 2000 } }
  // Você do lado, calado há um tempo: ele fica curioso e pergunta se está tudo bem.
  if (pessoa.presente && t - audio.ultimoSom > 45000 && t - pessoa.desde > 45000 && t > proxCuriosidade) {
    proxCuriosidade = t + 240000
    evento({ label: 'você está quieto do meu lado', P: 0.1, A: 0.35, interesse: 0.8, expr: 'curioso', icone: '?', som: 'curioso', gesto: 'nao_sei', dur: 3500 })
  }
  // Clima (SHT40 simulado), a cada 2 min.
  if (t - ultimoClima > 120000) {
    ultimoClima = t
    if (clima.temp >= 30) evento({ label: `calor (${clima.temp} °C)`, P: -0.15, A: -0.35, interesse: 0.3, expr: 'calor', icone: 'gota', som: false, dur: 4000 })
    else if (clima.temp <= 18) evento({ label: `frio (${clima.temp} °C)`, P: -0.2, A: 0.1, interesse: 0.3, expr: 'frio', som: false, dur: 4000 })
    if (clima.umid <= 30) evento({ label: `ar seco (${clima.umid} %)`, P: -0.1, interesse: 0.3, som: 'tosse', dur: 1500 })
  }
}

setInterval(() => { store.set('pers', P); store.set('humor', { dia: humor.dia, P: humor.P, A: humor.A, D: humor.D }) }, 10000)

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
  surpresa: { dur: 700, f: (t) => ({ oy: -Math.sin(t * Math.PI) * 12, s: 1 + Math.sin(t * Math.PI) * 0.08 }) },
}
let gesto = null
function iniciarGesto(nome) { if (GESTOS[nome]) { gesto = { nome, t0: now() }; bus.emit('gesto', { label: nome }, 'Cérebro') } }
function estadoGesto(t) {
  if (!gesto) return {}
  const g0 = GESTOS[gesto.nome], k = (t - gesto.t0) / g0.dur
  if (k >= 1) { gesto = null; return {} }
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
  raio: '⚡', bateria: '🔋', wifi: '📶', seta_cima: '⬆️', seta_baixo: '⬇️', mais: '➕', menos: '➖', fantasma: '👻',
}
let balao = null // {itens, numero, ate}
const olhar = { x: 0, y: 0, tx: 0, ty: 0, proxSacada: 0 }
let piscar = 0, proxPiscar = now() + 3000, balanco = 0, inclinacao = 0

function alvoExpr() {
  if (dormindo) return 'sono'
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
  olhar.x = lerp(olhar.x, olhar.tx, vo); olhar.y = lerp(olhar.y, olhar.ty, vo)

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
  const fE = ge.forma || formaAtual, fD = ge.formaD || ge.forma || formaAtual
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

// ================================================================ S3: OUVIDO
const audio = { rms: 0, rmsMedio: 0.01, bpm: 0, conf: 0, musica: false, estilo: 'animada', centroide: 0, pitch: 0, clareza: 0, melodiaY: 0, melodiaAte: 0, ultimoSom: now(), testeAte: 0 }
let an, tbuf, fbuf, prevMag, sr, binMax
const fluxHist = [], onsets = []
let ultimoOnset = 0, proxBeat = 0, ancora = 0, votosMusica = 0, ultimoSusto = 0, centroides = []
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
}

function analisar() {
  const t = now()
  an.getFloatTimeDomainData(tbuf)
  let s = 0; for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i]
  const rms = Math.sqrt(s / tbuf.length)
  audio.rms = rms
  if (t < falandoAte) return // ouvindo a própria voz
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
  if (tom && tom.c > 0.88 && !audio.musica) {
    ultimoTom = t
    cantoRun.push({ t, f: tom.f }); while (cantoRun.length && t - cantoRun[0].t > 3000) cantoRun.shift()
    const dur = t - cantoRun[0].t
    const st = cantoRun.map((p) => 12 * Math.log2(p.f / 440))
    const med = [...st].sort((a, b) => a - b)[Math.floor(st.length / 2)]
    audio.melodiaY = clamp(-(st[st.length - 1] - med) / 6, -1, 1)
    audio.melodiaAte = t + 300
    if (dur > 450 && !cantoEmitido) {
      const fMed = 440 * 2 ** (med / 12)
      const dpSt = Math.sqrt(st.reduce((a, b) => a + (b - med) ** 2, 0) / st.length)
      cantoEmitido = true
      if (fMed > 650) bus.emit('assobio', { label: `${Math.round(fMed)} Hz` })
      else if (dpSt < 3.5) bus.emit('cantarolar', { label: `${Math.round(fMed)} Hz` })
      else if (t - ultimaVoz > 20000) { ultimaVoz = t; bus.emit('voz', { label: 'alguém falando' }) }
    }
  } else if (t - ultimoTom > 400) { cantoRun = []; cantoEmitido = false }
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
bus.on('susto', () => evento({ label: 'susto com barulho', P: -0.4, A: 0.9, D: -0.4, interesse: 0.95, expr: 'medo', icone: 'exclamacao', som: 'medo', gesto: 'encolher', dur: 1800 }))
bus.on('musica_comecou', () => evento({ label: 'música!', P: 0.3, A: 0.4, interesse: 0.65, expr: 'surpreso', icone: 'nota', som: 'feliz', dur: 1200 }))
bus.on('estilo', () => {
  const gosto = P.gostos[audio.estilo]
  const energia = audio.estilo === 'calma' ? -0.2 : audio.estilo === 'pesada' ? 0.6 : 0.45
  if (gosto < -0.3) evento({ label: `${audio.estilo} de novo… não curto muito`, P: -0.25, A: 0.1, interesse: 0.4, expr: 'entediado', som: 'entediado', gesto: 'suspiro', dur: 3000 })
  else evento({ label: `curtindo música ${audio.estilo}`, P: 0.3 + gosto * 0.4, A: energia, interesse: 0.6 + gosto * 0.3, expr: gosto > 0.4 ? 'animado' : 'musica', icone: 'nota', som: 'musica', gesto: gosto > 0.2 ? 'dancinha' : null, dur: 4000, lembrar: gosto > 0.5 })
  // Gosto aprendido: quanto mais toca, mais ele se acostuma (com um pouco de acaso).
  P.gostos[audio.estilo] = clamp(gosto + rnd(-0.01, 0.04) * (0.5 + P.curiosidade), -1, 1)
})
bus.on('musica_parou', () => evento({ label: 'a música acabou', P: -0.1, A: -0.2, interesse: 0.3, som: false }))
bus.on('assobio', () => { evento({ label: 'alguém assobiou', P: 0.35, A: 0.45, interesse: 0.8, expr: 'curioso', icone: 'nota', som: 'curioso', gesto: 'olhar_em_volta', dur: 2500 }); P.gostos.assobio = clamp(P.gostos.assobio + 0.02, -1, 1) })
bus.on('cantarolar', () => { evento({ label: 'alguém cantarolando', P: 0.4, A: 0.3, interesse: 0.75, expr: 'contente', icone: 'nota', som: 'contente', dur: 3000 }); P.gostos.cantarolar = clamp(P.gostos.cantarolar + 0.02, -1, 1) })
bus.on('voz', () => evento({ label: 'ouvi alguém falar', P: 0.05, A: 0.25, interesse: 0.5 * P.curiosidade + 0.2, expr: 'curioso', som: false, dur: 1500 }))

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
    const { FilesetResolver, FaceDetector } = await import(V)
    const vision = await FilesetResolver.forVisionTasks(V + '/wasm')
    camera.detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', delegate: 'GPU' },
      runningMode: 'VIDEO', minDetectionConfidence: 0.6,
    })
    pushLog('S3→ detector pronto (roda no celular)')
  }
  camera.timer = setInterval(() => {
    if (!camera.ligada || video.readyState < 2) return
    const r = camera.detector.detectForVideo(video, now())
    const d = r.detections?.[0]
    if (d) {
      const b = d.boundingBox
      const x = -((b.originX + b.width / 2) / video.videoWidth * 2 - 1) // espelhado
      const y = (b.originY + b.height / 2) / video.videoHeight * 2 - 1
      bus.emit('face', { x, y, tam: b.width / video.videoWidth })
    }
    vigiarPresenca()
  }, 125)
}
function desligarCamera() {
  camera.ligada = false; clearInterval(camera.timer)
  camera.stream?.getTracks().forEach((t) => t.stop()); camera.stream = null
  if (pessoa.presente) { pessoa.presente = false; bus.emit('pessoa_saiu', { label: 'câmera desligada' }) }
}
bus.on('face', (f) => {
  const t = now()
  pessoa.x = f.x; pessoa.y = f.y; pessoa.tam = f.tam; pessoa.visto = t
  if (!pessoa.presente) { pessoa.presente = true; pessoa.desde = t; bus.emit('pessoa_chegou', { label: `rosto ${(f.tam * 100).toFixed(0)}%` }) }
})
function vigiarPresenca() { if (pessoa.presente && now() - pessoa.visto > 8000) { pessoa.presente = false; pessoa.saiuEm = now(); bus.emit('pessoa_saiu', { label: '' }) } }

bus.on('pessoa_chegou', () => {
  const sumido = (now() - pessoa.saiuEm) / 1000
  if (sumido < 20) return
  const afeto = P.afeto
  evento({ label: `${cfg.dono} chegou`, P: 0.3 + afeto * 0.5, A: 0.5, interesse: 0.85, expr: afeto > 0.65 ? 'apaixonado' : 'feliz', icone: afeto > 0.65 ? 'coracao' : null, som: afeto > 0.65 ? 'amor' : 'feliz', gesto: 'pulinhos', dur: 2500, lembrar: sumido > 1800 })
  evoluir('extroversao', 0.002)
})
bus.on('pessoa_saiu', () => evento({ label: `${cfg.dono} saiu`, P: -0.2 - P.afeto * 0.2, A: -0.1, interesse: 0.4, expr: 'triste', som: P.afeto > 0.6 ? 'triste' : false, dur: 2000 }))

// ================================================================ C3: TOQUE e CLIMA
const clima = { temp: 26, umid: 55 }
const toques = []
cv.addEventListener('pointerdown', () => {
  if (!actx) return
  const t = now(); toques.push(t); while (toques.length && t - toques[0] > 4000) toques.shift()
  if (toques.length > 6) { evento({ label: 'muito cutucão!', P: -0.4, A: 0.5, D: 0.4, interesse: 0.8, expr: 'bravo', icone: 'exclamacao', som: 'bravo', gesto: 'nao', dur: 2000 }); return }
  evento({ label: 'carinho na cabeça', P: 0.5, A: 0.15, interesse: 0.85, expr: Math.random() < 0.35 ? 'timido' : 'amor', icone: 'coracao', som: 'amor', gesto: Math.random() < 0.3 ? 'piscadela' : null, dur: 2000 })
  P.afeto = clamp(P.afeto + 0.004, 0.05, 0.95)
})
$('#temp').oninput = (e) => { clima.temp = +e.target.value; $('#tv').textContent = clima.temp; ultimoClima = 0 }
$('#umid').oninput = (e) => { clima.umid = +e.target.value; $('#hv').textContent = clima.umid; ultimoClima = 0 }

// ================================================================ GROQ: conversa
let gravando = false, rec = null, micStream = null
let conversa = [] // últimas falas desta sessão, para ele seguir o assunto
async function groq(path, opts) {
  const r = await fetch('https://api.groq.com/openai/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + cfg.key, ...(opts?.headers || {}) } })
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

async function alternarFala() {
  if (!cfg.key) { abrirCfg(); $('#cMsg').textContent = 'Coloque a chave do Groq para conversar.'; return }
  if (gravando) { rec?.stop(); return }
  const partes = []
  rec = new MediaRecorder(micStream)
  rec.ondataavailable = (e) => e.data.size && partes.push(e.data)
  rec.onstop = () => { gravando = false; $('#btnFalar').classList.remove('on'); processarFala(new Blob(partes, { type: rec.mimeType })) }
  rec.start(); gravando = true; $('#btnFalar').classList.add('on')
  foco = { expr: 'ouvindo', ate: now() + 9000 }; icone = { tipo: 'reticencias', ate: now() + 9000 }
  setTimeout(() => { if (gravando) rec.stop() }, 8000)
}

async function processarFala(blob) {
  foco = { expr: 'pensando', ate: now() + 15000 }; icone = { tipo: 'reticencias', ate: now() + 15000 }
  try {
    const fd = new FormData()
    fd.append('file', blob, 'fala.' + (blob.type.includes('mp4') ? 'm4a' : 'webm'))
    fd.append('model', cfg.stt); fd.append('language', 'pt'); fd.append('response_format', 'json')
    const { text } = await groq('/audio/transcriptions', { method: 'POST', body: fd })
    pushLog(`Você: ${text}`)
    if (!text?.trim()) throw new Error('não entendi nada')
    const traços = `extroversão ${P.extroversao.toFixed(2)}, curiosidade ${P.curiosidade.toFixed(2)}, energia ${P.energia.toFixed(2)}, sensibilidade ${P.sensibilidade.toFixed(2)}, afeto por ${cfg.dono} ${P.afeto.toFixed(2)}`
    const gostos = Object.entries(P.gostos).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')
    const recentes = memorias.slice(0, 8).map((m) => '- ' + m.txt).join('\n') || '- nada marcante ainda'
    const agora = new Date()
    const quando = agora.toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    const sys = `Você é ${cfg.nome}, um robozinho de mesa com personalidade própria, que mora na mesa de ${cfg.dono}.
Você NÃO fala nem escreve palavras. Você responde com: um GESTO do rosto, uma EMOÇÃO, até 3 ÍCONES num balão e, se precisar, um NÚMERO curto. Os sons fofos (estilo WALL-E e R2-D2) saem sozinhos.

Como responder:
- Pergunta de sim/não: use o gesto "sim" ou "nao" (ou "talvez", "nao_sei"). Isso é o mais importante.
- Para dizer algo, combine ícones em ordem, como uma frase de figurinhas. Ex.: "vai chover?" → gesto "nao_sei", ícones ["nuvem","chuva"]. "Tá com fome?" → "nao" + ["robo","bateria"]. "O que você quer fazer?" → gesto "dancinha" + ["musica","jogo"]. Use só nomes que estão nas listas abaixo.
- Hora, data, temperatura, contagens: use "numero" (até 6 caracteres, ex.: "14:30", "26°", "3", "8/11").
- Piadas: "rir". Elogio: "timido" ou "orgulhoso". Notícia triste: "chorando" ou "suspiro". Coisa estranha: "desconfiado". Coisa confusa: "tonto". Algo incrível: "pulinhos" ou "empolgado".
- Seja coerente com o humor de hoje: de mau humor reage menos; entediado, só algo interessante anima. Não seja sempre feliz. Varie os gestos.

Agora: ${quando}. Temperatura ${clima.temp} °C, umidade ${clima.umid} %. ${audio.musica ? `Está tocando música ${audio.estilo} (${audio.bpm} BPM).` : ''}
Sua personalidade (0 a 1): ${traços}. Você tem ${P.dias} dia(s) de vida.
Gostos aprendidos (-1 a 1): ${gostos}.
Humor de hoje: ${nomePAD(humor)}. Emoção agora: ${emo.nome}.
Coisas que você lembra:
${recentes}

GESTOS: ${Object.keys(GESTOS).join(', ')}, nenhum
EMOÇÕES: ${EMOCOES.join(', ')}
ÍCONES: ${Object.keys(ICONES).join(', ')}

Responda SÓ com JSON: {"gesto": "...", "emocao": "...", "intensidade": 0 a 1, "icones": [até 3 da lista, ou vazio], "numero": "" ou curto, "pensamento": "o que você quis dizer, numa frase curta em português", "afeto": número de -0.05 a 0.05, "lembrar": "frase curta se valer guardar na memória, senão vazio"}`
    conversa.push({ role: 'user', content: `${cfg.dono} disse: "${text}"` })
    const r = await groq('/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, temperature: 0.85, max_tokens: 260, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, ...conversa.slice(-10)] }),
    })
    const bruto = r.choices[0].message.content
    const j = JSON.parse(bruto)
    conversa.push({ role: 'assistant', content: bruto }); conversa = conversa.slice(-10)
    const nome = EMOCOES.includes(j.emocao) ? j.emocao : 'curioso'
    const gest = GESTOS[j.gesto] ? j.gesto : 'nenhum'
    const icns = Array.isArray(j.icones) ? j.icones.filter((x) => ICONES[x]).slice(0, 3) : []
    const v = PAD[nome], k = clamp(+j.intensidade || 0.5, 0, 1)
    pushLog(`${cfg.nome}: ${j.pensamento || '…'} [${gest} · ${nome} ${k.toFixed(1)}${icns.length ? ' · ' + icns.map((x) => ICONES[x]).join('') : ''}${j.numero ? ' · ' + j.numero : ''}]`)
    P.afeto = clamp(P.afeto + clamp(+j.afeto || 0, -0.05, 0.05), 0.05, 0.95)
    if (j.lembrar) lembrar(j.lembrar)
    evoluir('extroversao', 0.003)
    foco = null; icone = null
    evento({ label: `respondeu a "${text.slice(0, 40)}"`, P: v[0] * k, A: v[1] * k, D: v[2] * k, interesse: 0.9, expr: nome, gesto: gest, forcarGesto: true, icones: icns, numero: j.numero, som: nome, intens: k, dur: 4500 })
  } catch (err) {
    pushLog('Erro: ' + err.message)
    foco = { expr: 'triste', ate: now() + 2500 }; icone = { tipo: 'interrogacao', ate: now() + 2500 }
    somDe('triste', 0.4)
  }
}

// ================================================================ telas
// Com um painel aberto, o rosto encolhe e sobe para continuar visível.
new MutationObserver(() => document.body.classList.toggle('painel', !$('#debug').hidden || !$('#cfg').hidden))
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
document.querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = () => { $('#debug').hidden = true; $('#cfg').hidden = true }))
function abrirCfg() {
  $('#cNome').value = cfg.nome; $('#cDono').value = cfg.dono; $('#cKey').value = cfg.key; $('#cStt').value = cfg.stt
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
    if (!ids.includes(cfg.model)) { const pref = ids.find((i) => /llama.*70b/i.test(i)) || ids.find((i) => /llama/i.test(i)) || ids[0]; sel.value = pref }
    const stts = data.map((m) => m.id).filter((id) => /whisper/i.test(id))
    if (stts.length && !stts.includes(cfg.stt)) $('#cStt').value = stts.find((i) => /turbo/.test(i)) || stts[0]
  } catch (e) { $('#cMsg').textContent = 'Não consegui listar os modelos: ' + e.message }
}
$('#btnCfg').onclick = () => ($('#cfg').hidden ? abrirCfg() : ($('#cfg').hidden = true))
$('#cClose').onclick = () => ($('#cfg').hidden = true)
$('#cKey').onchange = () => { cfg.key = $('#cKey').value.trim(); carregarModelos() }
$('#cSave').onclick = () => {
  Object.assign(cfg, { nome: $('#cNome').value.trim() || 'Robô', dono: $('#cDono').value.trim() || 'Will', key: $('#cKey').value.trim(), model: $('#cModel').value, stt: $('#cStt').value.trim() || 'whisper-large-v3-turbo' })
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
$('#btnDebug').onclick = () => { $('#debug').hidden = !$('#debug').hidden; $('#cfg').hidden = true }
document.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => {
  const s = b.dataset.sim
  if (s === 'susto') bus.emit('susto', { label: 'teste' })
  if (s === 'pessoa') { pessoa.saiuEm = now() - 60000; bus.emit('face', { x: rnd(-0.5, 0.5), y: 0, tam: 0.3 }) }
  if (s === 'saiu') { pessoa.visto = 0; vigiarPresenca() }
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
Vida         : ${P.dias} dia(s)`
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
  } catch (e) {
    $('#start').querySelector('p').textContent = 'Não consegui usar o microfone: ' + e.message + '. Libere o microfone para este site e tente de novo.'
  }
}
requestAnimationFrame(quadro)
