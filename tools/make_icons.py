"""Draws the app icons (a mine on an orange tile) as PNGs. No extra libraries needed.
Run:  python tools/make_icons.py"""
import math, os, struct, zlib

BG, BG2 = (228, 87, 46), (196, 62, 28)   # orange gradient
MINE, SHINE = (24, 26, 32), (255, 255, 255)

def draw(size, ss=4):
    S = size * ss
    cx = cy = S / 2
    r = S * 0.20                       # body radius (inside maskable safe zone)
    spike_len, spike_w = S * 0.31, S * 0.045
    px = bytearray()
    for y in range(size):
        px.append(0)                   # PNG filter byte
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    X, Y = x * ss + sx + .5, y * ss + sy + .5
                    t = Y / S
                    col = tuple(int(BG[i] * (1 - t) + BG2[i] * t) for i in range(3))
                    dx, dy = X - cx, Y - cy
                    d = math.hypot(dx, dy)
                    inside = d < r
                    if not inside and d < spike_len:   # 8 spikes
                        for k in range(8):
                            a = k * math.pi / 4
                            along = dx * math.cos(a) + dy * math.sin(a)
                            perp = abs(-dx * math.sin(a) + dy * math.cos(a))
                            if along > 0 and perp < spike_w * (1 - along / spike_len * .35):
                                inside = True; break
                    if inside:
                        col = MINE
                        if math.hypot(X - (cx - r * .38), Y - (cy - r * .38)) < r * .22:
                            col = SHINE
                    for i in range(3): acc[i] += col[i]
            px.extend(int(v / (ss * ss)) for v in acc)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(px), 9)) + chunk(b'IEND', b''))

out = os.path.join(os.path.dirname(__file__), '..', 'icons')
for name, size in [('apple-touch-icon.png', 180), ('icon-192.png', 192), ('icon-512.png', 512)]:
    with open(os.path.join(out, name), 'wb') as f:
        f.write(draw(size, 2 if size > 256 else 4))
    print('wrote', name)
