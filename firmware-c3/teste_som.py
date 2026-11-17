# Teste do som: MAX98357A (I2S) + alto-falante 40 mm na placa 2 do ESP32-C3.
#   LRC → GPIO7, BCLK → GPIO6, DIN → GPIO5. GAIN e SD soltos (9 dB, mono).
# Gera as ondas por período (uma volta da onda, repetida): calcular amostra a amostra
# em Python não daria conta de 16 000 por segundo.
import math
import struct
import time
from machine import I2S, Pin

TAXA = 16000
VOL = 0.15  # começa baixo; 1.0 = volume máximo do amplificador

i2s = I2S(0, sck=Pin(6), ws=Pin(7), sd=Pin(5), mode=I2S.TX, bits=16,
          format=I2S.MONO, rate=TAXA, ibuf=8000)

try:  # mostra a etapa na tela, se ela estiver ligada
    from tela import Tela, cor, PRETO
    tela = Tela()
    tela.preencher(PRETO)
except Exception as e:
    print("sem tela:", e)
    tela = None


def etapa(texto):
    print(texto)
    if tela:
        tela.preencher(PRETO)
        tela.texto(texto[:14], 8, 112, cor(126, 240, 201), PRETO, 2)


def periodo(freq, forma="seno", vol=VOL):
    n = max(2, round(TAXA / freq))
    a = int(32767 * vol)
    buf = bytearray(2 * n)
    for i in range(n):
        if forma == "seno":
            v = int(a * math.sin(2 * math.pi * i / n))
        elif forma == "quadrada":  # mais "robô"; mais alta, por isso 60 %
            v = int(a * 0.6) if i < n // 2 else -int(a * 0.6)
        else:  # triangular
            f = i / n
            v = int(a * (4 * f - 1 if f < 0.5 else 3 - 4 * f))
        struct.pack_into("<h", buf, 2 * i, v)
    return bytes(buf)


SILENCIO = bytes(2 * 256)


def tocar(freq, ms, forma="seno", vol=VOL):
    amostras = TAXA * ms // 1000
    if freq <= 0:
        for _ in range(max(1, amostras // 256)):
            i2s.write(SILENCIO)
        return
    p = periodo(freq, forma, vol)
    n = len(p) // 2
    voltas = max(1, amostras // n)
    bloco = p * max(1, min(voltas, 512 // n + 1))  # bytes * int funciona; bytearray * int não
    feitas = 0
    por_bloco = len(bloco) // len(p)
    while feitas + por_bloco <= voltas:
        i2s.write(bloco)
        feitas += por_bloco
    for _ in range(voltas - feitas):
        i2s.write(p)


# 1. Bipe
etapa("1. bipe 440 Hz")
tocar(440, 600)
tocar(0, 600)

# 2. Varredura do grave ao agudo: escute se chia ou vibra em alguma faixa
etapa("2. grave>agudo")
f, fim, passos = 100, 6000, 70
k = (fim / f) ** (1 / passos)
for _ in range(passos):
    tocar(f, 60)
    f *= k
tocar(0, 500)

# 3. Melodiazinha (arpejo de dó maior, sobe e desce)
etapa("3. melodia")
for nota, ms in ((523, 180), (659, 180), (784, 180), (1047, 360), (784, 180), (659, 180), (523, 400)):
    tocar(nota, ms, "triangular")
    tocar(0, 25)
tocar(0, 500)

# 4. Sons de robô: frases rápidas de bipes e deslizes (a "voz" do Bob-e)
etapa("4. sons do Bob-e")
# "oi!": sobe rápido
for fr in range(700, 2600, 120):
    tocar(fr, 14, "quadrada")
tocar(0, 120)
# conversa: bipes curtos variados
for fr, ms in ((1800, 60), (2400, 40), (1500, 70), (2900, 35), (2100, 90)):
    tocar(fr, ms, "quadrada")
    tocar(0, 30)
tocar(0, 200)
# curioso: trinado
for _ in range(8):
    tocar(1600, 30, "quadrada")
    tocar(2300, 30, "quadrada")
tocar(0, 200)
# triste: desce devagar
for fr in range(1400, 380, -40):
    tocar(fr, 22, "seno", VOL * 1.3)
tocar(0, 300)
# feliz: dois "piu" subindo
for _ in range(2):
    for fr in range(1200, 3000, 150):
        tocar(fr, 10, "quadrada")
    tocar(0, 90)

tocar(0, 300)
i2s.deinit()
etapa("fim do teste")
print("fim do teste")
