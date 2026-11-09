// ================================================================ ESP32-C3 · firmware da tela (emulado)
// Este arquivo só desenha. Não sabe nada de IA, câmera ou microfone: recebe do S3 (cérebro) linhas
// curtas de texto pela UART, como "EXPR feliz", "GESTO sim" ou "BALAO 4500|sol,chuva|24°", e devolve
// só o toque na tela ("TOQUE x y"). A lista de mensagens está em receber(), mais abaixo.
//
// Regras para caber no C3 (sem FPU, 400 KB de RAM, SPI de ~115 KB por quadro):
//  · pixel art e retângulos nunca giram; só pontos de linhas e polígonos (olho de estrela, espiral, boca);
//  · inclinar a cabeça = girar só os pontos de encaixe (olhos, boca, acessórios), que continuam retos;
//  · fundo liso (sem degradê) e as máscaras dos olhos pintadas com a cor do fundo (sem composição);
//  · texto só com a fonte de pixel 5×7 daqui (o C3 não tem fonte de emoji);
//  · transparência só em coisas pequenas (ícones, brilhos, zzz), nunca na tela inteira.
import { ICONES_PX } from './icones.js?v=24'
import { ICONES, PALETA, EMOTES, ACESS, BASE, EXPR, GESTO_DUR } from './comum.js?v=24'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const rnd = (a, b) => a + Math.random() * (b - a)
const media = (a, b) => (a ? a * 0.95 + b * 0.05 : b)

// ---------------------------------------------------------------- fonte de pixel 5×7 (7 bytes por letra na flash)
const FONTE_SRC = {
  0: '.###. #...# #..## #.#.# ##..# #...# .###.', 1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.', 2: '.###. #...# ....# ...#. ..#.. .#... #####',
  3: '##### ...#. ..#.. ...#. ....# #...# .###.', 4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.', 5: '##### #.... ####. ....# ....# #...# .###.',
  6: '..##. .#... #.... ####. #...# #...# .###.', 7: '##### ....# ...#. ..#.. .#... .#... .#...', 8: '.###. #...# #...# .###. #...# #...# .###.',
  9: '.###. #...# #...# .#### ....# ...#. .##..',
  A: '.###. #...# #...# ##### #...# #...# #...#', B: '####. #...# #...# ####. #...# #...# ####.', C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '###.. #..#. #...# #...# #...# #..#. ###..', E: '##### #.... #.... ####. #.... #.... #####', F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####', H: '#...# #...# #...# ##### #...# #...# #...#', I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..', K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#', L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#', N: '#...# #...# ##..# #.#.# #..## #...# #...#', O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....', Q: '.###. #...# #...# #...# #.#.# #..#. .##.#', R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.', T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..', U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..', W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.', X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..', Z: '##### ....# ...#. ..#.. .#... #.... #####',
  ':': '..... ..#.. ..#.. ..... ..#.. ..#.. .....', '.': '..... ..... ..... ..... ..... ..... ..#..', ',': '..... ..... ..... ..... ..#.. ..#.. .#...',
  '°': '.##.. #..#. #..#. .##.. ..... ..... .....', '%': '##... ##..# ...#. ..#.. .#... #..## ...##', '/': '..... ....# ...#. ..#.. .#... #.... .....',
  '-': '..... ..... ..... ##### ..... ..... .....', '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....', '=': '..... ..... ##### ..... ##### ..... .....',
  '?': '.###. #...# ....# ...#. ..#.. ..... ..#..', '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..', '…': '..... ..... ..... ..... ..... ..... #.#.#',
  '♪': '..#.. ..##. ..#.# ..#.. .##.. ###.. .#...', '$': '..#.. .#### #.#.. .###. ..#.# ####. ..#..', '×': '..... #...# .#.#. ..#.. .#.#. #...# .....',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.', ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...', '<': '...#. ..#.. .#... #.... .#... ..#.. ...#.',
  '>': '.#... ..#.. ...#. ....# ...#. ..#.. .#...', "'": '..#.. ..#.. ..... ..... ..... ..... .....', '#': '.#.#. ##### .#.#. .#.#. ##### .#.#. .....',
}
const FONTE = {}
for (const [c, s] of Object.entries(FONTE_SRC)) FONTE[c] = s.split(' ').map((r) => [...r].reduce((m, ch, i) => m | (ch === '#' ? 16 >> i : 0), 0))
const paraFonte = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] // pontilhado ordenado (névoa sem transparência)

