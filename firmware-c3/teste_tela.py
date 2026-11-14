# Teste da tela no ESP32-C3 (placa 2): cores, texto e o rosto do Bob-e piscando.
import time
from tela import Tela, cor, PRETO, BRANCO, VERMELHO, VERDE, AZUL

t0 = time.ticks_ms()
tela = Tela()
print("tela iniciada em", time.ticks_diff(time.ticks_ms(), t0), "ms")

for nome, c in (("vermelho", VERMELHO), ("verde", VERDE), ("azul", AZUL), ("branco", BRANCO)):
    t = time.ticks_ms()
    tela.preencher(c)
    print(nome, "em", time.ticks_diff(time.ticks_ms(), t), "ms")
    time.sleep(1.5)

tela.preencher(PRETO)
tela.texto("Ola, Bob-e!", 32, 60, BRANCO, PRETO, 2)
tela.texto("cima", 88, 4, cor(255, 200, 0), PRETO, 2)
tela.texto("240x240 ST7789", 8, 210, cor(120, 180, 255), PRETO, 2)
time.sleep(3)

# Rosto: olhos em verde-água, como no protótipo.
OLHO = cor(126, 240, 201)
FUNDO = PRETO


def olhos(abertos=True):
    for x in (62, 138):
        tela.retangulo(x, 70, 40, 70, FUNDO)
        if abertos:
            tela.retangulo_redondo(x, 70, 40, 70, 18, OLHO)
        else:
            tela.retangulo_redondo(x, 102, 40, 8, 4, OLHO)


tela.preencher(FUNDO)
olhos(True)
# sorriso
for i in range(-30, 31):
    y = 172 + int((900 - i * i) ** 0.5 * 0.35)
    tela.retangulo(120 + i, y, 3, 4, OLHO)

for _ in range(6):
    time.sleep(2.2)
    olhos(False)
    time.sleep_ms(140)
    olhos(True)
print("fim do teste")
