"""Generate the application icons from the supplied SVG artwork.

``web/babeldoc-icon.png`` is a Chromium render of the SVG (MuPDF's SVG
conversion loses the gradients and the speech-bubble shadow, producing a black
silhouette), so the ICO can be rebuilt offline without a browser and without
losing quality:

    python tools/make_icon.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "BabelDOC-Studio-app-icon.svg"
PNG = ROOT / "web" / "babeldoc-icon.png"
SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    (ROOT / "web" / "favicon.svg").write_bytes(SVG.read_bytes())
    if not PNG.exists():
        raise SystemExit(f"missing {PNG.name}: render the SVG to a 512 px PNG first")
    image = Image.open(PNG).convert("RGBA")
    image.save(ROOT / "web" / "babeldoc.ico", sizes=SIZES)
    print(f"wrote web/favicon.svg and web/babeldoc.ico ({image.width}px source)")


if __name__ == "__main__":
    main()