// ---------------------------------------------------------------- movimentos do rosto inteiro (t de 0 a 1)
// Devolvem deslocamento, giro dos pontos de encaixe, escala e, às vezes, olhar ou forma dos olhos.
// A duração de cada um mora em comum.js (o cérebro também precisa saber quanto tempo dura).
let forcaTremor = 1
const MOV = {
  sim: { f: (t) => ({ oy: Math.sin(t * Math.PI * 4) * 10 * (1 - t * 0.3) }) },
  nao: { f: (t) => ({ ox: Math.sin(t * Math.PI * 6) * 14 * (1 - t * 0.3) }) },
  talvez: { f: (t) => ({ rot: Math.sin(t * Math.PI * 2) * 0.18 }) },
  nao_sei: { f: (t) => ({ rot: Math.sin(t * Math.PI) * 0.14, gy: -0.8, gx: 0.3 }) },
  pulinhos: { f: (t) => ({ oy: -Math.abs(Math.sin(t * Math.PI * 3)) * 18, sy: 1 - Math.abs(Math.cos(t * Math.PI * 3)) * 0.08 }) },
  rir: { f: (t) => ({ oy: Math.sin(t * Math.PI * 18) * 3, rot: Math.sin(t * Math.PI * 4) * 0.05, forma: 'fechado_feliz' }) },
  piscadela: { f: (t) => ({ formaD: t < 0.75 ? 'fechado_feliz' : null, rot: Math.sin(t * Math.PI) * 0.06 }) },
  timido: { f: () => ({ gx: 0.6, gy: 0.8 }) },
  desconfiado: { f: (t) => ({ gx: -0.8 + t * 1.6, gy: 0.1 }) },
  tonto: { f: (t) => ({ rot: Math.sin(t * Math.PI * 4) * 0.15, ox: Math.sin(t * Math.PI * 3) * 8, forma: 'espiral' }) },
  suspiro: { f: (t) => ({ oy: Math.sin(t * Math.PI) * 10, sy: 1 - Math.sin(t * Math.PI) * 0.05 }) },
  dancinha: { f: (t) => ({ rot: Math.sin(t * Math.PI * 6) * 0.15, ox: Math.sin(t * Math.PI * 6) * 10, oy: -Math.abs(Math.sin(t * Math.PI * 6)) * 6 }) },
  encolher: { f: (t) => ({ s: 1 - Math.sin(t * Math.PI) * 0.15, oy: Math.sin(t * Math.PI) * 6 }) },
  olhar_em_volta: { f: (t) => ({ gx: Math.sin(t * Math.PI * 2) * 0.9, gy: 0 }) },
  desmaiar: { f: (t) => { const k = t < 0.8 ? Math.min(1, t * 3) : 1 - (t - 0.8) * 5; return { rot: 0.4 * k, oy: 22 * k, forma: t < 0.85 ? 'x' : null } } },
  surpresa: { antes: { oy: 4, sy: 0.93 }, f: (t) => ({ oy: -Math.sin(t * Math.PI) * 12, s: 1 + Math.sin(t * Math.PI) * 0.08 }) },
  espreguicar: { f: (t) => ({ sy: 1 + Math.sin(t * Math.PI) * 0.12, oy: -Math.sin(t * Math.PI) * 8, rot: Math.sin(t * Math.PI * 2) * 0.05, forma: t > 0.2 && t < 0.8 ? 'fechado_feliz' : null }) },
}
// Antecipação (princípio de animação da Disney): antes de pular, se abaixa um pouquinho.
MOV.pulinhos.antes = { oy: 5, sy: 0.9 }
MOV.tremer = { f: (t) => ({ ox: Math.sin(t * Math.PI * 34) * 3 * forcaTremor * (1 - t * 0.5), oy: Math.sin(t * Math.PI * 27) * 1.2 * forcaTremor }) }
MOV.aceno = { f: (t) => ({ oy: Math.sin(t * Math.PI) * 5 }) }
MOV.bocejo = { f: (t) => ({ sy: 1 + Math.sin(t * Math.PI) * 0.07, oy: -Math.sin(t * Math.PI) * 4, forma: t > 0.15 && t < 0.85 ? 'fechado' : null }) }
MOV.sim.antes = { oy: -4 }

// Desenhos que só a tela usa.
const CARNEIRO = ['.wwwww....', 'wwwwwwwkk.', 'wwwwwwwkkk', 'wwwwwwwkk.', '.wwwwww...', '.k.k..k.k.', '.k.k..k.k.']
const BICHO = ['..k.k..', '.rrkrr.', 'rkrkrkr', 'rrrkrrr', '.r.k.r.']
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

