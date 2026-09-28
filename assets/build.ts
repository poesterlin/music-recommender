#!/usr/bin/env bun
/**
 * Builds every app and docs image asset from one committed master.
 *
 * `source/logo-mark.png` is already cropped to the mark and squared, so this
 * pipeline only ever resizes and encodes. That matters: Bun.Image (1.4.x) can
 * resize, rotate, flip and encode, but it cannot crop or pad, and it exposes no
 * raw pixels. Keeping the crop out of the pipeline is what lets the whole thing
 * run on Bun with no native dependency.
 *
 *   bun run build     regenerate the files
 *   bun run check     exit 1 if a committed output no longer matches the master
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const dir = import.meta.dir;
const root = join(dir, "..");
const checkOnly = Bun.argv.includes("--check");

type Target = {
  /** Path relative to the repository root. */
  out: string;
  /** Square edge length, in pixels. */
  size: number;
  /** PNG deflate level, 0-9. Worth setting for the small files only. */
  compression?: number;
  /** Why this file exists, shown in the report. */
  why: string;
  /**
   * Master to resize, relative to the repository root. Defaults to the opaque
   * master. Only the knockout master differs, and only because the app draws
   * the mark on its own paper, where an opaque cream tile would show.
   */
  from?: string;
};

const OPAQUE_MASTER = "assets/source/logo-mark.png";

const targets: Target[] = [
  { out: "web/static/favicon.png", size: 64, compression: 9, why: "browser tab" },
  { out: "web/static/apple-touch-icon.png", size: 180, compression: 9, why: "iOS home screen" },
  { out: "web/static/icon-192.png", size: 192, compression: 9, why: "PWA icon" },
  { out: "web/static/icon-512.png", size: 512, compression: 9, why: "PWA and social cards" },
  { out: "docs/public/logo.png", size: 512, compression: 9, why: "docs nav and hero" },
  {
    out: "web/static/logo-mark.png",
    size: 128,
    compression: 9,
    why: "header and login mark, drawn on the app's own paper",
    from: "assets/source/logo-mark-alpha.png"
  }
];

// bun-types does not describe the Image API yet, so the calls are typed loosely.
const Image = (Bun as unknown as { Image: new (input: ArrayBuffer) => any }).Image;

const sources = new Map<string, ArrayBuffer>();
async function masterBytes(path: string): Promise<ArrayBuffer> {
  const cached = sources.get(path);
  if (cached) return cached;
  if (!(await Bun.file(join(root, path)).exists())) {
    console.error(`Missing master: ${path}`);
    console.error("See README.md for how the masters are produced.");
    process.exit(1);
  }
  const bytes = await Bun.file(join(root, path)).arrayBuffer();
  sources.set(path, bytes);
  return bytes;
}

/** Encode one target in memory, so --check can compare bytes instead of writing. */
async function encode(target: Target): Promise<Uint8Array> {
  const source = await masterBytes(target.from ?? OPAQUE_MASTER);
  const image = new Image(source).resize(target.size, target.size);
  const png = target.compression ? image.png({ compressionLevel: target.compression }) : image.png();
  return png.bytes();
}

let stale = 0;
const rows: string[] = [];

for (const target of targets) {
  const outPath = join(root, target.out);
  const encoded = await encode(target);
  const label = relative(root, outPath);

  if (checkOnly) {
    const current = await readFile(outPath).catch(() => null);
    const matches = current !== null && Buffer.compare(current, Buffer.from(encoded)) === 0;
    if (!matches) stale += 1;
    rows.push(
      `${matches ? "ok   " : "STALE"} ${target.size.toString().padStart(4)}px  ${label}  ${target.why}`
    );
    continue;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, encoded);
  rows.push(
    `${(encoded.byteLength / 1024).toFixed(1).padStart(6)} kB  ${target.size
      .toString()
      .padStart(4)}px  ${label}  ${target.why}`
  );
}

console.log(rows.join("\n"));

if (checkOnly) {
  if (stale > 0) {
    console.error(`\n${stale} asset(s) out of date. Run: bun run build`);
    process.exit(1);
  }
  console.log("\nAll assets match their master.");
} else {
  const used = [...new Set(targets.map((t) => t.from ?? OPAQUE_MASTER))].sort();
  console.log(`\n${targets.length} assets written from ${used.length} master(s):`);
  for (const path of used) console.log(`  ${path}`);
}
