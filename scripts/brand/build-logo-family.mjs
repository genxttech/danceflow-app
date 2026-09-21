#!/usr/bin/env node
// DanceFlow brand family generator.
//
//   node scripts/brand/build-logo-family.mjs           build the family into public/brand and src/app
//   node scripts/brand/build-logo-family.mjs --verify  verify tracked inputs, regenerate into a temporary
//                                                      directory, and compare with the committed outputs
//                                                      (decoded pixels for images, bytes for copies)
//
// Sources of truth: the six owner-approved masters tracked in docs/brand/masters/ (see SHA256SUMS.txt there):
//   danceflow-logo-primary-gradient.svg, danceflow-logo-primary-white.svg,
//   danceflow-symbol-gradient.svg,       danceflow-symbol-white.svg,
//   danceflow-app-icon-1024.png,         danceflow-social-avatar-1080.png
// Nothing outside the repository is read. Inputs are hash-verified first and the script fails closed.
//
// Derivation rules:
//   * logo family (primary/symbol, colour/white/mono) <- the SVG masters. Monochrome purple is the white master
//     with #FFFFFF replaced by the existing UI brand value #5b145e (the approved artwork carries no purple master).
//   * favicon family (16/32/48 + .ico) and the transparent / reversed icon sources <- the symbol SVG masters.
//   * app / PWA / apple-touch icons <- the approved app-icon master (Lanczos downscale; the 1024 source is a copy).
//   * runtime social avatar 1024 <- the approved 1080 avatar master (Lanczos downscale).
//   * Open Graph card <- the primary gradient logo centred on --brand-surface (#fff9f3); no text or claims.
// The application palette, typography and token system are not changed by this script.
//
// Requires `sharp` (installed transitively with Next.js). Not part of the app build.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MASTER_DIR = join(ROOT, "docs/brand/masters");

const PURPLE_HEX = "#5b145e"; // --brand-primary (existing UI brand value; NOT the package palette)
const SURFACE = "#fff9f3"; // --brand-surface
const PNG_OPTS = { compressionLevel: 9, adaptiveFiltering: true, palette: false }; // lossless, never quantised

// Pinned hashes of the approved masters. SHA256SUMS.txt must agree with these.
const EXPECTED = {
  "danceflow-logo-primary-gradient.svg": "b80612ffecd5383a1c0dc0b2a5486ea686288221a278d053221e5e077ab3b459",
  "danceflow-logo-primary-white.svg": "2d75e3e700118228f2f1aba9e3d517b8acdbf70f4c5be0b6a47bd9423946b05c",
  "danceflow-symbol-gradient.svg": "e2c5fe2f12f9c04f8f51d4337f3e7cb31f385589e88ab02929fc828c3d74ee7d",
  "danceflow-symbol-white.svg": "eb4ed1f0ff12ce4743aef5b740b5934a8b59494a89b052e905e312ec9591d3d2",
  "danceflow-app-icon-1024.png": "ea0cb3560d92900f404cf96240771f93b23d8fec0e3328f90415878848c91261",
  "danceflow-social-avatar-1080.png": "94c357b9e862560ec667b845c30d17a8606ef5c0bb61fc98b04e52d4ff42eff4",
};

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- 1. verify tracked inputs (fail closed) ----
const masters = {};
{
  const sums = new Map();
  const sumsPath = join(MASTER_DIR, "SHA256SUMS.txt");
  if (!existsSync(sumsPath)) fail("docs/brand/masters/SHA256SUMS.txt is missing");
  for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [hash, name] = line.trim().split(/\s+/);
    sums.set(name, hash);
  }
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const path = join(MASTER_DIR, name);
    if (!existsSync(path)) fail(`missing tracked master ${name}`);
    const buf = readFileSync(path);
    const actual = sha256(buf);
    if (actual !== expected) fail(`${name}: sha256 ${actual} != pinned ${expected}`);
    if (sums.get(name) !== expected) fail(`${name}: SHA256SUMS.txt disagrees with the pinned hash`);
    masters[name] = buf;
  }
  console.log(`inputs verified: ${Object.keys(EXPECTED).length} tracked masters match their pinned SHA-256`);
}

