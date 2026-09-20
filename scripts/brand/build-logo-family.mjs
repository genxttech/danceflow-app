#!/usr/bin/env node
// DanceFlow Branding Relaunch -- BR-1: derives the raster logo family from the
// approved master artwork WITHOUT redesigning it.
//
//   node scripts/brand/build-logo-family.mjs           build public/brand/logo + public/brand/icons
//   node scripts/brand/build-logo-family.mjs --verify  build, then prove every kept pixel equals the master
//
// Rules (see docs/brand/DANCEFLOW_BRAND_GUIDE.md):
//   * The master is public/brand/danceflow-logo.png (approved dancing-couple mark + script wordmark). Only a
//     raster master exists; there is NO trustworthy vector source, so nothing here is traced or redrawn.
//   * Full-colour derivatives are lossless crops: every pixel with alpha > 0 is byte-identical to the master.
//     The only change is zeroing the RGB of fully transparent pixels (invisible; it removes a hidden glow that
//     made the master 2.2 MB).
//   * The symbol-only mark is isolated by connected components of the master's own opaque pixels (couple + sweep),
//     never re-drawn.
//   * Monochrome / reversed forms reuse the master's alpha as a silhouette (flat colour); scaled sizes use
//     Lanczos resampling of the master pixels. Icons place the symbol on a canvas; they never alter it.
//
// Requires `sharp` (installed transitively with Next.js). Not part of the app build.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MASTER = join(ROOT, "public/brand/danceflow-logo.png");
const LOGO_DIR = join(ROOT, "public/brand/logo");
const ICON_DIR = join(ROOT, "public/brand/icons");
mkdirSync(LOGO_DIR, { recursive: true });
mkdirSync(ICON_DIR, { recursive: true });

const PURPLE = { r: 0x5b, g: 0x14, b: 0x5e }; // --brand-primary
const SURFACE = "#fff9f3"; // --brand-surface
const PNG_OPTS = { compressionLevel: 9, adaptiveFiltering: true, palette: false }; // lossless (never palette-quantise)

const masterBytes = readFileSync(MASTER);
console.log(`master sha256: ${createHash("sha256").update(masterBytes).digest("hex")}`);

const { data: src, info } = await sharp(masterBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const A = (buf, i) => buf[i * 4 + 3];

// ---- connected components over the master's own opaque pixels (alpha >= 40, 5x5 neighbourhood) ----
const label = new Int32Array(W * H);
const comps = [];
for (let s = 0; s < W * H; s++) {
  if (label[s] || A(src, s) < 40) continue;
  const id = comps.length + 1;
  const c = { id, px: 0, x0: W, y0: H, x1: 0, y1: 0 };
  const stack = [s];
  label[s] = id;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i / W) | 0;
    c.px++;
    if (x < c.x0) c.x0 = x;
    if (x > c.x1) c.x1 = x;
    if (y < c.y0) c.y0 = y;
    if (y > c.y1) c.y1 = y;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!label[j] && A(src, j) >= 40) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
  }
  comps.push(c);
}
// The couple + sweep and its small accents are every component that ends left of the wordmark ("D" starts near x=541).
const SYMBOL_X_LIMIT = 560;
const symbolComps = new Set(comps.filter((c) => c.x1 <= SYMBOL_X_LIMIT).map((c) => c.id));
const symbolRight = Math.max(...comps.filter((c) => symbolComps.has(c.id)).map((c) => c.x1)) + 6;
console.log(`components: ${comps.length}; symbol components: ${[...symbolComps].join(",")}; symbol right edge x=${symbolRight}`);

// ---- base RGBA buffers ----
function cleanTransparent(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < W * H; i++) {
    if (out[i * 4 + 3] === 0) {
      out[i * 4] = 0;
      out[i * 4 + 1] = 0;
      out[i * 4 + 2] = 0;
    }
  }
  return out;
}
const full = cleanTransparent(src);

