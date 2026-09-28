# Assets

Generates the app and docs images from one master. Bun only — no ImageMagick, no sharp, no native dependency.

```sh
cd assets
bun run build   # regenerate the derived files
bun run check   # exit 1 if a committed file no longer matches the master
```

## How it fits together

`source/logo-mark.png` is the only input. It is already cropped to the logo mark and squared, so the pipeline only resizes and encodes.

That split is deliberate. `Bun.Image` (1.4.x) can resize, rotate, flip and encode, but it cannot crop or pad, and it exposes no raw pixels. Cropping happens once, outside the pipeline, and the committed master is the result.

## Replacing the master

The source artwork is `logo-4k.png` in the repository root: a 3891×3891 export with the mark on a rounded card, a soft shadow, and a cream border. To rebuild the master from it, crop the card away and square the mark:

1. Find the mark's bounds: pixels differing from the corner colour by more than ~80/255. That gives `x 489..3459, y 757..3069` — the orange disk, the fish, and the music note. The threshold is high enough to ignore the card's fill and shadow.
2. Add a 40px margin so the mark is not flush to the edge. The card edge stays outside this rectangle, so no border or shadow is included.
3. Pad to a square with the median colour of the crop's border — a flat cream. The committed master is 1024×1024, which covers the largest target (512) at 2×.

Then run `bun run build`. The exact numbers above are from the current artwork; measure again if the artwork changes, since a different balance of mark to card will move the bounds.

## Outputs

| File | Size | Used for |
|---|---|---|
| `web/static/favicon.png` | 64 | Browser tab |
| `web/static/apple-touch-icon.png` | 180 | iOS home screen |
| `web/static/icon-192.png` | 192 | PWA icon |
| `web/static/icon-512.png` | 512 | PWA icon, social cards |
| `docs/public/logo.png` | 512 | Docs nav and home hero |

Every output is a square resize of the master, so they differ only in size. The master is flat cream, so the icons are cream tiles with the mark centred; they are not transparent. If an icon needs to sit on a dark or coloured surface, add a transparent variant to the master and a target here rather than editing the generated files.