const primaryGradientSvg = masters["danceflow-logo-primary-gradient.svg"];
const primaryWhiteSvg = masters["danceflow-logo-primary-white.svg"];
const symbolGradientSvg = masters["danceflow-symbol-gradient.svg"];
const symbolWhiteSvg = masters["danceflow-symbol-white.svg"];
const appIconMaster = masters["danceflow-app-icon-1024.png"];
const avatarMaster = masters["danceflow-social-avatar-1080.png"];

const toMono = (svgBuf) => {
  const text = svgBuf.toString("utf8");
  if (!text.includes("#FFFFFF")) fail("white master unexpectedly has no #FFFFFF fill");
  return Buffer.from(text.replaceAll("#FFFFFF", PURPLE_HEX), "utf8");
};
const primaryMonoSvg = toMono(primaryWhiteSvg);
const symbolMonoSvg = toMono(symbolWhiteSvg);

// SVG masters are 600x150 (primary) and 197x272 (symbol); density 288 renders them at 4x (2400x600 / 788x1088).
const render = (svg, density) => sharp(svg, { density }).ensureAlpha();
const lanczos = (p, width) => p.resize({ width, kernel: "lanczos3" });

// ---- 2. build every output into `outRoot` (returns the manifest of written files) ----
async function build(outRoot) {
  const LOGO_DIR = join(outRoot, "public/brand/logo");
  const ICON_DIR = join(outRoot, "public/brand/icons");
  const APP_DIR = join(outRoot, "src/app");
  for (const d of [LOGO_DIR, ICON_DIR, APP_DIR, join(outRoot, "public/brand")]) mkdirSync(d, { recursive: true });

  const written = [];
  const record = (path, kind, w, h, bytes) =>
    written.push({ path: relative(outRoot, path).replaceAll("\\", "/"), kind, w, h, bytes });

  async function savePng(pipeline, dir, name) {
    const path = join(dir, name);
    const buf = await pipeline.png(PNG_OPTS).toBuffer();
    writeFileSync(path, buf);
    const m = await sharp(buf).metadata();
    record(path, "image", m.width, m.height, buf.length);
    return buf;
  }
  function saveCopy(bytes, dir, name) {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    record(path, "copy", 0, 0, bytes.length);
  }

  // -- logo family from SVG masters --
  const primaryHi = await render(primaryGradientSvg, 288).png().toBuffer(); // 2400x600
  await savePng(sharp(primaryHi), LOGO_DIR, "danceflow-logo-primary.png");
  await savePng(lanczos(sharp(primaryHi), 640), LOGO_DIR, "danceflow-logo-primary-640.png");
  await savePng(lanczos(sharp(primaryHi), 320), LOGO_DIR, "danceflow-logo-primary-320.png");
  await savePng(render(primaryWhiteSvg, 144), LOGO_DIR, "danceflow-logo-primary-white.png"); // 1200x300
  await savePng(render(primaryMonoSvg, 144), LOGO_DIR, "danceflow-logo-primary-mono-purple.png");

  const symbolHi = await render(symbolGradientSvg, 288).png().toBuffer(); // 788x1088
  await savePng(sharp(symbolHi), LOGO_DIR, "danceflow-symbol.png");
  await savePng(lanczos(sharp(symbolHi), 256), LOGO_DIR, "danceflow-symbol-256.png");
  await savePng(lanczos(sharp(symbolHi), 128), LOGO_DIR, "danceflow-symbol-128.png");
  await savePng(render(symbolWhiteSvg, 288), LOGO_DIR, "danceflow-symbol-white.png");
  await savePng(render(symbolMonoSvg, 288), LOGO_DIR, "danceflow-symbol-mono-purple.png");

  // -- symbol centred on a square canvas (icon sources, favicons) --
  async function symbolCanvas(size, fill, svg, background) {
    // fill = fraction of the canvas height the (portrait) symbol occupies
    const h = Math.round(size * fill);
    const inner = await sharp(svg, { density: Math.max(72, Math.ceil((h / 272) * 72 * 4)) })
      .ensureAlpha()
      .resize({ height: h, kernel: "lanczos3" })
      .png()
      .toBuffer();
    const m = await sharp(inner).metadata();
    const base = sharp({ create: { width: size, height: size, channels: 4, background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } } });
    return base.composite([{ input: inner, left: Math.round((size - m.width) / 2), top: Math.round((size - h) / 2) }]);
  }
  const purpleRgb = { r: 0x5b, g: 0x14, b: 0x5e, alpha: 1 };
  await savePng(await symbolCanvas(1024, 0.64, symbolGradientSvg), ICON_DIR, "danceflow-icon-source-1024.png"); // transparent
  await savePng(await symbolCanvas(1024, 0.64, symbolWhiteSvg, purpleRgb), ICON_DIR, "danceflow-app-icon-source-1024-reversed.png");
  saveCopy(appIconMaster, ICON_DIR, "danceflow-app-icon-source-1024.png"); // approved master, byte copy

  // -- favicon family from the symbol SVG --
  const icoPngs = [];
  for (const s of [16, 32, 48]) {
    const buf = await savePng(await symbolCanvas(s, 0.94, symbolGradientSvg), ICON_DIR, `danceflow-favicon-${s}.png`);
    icoPngs.push({ size: s, buf });
  }

  // -- app / PWA / apple-touch icons from the approved app-icon master --
  const down = (size) => sharp(appIconMaster).ensureAlpha().resize({ width: size, height: size, kernel: "lanczos3" });
  await savePng(down(180), ICON_DIR, "danceflow-apple-touch-icon-180.png");
  await savePng(down(192), ICON_DIR, "danceflow-pwa-192.png");
  await savePng(down(512), ICON_DIR, "danceflow-pwa-512.png");
  // Maskable: the same artwork; the symbol spans +/-328 px from centre of 1024 (inside the 80% safe zone radius, 410 px).
  await savePng(down(512), ICON_DIR, "danceflow-pwa-maskable-512.png");

  // -- runtime social avatar 1024 from the approved 1080 avatar --
  await savePng(sharp(avatarMaster).ensureAlpha().resize({ width: 1024, height: 1024, kernel: "lanczos3" }), ICON_DIR, "danceflow-social-avatar-1024.png");

  // -- Open Graph / Twitter card 1200x630: primary gradient logo centred on --brand-surface, no text or claims --
  {
    const OG_W = 1200;
    const OG_H = 630;
    const logo = await lanczos(sharp(primaryHi), 800).png().toBuffer();
    const lm = await sharp(logo).metadata();
    const card = sharp({ create: { width: OG_W, height: OG_H, channels: 4, background: SURFACE } }).composite([
      { input: logo, left: Math.round((OG_W - lm.width) / 2), top: Math.round((OG_H - lm.height) / 2) },
    ]);
    await savePng(card, join(outRoot, "public/brand"), "danceflow-og-1200x630.png");
  }

  // -- ICO container with embedded PNGs (16/32/48) --
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
  saveCopy(ico, ICON_DIR, "danceflow-favicon.ico");

  // -- canonical copies used by the Next.js file conventions --
  saveCopy(ico, APP_DIR, "favicon.ico");
  saveCopy(readFileSync(join(ICON_DIR, "danceflow-pwa-512.png")), APP_DIR, "icon.png");
  saveCopy(readFileSync(join(ICON_DIR, "danceflow-apple-touch-icon-180.png")), APP_DIR, "apple-icon.png");

  return written;
}

