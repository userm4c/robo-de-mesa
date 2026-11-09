# Robô de mesa

Robô de mesa com ESP32-S3 (câmera, microfones, som) e ESP32-C3 (rosto, presença, temperatura, servos), com personalidade que evolui.

## Protótipo no celular

Abra https://userm4c.github.io/robo-de-mesa/ no Chrome do Android e toque em "Acordar o robô".

- **Microfone:** ritmo e BPM (o rosto balança na batida), estilo aproximado da música, cantarolar e assobio (os olhos seguem a melodia), susto com barulho alto.
- **Câmera (opcional, 📷):** rosto e expressões rodando no próprio celular (MediaPipe Face Landmarker); os olhos seguem você. Ponto vermelho no rosto = câmera ligada.
- **Espelho:** sorri quando você sorri, se assusta junto com a sua cara de surpresa, às vezes pisca junto. Se você fica sério e calado do lado dele, ele vem ver se está tudo bem.
- **Luz:** pela câmera, percebe quando apagam a luz (à noite dorme, de dia estranha) e acorda quando acende de manhã.
- **Mãos livres:** é só chamar pelo nome e falar; por 15 s depois da resposta dá para continuar sem repetir o nome. Desliga em ⚙️.
- **Tom de voz:** aprende a sua voz normal e percebe quando você está animado ou desanimado; isso muda a reação dele e vai para o Groq.
- **Jogo da melodia (🎶):** ele toca notas, você repete assobiando ou cantarolando; a cada acerto, mais uma nota. Guarda o recorde. Também começa pedindo por voz.
- **Emoções em 3 camadas:** personalidade (muda devagar), humor do dia (sorteado ao acordar), emoção (reação rápida). Entediado, só algo interessante tira ele do tédio.
- **Sons fofos** gerados na hora, nunca iguais. Sem fala.
- **Gestos:** sim, não, talvez, não sei, pulinhos, rir, piscadela, tímido, desconfiado, tonto, suspiro, dancinha, encolher, olhar em volta, desmaiar, surpresa.
- **Olhos especiais:** coração, estrela, espiral, X, fechadinhos de rir; bochechas coradas e lágrimas.
- **Balão:** até 3 ícones (60 opções) ou um número curto (hora, temperatura).
- **Conversa (🎤):** grava até 8 s, transcreve e decide a reação pelo Groq (chave em ⚙️, guardada só no celular). Ele sabe a hora, a temperatura e lembra as últimas falas.
- **Depuração (🐞):** humor, emoção, BPM, tom, personalidade, temperatura e umidade simuladas (SHT40), tráfego da UART S3→C3 (mensagens por segundo, bytes, últimas linhas), campo para mandar uma linha direto à tela, desempenho de cada parte e testes de cada gesto, expressão e ícone.

## Fase 2 (08/11)

- **Conversa fluida:** "Ei", "Olha pra mim", "Você está bem?" deixam ele atento ("será comigo?"); um "Sim" confirma e ele responde a frase original. Na conversa não precisa do nome; ele acena quando você pausa, pergunta de volta e espera.
- **Aprende sons:** guarda a impressão digital do barulho que o assusta; depois de 3 sustos, toca o som (assustando-se consigo mesmo) e pergunta o que é. Com a explicação, perde o medo aos poucos.
- **Imaginação:** devaneios (sozinho ou entediado), sonhos e pesadelos (fase REM, mais prováveis depois de um dia ruim), guardados para contar depois em quadrinhos de ícones.
- **Palco pixelado:** 23 emotes de pixel art original que substituem o rosto, com transições (pixel, TV, zoom, glitch, deslizar, derreter); acessórios (cachecol, gorro, Papai Noel, óculos, leque, guarda-chuva, touca).
- **Corpo térmico:** faixas de frio e calor com respostas variadas, palhaçadas conforme a personalidade (Papai Noel + Jingle Bells, modo verão), tela embaçada com umidade alta.
- **Datas comemorativas:** decora a borda da tela sozinho (Natal, Ano-Novo, Carnaval, Páscoa, Namorados, Festa Junina, Crianças, Halloween, aniversários), pergunta se você gostou, guarda sugestões para a data certa e pesquisa ideias novas (groq/compound).
- **Rituais:** boa noite (touca, bocejo, carneirinhos), "toca aqui", saudade proporcional ao tempo longe; pede atenção em degraus só quando está muito solitário.

## Diversão (v17)

- **Jogos:** charadas de emoji, 20 perguntas, quiz de contas, imita a careta e imita eu (câmera), ritmo de palmas, esconde-esconde (câmera), pedra-papel-tesoura (câmera + reconhecimento de mãos), jogo da melodia.
- **Criatividade:** ele desenha pixel art pedida por voz (aparece pixel por pixel; galeria e desenho do dia), música do dia, segunda voz quando você assobia, dança no ritmo, diário do dia em quadrinhos, notícias em emojis.
- **Rotina:** modo foco (Pomodoro com fone e anel de progresso), lembretes e despertador por voz ("me lembra de… às 18h", "daqui a 20 minutos", soneca com bronca), previsão do tempo (Open-Meteo, sem chave), bom dia completo, cor do humor no fundo.
- **Vida:** bichinho do terrário (sensor simulado por enquanto), presentes surpresa, mêsversário com festa, álbum de 24 figurinhas.

