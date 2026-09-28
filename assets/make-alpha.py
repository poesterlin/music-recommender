#!/usr/bin/env python3
"""
Derive assets/source/logo-mark-alpha.png from the committed master.

Why this exists: the mark has to sit on the app's paper (#f4eee1) and on the
white login card, but the master is a flat cream (#fbf6e7) tile. Dropped in
raw it reads as a pale square, not a logo. Bun.Image cannot read raw pixels, so
the knockout cannot live in the Bun pipeline - it happens here, once, and the
result is committed as a second master. assets/build.ts then only resizes it,
exactly like every other target.

The knockout is neither a global colour key nor a plain flood fill, and both
naive versions are wrong here:

  colour key  the mark carries cream of its own - fin rays, eye rings, flank
              spots - and a key punches every one of them out.
  flood fill  a border-seeded fill leaks. The fin rays run the full width of
              the fin and meet its outer outline, and where they touch it the
              black is interrupted, so the exterior cream is connected to the
              cream between the rays. The fill walks in and eats the fins.

So the mark is closed first. The gaps in the fin outline are precisely the
leaks, so bridging them before filling means the fill never starts travelling
inward, and the fin interior stays enclosed. What the border can still reach
is exterior; what it cannot reach is the mark's own cream and stays opaque.

Requires Pillow. Run from anywhere:

    python3 assets/make-alpha.py
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

HERE = Path(__file__).resolve().parent
SRC = HERE / "source" / "logo-mark.png"
OUT = HERE / "source" / "logo-mark-alpha.png"

# A pixel counts as background cream when it is bright and barely saturated,
# i.e. anywhere on the ramp between the card cream and the anti-aliased edge.
MIN_CHANNEL = 196      # below this the pixel belongs to the mark
MAX_SPREAD = 34        # R-G spread; the orange and the near-black both exceed it

# Structuring element for the two morphology steps, in pixels. Must exceed the
# widest gap in the fin outlines so the close seals it, and stay well under the
# gap between two adjacent fin rays so the close cannot bridge those. The rays
# are roughly 14px apart, which is what leaves room here.
SIZE = 5

# Fringe absorption is exactly one pixel. That ring is the anti-aliasing, and
# removing it stops a pale halo appearing on any surface that is not the
# logo's own cream. Widening it is not free: the cream features are only about
# ten pixels across, so an aggressive dilate eats the fin rays whole.
FRINGE = 3


def split_channels(im: Image.Image):
    return im.convert("RGB").split()


def cream_mask(im: Image.Image) -> Image.Image:
    """L-mode mask, 255 on background cream."""
    r, g, b = split_channels(im)
    lo = ImageChops.darker(r, ImageChops.darker(g, b))
    hi = ImageChops.lighter(r, ImageChops.lighter(g, b))
    bright = lo.point(lambda v: 255 if v >= MIN_CHANNEL else 0)
    flat = ImageChops.subtract(hi, lo).point(lambda v: 255 if v <= MAX_SPREAD else 0)
    return ImageChops.darker(bright, flat)


def erode(mask: Image.Image) -> Image.Image:
    return mask.filter(ImageFilter.MinFilter(SIZE))


def dilate(mask: Image.Image, size: int = SIZE) -> Image.Image:
    return mask.filter(ImageFilter.MaxFilter(size))


def flood_from_border(mask: Image.Image) -> Image.Image:
    """255 on every pixel reachable from the border *through* set pixels.

    Pixels absent from the mask are walls, not open ground. Seeding them anyway
    floods the entire plane, which still looks roughly right in a preview and
    is completely wrong.
    """
    w, h = mask.size
    px = mask.load()
    reached = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()

    def visit(x: int, y: int) -> None:
        i = y * w + x
        if not reached[i] and px[x, y]:
            reached[i] = 1
            queue.append((x, y))

    for x in range(w):
        visit(x, 0)
        visit(x, h - 1)
    for y in range(h):
        visit(0, y)
        visit(w - 1, y)

    while queue:
        x, y = queue.popleft()
        if x:
            visit(x - 1, y)
        if x < w - 1:
            visit(x + 1, y)
        if y:
            visit(x, y - 1)
        if y < h - 1:
            visit(x, y + 1)

    return Image.frombytes("L", (w, h), bytes(255 if v else 0 for v in reached))


def selftest() -> None:
    """The cases that catch the two ways this has been wrong already."""
    # An enclosed set pixel is unreachable, and the walls are not open ground.
    m = Image.new("L", (5, 5), 0)
    m.putpixel((2, 2), 255)
    out = flood_from_border(m)
    assert out.getpixel((2, 2)) == 0, "enclosed pixel must not be reached"
    assert out.getpixel((0, 0)) == 0, "walls must not be treated as open ground"

    # A ring touching the border is reachable; what it encloses is not.
    m = Image.new("L", (7, 7), 0)
    for i in range(7):
        for edge in ((i, 0), (i, 6), (0, i), (6, i)):
            m.putpixel(edge, 255)
    m.putpixel((3, 3), 255)
    out = flood_from_border(m)
    for i in range(7):
        for edge in ((i, 0), (i, 6), (0, i), (6, i)):
            assert out.getpixel(edge) == 255, "the ring itself is open"
    assert out.getpixel((1, 1)) == 0, "interior stays enclosed"
    assert out.getpixel((3, 3)) == 0, "island stays enclosed"

    # No walls at all: everything, including the border, is reachable.
    out = flood_from_border(Image.new("L", (4, 4), 255))
    assert all(out.getpixel((x, y)) for y in range(4) for x in range(4)), "solid fill"


def main() -> None:
    selftest()
    im = Image.open(SRC).convert("RGB")
    w, h = im.size

    cream = cream_mask(im)
    mark = ImageChops.invert(cream)

    # Close the gaps in the fin outlines, then take the exterior only.
    closed = dilate(erode(mark))
    exterior = flood_from_border(ImageChops.invert(closed))
    exterior = ImageChops.darker(dilate(exterior, FRINGE), cream)

    r, g, b = im.split()
    out = Image.merge("RGBA", (r, g, b, ImageChops.invert(exterior)))
    out.save(OUT, optimize=True)

    transparent = sum(1 for v in exterior.getdata() if v)
    total = w * h
    print(f"wrote {OUT.relative_to(HERE.parent)}")
    print(
        f"  {w}x{h}  transparent {transparent} px ({transparent / total:.1%})"
        f"  opaque {total - transparent} px ({(total - transparent) / total:.1%})"
    )


if __name__ == "__main__":
    main()