const decoded = async (path) => {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
};

// Expected pixel dimensions of every generated image (fail closed on drift).
const EXPECTED_DIMS = {
  "public/brand/logo/danceflow-logo-primary.png": [2400, 600],
  "public/brand/logo/danceflow-logo-primary-640.png": [640, 160],
  "public/brand/logo/danceflow-logo-primary-320.png": [320, 80],
  "public/brand/logo/danceflow-logo-primary-white.png": [1200, 300],
  "public/brand/logo/danceflow-logo-primary-mono-purple.png": [1200, 300],
  "public/brand/logo/danceflow-symbol.png": [788, 1088],
  "public/brand/logo/danceflow-symbol-256.png": [256, 353],
  "public/brand/logo/danceflow-symbol-128.png": [128, 177],
  "public/brand/logo/danceflow-symbol-white.png": [788, 1088],
  "public/brand/logo/danceflow-symbol-mono-purple.png": [788, 1088],
  "public/brand/icons/danceflow-icon-source-1024.png": [1024, 1024],
  "public/brand/icons/danceflow-app-icon-source-1024-reversed.png": [1024, 1024],
  "public/brand/icons/danceflow-favicon-16.png": [16, 16],
  "public/brand/icons/danceflow-favicon-32.png": [32, 32],
  "public/brand/icons/danceflow-favicon-48.png": [48, 48],
  "public/brand/icons/danceflow-apple-touch-icon-180.png": [180, 180],
  "public/brand/icons/danceflow-pwa-192.png": [192, 192],
  "public/brand/icons/danceflow-pwa-512.png": [512, 512],
  "public/brand/icons/danceflow-pwa-maskable-512.png": [512, 512],
  "public/brand/icons/danceflow-social-avatar-1024.png": [1024, 1024],
  "public/brand/danceflow-og-1200x630.png": [1200, 630],
};

