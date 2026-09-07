"""Regenerate the PWA icons for the phone day view.

NOT a build step -- the app never runs this and ships fine without it, exactly
like static/vendor/textures/generate.py. Run it by hand only when the mark
changes:

    python static/icons/generate.py

The mark is the drafting language in miniature: a paper ground, a ruled inset
border, a few schedule hairlines, one datum square, and the single red "now"
line the calendar draws on today. Colours are drafting.css's own light-theme
--dr-paper (#fcfcfa), --dr-ink (rgb 30,27,24) and --dr-red (#c23b2e).

Outputs, all beside this file:
    icon-192.png            any-purpose, small margin
    icon-512.png            any-purpose, small margin
    icon-maskable-512.png   content kept inside the centre 60% safe zone
    apple-touch-icon.png     180px, opaque (iOS rounds the corners itself)
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

PAPER = (252, 252, 250)
INK = (30, 27, 24)
RED = (194, 59, 46)


def draw_mark(size, safe=1.0):
    """One icon at `size` px. `safe` < 1 pulls the drawing in from the edges so
    a maskable crop can't clip it."""
    img = Image.new("RGB", (size, size), PAPER)
    d = ImageDraw.Draw(img)

    margin = size * (1 - safe) / 2
    inset = margin + size * 0.14
    x0, y0, x1, y1 = inset, inset, size - inset, size - inset
    w = max(2, round(size * 0.012))

    # The sheet border: a ruled rectangle, not a filled panel.
    d.rectangle([x0, y0, x1, y1], outline=INK, width=w)

    # Schedule hairlines across the sheet.
    rows = 5
    for i in range(1, rows):
        y = y0 + (y1 - y0) * i / rows
        d.line([x0, y, x1, y], fill=INK, width=max(1, w // 2))

    # The datum square, top-left corner of the field.
    s = size * 0.07
    d.rectangle([x0, y0, x0 + s, y0 + s], fill=INK)

    # The one red line: "now", a third of the way across.
    nx = x0 + (x1 - x0) * 0.36
    d.line([nx, y0, nx, y1], fill=RED, width=w + 1)

    return img


def main():
    draw_mark(192).save(HERE / "icon-192.png")
    draw_mark(512).save(HERE / "icon-512.png")
    draw_mark(512, safe=0.6).save(HERE / "icon-maskable-512.png")
    draw_mark(180).save(HERE / "apple-touch-icon.png")
    print("wrote icon-192, icon-512, icon-maskable-512, apple-touch-icon")


if __name__ == "__main__":
    main()
