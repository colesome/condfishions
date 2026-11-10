"""Draw the app icons (no external assets)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG, TEAL, FISH = (11, 22, 32), (95, 179, 201), (232, 240, 244)


def draw(size: int, pad_frac: float = 0.0) -> Image.Image:
    s = 1024
    im = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(im)
    p = int(s * pad_frac)
    k = (s - 2 * p) / s
    X = lambda v: p + v * k  # noqa: E731
    # waves
    for i, y in enumerate((690, 780, 870)):
        pts = []
        for x in range(0, 1025, 16):
            import math
            pts.append((X(x), X(y + 26 * math.sin((x / 1024) * 2 * math.pi * 2 + i))))
        d.line(pts, fill=TEAL if i == 0 else (60, 120, 140), width=int(30 * k))
    # fish body + tail + eye
    d.ellipse([X(250), X(330), X(700), X(560)], fill=FISH)
    d.polygon([(X(690), X(445)), (X(840), X(330)), (X(840), X(560))], fill=FISH)
    d.ellipse([X(330), X(405), X(380), X(455)], fill=BG)
    # hook-ish arc above
    d.arc([X(420), X(150), X(560), X(330)], start=180, end=20, fill=TEAL, width=int(26 * k))
    return im.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
draw(192).save(OUT / "icon-192.png")
draw(512).save(OUT / "icon-512.png")
draw(512, 0.12).save(OUT / "icon-maskable-512.png")
draw(180).save(OUT / "apple-touch-icon.png")
print("icons written to", OUT)
