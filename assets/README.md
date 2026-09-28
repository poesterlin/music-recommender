# Assets

Generates the app and docs images from one master. Bun only — no ImageMagick, no sharp, no native dependency.

```sh
cd assets
bun run build   # regenerate the derived files
bun run check   # exit 1 if a committed file no longer matches the master
```

## How it fits together

There are two committed masters in `source/`, and the pipeline only resizes and
encodes them.

`source/logo-mark.png` is the mark as supplied: already cropped to the logo mark
and squared. `source/logo-mark-alpha.png` is the same artwork with its cream
background knocked out, for drawing the mark on a surface that is not the
logo's own cream. Both are already cropped and squared, so the pipeline never
crops or pads.

That split is deliberate. `Bun.Image` (1.4.x) can resize, rotate, flip and
encode, but it cannot crop or pad, and it exposes no raw pixels. Both the crop
and the knockout happen once, outside the pipeline, and the committed masters
are the results.

## Replacing the master

The source artwork is `logo-4k.png` in the repository root: a 3891×3891 export with the mark on a rounded card, a soft shadow, and a cream border. To rebuild the master from it, crop the card away and square the mark:

1. Find the mark's bounds: pixels differing from the corner colour by more than ~80/255. That gives `x 489..3459, y 757..3069` — the orange disk, the fish, and the music note. The threshold is high enough to ignore the card's fill and shadow.
2. Add a 40px margin so the mark is not flush to the edge. The card edge stays outside this rectangle, so no border or shadow is included.
3. Pad to a square with the median colour of the crop's border — a flat cream. The committed master is 1024×1024, which covers the largest target (512) at 2×.

Then run `bun run build`. The exact numbers above are from the current artwork; measure again if the artwork changes, since a different balance of mark to card will move the bounds.

## Rebuilding the knockout master

`make-alpha.py` derives `source/logo-mark-alpha.png` from the opaque master. Run it after replacing the artwork, before `bun run build`. It needs Pillow, unlike the rest of the pipeline.

The app draws the mark on its own paper (`#f4eee1`) and on a white login card, while the master's cream is `#fbf6e7` — close enough to read as the same colour and different enough to show as a pale square. So the mark needs a background-free variant, and that knockout cannot live in `build.ts` because `Bun.Image` exposes no raw pixels.

It is not a colour key, and it is not a plain flood fill. Both are wrong here:

- A **colour key** also removes the mark's own cream — the fin rays, the eye rings, the flank spots.
- A **flood fill** leaks. The fin rays run the full width of the fin and meet its outer outline, and where they touch it the black is interrupted. That leaves the exterior cream connected to the cream between the rays, and a border-seeded fill walks in and eats the fins.

So the mark is closed first. The gaps in the fin outline are exactly the leaks, so bridging them before filling means the fill never starts travelling inward. What the border can still reach is exterior; what it cannot reach is the mark's own cream and stays opaque. The script asserts the flood behaves before running, because it has been wrong twice in ways a preview did not make obvious.

If the artwork changes, re-check `SIZE`. It must exceed the widest gap in the fin outlines, or the fill leaks again, and stay well under the gap between two adjacent fin rays, or the close bridges them and the fin fills in solid. The rays are roughly 14px apart.

## Outputs

| File | Size | Master | Used for |
|---|---|---|---|
| `web/static/favicon.png` | 64 | opaque | Browser tab |
| `web/static/apple-touch-icon.png` | 180 | opaque | iOS home screen |
| `web/static/icon-192.png` | 192 | opaque | PWA icon, via `site.webmanifest` |
| `web/static/icon-512.png` | 512 | opaque | PWA icon and social cards, via `site.webmanifest` |
| `docs/public/logo.png` | 512 | opaque | Docs nav and home hero |
| `web/static/logo-mark.png` | 128 | knockout | Header and login mark, drawn on the app's own paper |

Every output is a square resize of one master, so they differ only in size. The opaque master is flat cream, so its icons are cream tiles with the mark centred and are not transparent. That is what a browser tab and a PWA icon want, since both are drawn on a surface the page does not control.

The one exception is the header mark, which sits on the app's own paper, so it comes from the knockout master. Add a target with `from` for any future output that has to sit on a coloured or dark surface, rather than editing the generated files.
