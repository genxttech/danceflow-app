#!/usr/bin/env node
/*
  Copies mobile/shared/assistant/*.ts(x) into each app's src/assistant/shared/ (generated, committed, never edited by hand).
  `node mobile/shared/sync-assistant.js` writes; `--check` exits 1 if any copy differs (the apps' parity tests do the same in jest).
*/
const fs = require("fs");
const path = require("path");

const source = path.join(__dirname, "assistant");
const apps = ["student", "business"];
const HEADER = "// GENERATED from mobile/shared/assistant/ by mobile/shared/sync-assistant.js. Do not edit here; edit the source and re-run.\n";
const check = process.argv.includes("--check");

const files = fs.readdirSync(source).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
let drift = 0;
for (const app of apps) {
  const dest = path.join(__dirname, "..", app, "src", "assistant", "shared");
  if (!check) fs.mkdirSync(dest, { recursive: true });
  const expected = new Set(files);
  if (fs.existsSync(dest)) for (const f of fs.readdirSync(dest)) if (!expected.has(f)) { drift++; if (!check) fs.rmSync(path.join(dest, f)); console.log(`${check ? "stale" : "removed"}: ${app}/${f}`); }
  for (const f of files) {
    const want = HEADER + fs.readFileSync(path.join(source, f), "utf8");
    const target = path.join(dest, f);
    const have = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (have !== want) { drift++; console.log(`${check ? "differs" : "wrote"}: ${app}/${f}`); if (!check) fs.writeFileSync(target, want); }
  }
}
if (check && drift) process.exit(1);
