#!/usr/bin/env node
/**
 * Keeps absolute local paths out of committed QA documentation and evidence.
 *   node e2e/tools/scrub-committed-evidence.mjs <file.json> [...]      rewrites JSON evidence in place (2-space JSON, as acceptance-report.mjs writes it)
 *   node e2e/tools/scrub-committed-evidence.mjs --check [file...]      exits 1 if any file still holds a local path. JSON files are parsed; every other
 *                                                                      file (md, sh, mjs, tsv, txt, out, sql, ...) is checked as text. With no files,
 *                                                                      every tracked file under docs/qa/ is checked (git ls-files).
 * Text files are never rewritten automatically: replace the path by hand with a placeholder (<qa-run>/..., <worktrees>/..., <repo>/...).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hasLocalPath, scrubValue } from "./path-scrub.mjs";

const args = process.argv.slice(2);
const check = args[0] === "--check";
let files = check ? args.slice(1) : args;
if (check && files.length === 0) files = execFileSync("git", ["ls-files", "docs/qa"], { encoding: "utf8" }).split("\n").filter(Boolean);
if (files.length === 0) { console.error("usage: scrub-committed-evidence.mjs [--check] [file...]"); process.exit(2); }
let dirty = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const isJson = file.endsWith(".json");
  if (!isJson) {
    if (check) { if (hasLocalPath(text)) { console.error(`local path in ${file}`); dirty += 1; } } else console.error(`skipped (text file, edit by hand): ${file}`);
    continue;
  }
  const json = JSON.parse(text);
  const clean = JSON.stringify(scrubValue(json), null, 2);
  const still = hasLocalPath(JSON.stringify(json));
  if (check) { if (still) { console.error(`local path in ${file}`); dirty += 1; } continue; }
  if (clean !== JSON.stringify(json, null, 2) || still) writeFileSync(file, clean + (text.endsWith("\n") ? "\n" : ""));
  console.log(`${still ? "scrubbed" : "clean"} ${file}`);
}
process.exit(dirty ? 1 : 0);