## Música, jogos e vida (v26)

- **Jogo da velha por voz:** você escolhe X ou O e fala o lugar ("centro", "canto superior esquerdo", "meio de baixo", "lado direito" ou "casa 7"). O tabuleiro toma a tela e os olhinhos espiam por cima. Ele erra às vezes (mais quando você anda perdendo); revanche alterna quem começa.
- **Que música é essa?** Ele ouve 9 s (música tocando, cantarolado ou assobio) e o Gemini reconhece. Com música tocando há mais de 20 s, ele tenta sozinho (até 8 vezes por dia).
- **Canta a música que você pedir:** caderninho com músicas de domínio público (Brilha brilha estrelinha, Parabéns, Jingle Bells, Ode à Alegria, Frère Jacques, Noite Feliz, Für Elise). Outras ele tenta "de ouvido" pela IA e, se você corrigir assobiando logo depois, aprende do seu jeito. Também dá para ensinar: cantarole e diga "essa é a música X".
- **No seu ritmo:** repete a sua melodia com as pausas e a duração das notas, faz a segunda voz ou responde com outra frase no mesmo ritmo (duelo). Assobio volta como assobio.
- **Karaokê ao contrário, adivinha o som** (12 sons sintetizados + os barulhos que ele aprendeu; depois você imita e ele adivinha pelo Gemini), **Genius de cores** (fala as cores em ordem) e **história a dois** em quadrinhos (fica guardada no diário).
- **Aprende com você:** truques ("quando eu disser abracadabra, você faz a dancinha"), caretas com nome pela câmera ("aprende essa cara: cara de pastel"; depois "faz a cara de pastel", e ele reconhece quando você faz), palavra do dia.
- **Companhia:** torcedor do seu time ("meu time é o …": agenda do dia, placar ao vivo, comemora gol), pausa depois de 2 h na frente dele, copinho de água ("bebi água", meta de 8), plantas ("me lembra de regar as plantas a cada 3 dias", "reguei"), fica com sono antes de você às 22 h.
- **Personalidade:** hobby que muda a cada 1–2 semanas, uma mania própria, ciúme leve do celular (olhando para baixo por muito tempo), música do humor (feliz = rápida e maior; triste = devagar e menor) e medo do escuro que passa com carinho.

## Palavrinhas e atualização (v29)

- **Fala de verdade, aos pouquinhos** (como os botões de fala de pet, ou o Bumblebee com o rádio):
  - Nasce sabendo "oi" e "eu" e aprende uma palavra por dia, gaguejando no começo ("ca… cari… carinho!"). O seu nome vem primeiro.
  - Você também ensina: "fala carinho", "diz o meu nome", "repete comigo: banana". A palavra do dia também vira palavra falada.
  - Usa as palavras para cumprimentar, chamar atenção, pedir carinho, comemorar e se assustar. A IA pode escolher palavras da lista dele.
  - Fala cada vez mais vezes conforme o vocabulário e os dias de vida. Cada palavra sai numa voz pt-BR diferente do aparelho, com um chiado de rádio antes, e aparece escrita num balão.
  - No robô de verdade, as palavras viram áudios curtos gerados no homelab.
- **Voz de robô feita da sua voz** (v32), do jeito que os designers de som de robôs de cinema fazem:
  - Quando ele aprende uma palavra, pede para você dizer só ela e grava (8 kHz, 8 bits, até 1,6 s, ~10 KB). Também dá para pedir "grava a palavra X" ou usar o painel do 🐞.
  - Ao tocar: mais agudo, "picotado" (degraus de 8 bits), filtro de rádio, zumbido metálico (modulação em anel), tremido e um bipinho no começo e no fim. O humor muda o tom.
  - No 🐞 há controles de tom, robótico e tremido. As gravações vão para a memória na nuvem.
  - Palavra sem gravação usa a voz do sistema.
- **Versão nova:**
  - Ele percebe a versão nova e pede: "Tem uma versão nova pra mim! Posso atualizar?" (sim / depois).
  - Também dá para pedir com "se atualiza".
  - Atualizando, a tela mostra uma chuva de letras verdes com a barra "BAIXANDO" e depois "INSTALANDO".
  - Ao voltar, conta uma a uma as novidades da versão ("Agora eu sei…") e diz que se sente mais esperto e poderoso.
  - Se a tela estiver fora de vista, atualiza sozinho e conta as novidades quando você voltar.

## Memória na nuvem (v28)

