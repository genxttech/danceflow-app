#!/usr/bin/env node
/**
 * WP-D0 function coverage meter: merges the per-suite coverage.json files that `run-chain.mjs suites --track-functions` writes
 * (pg_stat_user_functions joined to pg_proc, one fresh database per suite) into one table.
 *
 *   node scripts/qa/tw4f/coverage-report.mjs <run-out-dir>[,<more-run-dirs>] [--scope tw4|public] [--json <file>] [--md <file>]
 *
 * Scope "tw4" (default) = the volatile functions that scripts/hosted/tw4f/probe_fingerprint.sql lists as TW-4 / TW-4F (tw4_functions + other_sms_functions rows in <run-out-dir>/probe_fingerprint.txt
 * when present, otherwise every public function whose name starts with tw4_ / _tw4 / studio_sms / sms_ / _sms_). "public" = every volatile public function.
 * A function counts as covered when at least one suite recorded >= 1 call. A suite that was INFRA/BLOCKED still contributes whatever it recorded; the report lists suite verdicts.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const dirs = (argv[0] ?? "").split(",").filter(Boolean);
const dir = dirs[0];
if (!dir) { console.error("usage: coverage-report.mjs <run-out-dir> [--scope tw4|public] [--json f] [--md f] [--probe f]"); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const scope = opt("scope", "tw4");

const verdictOf = new Map();
for (const d of dirs) { const f = path.join(d, "report.json"); if (existsSync(f)) for (const r of JSON.parse(readFileSync(f, "utf8")).suites?.results ?? []) verdictOf.set(path.basename(r.suite, ".test.ts"), r.status); }

const probePath = opt("probe", [...dirs.map((d) => path.join(d, "probe_fingerprint.txt")), opt("probe-fallback", "")].find((f) => f && existsSync(f)) ?? "");
const probeNames = existsSync(probePath)
  ? new Set(readFileSync(probePath, "utf8").split("\n").filter((l) => l.startsWith("fn_body:tw4_functions") || l.startsWith("fn_body:other_sms_functions")).map((l) => l.split("|")[1].replace(/\(.*$/, "")))
  : null;
const inScope = (name) => (scope === "public" ? true : probeNames ? probeNames.has(name) : /^(tw4_|_tw4|studio_sms|sms_|_sms_)/.test(name));

const fns = new Map(); // key name(args) -> {name,args,vol,kind,suites:{}, calls}
const suites = [];
for (const [rd, d] of dirs.flatMap((rd) => readdirSync(rd).filter((x) => x.startsWith("suite-")).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])).map((d) => [rd, d]))) {
  const f = path.join(rd, d, "coverage.json");
  const suite = d.replace(/^suite-\d+-/, "");
  if (!existsSync(f)) { suites.push({ suite, status: verdictOf.get(suite) ?? "?", coverage: false }); continue; }
  let rows;
  try { rows = JSON.parse(readFileSync(f, "utf8").trim()); } catch { suites.push({ suite, status: verdictOf.get(suite) ?? "?", coverage: false }); continue; }
  if (!Array.isArray(rows)) { suites.push({ suite, status: verdictOf.get(suite) ?? "?", coverage: false }); continue; }
  suites.push({ suite, status: verdictOf.get(suite) ?? "?", coverage: true });
  for (const r of rows) {
    const key = `${r.name}(${r.args})`;
    const e = fns.get(key) ?? { name: r.name, args: r.args, vol: r.vol, kind: r.kind, suites: {}, calls: 0 };
    if (r.calls > 0) { e.suites[suite] = (e.suites[suite] ?? 0) + Number(r.calls); e.calls += Number(r.calls); }
    fns.set(key, e);
  }
}

{ const last = new Map(); for (const x of suites) last.set(x.suite, x); suites.splice(0, suites.length, ...last.values()); } // a suite rerun in a later run dir replaces its earlier row
const volWord = { v: "volatile", s: "stable", i: "immutable" };
const rows = [...fns.entries()].filter(([, e]) => e.vol === "v" && inScope(e.name)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const covered = rows.filter(([, e]) => e.calls > 0);
const uncovered = rows.filter(([, e]) => e.calls === 0);

const md = [];
md.push(`### WP-D0 function coverage (scope: ${scope}${probeNames && scope !== "public" ? `, ${probeNames.size} probe names` : ""})`);
md.push(`- volatile functions in scope: **${rows.length}**; called by at least one suite: **${covered.length}**; never called: **${uncovered.length}**`);
md.push(`- suites with coverage data: ${suites.filter((s) => s.coverage).length}/${suites.length}`);
md.push("\n| Suite | Result | Coverage captured |\n|---|---|---|");
for (const s of suites) md.push(`| ${s.suite} | ${s.status} | ${s.coverage ? "yes" : "NO"} |`);
md.push("\n| Function | Volatility | Suites that called it | Calls |\n|---|---|---|---|");
for (const [k, e] of rows) md.push(`| ${k.replace(/\|/g, "/")} | ${volWord[e.vol]} | ${Object.entries(e.suites).map(([s, c]) => `${s} (${c})`).join(", ") || "-"} | ${e.calls} |`);
md.push("\n#### Uncovered (zero recorded calls)");
for (const [k] of uncovered) md.push(`- ${k}`);

const outMd = opt("md", path.join(dir, "coverage.md"));
const outJson = opt("json", path.join(dir, "coverage-merged.json"));
writeFileSync(outMd, md.join("\n"));
writeFileSync(outJson, JSON.stringify({ scope, total: rows.length, covered: covered.length, uncovered: uncovered.map(([k]) => k), suites, functions: rows.map(([k, e]) => ({ fn: k, calls: e.calls, suites: e.suites })) }, null, 2));
console.log(md.slice(0, 2).join("\n"));
console.log(`written ${outMd} and ${outJson}`);
