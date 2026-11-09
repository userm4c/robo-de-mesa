// ================================================================ memória na nuvem
// A mesma memória do robô em todos os aparelhos. Fica num arquivo JSON no repositório privado
// (o mesmo dos logs, com o mesmo token). No robô de verdade, quem guarda é o homelab.
//
// Como funciona:
//  · ao abrir, antes de o robô "acordar", baixa a memória mais nova (se outro aparelho mudou algo);
//  · a cada poucos minutos e ao sair da tela, sobe o que mudou aqui;
//  · se dois aparelhos mudaram ao mesmo tempo, junta: lembranças, sons, figurinhas, truques,
//    músicas, caretas e desenhos dos dois; o resto fica com a versão mais nova;
//  · se forem dois robôs diferentes (um recém-nascido num aparelho novo), vale o mais velho.
// As chaves (Groq, Gemini, token) NÃO vão para a nuvem: cada aparelho usa o link pessoal.

export const CHAVES_MEMORIA = ['pers', 'memorias', 'sons', 'necess', 'humor', 'impReflexao', 'imagHoje', 'terrario', 'usoIA', 'vozes']
const CFG_NUVEM = ['nome', 'dono', 'cidade', 'legenda', 'maosLivres', 'corHumor', 'model', 'stt']
const CAMINHO = 'memoria/robo.json'

const paraB64 = (txt) => { const u8 = new TextEncoder().encode(txt); let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s) }
const deB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)))
const porChave = (a, b, chave) => { const m = new Map(); for (const x of [...(b || []), ...(a || [])]) if (x) m.set(chave(x), x); return [...m.values()] }

