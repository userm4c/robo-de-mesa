# Teste geral da tela ST7789 240x240, pixel a pixel. Cada etapa mostra o nome antes.
import time
import struct
from tela import Tela, cor, PRETO, BRANCO, VERMELHO, VERDE, AZUL

t = Tela()
W, H = t.w, t.h


def etapa(n, nome, seg=1.2):
    print("%2d. %s" % (n, nome))
    t.preencher(PRETO)
    t.texto("%d." % n, 8, 100, cor(255, 200, 0), PRETO, 3)
    t.texto(nome, 8, 130, BRANCO, PRETO, 2)
    time.sleep(seg)


def linhas_alternadas(a, b):
    """Linha a linha, alternando duas linhas prontas (não cabe o quadro inteiro na RAM)."""
    t._janela(0, 0, W - 1, H - 1)
    for y in range(H):
        t.spi.write(a if y % 2 == 0 else b)


# 1. Cores sólidas: procurar pixel morto (sempre preto) ou preso (sempre aceso).
etapa(1, "pixels mortos")
for nome, c in (("branco", BRANCO), ("preto", PRETO), ("vermelho", VERMELHO),
                ("verde", VERDE), ("azul", AZUL), ("cinza", cor(128, 128, 128))):
    print("    ", nome)
    t.preencher(c)
    time.sleep(4)

# 2. Bordas: a linha de 1 pixel em volta tem de aparecer inteira (sem corte nem deslocamento).
etapa(2, "bordas")
t.preencher(PRETO)
t.retangulo(0, 0, W, 1, VERMELHO)        # topo
t.retangulo(0, H - 1, W, 1, VERDE)       # baixo
t.retangulo(0, 0, 1, H, AZUL)            # esquerda
t.retangulo(W - 1, 0, 1, H, BRANCO)      # direita
for x, y in ((0, 0), (W - 6, 0), (0, H - 6), (W - 6, H - 6)):
    t.retangulo(x, y, 6, 6, cor(255, 200, 0))
t.texto("topo: vermelho", 32, 70, VERMELHO, PRETO, 1)
t.texto("baixo: verde", 32, 90, VERDE, PRETO, 1)
t.texto("esquerda: azul", 32, 110, AZUL, PRETO, 1)
t.texto("direita: branco", 32, 130, BRANCO, PRETO, 1)
time.sleep(6)

# 3. Grade de 20 em 20 pixels: linhas retas e espaçamento igual.
etapa(3, "grade")
t.preencher(PRETO)
for i in range(0, W, 20):
    t.retangulo(i, 0, 1, H, cor(90, 90, 90))
    t.retangulo(0, i, W, 1, cor(90, 90, 90))
t.retangulo(W // 2, 0, 1, H, VERMELHO)
t.retangulo(0, H // 2, W, 1, VERMELHO)
time.sleep(5)

# 4. Xadrez de 1 pixel: cada pixel vizinho alterna. Deve parecer cinza liso, sem listras.
etapa(4, "xadrez 1px")
bw = struct.pack(">HH", BRANCO, PRETO) * (W // 2)
wb = struct.pack(">HH", PRETO, BRANCO) * (W // 2)
linhas_alternadas(bw, wb)
time.sleep(5)

# 5. Listras de 1 pixel, verticais e horizontais.
etapa(5, "listras 1px")
linhas_alternadas(bw, bw)                 # verticais
time.sleep(3)
linhas_alternadas(struct.pack(">H", BRANCO) * W, struct.pack(">H", PRETO) * W)  # horizontais
time.sleep(3)

# 6. Degradês: 4 faixas (vermelho, verde, azul, cinza). Devem ser suaves, sem degraus grandes.
etapa(6, "degrades")
faixa = H // 4
for i, (r, g, b) in enumerate(((1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 1))):
    linha = b"".join(struct.pack(">H", cor(r * v, g * v, b * v))
                     for v in (x * 255 // (W - 1) for x in range(W)))
    t._janela(0, i * faixa, W - 1, (i + 1) * faixa - 1)
    for _ in range(faixa):
        t.spi.write(linha)
time.sleep(6)

# 7. Varredura: uma linha branca percorre a tela, para achar fileira ou coluna morta.
etapa(7, "varredura")
t.preencher(PRETO)
for y in range(H):
    t.retangulo(0, y, W, 1, BRANCO)
    time.sleep_ms(8)
    t.retangulo(0, y, W, 1, PRETO)
for x in range(W):
    t.retangulo(x, 0, 1, H, BRANCO)
    time.sleep_ms(8)
    t.retangulo(x, 0, 1, H, PRETO)

# 8. Pixel a pixel: acende os 57.600 pixels um por um, em sequência.
etapa(8, "pixel a pixel")
t.preencher(PRETO)
t0 = time.ticks_ms()
px = struct.pack(">H", cor(126, 240, 201))
for y in range(H):
    for x in range(W):
        t._janela(x, y, x, y)
        t.spi.write(px)
print("    57600 pixels em %d ms" % time.ticks_diff(time.ticks_ms(), t0))
time.sleep(3)

# 9. Velocidade: quadros cheios por segundo.
etapa(9, "velocidade")
t0 = time.ticks_ms()
for i in range(20):
    t.preencher(VERMELHO if i % 2 else AZUL)
ms = time.ticks_diff(time.ticks_ms(), t0)
print("    20 quadros em %d ms = %.1f quadros/s" % (ms, 20000 / ms))

t.preencher(PRETO)
t.texto("fim do teste", 24, 112, VERDE, PRETO, 2)
print("fim do teste")