// Symbol-only: remove pixels that belong to non-symbol components (dilated 3px so no fringe survives), never touching
// symbol pixels, and drop everything right of the symbol.
const symbol = Buffer.from(full);
{
  const kill = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const l = label[i];
    if (l && !symbolComps.has(l)) {
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) kill[ny * W + nx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const l = label[i];
    const isSymbolPixel = l && symbolComps.has(l);
    if (!isSymbolPixel && (kill[i] || x > symbolRight)) {
      symbol[i * 4] = 0;
      symbol[i * 4 + 1] = 0;
      symbol[i * 4 + 2] = 0;
      symbol[i * 4 + 3] = 0;
    }
  }
}

function bbox(buf, threshold = 8) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (buf[(y * W + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}
function cropBox(b, pad) {
  const left = Math.max(0, b.x0 - pad);
  const top = Math.max(0, b.y0 - pad);
  const right = Math.min(W - 1, b.x1 + pad);
  const bottom = Math.min(H - 1, b.y1 + pad);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
const PAD = 12;
const fullBox = cropBox(bbox(full), PAD);
const symBox = cropBox(bbox(symbol), PAD);
console.log(`primary crop ${JSON.stringify(fullBox)}; symbol crop ${JSON.stringify(symBox)}`);

// Crop in plain JS (no premultiply / colour round trip), so cropped pixels stay byte-identical to the master.
function cropRaw(buf, box) {
  const out = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    buf.copy(out, y * box.width * 4, ((box.top + y) * W + box.left) * 4, ((box.top + y) * W + box.left + box.width) * 4);
  }
  return out;
}
const crop = (buf, box) => sharp(cropRaw(buf, box), { raw: { width: box.width, height: box.height, channels: 4 } });

// mono: flat colour, alpha from the master
function mono(buf, rgb) {
  const out = Buffer.from(buf);
  for (let i = 0; i < W * H; i++) {
    if (out[i * 4 + 3] === 0) continue;
    out[i * 4] = rgb.r;
    out[i * 4 + 1] = rgb.g;
    out[i * 4 + 2] = rgb.b;
  }
  return out;
}
const fullWhite = mono(full, { r: 255, g: 255, b: 255 });
const fullPurple = mono(full, PURPLE);
const symWhite = mono(symbol, { r: 255, g: 255, b: 255 });
const symPurple = mono(symbol, PURPLE);

const written = [];
async function save(pipeline, dir, name) {
  const path = join(dir, name);
  const buf = await pipeline.png(PNG_OPTS).toBuffer();
  writeFileSync(path, buf);
  const m = await sharp(buf).metadata();
  written.push({ path: relative(ROOT, path).replaceAll("\\", "/"), w: m.width, h: m.height, bytes: buf.length });
  return buf;
}
const resized = (p, width) => p.resize({ width, kernel: "lanczos3", withoutEnlargement: true });

// ---- logo family ----
for (const [suffix, buf] of [
  ["", full],
  ["-white", fullWhite],
  ["-mono-purple", fullPurple],
]) {
  await save(crop(buf, fullBox), LOGO_DIR, `danceflow-logo-primary${suffix}.png`);
  if (suffix === "") {
    await save(resized(crop(buf, fullBox), 640), LOGO_DIR, "danceflow-logo-primary-640.png");
    await save(resized(crop(buf, fullBox), 320), LOGO_DIR, "danceflow-logo-primary-320.png");
  }
}
for (const [suffix, buf] of [
  ["", symbol],
  ["-white", symWhite],
  ["-mono-purple", symPurple],
]) {
  await save(crop(buf, symBox), LOGO_DIR, `danceflow-symbol${suffix}.png`);
  if (suffix === "") {
    await save(resized(crop(buf, symBox), 256), LOGO_DIR, "danceflow-symbol-256.png");
    await save(resized(crop(buf, symBox), 128), LOGO_DIR, "danceflow-symbol-128.png");
  }
}

// ---- icons / avatars: symbol centred on a square canvas ----
const symPng = await crop(symbol, symBox).png().toBuffer();
const symWhitePng = await crop(symWhite, symBox).png().toBuffer();
const symMeta = await sharp(symPng).metadata();
async function canvas(size, fill, background, whitePng) {
  // fill = fraction of the canvas the symbol's LONGER side may occupy
  const scale = (size * fill) / Math.max(symMeta.width, symMeta.height);
  const w = Math.round(symMeta.width * scale);
  const h = Math.round(symMeta.height * scale);
  const inner = await sharp(whitePng ?? symPng).resize({ width: w, height: h, kernel: "lanczos3" }).png().toBuffer();
  const base = sharp({ create: { width: size, height: size, channels: 4, background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } } });
  return base.composite([{ input: inner, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }]);
}
// transparent source
await save(await canvas(1024, 0.86), ICON_DIR, "danceflow-icon-source-1024.png");
// opaque app-icon sources (stores apply their own mask; no rounded corners baked in)
await save(await canvas(1024, 0.74, SURFACE), ICON_DIR, "danceflow-app-icon-source-1024.png");
await save(await canvas(1024, 0.74, { ...PURPLE, alpha: 1 }, symWhitePng), ICON_DIR, "danceflow-app-icon-source-1024-reversed.png");
// Facebook / social avatar (circle-safe: symbol fills at most ~64% of the square)
await save(await canvas(1024, 0.64, SURFACE), ICON_DIR, "danceflow-social-avatar-1024.png");
// browser / OS sizes
const icoPngs = [];
for (const s of [16, 32, 48]) {
  const buf = await save(await canvas(s, 0.96), ICON_DIR, `danceflow-favicon-${s}.png`);
  icoPngs.push({ size: s, buf });
}
await save(await canvas(180, 0.78, SURFACE), ICON_DIR, "danceflow-apple-touch-icon-180.png");
await save(await canvas(192, 0.86), ICON_DIR, "danceflow-pwa-192.png");
await save(await canvas(512, 0.86), ICON_DIR, "danceflow-pwa-512.png");
await save(await canvas(512, 0.56, SURFACE), ICON_DIR, "danceflow-pwa-maskable-512.png"); // inside the 80% safe zone

// ICO container with embedded PNGs (source asset only; not wired anywhere)
{
  const n = icoPngs.length;
  const header = Buffer.alloc(6 + 16 * n);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);
  let offset = header.length;
  icoPngs.forEach((p, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(p.size, e);
    header.writeUInt8(p.size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(p.buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += p.buf.length;
  });
  const ico = Buffer.concat([header, ...icoPngs.map((p) => p.buf)]);
  writeFileSync(join(ICON_DIR, "danceflow-favicon.ico"), ico);
  written.push({ path: "public/brand/icons/danceflow-favicon.ico", w: "16/32/48", h: "", bytes: ico.length });
}

console.log("\nwritten:");
for (const w of written) console.log(`  ${w.path}  ${w.w}x${w.h}  ${(w.bytes / 1024).toFixed(1)} KB`);

// ---- verification: every kept pixel is byte-identical to the master ----
if (process.argv.includes("--verify")) {
  let bad = 0;
  let checked = 0;
  for (const [name, buf, box] of [
    ["primary", full, fullBox],
    ["symbol", symbol, symBox],
  ]) {
    const out = await crop(buf, box).raw().toBuffer();
    for (let y = 0; y < box.height; y++) {
      for (let x = 0; x < box.width; x++) {
        const o = (y * box.width + x) * 4;
        const s = ((box.top + y) * W + box.left + x) * 4;
        if (out[o + 3] === 0) continue; // fully transparent
        checked++;
        if (out[o] !== src[s] || out[o + 1] !== src[s + 1] || out[o + 2] !== src[s + 2] || out[o + 3] !== src[s + 3]) bad++;
      }
    }
    // the exported PNG file must round-trip to the same visible pixels
    const file = await sharp(join(LOGO_DIR, name === "primary" ? "danceflow-logo-primary.png" : "danceflow-symbol.png"))
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] !== 0 && (out[i] !== file[i] || out[i + 1] !== file[i + 1] || out[i + 2] !== file[i + 2] || out[i + 3] !== file[i + 3])) bad++;
    }
  }
  console.log(`\nverify: ${checked} visible pixels checked across primary + symbol, ${bad} differ from the master`);
  if (bad) process.exit(1);
}
