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

Toque no rosto = carinho. Muitos toques seguidos = ele fica bravo.