export function criarC3(cv, op = {}) {
  const now = () => performance.now()
  const gTela = cv.getContext('2d'); gTela.setTransform(2, 0, 0, 2, 0, 0) // canvas 480 desenhando em 240×240, como a tela de verdade
  let g = gTela
  const cvF = document.createElement('canvas'); cvF.width = cvF.height = 480 // rosto fora da tela durante um emote
  const gF = cvF.getContext('2d'); gF.setTransform(2, 0, 0, 2, 0, 0)
  const cvP = document.createElement('canvas'), gP = cvP.getContext('2d')

  // Estado da tela: só o que chegou pela UART.
  const tela = {
    expr: 'neutro', olhar: { modo: 'auto', x: 0, y: 0, amp: 0.8, tedio: false, fixoY: null }, atento: false, sono: false, treme: 0,
    icone: null, balao: null, palco: null, vestido: {}, moldura: [], decoT0: 0, nevoa: 0, limpando: null, limpos: [],
    humor: null, nuvem: null, painel: null, sonho: null, carneirosAte: 0, bicho: null, anel: null, status: {},
    velha: null, copo: null, cor: null, matrix: null,
  }
  const cur = structuredClone(BASE)
  let formaAtual = 'normal', gesto = null, piscar = 0, proxPiscar = now() + 3000, balanco = 0, inclinacao = 0, tAnterior = now()
  const olhar = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, mx: 0, my: 0, proxSacada: 0, proxMicro: 0 }
  const perf = { quadro: 0, fps: 0, ultimoQ: 0, msgs: 0 }

  // ---------------------------------------------------------------- mensagens S3 → C3
  // EXPR nome · OLHAR x y | OLHAR auto amplitude tédio [y] | OLHAR rem · ATENTO 0|1 · SONO 0|1 · TREME 0..3
  // GESTO nome [força] · PISCAR · BATIDA [força] · ICONE tipo|- · BALAO ms|ic,ic,ic|número · BALAO -
  // EMOTE nome ms saída volta lado · DESENHO ms saída volta <256 letras de cor> · ACESS a,b,c|-
  // MOLDURA elemento:cores;elemento:cores|- · NEVOA 0..1 · LIMPAR · HUMOR P A|- · NUVEM ic,ic|.|-
  // PAINEL quadro total ic,ic|- · SONHO ic,ic|- · CARNEIROS ms · BICHO x dir vel seco|- · ANEL fase total resta|-
  // STATUS câmera vad verificando gravando (4 dígitos) · VELHA casas(9: X, O ou .) última|- linha|- · VELHA -
  // COPO copos meta ms · COR letra ms (círculo colorido do Genius) · MATRIX fase(baixar|instalar) porcentagem versão · MATRIX -
  function receber(linha) {
    perf.msgs++
    const i = linha.indexOf(' '), cmd = i < 0 ? linha : linha.slice(0, i), a = i < 0 ? '' : linha.slice(i + 1), p = a.split(' ')
    const lista = (s) => (!s || s === '-' ? [] : s.split(',').filter(Boolean))
    const t = now()
    switch (cmd) {
      case 'EXPR': tela.expr = EXPR[a] ? a : 'neutro'; break
      case 'OLHAR':
        if (p[0] === 'auto') Object.assign(tela.olhar, { modo: 'auto', amp: +p[1] || 0.8, tedio: p[2] === '1', fixoY: p[3] !== undefined ? +p[3] : null })
        else if (p[0] === 'rem') tela.olhar.modo = 'rem'
        else Object.assign(tela.olhar, { modo: 'fixo', x: +p[0] || 0, y: +p[1] || 0 })
        break
      case 'ATENTO': tela.atento = a === '1'; break
      case 'SONO': tela.sono = a === '1'; break
      case 'TREME': tela.treme = +a || 0; break
      case 'GESTO': if (MOV[p[0]]) { gesto = { nome: p[0], t0: t }; if (p[1]) forcaTremor = +p[1] } break
      case 'PISCAR': piscar = 1; break
      case 'BATIDA': balanco = Math.max(balanco, +a || 1); break
      case 'ICONE': tela.icone = a === '-' ? null : a; break
      case 'BALAO': {
        if (a === '-') { tela.balao = null; break }
        const [ms, itens, numero = ''] = a.split('|')
        tela.balao = { itens: lista(itens).slice(0, 3), numero: numero.slice(0, 12), t0: t, ate: t + (+ms || 4500) }
        break
      }
      case 'EMOTE': if (EMOTES[p[0]]) tela.palco = { emote: p[0], dur: +p[1] || 1900, saida: p[2], volta: p[3], lado: +p[4] || 1, t0: t }; break
      case 'DESENHO': tela.palco = { emote: 'desenho', dur: +p[0] || 7000, saida: p[1], volta: p[2], lado: 1, t0: t, desenho: true, px: Array.from({ length: 16 }, (_, r) => (p[3] || '').slice(r * 16, r * 16 + 16).padEnd(16, '.')) }; break
      case 'ACESS': { const v = {}; for (const n of lista(a)) if (ACESS[n]) v[n] = tela.vestido[n] || t; tela.vestido = v; break }
      case 'MOLDURA': tela.moldura = a === '-' ? [] : a.split(';').map((x) => { const [el, cs = ''] = x.split(':'); return { el, cores: [...cs] } }); tela.decoT0 = t; break
      case 'NEVOA': tela.nevoa = +a || 0; break
      case 'LIMPAR': tela.limpando = { t0: t }; break
      case 'HUMOR': tela.humor = a === '-' ? null : { p: +p[0] || 0, a: +p[1] || 0 }; break
      case 'NUVEM': tela.nuvem = a === '-' ? null : a === '.' ? [] : lista(a); break
      case 'PAINEL': tela.painel = a === '-' ? null : { i: +p[0], n: +p[1], icones: lista(p[2]) }; break
      case 'SONHO': tela.sonho = a === '-' ? null : lista(a); break
      case 'CARNEIROS': tela.carneirosAte = t + (+a || 7000); break
      case 'BICHO': tela.bicho = a === '-' ? null : { x: +p[0], dir: +p[1] || 1, vel: +p[2] || 36, seco: p[3] === '1' }; break
      case 'ANEL': tela.anel = a === '-' ? null : { fase: p[0], ini: t - (+p[1] - +p[2]), fim: t + +p[2] }; break
      case 'VELHA': tela.velha = a === '-' ? null : { c: (p[0] || '').padEnd(9, '.').slice(0, 9), ultima: p[1] && p[1] !== '-' ? +p[1] : -1, linha: lista(p[2]).map(Number), t0: t }; break
      case 'COPO': tela.copo = a === '-' ? null : { n: +p[0] || 0, meta: +p[1] || 8, t0: t, ate: t + (+p[2] || 6000) }; break
      case 'COR': tela.cor = PALETA[p[0]] ? { c: PALETA[p[0]], t0: t, ate: t + (+p[1] || 500) } : null; break
      case 'MATRIX': tela.matrix = a === '-' ? null : { fase: p[0], pct: clamp(+p[1] || 0, 0, 100), versao: (p[2] || '').toUpperCase(), t0: tela.matrix?.t0 || t }; break
      case 'STATUS': tela.status = { cam: a[0] === '1', vad: a[1] === '1', verif: a[2] === '1', grav: a[3] === '1' }; break
      default: return false
    }
    return true
  }
  // C3 → S3: o único sentido de volta é o toque.
  cv.addEventListener('pointerdown', (e) => { const r = cv.getBoundingClientRect(); op.enviar?.(`TOQUE ${Math.round((e.clientX - r.left) / r.width * 240)} ${Math.round((e.clientY - r.top) / r.height * 240)}`) })

  // ---------------------------------------------------------------- desenho básico
  function texto(s, cx, cy, e = 2, cor = '#e8f6ff', alinhar = 'centro') {
    const str = paraFonte(s), larg = str.length * 6 * e - e
    let x = Math.round(alinhar === 'centro' ? cx - larg / 2 : cx); const y = Math.round(cy - 3.5 * e)
    g.fillStyle = cor
    for (const ch of str) {
      const gl = ch === ' ' ? null : FONTE[ch] || FONTE['?']
      if (gl) for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (gl[r] & (16 >> c)) g.fillRect(x + c * e, y + r * e, e, e)
      x += 6 * e
    }
  }
  const largTexto = (s, e) => paraFonte(s).length * 6 * e - e
  const corPx = {}
  const css565 = (h) => corPx[h] || (corPx[h] = (() => { const v = parseInt(h, 16); return `rgb(${((v >> 11) & 31) << 3},${((v >> 5) & 63) << 2},${(v & 31) << 3})` })())
  // Ícone em pixel 16×16 (paleta RGB565 de cada ícone). Sem ícone no atlas, um "?" (o C3 não tem emoji).
  function desenharIconePx(chave, cx, cy, e = 1.6) {
    const d = ICONES_PX[ICONES[chave] || chave]
    if (!d) return texto('?', cx, cy, Math.max(1, Math.round(e * 1.5)))
    const x0 = cx - 8 * e, y0 = cy - 8 * e
    for (let y = 0; y < 16; y++) {
      const l = d.l[y]
      for (let x = 0; x < 16; x++) { const c = l.charCodeAt(x) - 48; if (!c) continue; g.fillStyle = css565(d.p[(c > 9 ? c - 39 : c) - 1]); g.fillRect(x0 + x * e, y0 + y * e, e + 0.35, e + 0.35) }
    }
  }
  function desenharSprite(px, cx, cy, e, troca = null, alpha = 1, ex = e) {
    const h = px.length, w = px[0].length
    g.save(); g.globalAlpha *= alpha
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      let ch = px[r][c]; if (ch === '.') continue
      if (troca && troca[ch]) ch = troca[ch]
      g.fillStyle = PALETA[ch] || ch
      g.fillRect(cx + (c - w / 2) * ex, cy + (r - h / 2) * e, ex + 0.4, e + 0.4)
    }
    g.restore()
  }

  // ---------------------------------------------------------------- olhos
  // fv = achatamento vertical (piscada das formas especiais); fundo = cor das máscaras.
  function desenharOlho(cx, cy, w, h, lado, p, cor, forma, t, fv, fundo) {
    g.fillStyle = cor; g.strokeStyle = cor; g.lineCap = 'round'; g.lineJoin = 'round'
    const s = w / 54, X = (dx) => cx + dx * s, Y = (dy) => cy + dy * s * fv
    if (forma === 'coracao') {
      const k = 1 + Math.sin(t / 160) * 0.06, Xk = (dx) => cx + dx * s * k, Yk = (dy) => cy + dy * s * k * fv
      g.beginPath(); g.moveTo(Xk(0), Yk(26)); g.bezierCurveTo(Xk(-46), Yk(-6), Xk(-22), Yk(-44), Xk(0), Yk(-18)); g.bezierCurveTo(Xk(22), Yk(-44), Xk(46), Yk(-6), Xk(0), Yk(26)); g.fill()
      return
    }
    if (forma === 'estrela') { // os pontos giram, não a imagem
      const a0 = -Math.PI / 2 + Math.sin(t / 300) * 0.15
      g.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 13 : 32, a = a0 + i * Math.PI / 5; g.lineTo(X(Math.cos(a) * r), Y(Math.sin(a) * r)) }
      g.closePath(); g.fill(); return
    }
    if (forma === 'x') {
      g.lineWidth = 8 * s; g.beginPath(); g.moveTo(X(-18), Y(-18)); g.lineTo(X(18), Y(18)); g.moveTo(X(18), Y(-18)); g.lineTo(X(-18), Y(18)); g.stroke(); return
    }
    if (forma === 'espiral') {
      const fase = t / 150 * lado
      g.lineWidth = 5 * s; g.beginPath(); for (let a = 0; a < Math.PI * 6; a += 0.2) { const r = a * 1.6; g.lineTo(X(Math.cos(a + fase) * r), Y(Math.sin(a + fase) * r)) }
      g.stroke(); return
    }
    if (forma === 'fechado') { g.lineWidth = 7 * s; g.beginPath(); g.moveTo(X(-20), Y(4)); g.quadraticCurveTo(X(0), Y(12), X(20), Y(4)); g.stroke(); return }
    if (forma === 'fechado_feliz') { g.lineWidth = 8 * s; g.beginPath(); g.ellipse(X(0), Y(10), 20 * s, 20 * s * fv, 0, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); return }
    const r = Math.min(w, h) * 0.3
    g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, Math.max(1, Math.min(r, h / 2))); g.fill()
    // Máscaras pintadas com a cor do fundo (no C3 não existe "recortar"): pálpebra cansada, brava e bochecha feliz.
    g.fillStyle = fundo
    const top = cy - h / 2 - 1, L = cx - w / 2 - 1, R = cx + w / 2 + 1
    const fora = lado < 0 ? L : R, dentro = lado < 0 ? R : L
    if (p.tired > 0.02) { g.beginPath(); g.moveTo(L, top - 1); g.lineTo(R, top - 1); g.lineTo(fora, top + p.tired * h * 0.75); g.closePath(); g.fill() }
    if (p.angry > 0.02) { g.beginPath(); g.moveTo(L, top - 1); g.lineTo(R, top - 1); g.lineTo(dentro, top + p.angry * h * 0.75); g.closePath(); g.fill() }
    if (p.happy > 0.02) { g.beginPath(); g.ellipse(cx, cy + h * (1 - 0.5 * p.happy) + 2, w * 0.8, h * 0.55, 0, 0, Math.PI * 2); g.fill() }
  }

  // ---------------------------------------------------------------- ícone do canto, balão
  function desenharIcone(tipo, t) {
    const y = 34 + Math.sin(t / 300) * 3
    if (tipo === 'coracao') {
      const s = 1 + Math.sin(t / 150) * 0.08, X = (dx) => 204 + dx * s, Y = (dy) => y + dy * s
      g.fillStyle = '#ff7eb6'; g.beginPath(); g.moveTo(X(0), Y(8)); g.bezierCurveTo(X(-16), Y(-4), X(-8), Y(-16), X(0), Y(-7)); g.bezierCurveTo(X(8), Y(-16), X(16), Y(-4), X(0), Y(8)); g.fill()
    } else if (tipo === 'gota') {
      const gy = 70 + ((t / 25) % 18)
      g.fillStyle = '#6cc8ff'; g.beginPath(); g.moveTo(40, gy - 9); g.quadraticCurveTo(48, gy + 3, 40, gy + 7); g.quadraticCurveTo(32, gy + 3, 40, gy - 9); g.fill()
    } else if (tipo === 'zzz') {
      for (let i = 0; i < 3; i++) { const k = ((t / 900 + i / 3) % 1); g.globalAlpha = 1 - k; texto('z', 196 + k * 22, 54 - k * 34, 2) }
      g.globalAlpha = 1
    } else {
      const txt = { interrogacao: '?', '?': '?', exclamacao: '!', '!': '!', reticencias: '…', nota: '♪' }[tipo] || tipo
      texto(txt, 204, y, 4, tipo === 'exclamacao' || tipo === '!' ? '#ffd166' : tipo === 'nota' ? '#7df9ff' : '#e8f6ff')
    }
  }
  // Balão no alto da tela: até 3 ícones, aparecendo um por um, ou um número curto (hora, temperatura).
  function desenharBalao(t) {
    const b = tela.balao, idade = t - b.t0, temNum = !!b.numero
    const e = b.numero.length > 6 ? 2 : 3
    const larg = temNum ? Math.max(70, largTexto(b.numero, e) + 28) : b.itens.length * 36 + 18
    const x = 120 - larg / 2, y = 4, alt = 40
    g.fillStyle = '#1b2632'; g.strokeStyle = '#3a4a5a'; g.lineWidth = 1.5
    g.beginPath(); g.roundRect(x, y, larg, alt, 14); g.fill(); g.stroke()
    g.beginPath(); g.moveTo(112, y + alt); g.lineTo(120, y + alt + 7); g.lineTo(128, y + alt); g.fill()
    if (temNum) texto(b.numero, 120, y + alt / 2, e)
    else {
      const mostrados = Math.min(b.itens.length, 1 + Math.floor(Math.max(0, idade) / 450))
      for (let i = 0; i < mostrados; i++) desenharIconePx(b.itens[i], x + 27 + i * 36, y + alt / 2 + Math.round(Math.sin(t / 250 + i) * 1.5), 1.6)
    }
  }

  // ---------------------------------------------------------------- palco (emotes)
  function compor(t) {
    const pl = tela.palco, k = t - pl.t0, S = 340, V = 420, E = pl.dur
    g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240)
    if (k < S) efeito(pl.saida, k / S)
    else if (k < S + E) desenharEmote(pl, k - S, E)
    else if (k < S + E + V) efeito(pl.volta, 1 - (k - S - E) / V)
    else { tela.palco = null; g.drawImage(cvF, 0, 0, 240, 240) }
  }
  // p = 0: rosto inteiro; p = 1: rosto sumiu. Só cópias, recortes e escala do quadro (sem girar e sem misturar cores).
  function efeito(tipo, p) {
    p = clamp(p, 0, 1)
    g.save()
    if (tipo === 'pixel') {
      if (p < 0.92) {
        const n = Math.max(6, Math.round(240 * Math.pow(1 - p, 2.2)))
        cvP.width = cvP.height = n; gP.imageSmoothingEnabled = false; gP.drawImage(cvF, 0, 0, n, n)
        g.imageSmoothingEnabled = false; g.drawImage(cvP, 0, 0, 240, 240); g.imageSmoothingEnabled = true
      }
    } else if (tipo === 'tv') {
      if (p < 0.7) { const sy = Math.max(0.02, 1 - p / 0.7); g.drawImage(cvF, 0, 0, 480, 480, 0, 120 * (1 - sy), 240, 240 * sy) }
      else { const sx = 1 - (p - 0.7) / 0.3; g.fillStyle = '#e8f6ff'; g.fillRect(120 - 120 * sx, 119, 240 * sx, 2) }
    } else if (tipo === 'glitch') {
      for (let y = 0; y < 240; y += 12) {
        if (Math.random() < p * 0.8) continue // faixa apagada
        const dx = Math.round((Math.random() - 0.5) * p * 90)
        g.drawImage(cvF, 0, y * 2, 480, 24, dx, y, 240, 12)
        if (Math.random() < p * 0.5) { g.fillStyle = Math.random() < 0.5 ? '#7df9ff' : '#ff4d8d'; g.fillRect(0, y + Math.floor(Math.random() * 12), 240, 1) }
      }
    } else if (tipo === 'derreter') {
      for (let x = 0; x < 240; x += 6) g.drawImage(cvF, x * 2, 0, 12, 480, x, p * (60 + ((x * 37) % 23) * 6), 6, 240)
    } else if (tipo === 'deslizar') {
      g.drawImage(cvF, (tela.palco?.lado || 1) * p * 260, 0, 240, 240)
    } else { // zoom (antigo "giro"): só encolhe para o meio
      const s = 1 - p; g.drawImage(cvF, 120 - 120 * s, 120 - 120 * s, 240 * s, 240 * s)
    }
    g.restore()
  }
  function desenharEmote(pl, k, E) {
    const em = pl.px ? { px: pl.px, anim: pl.desenho ? 'revelar' : 'pulsar' } : EMOTES[pl.emote]
    const ent = clamp(k / 240, 0, 1), sai = clamp((E - k) / 220, 0, 1)
    const pop = ent < 1 ? 1 + 2.7 * Math.pow(ent - 1, 3) + 1.7 * Math.pow(ent - 1, 2) : 1
    let s = 9 * pop * (sai < 1 ? sai : 1), x = 120, y = 122, ex = null
    if (em.anim === 'pulsar') s *= 1 + 0.08 * Math.sin(k / 110)
    if (em.anim === 'quicar') y -= Math.abs(Math.sin(k / 170)) * 16
    if (em.anim === 'tremer') { x += rnd(-2.5, 2.5); y += rnd(-1.5, 1.5) }
    if (em.anim === 'girar') ex = s * Math.max(0.12, Math.abs(Math.cos(k / 260))) // vira como moeda (só a largura muda)
    if (em.anim === 'balancar') x += Math.sin(k / 250) * 9
    if (em.anim === 'flutuar') y += Math.sin(k / 380) * 7
    if (em.anim === 'cair' && k > E * 0.5) { const q = (k - E * 0.5) / (E * 0.5); y += q * q * 40; x += q * 10 }
    if (em.anim === 'revelar') { // desenho aparecendo pixel por pixel, como se ele estivesse pintando
      const n = Math.floor(256 * clamp(k / (E * 0.45), 0, 1)), e = 9 * (sai < 1 ? sai : 1)
      for (let i = 0; i < n; i++) { const r = i >> 4, c = i & 15, ch = em.px[r][c]; if (ch === '.' || !PALETA[ch]) continue; g.fillStyle = PALETA[ch]; g.fillRect(x + (c - 8) * e, y + (r - 8) * e, e + 0.4, e + 0.4) }
    } else desenharSprite(em.px, x, y, Math.max(0.5, s), null, 1, ex ?? Math.max(0.5, s))
    // brilhinhos de pixel em volta
    g.fillStyle = '#e8f6ff'
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + k / 700, r = 92 + Math.sin(k / 160 + i) * 6; g.globalAlpha = 0.5 + 0.5 * Math.sin(k / 120 + i * 2); g.fillRect(120 + Math.cos(a) * r - 2, 122 + Math.sin(a) * r - 2, 4, 4) }
    g.globalAlpha = 1
  }

  // ---------------------------------------------------------------- moldura, névoa e o resto
  let decoAlpha = 1
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
  function desenharMoldura(t) {
    if (!tela.moldura.length) return
    decoAlpha = clamp((t - tela.decoT0) / 1200, 0, 1)
    g.save(); g.globalAlpha = decoAlpha
    for (const d of tela.moldura) MOLDURA[d.el]?.(t, d.cores)
    g.restore()
  }
  // Tela embaçada: pontilhado (o C3 só acende alguns pixels, sem transparência). O paninho limpa e ela embaça de novo devagar.
  const limpo = new Uint8Array(80 * 80)
  function desenharNevoa(t) {
    if (tela.limpando) {
      const p = (t - tela.limpando.t0) / 1800
      if (p >= 1) tela.limpando = null
      else tela.limpos.push({ x: 30 + 180 * p, y: 120 + Math.sin(p * Math.PI * 3) * 45, t })
    }
    tela.limpos = tela.limpos.filter((c) => t - c.t < 30000)
    if (tela.nevoa < 0.03) return
    limpo.fill(0)
    for (const c of tela.limpos) {
      const r = 26 * Math.sqrt(1 - (t - c.t) / 30000) / 3, gx = c.x / 3, gy = c.y / 3
      for (let y = Math.max(0, Math.floor(gy - r)); y <= Math.min(79, Math.ceil(gy + r)); y++) for (let x = Math.max(0, Math.floor(gx - r)); x <= Math.min(79, Math.ceil(gx + r)); x++) if ((x - gx) ** 2 + (y - gy) ** 2 <= r * r) limpo[y * 80 + x] = 1
    }
    const lim = tela.nevoa * 11
    g.fillStyle = '#a9bccd'
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if (!limpo[y * 80 + x] && BAYER[(y & 3) * 4 + (x & 3)] < lim) g.fillRect(x * 3, y * 3, 2, 2)
    if (tela.limpando) { const c = tela.limpos[tela.limpos.length - 1]; if (c) desenharSprite(['llll', 'lsll', 'llll'], c.x, c.y, 5) }
  }
  function desenharAcessorios(t, A) {
    for (const nome of ['cachecol', 'nariz', 'lingua', 'oculos', 'gorro', 'touca', 'noel', 'fone', 'chapeu', 'guarda_chuva', 'leque']) {
      if (!tela.vestido[nome]) continue
      const a = ACESS[nome], ent = clamp((t - tela.vestido[nome]) / 400, 0, 1)
      let [x, y] = A(a.x, a.y); y -= (1 - ent) * 30
      if (a.anim === 'abanar') x += Math.sin(t / 90) * 4
      desenharSprite(a.px, x, y, a.e, null, ent)
    }
  }
  function desenharImaginacao(t) {
    if (tela.nuvem) {
      g.fillStyle = '#e8f6ff'
      for (const [x, y, r] of [[200, 82, 3], [209, 70, 5]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill() }
      for (const [x, y, rx, ry] of [[150, 32, 30, 19], [178, 24, 30, 21], [206, 34, 26, 18], [174, 44, 42, 15]]) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill() }
      const ics = tela.nuvem
      if (ics.length) ics.forEach((k, i) => desenharIconePx(k, 178 + (i - (ics.length - 1) / 2) * 25, 33, 1.3))
      else { g.fillStyle = '#5b6b7b'; const n = 1 + Math.floor(t / 400) % 3; for (let i = 0; i < n; i++) g.fillRect(166 + i * 10, 33, 4, 4) }
    }
    if (tela.painel) {
      const { i, n, icones } = tela.painel
      g.fillStyle = '#1b2632'; g.strokeStyle = '#7df9ff'; g.lineWidth = 2
      g.beginPath(); g.roundRect(30, 4, 180, 48, 10); g.fill(); g.stroke()
      icones.forEach((k, j) => desenharIconePx(k, 120 + (j - (icones.length - 1) / 2) * 34, 26, 1.6))
      for (let j = 0; j < n; j++) { g.fillStyle = j <= i ? '#7df9ff' : '#3a4a5a'; g.fillRect(120 - n * 6 + j * 12, 46, 6, 3) }
    }
  }
  function desenharCarneiros(t) {
    if (t > tela.carneirosAte) return
    const k = 7000 - (tela.carneirosAte - t)
    g.fillStyle = '#9aa5b1'; g.fillRect(112, 214, 4, 18); g.fillRect(124, 214, 4, 18); g.fillRect(108, 218, 24, 3) // cerquinha
    for (let i = 0; i < 3; i++) {
      const p = ((k - i * 2100) / 2100); if (p < 0 || p > 1) continue
      desenharSprite(CARNEIRO, 30 + p * 180, 222 - Math.sin(p * Math.PI) * 34, 3)
      if (p > 0.48 && p < 0.52 && tela.balao?.numero !== String(i + 1)) tela.balao = { itens: [], numero: String(i + 1), t0: t, ate: t + 900 }
    }
  }
  function desenharBicho(t, dt) {
    const b = tela.bicho; if (!b) return
    b.x += b.dir * b.vel * dt
    if (b.x < -14 || b.x > 254) b.dir *= -1
    desenharSprite(BICHO, b.x, 228 - Math.abs(Math.sin(t / 110)) * 1.5, 3, b.seco ? { r: 'd' } : null)
  }
  function corFundo() { // fundo liso tingido pelo humor (antes era um degradê)
    const h = tela.humor; if (!h || tela.sono) return '#000'
    const c = h.p > 0.15 ? [255, Math.round(190 - h.p * 60), 90] : h.p < -0.15 ? [110, 120, 255] : [125, 249, 255]
    const k = (0.05 + 0.1 * (h.a + 1) / 2) * 0.5
    return `rgb(${c.map((v) => Math.round(v * k)).join(',')})`
  }
  function estadoGesto(t) {
    if (!gesto) return {}
    const g0 = MOV[gesto.nome], k = (t - gesto.t0) / GESTO_DUR[gesto.nome]
    if (k >= 1) { gesto = null; return {} }
    if (g0.antes) {
      if (k < 0.12) { const a = Math.sin((k / 0.12) * Math.PI / 2); return Object.fromEntries(Object.entries(g0.antes).map(([c, v]) => [c, c === 'sy' || c === 's' ? 1 + (v - 1) * a : v * a])) }
      return g0.f((k - 0.12) / 0.88)
    }
    return g0.f(k)
  }

  // ---------------------------------------------------------------- jogo da velha e copinho de água
  // Tabuleiro no lugar do rosto; os olhinhos espiam por cima.
  function desenharVelha(t, corOlho, fecha) {
    const v = tela.velha, x0 = 36, y0 = 54, L = 56
    const ex = olhar.x * 6, ey = olhar.y * 3, h = Math.max(2, 18 * clamp(cur.open, 0.1, 1.2) * fecha)
    g.fillStyle = corOlho
    for (const cx of [104, 136]) { g.beginPath(); g.roundRect(cx - 7 + ex, 27 - h / 2 + ey, 14, h, 4); g.fill() }
    if (cur.happy > 0.3) { g.fillStyle = corFundo(); for (const cx of [104, 136]) { g.beginPath(); g.ellipse(cx + ex, 27 + h * 0.55 + ey, 11, h * 0.45, 0, 0, Math.PI * 2); g.fill() } }
    g.fillStyle = '#3a4a5a'
    for (let i = 1; i < 3; i++) { g.fillRect(x0 + i * L - 2, y0 + 4, 4, 3 * L - 8); g.fillRect(x0 + 4, y0 + i * L - 2, 3 * L - 8, 4) }
    for (let k = 0; k < 9; k++) {
      const ch = v.c[k]; if (ch === '.') continue
      const cx = x0 + (k % 3) * L + L / 2, cy = y0 + Math.floor(k / 3) * L + L / 2
      const nova = k === v.ultima ? clamp((t - v.t0) / 250, 0, 1) : 1, r = 17 * (0.4 + 0.6 * nova)
      g.lineWidth = 7; g.lineCap = 'round'
      if (ch === 'X') { g.strokeStyle = '#7df9ff'; g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.stroke() }
      else { g.strokeStyle = '#ff7eb6'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke() }
    }
    if (v.linha.length === 3 && Math.floor(t / 300) % 2 === 0) { // linha vencedora piscando
      const c = (k) => [x0 + (k % 3) * L + L / 2, y0 + Math.floor(k / 3) * L + L / 2], a = c(v.linha[0]), b = c(v.linha[2])
      g.strokeStyle = '#ffd166'; g.lineWidth = 6; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke()
    }
  }
  function desenharCopo(t) {
    const c = tela.copo, x = 14, y = 168, w = 30, h = 46
    const enche = clamp((t - c.t0) / 800, 0, 1), nivel = clamp((c.n - 1 + enche) / c.meta, 0, 1)
    g.fillStyle = '#2b6cb0'; g.fillRect(x + 3, y + h - 3 - (h - 6) * nivel, w - 6, (h - 6) * nivel)
    g.strokeStyle = '#d9e2ec'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 3, y + h); g.lineTo(x + w - 3, y + h); g.lineTo(x + w, y); g.stroke()
    texto(`${c.n}/${c.meta}`, x + w / 2, y - 10, 2)
  }

  // ---------------------------------------------------------------- atualização: chuva de letras e barra de progresso
  // Só a fonte 5×7 e cores fixas (três tons de verde): nada de transparência, cabe no C3.
  const COLS = 20, LETRAS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:+-=<>#$%'
  const chuva = Array.from({ length: COLS }, () => ({ y: rnd(-240, 0), vel: rnd(60, 160), letras: Array.from({ length: 18 }, () => LETRAS[Math.floor(Math.random() * LETRAS.length)]) }))
  function desenharMatrix(t, dt) {
    const m = tela.matrix
    g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240)
    for (let c = 0; c < COLS; c++) {
      const col = chuva[c]; col.y += col.vel * dt * (m.fase === 'instalar' ? 1.6 : 1)
      if (col.y > 240 + 18 * 14) { col.y = rnd(-120, 0); col.vel = rnd(60, 160) }
      if (Math.random() < 0.08) col.letras[Math.floor(Math.random() * 18)] = LETRAS[Math.floor(Math.random() * LETRAS.length)]
      for (let k = 0; k < 18; k++) {
        const y = col.y - k * 14; if (y < -10 || y > 250) continue
        texto(col.letras[k], c * 12 + 6, y, 1.6, k === 0 ? '#d9ffe4' : k < 4 ? '#3ddc84' : k < 10 ? '#1f8f4e' : '#0f4d2a')
      }
    }
    // caixa com o que está acontecendo
    const titulo = m.fase === 'instalar' ? (m.pct >= 100 ? 'PRONTO!' : 'INSTALANDO') : 'BAIXANDO'
    g.fillStyle = '#000'; g.fillRect(28, 92, 184, 62); g.strokeStyle = '#3ddc84'; g.lineWidth = 2; g.strokeRect(28, 92, 184, 62)
    texto(`${titulo} ${m.versao}`, 120, 106, 2, '#d9ffe4')
    g.fillStyle = '#0f4d2a'; g.fillRect(40, 122, 160, 12)
    g.fillStyle = '#3ddc84'; for (let x = 0; x < Math.round(160 * m.pct / 100); x += 4) g.fillRect(40 + x, 122, 3, 12) // barra em bloquinhos
    texto(`${Math.round(m.pct)}%`, 120, 144, 1.4, '#3ddc84')
    if (Math.floor(t / 90) % 7 === 0) { g.fillStyle = '#3ddc84'; g.fillRect(0, Math.floor(Math.random() * 240), 240, 1) } // linha de "interferência"
  }

  // ---------------------------------------------------------------- quadro
  function desenharQuadro() {
    const t = now(), dt = Math.min(0.1, (t - tAnterior) / 1000); tAnterior = t
    const nome = tela.expr
    const alvo = Object.assign({}, BASE, EXPR[nome] || {})
    const vel = 1 - Math.exp(-dt * 9)
    for (const k of Object.keys(BASE)) {
      if (k === 'color') cur.color = cur.color.map((c, i) => lerp(c, alvo.color[i], vel))
      else cur[k] = lerp(cur[k], alvo[k], vel)
    }
    const ge = estadoGesto(t)
    const novaForma = alvo.forma || 'normal'
    if (novaForma !== formaAtual) { formaAtual = novaForma; piscar = 1 } // troca de olho escondida numa piscada

    const o = tela.olhar
    if (o.modo === 'fixo') { olhar.tx = o.x; olhar.ty = o.y }
    else if (o.modo === 'rem') { olhar.tx = Math.sin(t / 70) * 0.3 + Math.sin(t / 23) * 0.08; olhar.ty = Math.sin(t / 130) * 0.08 }
    else {
      if (t > olhar.proxSacada) { olhar.proxSacada = t + rnd(1500, 5000) * (o.tedio ? 1.6 : 1); olhar.tx = rnd(-0.8, 0.8) * o.amp; olhar.ty = rnd(-0.4, 0.4) }
      if (o.fixoY !== null) olhar.ty = o.fixoY
    }
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
    const alvoIncl = tela.atento ? 0.22 : nome === 'curioso' ? 0.12 : nome === 'musica' ? Math.sin(t / 400) * 0.04 : 0
    inclinacao = lerp(inclinacao, alvoIncl, vo)

    const fundo = corFundo()
    g = tela.palco ? gF : gTela
    g.fillStyle = fundo; g.fillRect(0, 0, 240, 240)
    let ox = olhar.x * 20 + (ge.ox || 0), oy = olhar.y * 14 + cur.dy - balanco * 9 + (ge.oy || 0)
    if (nome === 'frio' || tela.treme >= 2) ox += rnd(-1, 1) * (0.8 + tela.treme * 0.5) // quanto mais frio, mais treme
    if (nome === 'pesadelo') ox += rnd(-1.2, 1.2)
    if (tela.sono) oy += Math.sin(t / 1200) * 2
    // Cabeça inclinada: giram só os pontos de encaixe; olhos, boca e acessórios continuam retos.
    const ang = inclinacao + (ge.rot || 0), co = Math.cos(ang), si = Math.sin(ang), sx = ge.s || 1, sy = sx * (ge.sy || 1)
    const A = (x, y) => { const dx = (x - 120) * sx, dy = (y - 104) * sy; return [120 + ox + dx * co - dy * si, 104 + oy + dx * si + dy * co] }
    const corOlho = `rgb(${cur.color.map(Math.round).join(',')})`
    const w = 54 * cur.size * sx, h = 66 * cur.size * clamp(cur.open, 0.05, 1.3) * fecha * sy
    const fE = nome === 'olho_sonolento' ? 'fechado' : ge.forma || formaAtual, fD = ge.formaD || ge.forma || formaAtual
    const fv = Math.max(0.08, fecha) * (sy / sx)
    if (tela.velha) desenharVelha(t, corOlho, fecha)
    else {
      const [x1, y1] = A(74, 104), [x2, y2] = A(166, 104)
      desenharOlho(x1, y1, w * (1 + cur.asym), h * (1 + cur.asym), -1, cur, corOlho, fE, t, fv, fundo)
      desenharOlho(x2, y2, w * (1 - cur.asym * 0.6), h * (1 - cur.asym * 0.6), 1, cur, corOlho, fD, t, fv, fundo)
      if (cur.bochecha > 0.05) { // bochechas coradas
        g.fillStyle = `rgba(255,120,170,${0.8 * cur.bochecha})`
        for (const bx of [58, 182]) { const [x, y] = A(bx, 146); g.beginPath(); g.ellipse(x, y, 15 * sx, 7 * sy, 0, 0, Math.PI * 2); g.fill() }
      }
      if (cur.lagrimas > 0.05) { // lágrimas caindo
        g.fillStyle = 'rgb(108,200,255)'
        for (const [bx, fase] of [[64, 0], [176, 0.5]]) {
          const k = ((t / 900) + fase) % 1, [x, y0] = A(bx, 132), y = y0 + k * 50
          g.globalAlpha = cur.lagrimas * (1 - k); g.beginPath(); g.moveTo(x, y - 7); g.quadraticCurveTo(x + 6, y + 3, x, y + 6); g.quadraticCurveTo(x - 6, y + 3, x, y - 7); g.fill()
        }
        g.globalAlpha = 1
      }
      // Boca
      g.strokeStyle = corOlho; g.fillStyle = corOlho; g.lineWidth = 4 * sx; g.lineCap = 'round'
      if (cur.mouthOpen > 0.12) { const [x, y] = A(120, 172); g.beginPath(); g.ellipse(x, y, (9 + cur.mouthOpen * 4) * sx, (3 + cur.mouthOpen * 11) * sy, 0, 0, Math.PI * 2); g.fill() }
      else { const a = A(104, 172), c = A(120, 172 + cur.mouth * 14), b = A(136, 172); g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(c[0], c[1], b[0], b[1]); g.stroke() }
      desenharAcessorios(t, A)
    }

    if (tela.sono) desenharIcone('zzz', t)
    else if (tela.icone) desenharIcone(tela.icone, t)
    else if (nome === 'musica') desenharIcone('nota', t)
    if (tela.balao && t > tela.balao.ate) tela.balao = null
    if (tela.balao) desenharBalao(t)
    desenharImaginacao(t)
    desenharCarneiros(t)
    desenharBicho(t, dt)
    if (tela.sono && tela.sonho) { g.save(); g.globalAlpha = 0.45; tela.sonho.forEach((k, i) => desenharIconePx(k, 170 + i * 20, 84, 1)); g.restore() } // o sonho aparece clarinho perto do Zzz
    if (tela.cor && t < tela.cor.ate) { // Genius: um círculo grande da cor
      const k = clamp((tela.cor.ate - t) / 120, 0, 1)
      g.fillStyle = tela.cor.c; g.beginPath(); g.arc(120, 120, 100 * (0.85 + 0.15 * k), 0, Math.PI * 2); g.fill()
      g.strokeStyle = '#e8f6ff'; g.lineWidth = 3; g.stroke()
    } else tela.cor = null
    if (tela.copo && t < tela.copo.ate) desenharCopo(t)
    else tela.copo = null
    if (tela.palco) { g = gTela; compor(t) }
    desenharNevoa(t)
    desenharMoldura(t)
    if (tela.anel) { // anel de progresso do foco/pausa
      const p = clamp((t - tela.anel.ini) / Math.max(1, tela.anel.fim - tela.anel.ini), 0, 1)
      g.strokeStyle = tela.anel.fase === 'foco' ? '#4a9aa0' : '#2fa866'; g.lineWidth = 2.5
      g.beginPath(); g.arc(120, 120, 115, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); g.stroke()
    }
    const st = tela.status
    if (st.cam) { g.fillStyle = '#ff4d4d'; g.beginPath(); g.arc(14, 14, 4, 0, Math.PI * 2); g.fill() } // câmera ligada
    if (!st.grav && (st.vad || st.verif)) { g.fillStyle = st.verif ? '#ffd666' : '#7df9ff'; g.beginPath(); g.arc(120, 230, 3 + Math.sin(t / 120) * 1, 0, Math.PI * 2); g.fill() }
    if (tela.matrix) desenharMatrix(t, dt)
    if (st.grav) { g.fillStyle = '#ff4d4d'; g.beginPath(); g.arc(30, 228, 4, 0, Math.PI * 2); g.fill(); texto('ouvindo', 40, 228, 2, '#ff4d4d', 'esquerda') }
  }
  function quadro() {
    const a = performance.now()
    if (perf.ultimoQ) perf.fps = media(perf.fps, 1000 / Math.max(1, a - perf.ultimoQ))
    perf.ultimoQ = a
    try { desenharQuadro(); perf.quadro = media(perf.quadro, performance.now() - a) } catch (e) { g = gTela; op.erro?.('quadro', e) } finally { requestAnimationFrame(quadro) }
  }
  return { receber, ligar: () => requestAnimationFrame(quadro), perf, tela }
}
