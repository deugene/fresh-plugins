#!/usr/bin/env bash
# Builds the acceptance images (spec, "Test images") in DIR (default
# ~/.cache/iv-live/imgs) and prints DIR. Needs python3 and ffmpeg; PNGs,
# the WebP and the EXIF Orientation=6 tag are written by stdlib Python, so
# the images do not depend on which encoders the ffmpeg build has.
#
#   quadrants.png   400x300: red, green, blue, white quarters, black 2x2 centre mark
#   alpha.png       200x100 RGBA: left half opaque magenta, right half fully transparent
#   small16.png     16x16: pixel (x, y) is (16x, 16y, 128)
#   grey.png        64x48 greyscale (colour type 0) gradient
#   pal.png         64x48 palette (colour type 3), the quadrant colours
#   o6.jpg          a 400x300 JPEG (top red, bottom blue) tagged EXIF Orientation=6: shown 300x400
#   anim.gif        64x48, frame 1 red, frame 2 blue
#   quad.jpg, quad.gif, quad.bmp   quadrants.png in other formats
#   pic.webp        32x32 lossless WebP, solid (255,128,0)
#   animw.webp      32x32 animated WebP, frame 1 (255,128,0), frame 2 blue
#   anim.png        64x48 APNG, frame 1 red, frame 2 blue
#   big.jpg         4000x3000 JPEG (ffmpeg testsrc2)
#   corrupt.png     a text file
#   mis.png, ppm.png   JPEG and PPM data named .png (INV §8 P30)
#   upper/QUADRANTS.PNG, notes.txt, logo.svg
set -euo pipefail
DIR=${1:-$HOME/.cache/iv-live/imgs}
mkdir -p "$DIR/upper"
cd "$DIR"

python3 - <<'PY'
import struct, zlib

def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)

def png(path, w, h, ctype, rows, plte=None):
    raw = b"".join(b"\0" + r for r in rows)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    if plte: out += chunk(b"PLTE", plte)
    out += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(out)

def quad(x, y, w, h):
    if x in (w // 2 - 1, w // 2) and y in (h // 2 - 1, h // 2): return (0, 0, 0)
    if y < h // 2: return (255, 0, 0) if x < w // 2 else (0, 255, 0)
    return (0, 0, 255) if x < w // 2 else (255, 255, 255)

W, H = 400, 300
png("quadrants.png", W, H, 2, [bytes(c for x in range(W) for c in quad(x, y, W, H)) for y in range(H)])
png("alpha.png", 200, 100, 6, [bytes(c for x in range(200) for c in ((255, 0, 255, 255) if x < 100 else (0, 255, 0, 0))) for y in range(100)])
png("small16.png", 16, 16, 2, [bytes(c for x in range(16) for c in (16 * x, 16 * y, 128)) for y in range(16)])
png("grey.png", 64, 48, 0, [bytes(min(255, 4 * x) for x in range(64)) for y in range(48)])
pal = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
png("pal.png", 64, 48, 3, [bytes((0 if x < 32 else 1) if y < 24 else (2 if x < 32 else 3) for x in range(64)) for y in range(48)], pal)
png("o6src.png", 400, 300, 2, [bytes(c for x in range(400) for c in ((255, 0, 0) if y < 150 else (0, 0, 255))) for y in range(300)])

# A lossless (VP8L) WebP of one colour: every prefix code is a one-symbol
# "simple" code, so the pixels take no bits at all.
class Bits:
    def __init__(self): self.v, self.n = 0, 0
    def put(self, value, count): self.v |= value << self.n; self.n += count
    def bytes(self): return self.v.to_bytes((self.n + 7) // 8, "little")

def riff_chunk(t, d):
    return t + struct.pack("<I", len(d)) + d + (b"\0" if len(d) % 2 else b"")

def vp8l(w, h, r, g, b_):
    b = Bits()
    b.put(0x2F, 8); b.put(w - 1, 14); b.put(h - 1, 14); b.put(0, 1); b.put(0, 3)
    b.put(0, 1)  # no transform
    b.put(0, 1)  # no colour cache
    b.put(0, 1)  # no meta prefix codes
    for sym in (g, r, b_, 255, 0):  # green, red, blue, alpha, distance
        b.put(1, 1); b.put(0, 1); b.put(1, 1); b.put(sym, 8)
    return riff_chunk(b"VP8L", b.bytes())

def webp(path, chunks):
    body = b"WEBP" + b"".join(chunks)
    open(path, "wb").write(b"RIFF" + struct.pack("<I", len(body)) + body)

webp("pic.webp", [vp8l(32, 32, 255, 128, 0)])
# Animated: VP8X with the animation flag, ANIM, then one ANMF a frame.
u24 = lambda v: struct.pack("<I", v)[:3]
vp8x = bytes([0x02, 0, 0, 0]) + u24(31) + u24(31)
anim = struct.pack("<IH", 0, 0)
anmf = lambda frame: riff_chunk(b"ANMF", u24(0) + u24(0) + u24(31) + u24(31) + u24(100) + bytes([0]) + frame)
webp("animw.webp", [riff_chunk(b"VP8X", vp8x), riff_chunk(b"ANIM", anim), anmf(vp8l(32, 32, 255, 128, 0)), anmf(vp8l(32, 32, 0, 0, 255))])
PY

ff() { ffmpeg -nostdin -v error -y "$@"; }
ff -i o6src.png -frames:v 1 -q:v 2 o6raw.jpg
ff -i quadrants.png -frames:v 1 -q:v 2 quad.jpg
ff -i quadrants.png -frames:v 1 quad.gif
ff -i quadrants.png -frames:v 1 -c:v bmp quad.bmp
ff -f lavfi -i "color=red:s=64x48:r=10:d=0.2[a];color=blue:s=64x48:r=10:d=0.2[b];[a][b]concat=n=2:v=1:a=0" anim.gif
ff -f lavfi -i "color=red:s=64x48:r=10:d=0.2[a];color=blue:s=64x48:r=10:d=0.2[b];[a][b]concat=n=2:v=1:a=0" -plays 0 -f apng anim.png
ff -f lavfi -i testsrc2=s=4000x3000 -frames:v 1 -q:v 2 big.jpg

# EXIF Orientation=6 as an APP1 segment right after SOI.
python3 - <<'PY'
import struct
d = open("o6raw.jpg", "rb").read()
assert d[:2] == b"\xff\xd8"
ifd = struct.pack("<H", 1) + struct.pack("<HHII", 0x0112, 3, 1, 6) + struct.pack("<I", 0)
tiff = b"II*\0" + struct.pack("<I", 8) + ifd
app1 = b"Exif\0\0" + tiff
open("o6.jpg", "wb").write(d[:2] + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + d[2:])
PY
rm -f o6raw.jpg o6src.png

cp quadrants.png upper/QUADRANTS.PNG
printf 'this is not a png\n' > corrupt.png
cp quad.jpg mis.png
ff -i quadrants.png -frames:v 1 -c:v ppm -f image2 -update 1 ppm.png
printf 'plain text\n' > notes.txt
printf '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n' > logo.svg
pwd
