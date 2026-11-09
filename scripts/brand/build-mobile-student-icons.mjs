#!/usr/bin/env node
// Student App icon set, derived from the approved brand outputs in public/brand (themselves generated from the
// hash-pinned masters by build-logo-family.mjs). Scaling and padding only: no recolouring and no new artwork.
//
//   node scripts/brand/build-mobile-student-icons.mjs
//
// Outputs (mobile/student/assets):
//   danceflow-logo-primary.png              960x240 primary horizontal logo (headers, splash)
//   danceflow-app-icon-1024.png             byte copy of the approved app-icon master (symbol on its navy tile)
//   danceflow-adaptive-foreground-symbol.png full-colour symbol, 56% of a 1024 transparent canvas (Android safe zone)
//   danceflow-adaptive-monochrome-symbol.png white symbol, same layout (Android 13 themed icon)
//   danceflow-notification-symbol.png        white symbol on transparent, 192 square (Android uses alpha only)
//
// The adaptive-icon background is the app-icon master's own tile colour (#0E1028), set in app.json.

import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const brand = join(root, "public", "brand");
const out = join(root, "mobile", "student", "assets");

async function symbolOnCanvas(source, file, canvas, heightRatio) {
  const symbol = await sharp(source).resize({ height: Math.round(canvas * heightRatio) }).png().toBuffer();
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: symbol, gravity: "center" }])
    .png()
    .toFile(join(out, file));
}

await sharp(join(brand, "logo", "danceflow-logo-primary.png"))
  .resize(960, 240)
  .png()
  .toFile(join(out, "danceflow-logo-primary.png"));
copyFileSync(join(brand, "icons", "danceflow-app-icon-source-1024.png"), join(out, "danceflow-app-icon-1024.png"));
await symbolOnCanvas(join(brand, "logo", "danceflow-symbol.png"), "danceflow-adaptive-foreground-symbol.png", 1024, 0.56);
await symbolOnCanvas(join(brand, "logo", "danceflow-symbol-white.png"), "danceflow-adaptive-monochrome-symbol.png", 1024, 0.56);
await symbolOnCanvas(join(brand, "logo", "danceflow-symbol-white.png"), "danceflow-notification-symbol.png", 192, 0.83);

console.log("Student App icons written to", out);
