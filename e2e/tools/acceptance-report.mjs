#!/usr/bin/env node
/**
 * Turns a Playwright JSON report (results.json from e2e/playwright.acceptance.config.ts) into the machine-readable
 * acceptance JSON and a markdown results table. Usage:
 *   node e2e/tools/acceptance-report.mjs <results.json> [--out <file-stem>]
 * Status mapping (never optimistic): passed -> PASS; failed/timedOut/interrupted -> FAIL; skipped via test.fixme with a
 * NOT IMPLEMENTED / BLOCKED annotation -> that label; any other skip -> NOT RUN. A skipped test is never a PASS.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [input, ...rest] = process.argv.slice(2);
if (!input) { console.error("usage: acceptance-report.mjs <results.json> [--out <stem>]"); process.exit(2); }
const stem = rest[rest.indexOf("--out") + 1];
const report = JSON.parse(readFileSync(input, "utf8"));

const scenarios = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = test.results?.at(-1);
      const annotations = [...(test.annotations ?? []), ...(result?.annotations ?? [])];
      const label = annotations.find((a) => ["NOT IMPLEMENTED", "BLOCKED", "SETUP SHORTCUT"].includes(a.type));
      let status;
      if (test.status === "expected" && result?.status === "passed") status = "PASS";
      else if (test.status === "skipped" || result?.status === "skipped") status = label && label.type !== "SETUP SHORTCUT" ? label.type : annotations.some((a) => a.type === "fixme") ? "NOT IMPLEMENTED" : "NOT RUN";
      else status = "FAIL";
      const attachments = (result?.attachments ?? []).map((a) => ({ name: a.name, path: a.path ?? null, type: a.contentType }));
      scenarios.push({
        id: spec.title.match(/^(SCN-[\d.]+)/)?.[1] ?? spec.title,
        title: spec.title,
        status,
        note: label?.description ?? null,
        setupShortcut: annotations.some((a) => a.type === "SETUP SHORTCUT"),
        durationMs: result?.duration ?? 0,
        error: status === "FAIL" ? (result?.errors ?? []).map((e) => (e.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 12).join("\n")) : [],
        screenshots: attachments.filter((a) => a.type === "image/png").map((a) => a.path),
        trace: attachments.find((a) => a.name === "trace")?.path ?? null,
        evidence: annotations.filter((a) => a.type === "evidence").map((a) => { try { return JSON.parse(a.description); } catch { return a.description; } }),
      });
    }
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites ?? []) walk(suite);

const counts = scenarios.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
const out = { generatedAt: new Date().toISOString(), source: input, stats: report.stats ?? null, counts, scenarios };
if (stem) writeFileSync(`${stem}.json`, JSON.stringify(out, null, 2));
const md = ["| Scenario | Status | Screenshots | Trace |", "|---|---|---|---|",
  ...scenarios.map((s) => `| ${s.title.replace(/\|/g, "/")} | **${s.status}**${s.note ? ` — ${s.note}` : ""} | ${s.screenshots.length} | ${s.trace ?? "—"} |`)].join("\n");
if (stem) writeFileSync(`${stem}.table.md`, md + "\n"); else console.log(md);
console.log(JSON.stringify(counts));