A mesma memória do robô em todos os aparelhos. Ela fica em `memoria/robo.json` no repositório privado dos logs e usa o mesmo token do log (⚙️ ou o link pessoal).
- Ao abrir, antes de acordar, ele baixa o que outro aparelho mudou. Durante o uso, sincroniza a cada 3 min e ao sair da tela. Se outro aparelho mudou algo, recarrega sozinho num momento calmo (fora de conversa ou brincadeira).
- Se os dois aparelhos mudaram ao mesmo tempo, junta campo a campo comparando com a última versão sincronizada: lembranças, sons, figurinhas, truques, músicas, caretas e desenhos dos dois; no resto, fica o que cada lado mudou.
- Num aparelho novo, se já existir um robô na nuvem, vale o mais velho (o recém-nascido do aparelho novo vira o Bob-e).
- As chaves do Groq e do Gemini e o token **não** vão para a nuvem.
- Vão para a nuvem: personalidade, memórias, sons aprendidos, necessidades, humor, terrário, cota da IA do dia, e nome, dono, cidade e preferências do ⚙️.
- 🐞 mostra o estado ("Memória nuvem") e tem o botão ☁️ Sincronizar memória.

## Como o código está dividido (v22–v24)

O protótipo já está separado do jeito que o robô de verdade vai ser:

| Arquivo | Vai virar | O que faz |
|---|---|---|
| `robo.js` | firmware do **ESP32-S3** | cérebro: emoções, necessidades, ouvido, câmera, memória, jogos. Não desenha nada. |
| `c3.js` | firmware do **ESP32-C3** | tela 240×240: rosto, gestos, balão, emotes, acessórios, moldura, névoa. Só desenha o que chega pela UART. |
| `servidor.js` | gateway Node no **homelab** | toda a IA: modelos, cotas, cache, prompts, conversa, imaginação, desenho, pesquisa. |
| `memoria.js` | homelab | memória na nuvem: a mesma em todos os aparelhos (hoje no GitHub privado). |
| `comum.js` | tabelas nos dois chips | ícones, cores, emotes, acessórios, expressões, duração dos gestos. |
| `icones.js` | flash do C3 | 159 ícones 16×16 em 4 bits por pixel (≈21 KB), gerados por `ferramentas/gerar_icones.py`. |

**Mensagens S3→C3** (uma linha de texto cada, só quando algo muda): `EXPR`, `OLHAR`, `ATENTO`, `SONO`, `TREME`, `GESTO`, `PISCAR`, `BATIDA`, `ICONE`, `BALAO`, `EMOTE`, `DESENHO`, `ACESS`, `MOLDURA`, `NEVOA`, `LIMPAR`, `HUMOR`, `NUVEM`, `PAINEL`, `SONHO`, `CARNEIROS`, `BICHO`, `ANEL`, `STATUS`, `VELHA`, `COPO`, `COR`, `MATRIX`. **C3→S3:** `TOQUE x y`. Com o rosto parado passa quase nada; conversando, umas 10–15 mensagens e ~130 bytes por segundo (0,1 % de uma UART a 921600 baud). A lista completa está no começo de `receber()` em `c3.js`.

**Regras de desenho para caber no C3:** pixel art e retângulos não giram (inclinar a cabeça gira só os pontos de encaixe dos olhos e da boca); fundo liso tingido pelo humor em vez de degradê; máscaras dos olhos pintadas com a cor do fundo em vez de recortadas; névoa em pontilhado; transições sem girar nem misturar cores; texto numa fonte de pixel 5×7 própria.

## O que dá personalidade a ele

- **Necessidades** (como os *drives* do Kismet, do MIT): companhia, novidade e energia, cada uma com uma faixa boa. Fora dela ele fica incomodado e age: chama atenção, pede música, sente saudade, pede espaço quando é atenção demais, fica tonto com coisa demais, cochila.
- **Vontades próprias** escolhidas por utilidade (nota de cada comportamento conforme necessidades e personalidade, sorteio entre os melhores).
- **Relógio:** dorme de madrugada, acorda de manhã se espreguiçando; acordado de madrugada fica rabugento; coisa pouco interessante só faz ele abrir um olho.
- **Habituação:** a mesma coisa repetida perde a graça e depois volta a ter.
- **Proto-diálogo:** repete a melodia que você assobia ou cantarola e guarda a favorita para cantarolar sozinho; quando você fala, responde com bipes na vez dele.
- **Memória com importância e reflexão diária** (como os Generative Agents, de Stanford): escreve um diário, forma uma opinião sobre você e ajusta a personalidade um pouquinho.
- **Confiança:** cresce com carinho, cai com susto e cutucão.
- **Animação:** olhar com mola e microssacadas; antecipação antes de pular (princípio da Disney).

Toque no rosto = carinho. Muitos toques seguidos = ele fica bravo.

## Créditos

- Ícones em pixel gerados a partir do [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Google, imagens sob Apache 2.0) por `ferramentas/gerar_icones.py`.
