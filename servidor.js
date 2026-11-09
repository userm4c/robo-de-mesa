// O "cérebro de fora": tudo que usa IA (Groq e Gemini).
// No robô de verdade, este arquivo roda no homelab (Node.js) e conversa com o ESP32-S3 pela rede:
// o robô manda dados (o que ouviu, como está) e recebe respostas prontas. Aqui ele roda no próprio
// celular, mas já separado: não lê nada do robô diretamente, só o que recebe nos pedidos.
// As chaves, as cotas, o cache e o histórico da conversa ficam deste lado.

export function criarServidor(cfg, op) {
  const log = op.log, ler = op.ler, guardar = op.guardar
  const L = () => op.listas() // listas de nomes do robô (gestos, emoções, ícones, emotes, cores, elementos)

  // ---------------------------------------------------------------- estado do servidor
  let modelosGroq = [], modelosGemini = []
  const esfriando = {}, esfriandoDia = {}, formatoOk = {}
  let conversa = [] // últimas falas desta sessão (o servidor guarda o assunto)
  const COTA_DIA = { 'openai/gpt-oss-120b': 200000, 'openai/gpt-oss-20b': 200000, 'llama-3.3-70b-versatile': 100000, 'llama-3.1-8b-instant': 500000 }
  const MODELOS_BONS = [/gpt-oss-120b/i, /kimi-k2/i, /llama-4-maverick/i, /llama-3\.3-70b/i, /gpt-oss-20b/i]
  const modeloBom = (id) => MODELOS_BONS.some((re) => re.test(id))
  let uso = ler('usoIA', { dia: '', t: {} })
  const hojeSv = () => new Date().toLocaleDateString('sv')
  function anotarUso(modelo, tokens) { if (uso.dia !== hojeSv()) uso = { dia: hojeSv(), t: {} }; uso.t[modelo] = (uso.t[modelo] || 0) + (tokens || 1); guardar('usoIA', uso) }
  const usado = (m) => (uso.dia === hojeSv() ? uso.t[m] || 0 : 0)
  const curto = (m) => String(m).replace(/^gemini:/, '✦').split('/').pop()
  const json = (txt) => JSON.parse((String(txt || '').match(/\{[\s\S]*\}/) || ['{}'])[0])

  // ---------------------------------------------------------------- transporte
  async function groq(path, opts = {}) {
    const r = await fetch('https://api.groq.com/openai/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + cfg.key, ...(opts.headers || {}) } })
    if (r.status === 401 && !opts.jaTrocou) { // chave recusada: o robô decide se há uma reserva
      if (op.chaveRecusada?.(cfg.key)) return groq(path, { ...opts, jaTrocou: true })
    }
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 420)}`)
    return r.json()
  }
  function motores(tarefa) {
    const g = (re) => modelosGroq.find((i) => re.test(i))
    const gem = (re) => (cfg.geminiKey ? modelosGemini.find((i) => re.test(i)) : null)
    const lista = tarefa === 'conversa'
      ? [g(/gpt-oss-120b/), g(/kimi-k2/), g(/llama-3\.3-70b/), gem(/flash(?!.*lite)/), g(/gpt-oss-20b/), gem(/flash.*lite/), g(/qwen3/), g(/llama-3\.1-8b/)]
      : [g(/gpt-oss-20b/), gem(/flash.*lite/), g(/qwen3/), g(/llama-3\.1-8b/), usado('openai/gpt-oss-120b') < 120000 ? g(/gpt-oss-120b/) : null]
    const livres = [...new Set(lista.filter(Boolean))].filter((m) => !(esfriando[m] > Date.now()) && !(COTA_DIA[m] && usado(m) > COTA_DIA[m] * 0.97))
    return livres.length ? livres : modelosGroq.length || modelosGemini.length ? [] : [cfg.model]
  }
  function esfriar(modelo, msg) {
    let seg = 60
    const m = /try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(msg), rd = /"retryDelay":\s*"(\d+)s"/.exec(msg), dia = /per ?day|PerDay|TPD|RPD/i.test(msg)
    if (m) seg = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + +m[3]
    else if (rd) seg = +rd[1]
    if (dia) seg = Math.max(seg, modelo.startsWith('gemini:') ? 3 * 3600 : 600)
    esfriando[modelo] = Date.now() + seg * 1000 + 500
    if (dia) esfriandoDia[modelo] = esfriando[modelo]
    return { seg, dia }
  }
  async function pedirGroqModelo(modelo, messages, nome, extra) {
    const gpt = /gpt-oss/i.test(modelo)
    const base = { model: modelo, temperature: 0.5, max_completion_tokens: 1400, messages, ...extra, ...(gpt ? { reasoning_effort: 'low' } : {}), ...(/qwen/i.test(modelo) ? { reasoning_format: 'hidden' } : {}) }
    const formatos = [{ type: 'json_object' }, null]
    const chave = modelo + nome
    let erro
    for (let i = formatoOk[chave] ?? 0; i < formatos.length; i++) {
      try {
        const r = await groq('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formatos[i] ? { ...base, response_format: formatos[i] } : base) })
        formatoOk[chave] = i
        return r
      } catch (e) {
        erro = e
        if (!/Groq 400/.test(e.message) || i === formatos.length - 1) throw e
        log(`IA: formato ${formatos[i]?.type} recusado por ${curto(modelo)}: ${e.message.slice(0, 260)}`)
      }
    }
    throw erro
  }
  async function pedirGemini(modelo, messages, extra, ferramentas) {
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const contents = []
    for (const m of messages.filter((x) => x.role !== 'system')) {
      const role = m.role === 'assistant' ? 'model' : 'user', ult = contents[contents.length - 1]
      if (ult && ult.role === role) ult.parts[0].text += '\n' + m.content; else contents.push({ role, parts: [{ text: m.content }] })
    }
    if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(começo da conversa)' }] })
    const corpo = { contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}), ...(ferramentas ? { tools: ferramentas } : { generationConfig: { responseMimeType: 'application/json', temperature: extra.temperature ?? 0.6, maxOutputTokens: 2048 } }) }
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey }, body: JSON.stringify(corpo) })
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).replace(/\s+/g, ' ').slice(0, 420)}`)
    const j = await r.json()
    const txt = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('')
    if (!txt) throw new Error(`Gemini: resposta vazia (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || '?'})`)
    return { choices: [{ message: { content: txt } }], usage: { total_tokens: j.usageMetadata?.totalTokenCount } }
  }
  async function pedirJSON(messages, nome, extra = {}, tarefa = 'conversa') {
    const fila = motores(tarefa)
    if (!fila.length) throw new Error('IA 429: todos os modelos estão no limite agora')
    let erro
    for (let k = 0; k < fila.length; k++) {
      const modelo = fila[k]
      try {
        const r = modelo.startsWith('gemini:') ? await pedirGemini(modelo.slice(7), messages, extra) : await pedirGroqModelo(modelo, messages, nome, extra)
        r.modelo = modelo; anotarUso(modelo, r.usage?.total_tokens)
        return r
      } catch (e) {
        erro = e
        if (/ 401/.test(e.message)) throw e
        if (/ 429| 503|RESOURCE_EXHAUSTED|quota/i.test(e.message)) { const { seg, dia } = esfriar(modelo, e.message); log(`IA: limite ${dia ? 'do dia' : 'por minuto'} do ${curto(modelo)} (volta em ${seg > 3600 ? Math.round(seg / 3600) + ' h' : Math.ceil(seg) + ' s'})${fila[k + 1] ? '; usando ' + curto(fila[k + 1]) : ''}`) }
        else log(`IA: ${curto(modelo)} falhou (${e.message.slice(0, 160)})${fila[k + 1] ? '; usando ' + curto(fila[k + 1]) : ''}`)
      }
    }
    throw erro
  }
  // Pesquisa na web: modelo do Groq com busca (compound) ou Gemini com busca do Google.
  const podePesquisar = () => modelosGroq.some((i) => /compound/i.test(i)) || !!(cfg.geminiKey && modelosGemini.length)
  async function pesquisarNaWeb(pedido) {
    const compound = modelosGroq.find((i) => /^groq\/compound$/i.test(i)) || modelosGroq.find((i) => /compound/i.test(i))
    if (compound) { const r = await groq('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: compound, messages: [{ role: 'user', content: pedido }], max_completion_tokens: 1800 }) }); return String(r.choices[0].message.content) }
    const gem = cfg.geminiKey && (modelosGemini.find((m) => /flash(?!.*lite)/.test(m)) || modelosGemini[0])
    if (gem) return (await pedirGemini(gem.slice(7), [{ role: 'user', content: pedido }], {}, [{ google_search: {} }])).choices[0].message.content
    return null
  }

  // ---------------------------------------------------------------- modelos e cota
  let erroGemini = ''
  async function conferirGemini() {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': cfg.geminiKey } })
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 160)}`)
      const { models = [] } = await r.json()
      const versao = (n) => +((/(\d+(?:\.\d+)?)/.exec(n) || [0, 0])[1])
      modelosGemini = models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name) && !/image|tts|audio|live|embed|thinking|exp|preview/i.test(m.name))
        .map((m) => 'gemini:' + m.name.replace(/^models\//, '')).sort((a, b) => versao(b) - versao(a))
      erroGemini = ''
      log(`Gemini disponível: ${modelosGemini.map(curto).slice(0, 4).join(', ') || 'nenhum modelo flash'}`)
    } catch (e) { erroGemini = e.message; log('Gemini: ' + e.message) }
  }
  async function conferirModelos() {
    if (!cfg.key) return
    try {
      const { data } = await groq('/models')
      const ids = data.map((m) => m.id)
      modelosGroq = ids
      if (cfg.geminiKey) conferirGemini()
      log(`Modelos bons disponíveis: ${MODELOS_BONS.map((re) => ids.find((i) => re.test(i))).filter(Boolean).join(', ') || 'nenhum'}`)
      if (ids.includes(cfg.model) && modeloBom(cfg.model)) return log(`Modelo de conversa: ${cfg.model}`)
      const melhor = MODELOS_BONS.map((re) => ids.find((i) => re.test(i))).find(Boolean)
      if (!melhor) return
      log(`Troquei o modelo de conversa: ${cfg.model} → ${melhor}`)
      cfg.model = melhor; guardar('cfg', cfg)
    } catch (e) { log('Modelos: ' + e.message) }
  }
  async function listarModelos() { // para o menu de ⚙️
    const { data } = await groq('/models')
    const todos = data.map((m) => m.id).filter((id) => !/whisper|guard|tts|orpheus|playai|distil/i.test(id))
    return { ids: todos.filter(modeloBom).length ? MODELOS_BONS.flatMap((re) => todos.filter((i) => re.test(i))) : todos.sort(), stts: data.map((m) => m.id).filter((id) => /whisper/i.test(id)) }
  }
  // Fôlego: quanto ainda resta de "cabeça" no dia (o principal pesa mais).
  const PESO_IA = [[/gpt-oss-120b|kimi-k2/, 1], [/llama-3\.3-70b/, 0.7], [/gpt-oss-20b/, 0.6], [/flash.*lite/, 0.5], [/gemini.*flash/, 0.3], [/qwen3|llama-3\.1-8b/, 0.4]]
  const pesoIA = (m) => (PESO_IA.find(([re]) => re.test(m)) || [0, 0.3])[1]
  function folego() {
    if (!cfg.key || (!modelosGroq.length && !modelosGemini.length)) return 1
    const g = (re) => modelosGroq.find((i) => re.test(i)), gem = (re) => (cfg.geminiKey ? modelosGemini.find((i) => re.test(i)) : null)
    const todos = [...new Set([g(/gpt-oss-120b/), g(/kimi-k2/), g(/llama-3\.3-70b/), gem(/flash(?!.*lite)/), g(/gpt-oss-20b/), gem(/flash.*lite/), g(/qwen3/), g(/llama-3\.1-8b/)].filter(Boolean))]
    let cap = 0, max = 0
    for (const m of todos) {
      const peso = pesoIA(m); max += peso
      if (esfriandoDia[m] > Date.now()) continue
      cap += peso * (COTA_DIA[m] ? Math.min(1, Math.max(0, 1 - usado(m) / COTA_DIA[m])) : 1)
    }
    return max ? cap / max : 1
  }
  function voltaDaIA() {
    const t = Math.min(...Object.values(esfriandoDia).filter((x) => x > Date.now()), Infinity)
    if (!isFinite(t)) return ''
    const min = Math.ceil((t - Date.now()) / 60000)
    return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}min`
  }
  const cotaTexto = () => Object.entries(uso.dia === hojeSv() ? uso.t : {}).map(([m, n]) => `${curto(m)} ${m === 'local' ? n : COTA_DIA[m] ? Math.round(n / 1000) + 'k/' + COTA_DIA[m] / 1000 + 'k' : n}`).join(' · ') + Object.keys(esfriando).filter((m) => esfriando[m] > Date.now()).map((m) => ` · ${curto(m)} esfriando`).join('')
  function esgotarParaTeste(ms) { for (const m of [...modelosGroq, ...modelosGemini]) esfriando[m] = esfriandoDia[m] = Date.now() + ms }
  function liberarTeste() { for (const k of Object.keys(esfriandoDia)) { delete esfriandoDia[k]; delete esfriando[k] } }

  // ---------------------------------------------------------------- fala → texto
  async function transcrever(blob) {
    const fd = new FormData()
    fd.append('file', blob, 'fala.' + (blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm'))
    fd.append('model', cfg.stt); fd.append('language', 'pt'); fd.append('response_format', 'json')
    fd.append('prompt', `${cfg.nome}.`) // só o nome (para acertar a grafia); dica longa vira texto inventado quando o som é ruim
    const { text } = await groq('/audio/transcriptions', { method: 'POST', body: fd })
    return (text || '').trim()
  }

  // ---------------------------------------------------------------- conversa
  // Parte fixa (regras, listas, exemplos e histórico) primeiro: o Groq guarda em cache e esses
  // tokens não contam no limite. O que muda a cada fala (a "situação") vem no fim, vinda do robô.
  let fixo = { chave: '', txt: '', ex: null }
  function promptFixo() {
    const chave = cfg.nome + '|' + cfg.dono
    if (fixo.chave === chave) return fixo.txt
    const l = L()
    fixo = { chave, ex: null, txt: `Você é ${cfg.nome}, um robozinho de mesa com personalidade própria, que mora na mesa de ${cfg.dono}.
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
- Brincadeiras e rotina (ações): "charada" (charadas de emoji), "vinte_perguntas", "quiz" (contas), "careta" (imita a careta), "imita_eu", "ritmo" (palmas), "esconde" (esconde-esconde), "ppt" (pedra, papel e tesoura), "desenhar" (preencha "tema" com o que desenhar), "dancar", "diario" (resumo do dia em quadrinhos), "noticias", "foco" (modo foco/Pomodoro), "parar_foco", "tempo" (previsão do tempo), "album" (álbum de figurinhas). Lembretes e despertador: preencha "lembrete" com {"quando": "HH:MM" ou "+N" (minutos), "texto": "o que lembrar"}.
- Outras ações: "cochilar" (pediu para você descansar ou tirar um cochilo), "cantar" (pediu para você cantar ou cantarolar uma música; NÃO é o jogo), "repetir_som" (${cfg.dono} quer ouvir o barulho que te assustou), "contar_historia" (quer saber o que você imaginou ou sonhou), "boa_noite" (disse boa noite ou mandou você dormir), "toca_aqui" (bater na mão), "devanear" (pediu para você imaginar algo), "decorar" (pediu para decorar a tela).
Use SÓ estes nomes (qualquer outro é ignorado):
GESTOS: ${l.gestos.join(', ')}, nenhum
EMOÇÕES: ${l.emocoes.join(', ')}
ÍCONES: ${l.icones.join(', ')}
EMOTES: ${l.emotes.join(', ')}
Responda SÓ com JSON: {"gesto": "...", "emocao": "...", "intensidade": 0 a 1, "icones": [até 3 da lista, ou vazio], "numero": "" ou curto, "pensamento": "o que você quis dizer, numa frase curta em português", "afeto": número de -0.05 a 0.05, "lembrar": "frase curta se valer guardar na memória, senão vazio", "importancia": 1 a 10 (1 = banal, 10 = marcante), "acao": "" ou uma das ações, "emote": "" ou um emote, "espera_resposta": true/false, "som_significado": "", "opiniao_deco": "", "sugestao": {"data": "", "ideia": "", "elementos": [], "cores": []}, "aniversario_dono": "", "tema": "", "lembrete": {"quando": "", "texto": ""}}` }
    return fixo.txt
  }
  function exemplos() {
    promptFixo()
    if (fixo.ex) return fixo.ex
    const ex = (u, a) => [{ role: 'user', content: `${cfg.dono} disse: "${u}"` }, { role: 'assistant', content: JSON.stringify(a) }]
    fixo.ex = [
      ...ex('Você gosta de música?', { gesto: 'sim', emocao: 'empolgado', intensidade: 0.8, icones: ['musica', 'coracao'], numero: '', pensamento: 'Amo! Ainda mais quando é animada.', afeto: 0.01, lembrar: '', importancia: 1 }),
      ...ex('Que horas são?', { gesto: 'nenhum', emocao: 'contente', intensidade: 0.4, icones: ['relogio'], numero: '{hora}', pensamento: 'Mostrei a hora.', afeto: 0, lembrar: '', importancia: 1 }),
      ...ex('Hoje eu tive um dia horrível no trabalho', { gesto: 'suspiro', emocao: 'triste', intensidade: 0.7, icones: ['trabalho', 'coracao_partido', 'abraco'], numero: '', pensamento: 'Poxa... queria te dar um abraço.', afeto: 0.03, lembrar: 'Will teve um dia ruim no trabalho', importancia: 6 }),
      ...ex('O que você imaginou hoje?', { gesto: 'pulinhos', emocao: 'empolgado', intensidade: 0.7, icones: ['ideia', 'livro'], numero: '', pensamento: 'Imaginei uma coisa! Olha só.', afeto: 0.01, lembrar: '', importancia: 1, acao: 'contar_historia' }),
      ...ex('Que barulho foi esse que te assustou?', { gesto: 'nao_sei', emocao: 'medo', intensidade: 0.6, icones: ['olhos', 'pergunta'], numero: '', pensamento: 'Esse aqui, ó… você sabe o que é?', afeto: 0, lembrar: '', importancia: 2, acao: 'repetir_som', espera_resposta: true }),
    ].map((m) => ({ ...m, content: m.content.replaceAll('Will', cfg.dono) }))
    return fixo.ex
  }
  // O robô manda o que ouviu e a "situação" (texto montado com o estado dele); o servidor devolve a reação.
  async function conversar(texto, situacao, tarefa = 'conversa') {
    conversa.push({ role: 'user', content: `${cfg.dono} disse: "${texto}"` })
    const hist = conversa.slice(-8)
    const r = await pedirJSON([{ role: 'system', content: promptFixo() }, ...exemplos(), ...hist.slice(0, -1), { role: 'system', content: situacao }, hist[hist.length - 1]], 'reacao', {}, tarefa)
    const bruto = r.choices[0].message.content
    const j = json(bruto)
    registrarResposta(j)
    return { j, bruto, modelo: r.modelo, usage: r.usage }
  }
  function registrarResposta(j) { conversa.push({ role: 'assistant', content: JSON.stringify({ gesto: j.gesto, emocao: j.emocao, icones: j.icones, pensamento: j.pensamento }) }); conversa = conversa.slice(-8) }
  function registrarTroca(texto, j) { conversa.push({ role: 'user', content: `${cfg.dono} disse: "${texto}"` }); registrarResposta(j) } // resposta local do robô

  // ---------------------------------------------------------------- imaginação, reflexão, desenho, jogos e pesquisa
  async function imaginar(d) {
    const l = L()
    const tom = d.tipo === 'diario' ? `um RESUMO DE VERDADE do dia de hoje com ${cfg.dono}, em quadrinhos: use só os acontecimentos e lembranças de hoje, sem inventar nada.`
      : d.tipo === 'pesadelo' ? 'um PESADELO de robô: assustador mas bobinho (ex.: ficar sem bateria, um aspirador gigante, perder o Wi-Fi, um barulho no escuro). Nunca violento ou cruel.'
        : d.tipo === 'sonho' ? 'um SONHO: uma mistura estranha e criativa das coisas que aconteceram hoje, como os sonhos de verdade.'
          : 'um DEVANEIO acordado: uma historinha que ele imagina por conta própria, divertida ou de aventura.'
    const sys = `Você é a imaginação de ${cfg.nome}, um robozinho de mesa com personalidade própria que mora com ${cfg.dono}. Crie ${tom}
Conte em 3 ou 4 quadrinhos; cada quadrinho tem 1 a 3 ícones (da lista) e a emoção dele naquele momento. Use as lembranças e os acontecimentos como inspiração.
Personalidade: ${d.personalidade}. Gostos: ${d.gostos || 'ainda descobrindo'}.
Época: ${d.epoca}.
Tema para inspirar desta vez: ${d.tema} (misture com o seu dia, do seu jeito).
NÃO repita estas histórias, invente outra bem diferente: ${d.titulosAnteriores.join('; ') || 'nenhuma ainda'}.
Acontecimentos de hoje: ${d.acontecimentos.join('; ') || 'nada demais'}.
Lembranças:
${d.lembrancas.map((m) => '- ' + m).join('\n') || '- quase nada ainda'}
ÍCONES: ${l.icones.join(', ')}
EMOÇÕES: ${l.emocoes.join(', ')}
Responda SÓ com JSON: {"titulo": "curto", "quadros": [{"icones": [...], "emocao": "..."}], "resumo": "a história em 1 ou 2 frases, em primeira pessoa, em português", "tom": "doce|engracado|estranho|aventura|assustador"}`
    const r = await pedirJSON([{ role: 'system', content: sys }, { role: 'user', content: 'Crie agora, em JSON.' }], 'historia', { temperature: 0.95 }, 'fundo')
    return json(r.choices[0].message.content)
  }
  async function refletir(d) {
    const sys = `Você é ${cfg.nome}, um robozinho de mesa que mora com ${cfg.dono}. Você não fala, mas pensa. Agora é hora de refletir sobre suas lembranças e escrever no seu diário, em português, em primeira pessoa, com o seu jeito.
Personalidade atual (0 a 1): ${d.personalidade}.
Gostos: ${d.gostos}.
Opinião anterior sobre ${cfg.dono}: ${d.opiniao || 'nenhuma ainda'}.
Lembranças:
${d.lembrancas.join('\n') || '- quase nada ainda'}
Responda SÓ com JSON: {"reflexoes": [1 a 3 frases curtas do diário, conclusões sobre você e sobre ${cfg.dono}], "opiniao": "o que você acha de ${cfg.dono} agora, numa frase", "ajustes": {"extroversao": -0.03 a 0.03, "curiosidade": -0.03 a 0.03, "energia": -0.03 a 0.03, "sensibilidade": -0.03 a 0.03}}
Mude pouco e só com motivo nas lembranças. Personalidade muda devagar.`
    const r = await pedirJSON([{ role: 'system', content: sys }, { role: 'user', content: 'Escreva o diário agora, em JSON.' }], 'reflexao', { temperature: 0.7 }, 'fundo')
    return json(r.choices[0].message.content)
  }
  async function desenhar(tema) {
    const sys = `Você faz pixel art 16x16 para a tela de um robozinho. Desenhe: ${tema}.
Use SÓ estas letras de cor: ${Object.entries(L().cores).map(([k, v]) => `${k}=${v}`).join(', ')}; e "." para o fundo transparente.
Dicas: formas grandes e simples que ocupem quase toda a grade, contorno com "k", olhos de 1 ou 2 pixels, poucas cores. Exemplo (um coração):
["................","..kkkk....kkkk..",".krrrrk..krrrrk.","krrwrrrkkrrrrrrk","krwrrrrrrrrrrrrk","krrrrrrrrrrrrrrk","krrrrrrrrrrrrrrk",".krrrrrrrrrrrrk.","..krrrrrrrrrrk..","...krrrrrrrrk...","....krrrrrrk....",".....krrrrk.....","......krrk......",".......kk.......","................","................"]
Responda SÓ JSON: {"titulo": "nome curto", "linhas": [exatamente 16 textos, cada um com exatamente 16 caracteres]}`
    const r = await pedirJSON([{ role: 'system', content: sys }, { role: 'user', content: 'Desenhe agora.' }], 'desenho', { temperature: 0.8 }, 'conversa')
    return json(r.choices[0].message.content)
  }
  async function vinte(segredo, pergunta) {
    const r = await pedirJSON([{ role: 'system', content: `Jogo de 20 perguntas. A coisa secreta é "${segredo}". Responda à pergunta de sim ou não sobre ela com honestidade, sem revelar o que é. Se a pessoa disser exatamente a coisa (ou um sinônimo), responda "acertou". Responda SÓ JSON: {"resposta": "sim" | "nao" | "talvez" | "acertou"}` }, { role: 'user', content: pergunta }], 'vinte', { temperature: 0.1 }, 'fundo')
    return String(json(r.choices[0].message.content).resposta || 'talvez')
  }
  async function pesquisarIdeia(d) {
    const pedido = `Um robozinho de mesa decora a borda da tela (pixel art, 240x240) para ${d.ocasiao || 'uma ocasião especial'}. A ideia de ${cfg.dono} foi: "${d.ideia}".
Pesquise o que precisar (cores, símbolos da ideia) e traduza para os elementos que ele sabe desenhar: ${L().elementos.join(', ')}.
Cores possíveis (letra=cor): ${Object.entries(L().cores).map(([k, v]) => `${k}=${v}`).join(', ')}.
Responda SÓ com JSON: {"elementos": [1 a 3 da lista], "cores": [até 4 letras], "nota": "o que você descobriu, numa frase curta em português"}`
    const txt = podePesquisar() ? await pesquisarNaWeb(pedido) : (await pedirJSON([{ role: 'user', content: pedido }], 'pesquisa', {}, 'conversa')).choices[0].message.content
    return json(txt)
  }
  async function noticias() {
    const pedido = `Pesquise as 3 notícias mais importantes de hoje (${new Date().toLocaleDateString('pt-BR')}) no Brasil. Prefira assuntos leves ou úteis; evite violência e tragédias.
Para cada uma escolha 1 a 3 ícones desta lista: ${L().icones.join(', ')}; e escreva uma frase curta em português (até 14 palavras).
Responda SÓ JSON: {"noticias": [{"icones": [...], "frase": "..."}]}`
    return json(await pesquisarNaWeb(pedido))
  }

  return {
    curto, conferirModelos, conferirGemini, listarModelos, modelos: () => ({ groq: modelosGroq, gemini: modelosGemini }), erroGemini: () => erroGemini,
    transcrever, conversar, registrarTroca, anotarUso,
    imaginar, refletir, desenhar, vinte, pesquisarIdeia, noticias, podePesquisar,
    folego, voltaDaIA, cotaTexto, esgotarParaTeste, liberarTeste,
  }
}
