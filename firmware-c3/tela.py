# Driver mínimo da tela ST7789 240×240 (1,54", módulo "1.54TFT-SPI-ST7789 Ver 1.1").
# MicroPython. Cores em RGB565, enviadas em big-endian (o que a ST7789 espera).
import time
import struct
import framebuf
from machine import Pin, SPI


def cor(r, g, b):
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


PRETO, BRANCO = 0x0000, 0xFFFF
VERMELHO, VERDE, AZUL = cor(255, 0, 0), cor(0, 255, 0), cor(0, 0, 255)


class Tela:
    def __init__(self, sck=4, mosi=3, dc=1, rst=0, largura=240, altura=240, baud=40_000_000):
        # Com o CS ligado direto no GND, a ST7789 só aceita o SPI modo 3 (polarity=1, phase=1).
        self.spi = SPI(1, baudrate=baud, polarity=1, phase=1, sck=Pin(sck), mosi=Pin(mosi))
        self.dc = Pin(dc, Pin.OUT, value=1)
        self.rst = Pin(rst, Pin.OUT, value=1)
        self.w, self.h = largura, altura
        self.iniciar()

    def _cmd(self, c, dados=None):
        self.dc.value(0)
        self.spi.write(bytes([c]))
        if dados:
            self.dc.value(1)
            self.spi.write(dados)

    def iniciar(self):
        self.rst.value(0); time.sleep_ms(20)
        self.rst.value(1); time.sleep_ms(150)
        self._cmd(0x01); time.sleep_ms(150)      # reset por software
        self._cmd(0x11); time.sleep_ms(120)      # sai do modo de sono
        self._cmd(0x3A, b"\x55")                 # 16 bits por pixel (RGB565)
        self._cmd(0x36, b"\x00")                 # orientação
        self._cmd(0x21)                          # inverte cores (painel IPS)
        self._cmd(0x13)                          # modo normal
        self._cmd(0x29); time.sleep_ms(20)       # liga o visor

    def _janela(self, x0, y0, x1, y1):
        self._cmd(0x2A, struct.pack(">HH", x0, x1))
        self._cmd(0x2B, struct.pack(">HH", y0, y1))
        self.dc.value(0)
        self.spi.write(b"\x2C")
        self.dc.value(1)

    def retangulo(self, x, y, w, h, c):
        x, y = max(0, x), max(0, y)
        w, h = min(w, self.w - x), min(h, self.h - y)
        if w <= 0 or h <= 0:
            return
        self._janela(x, y, x + w - 1, y + h - 1)
        linha = struct.pack(">H", c) * w
        bloco = linha * max(1, min(h, 2048 // w))
        n = len(bloco) // (2 * w)
        feitas = 0
        while feitas + n <= h:
            self.spi.write(bloco)
            feitas += n
        for _ in range(h - feitas):
            self.spi.write(linha)

    def preencher(self, c):
        self.retangulo(0, 0, self.w, self.h, c)

    def retangulo_redondo(self, x, y, w, h, raio, c):
        raio = min(raio, w // 2, h // 2)
        self.retangulo(x, y + raio, w, h - 2 * raio, c)
        for i in range(raio):
            d = raio - i - 0.5
            recuo = raio - int((raio * raio - d * d) ** 0.5)
            self.retangulo(x + recuo, y + i, w - 2 * recuo, 1, c)
            self.retangulo(x + recuo, y + h - 1 - i, w - 2 * recuo, 1, c)

    def texto(self, s, x, y, c=BRANCO, fundo=PRETO, escala=2):
        """Fonte 8×8 do MicroPython, ampliada."""
        mono = framebuf.FrameBuffer(bytearray(len(s) * 8), len(s) * 8, 8, framebuf.MONO_HLSB)
        mono.text(s, 0, 0, 1)
        w, h = len(s) * 8 * escala, 8 * escala
        on, off = struct.pack(">H", c), struct.pack(">H", fundo)
        buf = bytearray()
        for py in range(8):
            linha = bytearray()
            for px in range(len(s) * 8):
                linha += (on if mono.pixel(px, py) else off) * escala
            buf += bytes(linha) * escala  # bytearray * int não existe no MicroPython
        self._janela(x, y, x + w - 1, y + h - 1)
        self.spi.write(buf)