export function criarMemoria(op) {
  // op: ler(k, padrão), gravar(k, v), log(txt), acesso() → { token, repo }
  const meta = Object.assign({ base: 0, sujo: false, alterado: 0, disp: Math.random().toString(36).slice(2, 8), ultimo: 0, erro: '', estado: 'nunca' }, op.ler('sync', {}))
  const salvarMeta = () => op.gravar('sync', meta)
  salvarMeta()
  let travado = false, ocupado = false

  function marcar() { if (travado) return; meta.sujo = true; meta.alterado = Date.now(); salvarMeta() }
  function pacote() {
    const dados = {}
    for (const k of CHAVES_MEMORIA) { const v = op.ler(k, undefined); if (v !== undefined) dados[k] = v }
    const c = op.ler('cfg', {}), cfg = {}
    for (const k of CFG_NUVEM) if (c[k] !== undefined) cfg[k] = c[k]
    return { v: 1, t: meta.alterado || Date.now(), disp: meta.disp, dados, cfg }
  }
  function aplicar(pac) {
    for (const [k, v] of Object.entries(pac.dados || {})) op.gravar(k, v)
    op.gravar('cfg', { ...op.ler('cfg', {}), ...(pac.cfg || {}) })
  }
  // Junta campo a campo comparando com a última versão sincronizada ("base"): fica o que cada lado mudou.
  // Se os dois mudaram o mesmo campo: listas e coleções se juntam; o resto fica com o deste aparelho.
  const UNIR = { album: 1, musicas: 1, truques: 1, caretas: 1, desenhos: 1, lembretes: 1, sugestoes: 1, musicasOuvidas: 1 }
  const igual = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  function tresVias(l = {}, r = {}, b = {}, unir) {
    const out = {}
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      if (igual(l[k], b[k])) out[k] = k in r ? r[k] : l[k] // só o outro mudou (ou ninguém)
      else if (igual(r[k], b[k]) || !(k in r)) out[k] = l[k] // só este mudou
      else out[k] = unir?.(k, l[k], r[k]) ?? l[k] // os dois mudaram
    }
    return out
  }
  function mesclar3(local, remoto, base) {
    const unirPers = (k, a, b) => {
      if (!UNIR[k]) return undefined
      const tmp = mesclar({ t: 1, dados: { pers: { [k]: a } }, cfg: {} }, { t: 0, dados: { pers: { [k]: b } }, cfg: {} })
      return tmp.dados.pers[k]
    }
    const dados = tresVias(local.dados, remoto.dados, base.dados, (k, a, b) => {
      if (k === 'pers') return tresVias(a, b, base.dados.pers || {}, unirPers)
      if (k === 'vozes') return { ...b, ...a }
      if (k === 'memorias' || k === 'sons' || k === 'usoIA') return mesclar({ t: 1, dados: { [k]: a }, cfg: {} }, { t: 0, dados: { [k]: b }, cfg: {} }).dados[k]
      return undefined
    })
    return { v: 1, t: Math.max(local.t, remoto.t) + 1, disp: meta.disp, dados, cfg: tresVias(local.cfg, remoto.cfg, base.cfg || {}) }
  }
  // Junta duas memórias sem base (primeira vez neste aparelho). "a" e "b" são pacotes; a base de "pers" é a do robô mais velho
  // (dois robôs diferentes) ou a mais nova (o mesmo robô mudado nos dois aparelhos).
  function mesclar(a, b) {
    const pa = a.dados.pers || {}, pb = b.dados.pers || {}
    const outroRobo = pa.nasceu && pb.nasceu && Math.abs(pa.nasceu - pb.nasceu) > 60000
    const base = outroRobo ? (pa.nasceu <= pb.nasceu ? a : b) : a.t >= b.t ? a : b, outro = base === a ? b : a
    const P = structuredClone(base.dados.pers || {}), Q = outro.dados.pers || {}
    P.album = { ...(Q.album || {}), ...(P.album || {}) }
    P.musicas = { ...(Q.musicas || {}), ...(P.musicas || {}) }
    P.truques = porChave(P.truques, Q.truques, (x) => String(x.palavra).toLowerCase()).slice(-20)
    P.caretas = porChave(P.caretas, Q.caretas, (x) => String(x.nome).toLowerCase()).slice(-12)
    P.desenhos = porChave(P.desenhos, Q.desenhos, (x) => x.t || x.titulo).sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, 30)
    P.lembretes = porChave(P.lembretes, Q.lembretes, (x) => `${x.quando}|${x.texto}`).filter((x) => !x.feito)
    P.sugestoes = porChave(P.sugestoes, Q.sugestoes, (x) => x.id)
    P.musicasOuvidas = porChave(P.musicasOuvidas, Q.musicasOuvidas, (x) => x.titulo).sort((x, y) => y.t - x.t).slice(0, 20)
    const dados = { ...outro.dados, ...base.dados, pers: P }
    dados.memorias = porChave(base.dados.memorias, outro.dados.memorias, (m) => `${m.t}|${m.txt}`).sort((x, y) => y.t - x.t).slice(0, 120)
    dados.sons = porChave(base.dados.sons, outro.dados.sons, (s) => s.id).slice(-12)
    dados.vozes = { ...(outro.dados.vozes || {}), ...(base.dados.vozes || {}) } // palavras gravadas dos dois aparelhos
    const ua = a.dados.usoIA, ub = b.dados.usoIA
    if (ua && ub && ua.dia === ub.dia) { const t = { ...ua.t }; for (const [m, v] of Object.entries(ub.t || {})) t[m] = Math.max(t[m] || 0, v); dados.usoIA = { dia: ua.dia, t } }
    return { v: 1, t: Math.max(a.t, b.t) + 1, disp: meta.disp, dados, cfg: { ...outro.cfg, ...base.cfg } }
  }

  async function gh(metodo, corpo) {
    const { token, repo } = op.acesso()
    if (!token) throw new Error('sem token do GitHub (o mesmo do log)')
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${CAMINHO}`, {
      method: metodo, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token.trim(), Accept: 'application/vnd.github+json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    })
    if (metodo === 'GET' && r.status === 404) return null
    if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 120)}`); e.status = r.status; throw e }
    return r.json()
  }
  async function baixar() {
    const j = await gh('GET'); if (!j) return null
    if (!j.content) throw new Error('memória grande demais para baixar')
    return { sha: j.sha, pac: JSON.parse(deB64(j.content)) }
  }
  async function subir(pac, sha) {
    let txt = JSON.stringify(pac)
    if (txt.length > 900000) { pac = structuredClone(pac); pac.dados.sons = (pac.dados.sons || []).map(({ audio, ...s }) => s); txt = JSON.stringify(pac) } // sem os áudios, se ficar grande
    const j = await gh('PUT', { message: `memória (${meta.disp})`, content: paraB64(txt), ...(sha ? { sha } : {}) })
    meta.base = pac.t; meta.sujo = false; meta.ultimo = Date.now(); salvarMeta(); op.gravar('syncBase', pac)
    return j
  }

  // Devolve 'nada' | 'subiu' | 'baixou' | 'mesclou' | 'criou'. Baixou/mesclou = os dados locais mudaram.
  // aoVivo: o robô está rodando; antes de trocar os dados locais, trava as gravações (vai recarregar).
  async function sincronizar({ aoVivo = false } = {}, tentativa = 0) {
    if (ocupado || travado) return 'nada'
    ocupado = true
    try {
      const r = await baixar()
      let res = 'nada'
      if (!r) { await subir(pacote()); res = 'criou' }
      else {
        const remoto = r.pac, primeira = !meta.base
        const outroMudou = remoto.t > meta.base && remoto.disp !== meta.disp
        if (primeira || (outroMudou && meta.sujo)) {
          const base = !primeira && op.ler('syncBase', null)
          const m = base ? mesclar3(pacote(), remoto, base) : mesclar(pacote(), remoto)
          if (aoVivo) travado = true
          aplicar(m); await subir(m, r.sha); res = 'mesclou'
        } else if (outroMudou) {
          if (aoVivo) travado = true
          aplicar(remoto); meta.base = remoto.t; meta.ultimo = Date.now(); salvarMeta(); op.gravar('syncBase', remoto); res = 'baixou'
        } else if (meta.sujo) { await subir(pacote(), r.sha); res = 'subiu' }
      }
      meta.erro = ''; meta.estado = res === 'nada' ? meta.estado : res; meta.ultimo = Date.now(); salvarMeta()
      if (res !== 'nada') op.log(`Memória na nuvem→ ${{ criou: 'criada', subiu: 'enviada', baixou: 'baixada de outro aparelho', mesclou: 'juntada com a de outro aparelho' }[res]}`)
      return res
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && tentativa < 2) { ocupado = false; return sincronizar({ aoVivo }, tentativa + 1) } // outro aparelho subiu no meio
      meta.erro = e.message; salvarMeta(); op.log('Memória na nuvem: ' + e.message)
      return 'erro'
    } finally { ocupado = false }
  }
  // Ao abrir: espera no máximo alguns segundos (sem internet, o robô acorda com o que tem).
  async function aoAbrir(limiteMs = 6000) {
    if (!op.acesso().token) return 'sem token'
    return Promise.race([sincronizar(), new Promise((r) => setTimeout(() => r('demorou'), limiteMs))])
  }
  return {
    marcar, sincronizar, aoAbrir, meta,
    travar() { travado = true }, // antes de recarregar com a memória nova: nada antigo sobrescreve
    get travado() { return travado },
    texto() {
      if (!op.acesso().token) return 'desligada (precisa do token do log em ⚙️)'
      const min = meta.ultimo ? Math.round((Date.now() - meta.ultimo) / 60000) : null
      return `${meta.erro ? 'erro: ' + meta.erro : meta.estado === 'nunca' ? 'ainda não sincronizou' : `ok (${meta.estado}) há ${min} min`}${meta.sujo ? ' · mudanças para enviar' : ''} · aparelho ${meta.disp}`
    },
  }
}
