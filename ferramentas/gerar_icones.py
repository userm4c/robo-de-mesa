"""Gera icones.js: todos os emojis usados no robô viram pixel art 16x16 com até 15 cores (4 bits por pixel).

É o mesmo formato que o ESP32-C3 vai guardar na flash: paleta própria de cada ícone (RGB565) + 16 linhas
de 16 dígitos hexadecimais (0 = transparente). Uns 160 bytes por ícone.

Fonte das imagens: Noto Emoji (Google), imagens sob a licença Apache 2.0.
Uso: python ferramentas/gerar_icones.py   (precisa de internet e do Pillow)
"""
import io, json, os, re, sys, urllib.request
from PIL import Image

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
CACHE = os.path.join(AQUI, 'cache_noto')
URL = 'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/72/emoji_u{}.png'
os.makedirs(CACHE, exist_ok=True)

# Lê todos os .js do robô (menos o próprio atlas).
src = ''.join(open(os.path.join(RAIZ, f), encoding='utf-8').read() for f in sorted(os.listdir(RAIZ)) if f.endswith('.js') and f != 'icones.js')

# Todos os emojis que aparecem em textos do código (grafemas com pictogramas).
padrao = re.compile(r'(?:[\U0001F1E6-\U0001F1FF]{2})|(?:[☀-➿⬀-⯿\U0001F000-\U0001FAFF⌚-⌛⏩-⏺](?:️)?(?:‍[☀-➿\U0001F000-\U0001FAFF♀♂](?:️)?)*)')
emojis = []
for m in padrao.finditer(src):
    e = m.group(0)
    if e not in emojis:
        emojis.append(e)
# Alguns caracteres que aparecem no código mas não são ícones de balão (setas de log etc.).
IGNORAR = {'→', '✦', '♪', '✕'}
emojis = [e for e in emojis if e not in IGNORAR]


def nome_arquivo(e):
    cps = [f'{ord(c):x}' for c in e if ord(c) != 0xFE0F]
    return '_'.join(cps)


def bandeira_brasil():
    from PIL import ImageDraw
    img = Image.new('RGBA', (72, 72), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((2, 14, 69, 57), fill=(0, 156, 59, 255))
    d.polygon([(36, 18), (65, 36), (36, 54), (7, 36)], fill=(255, 223, 0, 255))
    d.ellipse((24, 24, 48, 48), fill=(0, 39, 118, 255))
    d.arc((22, 30, 54, 50), 200, 330, fill=(255, 255, 255, 255), width=3)
    return img


def baixar(e):
    if e == '🇧🇷':
        return bandeira_brasil()  # o Noto 2D não tem bandeiras
    nome = nome_arquivo(e)
    caminho = os.path.join(CACHE, nome + '.png')
    if not os.path.exists(caminho):
        try:
            dados = urllib.request.urlopen(URL.format(nome), timeout=20).read()
        except Exception:
            # sequências com ZWJ às vezes só existem com o FE0F; tenta a versão simples (primeiro caractere)
            try:
                dados = urllib.request.urlopen(URL.format(f'{ord(e[0]):x}'), timeout=20).read()
            except Exception as erro:
                print('  sem imagem para', e, nome, erro)
                return None
        open(caminho, 'wb').write(dados)
    return Image.open(caminho).convert('RGBA')


def rgb565(r, g, b):
    return f'{((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3):04x}'


def pixelizar(img):
    # Reduz para 16x16 (com área, para não perder traços finos) e corta a transparência.
    peq = img.resize((16, 16), Image.Resampling.BOX)
    alfa = [a for (_, _, _, a) in (peq.get_flattened_data() if hasattr(peq, 'get_flattened_data') else peq.getdata())]
    rgb = Image.new('RGB', (16, 16), (0, 0, 0))
    rgb.paste(peq, mask=peq.split()[3])
    q = rgb.quantize(colors=15, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[:15 * 3]
    idx = list(q.get_flattened_data() if hasattr(q, 'get_flattened_data') else q.getdata())
    usados = sorted({idx[i] for i in range(256) if alfa[i] >= 110})
    mapa = {old: n + 1 for n, old in enumerate(usados)}  # 0 = transparente
    linhas = []
    for y in range(16):
        linha = ''
        for x in range(16):
            i = y * 16 + x
            linha += '0' if alfa[i] < 110 else f'{mapa[idx[i]]:x}'
        linhas.append(linha)
    paleta = [rgb565(pal[o * 3], pal[o * 3 + 1], pal[o * 3 + 2]) for o in usados]
    return {'p': paleta, 'l': linhas}


atlas, faltando = {}, []
for e in emojis:
    img = baixar(e)
    if img is None:
        faltando.append(e)
        continue
    atlas[e] = pixelizar(img)

saida = os.path.join(RAIZ, 'icones.js')
with open(saida, 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Gerado por ferramentas/gerar_icones.py. Não editar à mão.\n')
    f.write('// Pixel art 16x16 dos ícones (até 15 cores, 4 bits por pixel, paleta RGB565). Imagens: Noto Emoji (Apache 2.0).\n')
    f.write('export const ICONES_PX = ' + json.dumps(atlas, ensure_ascii=False, separators=(',', ':')) + '\n')

# Prancha para conferir o resultado (não vai para o site).
cols = 16
linhas_folha = (len(atlas) + cols - 1) // cols
folha = Image.new('RGB', (cols * 40, linhas_folha * 40), (0, 0, 0))
for n, (e, d) in enumerate(atlas.items()):
    ic = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    for y, l in enumerate(d['l']):
        for x, ch in enumerate(l):
            if ch != '0':
                v = int(d['p'][int(ch, 16) - 1], 16)
                ic.putpixel((x, y), (((v >> 11) & 31) << 3, ((v >> 5) & 63) << 2, (v & 31) << 3, 255))
    folha.paste(ic.resize((32, 32), Image.Resampling.NEAREST), ((n % cols) * 40 + 4, (n // cols) * 40 + 4), ic.resize((32, 32), Image.Resampling.NEAREST))
folha.save(os.path.join(AQUI, 'prancha_icones.png'))
bytes_c3 = sum(128 + 2 * len(d['p']) for d in atlas.values())
print(f'{len(atlas)} ícones gerados · ~{bytes_c3 / 1024:.1f} KB no formato do C3 · faltando: {"".join(faltando) or "nenhum"}')
