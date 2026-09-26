import math
import os
from PIL import Image, ImageDraw

SIZE = 1024
OUTDIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(OUTDIR, exist_ok=True)

# Rack-unit faceplate look matching renderer/styles.css warm-on-charcoal theme.
BG = (23, 24, 26, 255)        # --bg-deep #17181A
RAIL = (38, 40, 43, 255)      # --panel-raised #26282B
LINE = (52, 55, 58, 255)      # --line #34373A
BRASS = (201, 154, 68, 255)   # --accent-brass #C99A44
BRASS_DIM = (120, 92, 42, 255)
CREAM = (236, 233, 226, 255)  # --text-primary #ECE9E2

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

MARGIN = 56
ROUND = 140
# Faceplate
d.rounded_rectangle([MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], radius=ROUND, fill=BG)
d.rounded_rectangle([MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], radius=ROUND, outline=LINE, width=10)
# Top / bottom rack rails
d.rounded_rectangle([MARGIN + 18, MARGIN + 26, SIZE - MARGIN - 18, MARGIN + 108], radius=24, fill=RAIL)
d.rounded_rectangle([MARGIN + 18, SIZE - MARGIN - 108, SIZE - MARGIN - 18, SIZE - MARGIN - 26], radius=24, fill=RAIL)
# Rail screws
for cx in (MARGIN + 64, SIZE - MARGIN - 64):
    for cy in (MARGIN + 67, SIZE - MARGIN - 67):
        d.ellipse([cx - 15, cy - 15, cx + 15, cy + 15], fill=(12, 13, 14, 255), outline=LINE, width=4)
        d.line([cx - 7, cy, cx + 7, cy], fill=LINE, width=3)

# Signal chain: brass knob circles wired left to right across the plate.
cx0, cx1 = 210, SIZE - 210
cy = SIZE // 2
n = 4
step = (cx1 - cx0) / (n - 1)
R_OUT, R_IN = 96, 62
# Wire first so knobs sit on top of it.
d.line([cx0, cy, cx1, cy], fill=BRASS_DIM, width=22)
for i in range(n):
    cx = cx0 + step * i
    d.ellipse([cx - R_OUT, cy - R_OUT, cx + R_OUT, cy + R_OUT], fill=RAIL, outline=BRASS, width=14)
    d.ellipse([cx - R_IN, cy - R_IN, cx + R_IN, cy + R_IN], fill=BG, outline=LINE, width=6)
# Brass pointer on the middle-right knob (a knob set to ~1 o'clock).
px = cx0 + step * 2
ang = math.radians(-50)
x1 = px + R_IN * 0.28 * math.cos(ang)
y1 = cy + R_IN * 0.28 * math.sin(ang)
x2 = px + (R_IN - 14) * math.cos(ang)
y2 = cy + (R_IN - 14) * math.sin(ang)
d.line([x1, y1, x2, y2], fill=BRASS, width=20)
# LED above the middle knob.
led_cx = cx0 + step * 1
led_cy = cy - R_OUT - 78
d.ellipse([led_cx - 24, led_cy - 24, led_cx + 24, led_cy + 24], fill=BRASS)
d.ellipse([led_cx - 24, led_cy - 24, led_cx + 24, led_cy + 24], outline=CREAM, width=5)

# Small cream label bar under the chain.
d.rounded_rectangle([cx0 - 60, cy + R_OUT + 56, cx1 + 60, cy + R_OUT + 118], radius=18, fill=CREAM)

img.save(os.path.join(OUTDIR, "icon.png"))

# Windows .ico: multi-size icon, PNG-compressed 256px entry + classic sizes.
img.save(os.path.join(OUTDIR, "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# Linux: electron-builder consumes icon.png directly for the AppImage; also
# ship an .icns so a future mac target needs no new artwork.
try:
    img.save(os.path.join(OUTDIR, "icon.icns"))
except Exception as e:
    print(f"warning: could not write icon.icns: {e}")

print("wrote assets/icon.png, assets/icon.ico" + (" and assets/icon.icns" if os.path.exists(os.path.join(OUTDIR, "icon.icns")) else ""))
