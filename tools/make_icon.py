"""Generate the app icon (web/babeldoc.ico) used by the desktop shortcut."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "babeldoc.ico"

S = 1024  # supersampled canvas


def gradient(size: int) -> Image.Image:
    top = (255, 106, 136)
    bottom = (214, 27, 68)
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        t = y / (size - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            # subtle diagonal lightening towards the top-left corner
            k = 1 - 0.10 * ((x / size) * 0.5 + (y / size) * 0.5)
            pixels[x, y] = tuple(max(0, min(255, int(c * k))) for c in color)
    return img


def build() -> Image.Image:
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    canvas.paste(gradient(S), (0, 0), mask)

    draw = ImageDraw.Draw(canvas)

    # page with folded corner
    page = [(320, 250), (560, 250), (700, 390), (700, 780), (320, 780)]
    draw.polygon(page, fill=(255, 255, 255, 255))

    # fold line
    draw.line([(560, 250), (560, 390), (700, 390)], fill=(255, 120, 150, 255), width=10)

    # check mark
    draw.line([(404, 610), (486, 692), (622, 530)], fill=(224, 32, 76, 255), width=44,
              joint="curve")
    for point in ((404, 610), (486, 692), (622, 530)):
        r = 22
        draw.ellipse([point[0] - r, point[1] - r, point[0] + r, point[1] + r],
                     fill=(224, 32, 76, 255))
    return canvas


def main() -> None:
    icon = build()
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icon.resize((256, 256), Image.LANCZOS).save(
        OUT, format="ICO", sizes=sizes
    )
    print("wrote", OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
