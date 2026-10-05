"""Application icons, converted from the source artwork.

Source of truth: assets/signal-chain-icon.png (2048x2048 RGBA with alpha).
The JPEGs in assets/ are reference renders only and are never read here.
Outputs (filenames unchanged, so package.json needs no edits):
  assets/icon.png   1024x1024 RGBA, consumed by electron-builder for the AppImage
  assets/icon.ico   multi-size Windows icon (16-256), alpha preserved
  assets/icon.icns  mac icon, so a future mac target needs no new artwork

  npm run icons
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "assets")
SOURCE = os.path.join(OUTDIR, "signal-chain-icon.png")
os.makedirs(OUTDIR, exist_ok=True)

img = Image.open(SOURCE)
if img.mode != "RGBA":
    img = img.convert("RGBA")

# Square source expected; center-crop defensively so a future non-square
# swap still yields a centered icon instead of a stretched one.
w, h = img.size
side = min(w, h)
img = img.crop(((w - side) // 2, (h - side) // 2,
                (w + side) // 2, (h + side) // 2))

icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save(os.path.join(OUTDIR, "icon.png"))

# Windows .ico: multi-size icon, PNG-compressed 256px entry + classic sizes.
icon.save(os.path.join(OUTDIR, "icon.ico"),
          sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

try:
    icon.save(os.path.join(OUTDIR, "icon.icns"))
except Exception as e:
    print(f"warning: could not write icon.icns: {e}")

print("wrote assets/icon.png, assets/icon.ico" + (" and assets/icon.icns" if os.path.exists(os.path.join(OUTDIR, "icon.icns")) else ""))