if (process.argv.includes("--verify")) {
  const tmp = mkdtempSync(join(tmpdir(), "danceflow-brand-verify-"));
  let problems = 0;
  try {
    const written = await build(tmp);
    let compared = 0;
    for (const w of written) {
      const fresh = join(tmp, w.path);
      const committed = join(ROOT, w.path);
      if (!existsSync(committed)) {
        console.error(`MISSING committed output: ${w.path}`);
        problems++;
        continue;
      }
      if (w.kind === "copy") {
        if (!readFileSync(fresh).equals(readFileSync(committed))) {
          console.error(`BYTES DIFFER: ${w.path}`);
          problems++;
        }
        compared++;
        continue;
      }
      const a = await decoded(fresh);
      const b = await decoded(committed);
      if (a.w !== b.w || a.h !== b.h) {
        console.error(`DIMENSIONS DIFFER: ${w.path} ${a.w}x${a.h} vs ${b.w}x${b.h}`);
        problems++;
        continue;
      }
      if (!a.data.equals(b.data)) {
        console.error(`PIXELS DIFFER: ${w.path}`);
        problems++;
      }
      const exp = EXPECTED_DIMS[w.path];
      if (exp && (b.w !== exp[0] || b.h !== exp[1])) {
        console.error(`UNEXPECTED DIMENSIONS: ${w.path} is ${b.w}x${b.h}, expected ${exp[0]}x${exp[1]}`);
        problems++;
      }
      compared++;
    }
    for (const p of Object.keys(EXPECTED_DIMS)) {
      if (!written.some((w) => w.path === p)) {
        console.error(`NOT GENERATED: ${p}`);
        problems++;
      }
    }
    console.log(`verify: ${compared} outputs compared against a fresh build from tracked inputs, ${problems} problem(s)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(problems ? 1 : 0);
} else {
  const written = await build(ROOT);
  console.log("\nwritten:");
  for (const w of written) console.log(`  ${w.path}  ${w.kind === "copy" ? `${w.bytes} bytes (copy)` : `${w.w}x${w.h}`}`);
  console.log(`\n${written.length} files written`);
}
