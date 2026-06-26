"""Generate notification icon PNGs from icons/popup-alert.png (high-res source)."""
import pathlib

from PIL import Image

root = pathlib.Path(__file__).resolve().parent
src = root / "icons" / "popup-alert.png"
if not src.is_file():
    raise SystemExit("missing icons/popup-alert.png")

img = Image.open(src).convert("RGBA")

sizes = {
    "icon-alert128.png": 128,
    "icon-notification256.png": 256,
}

icons_dir = root / "icons"
for name, size in sizes.items():
    out = icons_dir / name
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(out, format="PNG", optimize=True)
    print("ok", out.name, size, out.stat().st_size, "bytes")
