// Tabelas que o S3 (cérebro) e o C3 (tela) compartilham. No hardware, cada lado leva só a parte que usa:
// o S3 precisa dos nomes (para validar o que a IA pede); o C3 precisa dos desenhos e das cores.

// Ícones do balão: nome → emoji (o emoji é a chave do atlas de pixel em icones.js).
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

// Pixel art original, escrita como texto: cada letra é uma cor. No C3 vira um vetor RGB565 na flash.
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
  fone: { x: 120, y: 66, e: 9, px: ['........kkkkkkkk........', '.....kkkqqqqqqqqkkk.....', '....kqq..........qqk....', '...kq..............qk...', '..kq................qk..', '..kq................qk..', '.kq..................qk.', 'kkkk................kkkk', 'krrk................krrk', 'krrk................krrk', 'krrk................krrk', 'kkkk................kkkk'] },
  chapeu: { x: 168, y: 22, e: 4, px: ['....y....', '....p....', '...ppp...', '...pyp...', '..ppppp..', '..pbppp..', '.ppppypp.', '.ppppppp.', 'pppbppppp', 'ppppppypp', 'yyyyyyyyy'] },
  guarda_chuva: { x: 120, y: 22, e: 11, px: ['......kkkk......', '....kkbbbbkk....', '..kkbbbbbbbbkk..', '.kbbbbbbbbbbbbk.', 'kbbbbbbbbbbbbbbk', 'kkkkkkkkkkkkkkkk'] },
}

const ELEMENTOS = ['arvore', 'luzes', 'neve', 'bandeirinhas', 'confete', 'serpentina', 'fogos', 'aboboras', 'fantasmas', 'coracoes', 'baloes', 'estrelas', 'fogueira', 'ovos', 'flores']

// Expressões: o C3 interpola de uma para outra; o S3 só manda o nome.
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

// Duração de cada gesto em ms (o C3 anima; o S3 só precisa saber quando acaba).
const GESTO_DUR = { sim: 900, nao: 1000, talvez: 1400, nao_sei: 1600, pulinhos: 1200, rir: 1500, piscadela: 800, timido: 2500, desconfiado: 2600, tonto: 2000, suspiro: 1500, dancinha: 3000, encolher: 1500, olhar_em_volta: 2400, desmaiar: 2600, surpresa: 700, espreguicar: 2200, tremer: 1500, aceno: 520, bocejo: 2000 }
// Jeitos de o rosto sair e voltar num emote (sem girar a tela: o C3 não aguenta girar 240×240).
const SAIDAS = ['pixel', 'tv', 'zoom', 'glitch', 'deslizar']

export { ICONES, PALETA, NOME_COR, EMOTES, ACESS, ELEMENTOS, BASE, EXPR, GESTO_DUR, SAIDAS }
