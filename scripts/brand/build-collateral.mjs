#!/usr/bin/env node
// DanceFlow BR-5 collateral builder.
//
//   node scripts/brand/build-collateral.mjs                      build every asset into docs/brand/collateral/exports
//   node scripts/brand/build-collateral.mjs --verify             rebuild into a temp dir and compare with the committed exports
//   node scripts/brand/build-collateral.mjs --event "Name" [--detail "Booth 12"] --out <dir>
//                                                                 render the two event-presence social PNGs for one event
//
// Inputs (all tracked in this repository): docs/brand/collateral/copy.json, templates/, the logo masters in
// docs/brand/masters/, and public/brand/danceflow-path-hero.png (dancer card photo). Nothing else is read and
// nothing is fetched. Rendering uses the repo's Playwright Chromium; QR codes use the repo's `qrcode` package.
// Output is RGB. No CMYK or PDF/X conversion is performed (see COLLATERAL_GUIDE.md).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildQr, buildUrl, displayUrl, renderTemplate } from "./collateral-lib.mjs";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const COLLATERAL = join(ROOT, "docs/brand/collateral");
const TEMPLATES = join(COLLATERAL, "templates");
const DEFAULT_OUT = join(COLLATERAL, "exports");
const IN = 96; // CSS px per inch
const PT = 72;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// Keep an em dash attached to the word before it (a word joiner forbids the line break before the dash).
const WORD_JOINER = String.fromCharCode(0x2060);
const keepDash = (value) =>
  typeof value === "string"
    ? value.replace(/(\S)—/g, (_, c) => c + WORD_JOINER + "—")
    : Array.isArray(value)
      ? value.map(keepDash)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keepDash(v)]))
        : value;
