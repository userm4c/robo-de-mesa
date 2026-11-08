# Robô de mesa

Robô de mesa com ESP32-S3 (câmera, microfones, som) e ESP32-C3 (rosto, presença, temperatura, servos), com personalidade que evolui.

## Protótipo no celular

Abra https://userm4c.github.io/robo-de-mesa/ no Chrome do Android e toque em "Acordar o robô".

- **Microfone:** ritmo e BPM (o rosto balança na batida), estilo aproximado da música, cantarolar e assobio (os olhos seguem a melodia), susto com barulho alto.
- **Câmera (opcional, 📷):** detector de rosto rodando no próprio celular; os olhos seguem você. Ponto vermelho no rosto = câmera ligada.
- **Emoções em 3 camadas:** personalidade (muda devagar), humor do dia (sorteado ao acordar), emoção (reação rápida). Entediado, só algo interessante tira ele do tédio.
- **Sons fofos** gerados na hora, nunca iguais. Sem fala.
- **Gestos:** sim, não, talvez, não sei, pulinhos, rir, piscadela, tímido, desconfiado, tonto, suspiro, dancinha, encolher, olhar em volta, desmaiar, surpresa.
- **Olhos especiais:** coração, estrela, espiral, X, fechadinhos de rir; bochechas coradas e lágrimas.
- **Balão:** até 3 ícones (60 opções) ou um número curto (hora, temperatura).
- **Conversa (🎤):** grava até 8 s, transcreve e decide a reação pelo Groq (chave em ⚙️, guardada só no celular). Ele sabe a hora, a temperatura e lembra as últimas falas.
- **Depuração (🐞):** humor, emoção, BPM, tom, personalidade, temperatura e umidade simuladas (SHT40) o log das mensagens S3→C3 e testes de cada gesto, expressão e ícone.

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
