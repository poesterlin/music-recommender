# Assets

`build.ts` generates app and documentation images from two committed masters.
Resizing uses Bun. Rebuilding transparency also needs Python and Pillow.

```sh
cd assets
bun run build
bun run check
```

`check` exits `1` when a committed output differs from its generated image.

## Image masters

`source/logo-mark.png` contains the cropped, square mark with a cream background.
`source/logo-mark-alpha.png` contains the same mark with a transparent background.
The pipeline resizes and encodes them. It does not crop or pad them.

I keep two masters because `Bun.Image` cannot crop, pad, or expose raw pixels.
The [build script](build.ts) lists the output sizes and source masters.

## Replace the opaque master

The current source is `../logo-4k.png`, a `3891×3891` export.
Its rounded card, shadow, and border must be removed before resizing.

1. Find pixels differing from the corner colour by more than about `80/255`.
   The current mark spans `x 489..3459, y 757..3069`.
2. Add a `40px` margin around the mark. Exclude the card edge and shadow.
3. Pad the crop to a square with its median border colour.
4. Save a `1024×1024` master as `source/logo-mark.png`.
5. Rebuild the transparent master before running `bun run build`.

Measure the bounds again when changing the artwork. These coordinates describe
the current source only.

## Rebuild the transparent master

The app's paper is `#f4eee1`; the opaque master's cream is `#fbf6e7`.
The transparent master prevents a cream square appearing on the app's background.

Run [make-alpha.py](make-alpha.py) after replacing the opaque master:

```sh
python3 make-alpha.py
bun run build
bun run check
```

Install Pillow in your Python environment if the script reports a missing `PIL` module.

### History: removing the background

Closing outline gaps can also bridge nearby fin rays. Check both before resizing.
I tried two ways to remove the cream background:

- A colour key removed cream inside the mark, including fin rays and eye rings.
- A border-seeded flood fill leaked through gaps in the fin outline and removed fins.

The script now closes outline gaps before filling from the image border.
The fill removes connected exterior cream. Interior cream stays opaque.
I got this wrong twice without noticing in the preview.
The script checks the fill before writing the master.

If the artwork changes, check `SIZE` in `make-alpha.py`.
It must exceed the widest outline gap without bridging adjacent fin rays.
The current rays are roughly `14px` apart.

## Outputs

| File | Size in pixels | Master | Use |
|---|---|---|---|
| `web/static/favicon.png` | 64 | opaque | Browser tab |
| `web/static/apple-touch-icon.png` | 180 | opaque | iOS home screen |
| `web/static/icon-192.png` | 192 | opaque | Web app manifest |
| `web/static/icon-512.png` | 512 | opaque | Web app manifest and social cards |
| `docs/public/logo.png` | 512 | opaque | Documentation navigation and home page |
| `web/static/logo-mark.png` | 128 | transparent | Header and login mark |

Paths in this table start at the repository root.
Add a target with `from` in `build.ts` for another transparent output.
