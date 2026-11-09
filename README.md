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
- **Depuração (🐞):** humor, emoção, BPM, tom, personalidade, temperatura e umidade simuladas (SHT40) o log das mensagens S3→C3 e testes de cada gesto, expressão e ícone.

## Fase 2 (08/11)

- **Conversa fluida:** "Ei", "Olha pra mim", "Você está bem?" deixam ele atento ("será comigo?"); um "Sim" confirma e ele responde a frase original. Na conversa não precisa do nome; ele acena quando você pausa, pergunta de volta e espera.
- **Aprende sons:** guarda a impressão digital do barulho que o assusta; depois de 3 sustos, toca o som (assustando-se consigo mesmo) e pergunta o que é. Com a explicação, perde o medo aos poucos.
- **Imaginação:** devaneios (sozinho ou entediado), sonhos e pesadelos (fase REM, mais prováveis depois de um dia ruim), guardados para contar depois em quadrinhos de ícones.
- **Palco pixelado:** 23 emotes de pixel art original que substituem o rosto, com transições (pixel, TV, giro, glitch, deslizar, derreter); acessórios (cachecol, gorro, Papai Noel, óculos, leque, guarda-chuva, touca).
- **Corpo térmico:** faixas de frio e calor com respostas variadas, palhaçadas conforme a personalidade (Papai Noel + Jingle Bells, modo verão), tela embaçada com umidade alta.
- **Datas comemorativas:** decora a borda da tela sozinho (Natal, Ano-Novo, Carnaval, Páscoa, Namorados, Festa Junina, Crianças, Halloween, aniversários), pergunta se você gostou, guarda sugestões para a data certa e pesquisa ideias novas (groq/compound).
- **Rituais:** boa noite (touca, bocejo, carneirinhos), "toca aqui", saudade proporcional ao tempo longe; pede atenção em degraus só quando está muito solitário.

## Diversão (v17)

- **Jogos:** charadas de emoji, 20 perguntas, quiz de contas, imita a careta e imita eu (câmera), ritmo de palmas, esconde-esconde (câmera), pedra-papel-tesoura (câmera + reconhecimento de mãos), jogo da melodia.
- **Criatividade:** ele desenha pixel art pedida por voz (aparece pixel por pixel; galeria e desenho do dia), música do dia, segunda voz quando você assobia, dança no ritmo, diário do dia em quadrinhos, notícias em emojis.
- **Rotina:** modo foco (Pomodoro com fone e anel de progresso), lembretes e despertador por voz ("me lembra de… às 18h", "daqui a 20 minutos", soneca com bronca), previsão do tempo (Open-Meteo, sem chave), bom dia completo, cor do humor no fundo.
- **Vida:** bichinho do terrário (sensor simulado por enquanto), presentes surpresa, mêsversário com festa, álbum de 24 figurinhas.

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
