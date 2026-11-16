#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- a plain node script (CommonJS) */
/*
  node scripts/a11y-audit.js <out-dir>
  Reads every <screen>.xml in the folder (saved by `node scripts/device-smoke.js --a11y --out <dir>`, which also writes density.txt and
  size.txt), writes a11y-report.md and a11y-report.json beside them and exits 1 when any control is unlabelled. Small targets and
  stutter are reported, not failed (see the Student audit for why: rows cut off at the screen edge and wrapped text read as small).
*/
const fs = require("node:fs");
const path = require("node:path");
const { auditTree, report } = require("./a11y-audit-lib");

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: node scripts/a11y-audit.js <out-dir>");
  process.exit(2);
}
const read = (name, fallback) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8").trim() : fallback);
const density = Number(read("density.txt", "420"));
const screenHeight = Number(read("height.txt", "0")) || undefined;
const pxPerDp = density / 160;

const results = {};
let failures = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".xml") && f !== "fatal.xml").sort()) {
  const r = auditTree(fs.readFileSync(path.join(dir, file), "utf8"), pxPerDp, screenHeight);
  results[file.replace(/\.xml$/, "")] = r;
  failures += r.unlabelled.length;
}
if (!Object.keys(results).length) {
  console.error(`no .xml dumps in ${dir}`);
  process.exit(2);
}
const md = report(results, { density, pxPerDp });
fs.writeFileSync(path.join(dir, "a11y-report.md"), md);
fs.writeFileSync(path.join(dir, "a11y-report.json"), JSON.stringify(results, null, 2));
console.log(md.split("\n").slice(0, 30).join("\n"));
console.log(`\n${Object.keys(results).length} screens, ${failures} unlabelled control(s)`);
process.exit(failures ? 1 : 0);