const copy = keepDash(JSON.parse(readFileSync(join(COLLATERAL, "copy.json"), "utf8")));
const baseCss = readFileSync(join(TEMPLATES, "base.css"), "utf8");
const socialCss = readFileSync(join(TEMPLATES, "social.css"), "utf8");
const tpl = (name) => readFileSync(join(TEMPLATES, name), "utf8");
const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(file).toString("base64")}`;
const LOGO_COLOR = dataUri(join(ROOT, "docs/brand/masters/danceflow-logo-primary-gradient.svg"), "image/svg+xml");
const LOGO_WHITE = dataUri(join(ROOT, "docs/brand/masters/danceflow-logo-primary-white.svg"), "image/svg+xml");

const withSeparators = (labels) => labels.map((label, i) => ({ label, sep: i < labels.length - 1 }));
const pad2 = (n) => String(n).padStart(2, "0");

const report = { fonts: {}, pdfs: {}, qr: {}, images: {}, qa: {} };

/* ------------------------------------------------------------------------------------------------ */
/* Rendering helpers                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

async function openPage(browser, html, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}

async function probeFont(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-fontprobe]" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.map((f) => f.familyName);
}

/**
 * Layout QA inside the page: every text/logo/QR element must sit inside the safe rectangle, nothing may
 * overflow its page, and no two text elements may overlap. `safe` is {left,top,right,bottom} in CSS px
 * relative to each page element.
 */
async function layoutQa(page, pageSelector, safe) {
  return page.evaluate(
    ({ pageSelector, safe }) => {
      const issues = [];
      const pages = [...document.querySelectorAll(pageSelector)];
      for (const [pi, pg] of pages.entries()) {
        const pr = pg.getBoundingClientRect();
        const leaves = [...pg.querySelectorAll("*")].filter((el) => {
          if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return false;
          if (el.matches("img[data-photo]")) return false;
          if (el.matches("img.logo, .qr-tile")) return true;
          return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        });
        const rects = leaves.map((el) => ({ el, r: el.getBoundingClientRect() }));
        for (const { el, r } of rects) {
          const label = `${pi}:${el.className || el.tagName}:${(el.textContent || "").trim().slice(0, 24)}`;
          if (
            r.left - pr.left < safe.left - 1 ||
            r.top - pr.top < safe.top - 1 ||
            r.right - pr.left > safe.right + 1 ||
            r.bottom - pr.top > safe.bottom + 1
          )
            issues.push(`outside safe area: ${label}`);
        }
        for (let a = 0; a < rects.length; a += 1) {
          for (let b = a + 1; b < rects.length; b += 1) {
            const A = rects[a];
            const B = rects[b];
            if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
            const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
            const h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
            if (w > 1 && h > 1) issues.push(`overlap: ${A.el.className || A.el.tagName} / ${B.el.className || B.el.tagName}`);
          }
        }
        if (pg.scrollHeight > pg.clientHeight + 1 || pg.scrollWidth > pg.clientWidth + 1) issues.push(`page ${pi} overflows`);
      }
      return issues;
    },
    { pageSelector, safe },
  );
}

async function qrMetrics(page, qr) {
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-qr]").getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, bottom: r.bottom, scrollY: window.scrollY };
  });
  const tileIn = box.width / IN;
  const symbolIn = tileIn * qr.symbolFraction;
  return { tileIn: +tileIn.toFixed(3), symbolIn: +symbolIn.toFixed(3), moduleMm: +(((symbolIn * 25.4) / qr.modules)).toFixed(3), modules: qr.modules, box };
}

function stampPdf(bytes, { title, subject, bleedIn }) {
  return PDFDocument.load(bytes).then(async (doc) => {
    doc.setTitle(title);
    doc.setSubject(subject);
    doc.setProducer("DanceFlow collateral builder");
    doc.setCreator("DanceFlow collateral builder");
    doc.setAuthor("DanceFlow");
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));
    for (const p of doc.getPages()) {
      const { width, height } = p.getSize();
      const b = bleedIn * PT;
      p.setTrimBox(b, b, width - 2 * b, height - 2 * b);
      p.setBleedBox(0, 0, width, height);
    }
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  });
}

function pdfFonts(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const names = [...new Set([...text.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, "")))];
  return { fonts: names.sort(), embedded: /\/FontFile2?\b|\/FontFile3\b/.test(text) };
}

async function pngOf(buffer) {
  return sharp(buffer).png({ compressionLevel: 9 }).toBuffer();
}

/* ------------------------------------------------------------------------------------------------ */
/* Builders                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

async function buildBanner(browser, out) {
  const url = buildUrl(copy.meta, copy.banner.link);
  const qr = buildQr(url);
  const baseData = {
    baseCss,
    logoSrc: LOGO_COLOR,
    banner: copy.banner,
    audiencesView: withSeparators(copy.banner.audiences),
    qrSvg: qr.svg,
    url: displayUrl(copy.meta, copy.banner.link),
  };
  const viewport = { width: 34 * IN, height: 82 * IN };
  const name = "df-banner-booth-33x81-v1";

  const { page, context } = await openPage(browser, renderTemplate(tpl("banner.html"), { ...baseData, guides: false }), viewport);
  report.fonts[name] = await probeFont(page);
  const safe = { left: 1.5 * IN, top: 3.5 * IN, right: 32.5 * IN, bottom: 71.5 * IN };
  report.qa[name] = await layoutQa(page, "body", safe);
  const metrics = await qrMetrics(page, qr);
  // QR centre measured up from the bottom of the 81in trim (trim bottom sits 0.5in above the page bottom).
  const centreFromBottomIn = 81 + 0.5 - (metrics.box.top + metrics.box.width / 2) / IN;
  report.qr[name] = { url, ...metrics, centreFromTrimBottomIn: +centreFromBottomIn.toFixed(2), box: undefined };
  const pdfRaw = await page.pdf({ width: "34in", height: "82in", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const fontsInPdf = pdfFonts(pdfRaw);
  const pdf = await stampPdf(pdfRaw, {
    title: "DanceFlow event banner 33x81 (vendor-neutral master)",
    subject: "VENDOR-NEUTRAL MASTER - FINAL PRINTER FIT PENDING. RGB. Page includes 0.5in bleed.",
    bleedIn: 0.5,
  });
  writeFileSync(join(out, "review", `${name}-vendor-neutral-master.pdf`), pdf);
  report.pdfs[`${name}-vendor-neutral-master.pdf`] = { pages: 1, sizeIn: [34, 82], trimIn: [33, 81], bleedIn: 0.5, ...fontsInPdf };

  const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 34 * IN, height: 82 * IN } });
  const proof = await sharp(shot).resize({ width: 1088 }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(out, "review", `${name}-proof.png`), proof);
  await context.close();

  const g = await openPage(
    browser,
    renderTemplate(tpl("banner.html"), { ...baseData, guides: true, qrBandTop: 82 - 0.5 - 54, qrBandHeight: 18 /* band = 36in..54in up from the trim bottom */ }),
    viewport,
  );
  const gshot = await g.page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 34 * IN, height: 82 * IN } });
  writeFileSync(join(out, "review", `${name}-guides.png`), await sharp(gshot).resize({ width: 1088 }).png({ compressionLevel: 9 }).toBuffer());
  await g.context.close();
}

async function buildSheet(browser, out, key) {
  const a = copy[key];
  const url = buildUrl(copy.meta, a.link);
  const qr = buildQr(url);
  const name = `df-sheet-${key}-letter-v1`;
  const blocks = a.blocks.map((b, i) => ({ ...b, pad: pad2(i + 1) }));
  const html = renderTemplate(tpl("sheet.html"), {
    baseCss,
    logoSrc: LOGO_COLOR,
    a: { ...a, blocks },
    backClass: blocks.length > 3 ? "compact" : "",
    qrSvg: qr.svg,
    url: displayUrl(copy.meta, a.link),
    supportEmail: copy.meta.supportEmail,
  });
  const { page, context } = await openPage(browser, html, { width: 840, height: 1080 });
  report.fonts[name] = await probeFont(page);
  report.qa[name] = await layoutQa(page, "[data-page]", { left: 0.5 * IN, top: 0.5 * IN, right: 8.25 * IN, bottom: 10.75 * IN });
  report.qr[name] = { url, ...(await qrMetrics(page, qr)), box: undefined };
  const pdfRaw = await page.pdf({ width: "8.75in", height: "11.25in", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const fontsInPdf = pdfFonts(pdfRaw);
  const pdf = await stampPdf(pdfRaw, { title: `DanceFlow sheet - ${key}`, subject: "US Letter 8.5x11 trim, 0.125in bleed included, RGB", bleedIn: 0.125 });
  const pages = (await PDFDocument.load(pdf)).getPageCount();
  writeFileSync(join(out, "print", `${name}.pdf`), pdf);
  report.pdfs[`${name}.pdf`] = { pages, sizeIn: [8.75, 11.25], trimIn: [8.5, 11], bleedIn: 0.125, ...fontsInPdf };
  await previews(page, out, name, 8.75, 11.25, 0.125);
  await context.close();
}

async function previews(page, out, name, wIn, hIn, bleedIn) {
  const handles = await page.$$("[data-page]");
  for (const handle of handles) {
    const face = await handle.getAttribute("data-page");
    const shot = await handle.screenshot({ type: "png" });
    const b = Math.round(bleedIn * IN);
    const trimmed = await sharp(shot)
      .extract({ left: b, top: b, width: Math.round(wIn * IN) - 2 * b, height: Math.round(hIn * IN) - 2 * b })
      .resize({ width: Math.round((wIn - 2 * bleedIn) * 150) })
      .png({ compressionLevel: 9 })
      .toBuffer();
    writeFileSync(join(out, "review", `${name}-${face}.png`), trimmed);
  }
}

async function buildCard(browser, out) {
  const a = copy.dancers;
  const url = buildUrl(copy.meta, a.link);
  const qr = buildQr(url);
  const name = "df-card-dancers-4x6-v1";
  const photoHeightIn = 3.3;
  const srcFile = join(ROOT, "public/brand/danceflow-path-hero.png");
  const meta = await sharp(srcFile).metadata();
  const cropW = Math.round((4.25 / photoHeightIn) * meta.height);
  const left = Math.round((meta.width - cropW) * 0.12);
  const jpg = await sharp(srcFile).extract({ left, top: 0, width: cropW, height: meta.height }).jpeg({ quality: 92 }).toBuffer();
  report.images[name] = { sourcePx: [cropW, meta.height], placedIn: [4.25, photoHeightIn], effectiveDpi: Math.round(cropW / 4.25), minDpi: 300, source: "public/brand/danceflow-path-hero.png" };
  const html = renderTemplate(tpl("card.html"), {
    baseCss,
    logoSrc: LOGO_COLOR,
    photoSrc: `data:image/jpeg;base64,${jpg.toString("base64")}`,
    photoHeight: photoHeightIn,
    a,
    qrSvg: qr.svg,
    url: displayUrl(copy.meta, a.link),
  });
  const { page, context } = await openPage(browser, html, { width: 408, height: 600 });
  report.fonts[name] = await probeFont(page);
  report.qa[name] = await layoutQa(page, "[data-page]", { left: 0.375 * IN, top: 0.375 * IN, right: 3.875 * IN, bottom: 5.875 * IN });
  report.qr[name] = { url, ...(await qrMetrics(page, qr)), box: undefined };
  const pdfRaw = await page.pdf({ width: "4.25in", height: "6.25in", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const fontsInPdf = pdfFonts(pdfRaw);
  const pdf = await stampPdf(pdfRaw, { title: "DanceFlow dancer card", subject: "4x6 trim, 0.125in bleed included, RGB", bleedIn: 0.125 });
  const pages = (await PDFDocument.load(pdf)).getPageCount();
  writeFileSync(join(out, "print", `${name}.pdf`), pdf);
  report.pdfs[`${name}.pdf`] = { pages, sizeIn: [4.25, 6.25], trimIn: [4, 6], bleedIn: 0.125, ...fontsInPdf };
  await previews(page, out, name, 4.25, 6.25, 0.125);
  await context.close();
}

async function renderSocial(browser, outDir, { format, variant, eventText, detailText }) {
  const s = copy.social[variant === "awareness" ? "product" : "event"];
  const height = format === "square" ? 1080 : 1920;
  const html = renderTemplate(tpl(format === "square" ? "social-square.html" : "social-story.html"), {
    baseCss,
    socialCss,
    variant,
    isAwareness: variant === "awareness",
    isEvent: variant === "event",
    logoSrc: variant === "event" ? LOGO_WHITE : LOGO_COLOR,
    s,
    eventText: eventText ?? copy.social.event.eventField,
    detailText: detailText ?? "",
    audiencesView: withSeparators(s.audiences),
    host: copy.meta.displayHost,
  });
  const name = `df-social-${variant}-${format}-v1`;
  const { page, context } = await openPage(browser, html, { width: 1080, height });
  report.fonts[name] = await probeFont(page);
  const frame = await page.evaluate(() => {
    const r = document.querySelector("[data-safe]").getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  report.qa[name] = await layoutQa(page, "body", frame);
  const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1080, height } });
  const png = await pngOf(shot);
  const m = await sharp(png).metadata();
  report.images[name] = { px: [m.width, m.height], safeFrame: frame };
  await context.close();
  return { name, png };
}

async function buildSocial(browser, out) {
  for (const variant of ["awareness", "event"]) {
    for (const format of ["square", "story"]) {
      const { name, png } = await renderSocial(browser, out, { format, variant });
      writeFileSync(join(out, "social", `${name}.png`), png);
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Main                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

async function buildAll(out) {
  for (const sub of ["review", "print", "social"]) mkdirSync(join(out, sub), { recursive: true });
  const browser = await chromium.launch();
  try {
    await buildBanner(browser, out);
    for (const key of ["studios", "instructors", "organizers"]) await buildSheet(browser, out, key);
    await buildCard(browser, out);
    await buildSocial(browser, out);
  } finally {
    await browser.close();
  }
  const failures = Object.entries(report.qa).filter(([, issues]) => issues.length);
  writeFileSync(join(out, "BUILD_REPORT.json"), `${JSON.stringify(report, null, 2)}\n`);
  return failures;
}

async function main() {
  if (option("--event")) {
    const out = option("--out");
    if (!out) throw new Error("--out <dir> is required with --event");
    mkdirSync(out, { recursive: true });
    const browser = await chromium.launch();
    try {
      for (const format of ["square", "story"]) {
        const { name, png } = await renderSocial(browser, out, { format, variant: "event", eventText: option("--event"), detailText: option("--detail") });
        writeFileSync(join(out, `${name}-custom.png`), png);
        console.log(`wrote ${join(out, `${name}-custom.png`)}`);
      }
    } finally {
      await browser.close();
    }
    return;
  }

  if (flag("--verify")) {
    const tmp = mkdtempSync(join(tmpdir(), "df-collateral-"));
    try {
      const failures = await buildAll(tmp);
      let bad = failures.length;
      for (const sub of ["review", "print", "social"]) {
        for (const file of readdirSync(join(tmp, sub))) {
          const committed = join(DEFAULT_OUT, sub, file);
          if (!existsSync(committed)) {
            console.error(`MISSING committed export: ${sub}/${file}`);
            bad += 1;
            continue;
          }
          const a = readFileSync(join(tmp, sub, file));
          const b = readFileSync(committed);
          let same = a.equals(b);
          if (!same && file.endsWith(".png")) {
            const [ra, rb] = await Promise.all([sharp(a).raw().toBuffer(), sharp(b).raw().toBuffer()]);
            same = ra.equals(rb);
          }
          if (!same) {
            console.error(`DIFFERS: ${sub}/${file}`);
            bad += 1;
          }
        }
      }
      console.log(bad ? `verify FAILED (${bad})` : "verify OK");
      process.exitCode = bad ? 1 : 0;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  const failures = await buildAll(DEFAULT_OUT);
  for (const [name, issues] of failures) console.error(`QA issues in ${name}:\n  ${issues.join("\n  ")}`);
  console.log(failures.length ? `built with ${failures.length} QA issue group(s)` : "built; layout QA clean");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
