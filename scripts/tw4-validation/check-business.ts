/**
 * TW-4 Stage B preparation: check an owner-filled business JSON file against the exact wizard / database / runner rules.
 * Reads ONE local file. No network, no database, no Twilio. Never prints a field's value (findings name fields and rules only), so the
 * output is safe to paste into a chat or a log.
 *
 *   npx tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/check-business.ts <file> [--allow-in-repo]
 *
 * Exit codes: 0 = the file passes; 2 = it does not (or could not be read). Preferred entry point: check-business-file.ps1.
 * By default a file INSIDE this repository is refused: owner-filled business details must never be committed.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBusinessFile, isInsideDirectory } from "@/lib/sms/twilioIsv/validation/businessFile";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
const allowInRepo = args.includes("--allow-in-repo");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

if (!path) {
  out("Usage: check-business.ts <business.json> [--allow-in-repo]");
  process.exit(2);
}
if (!existsSync(path)) {
  out(`REFUSED: the file does not exist: ${path}`);
  process.exit(2);
}
const real = realpathSync(path);
if (!allowInRepo && isInsideDirectory(real, repoRoot)) {
  out("REFUSED: this file is inside the repository. Owner-filled business details must live OUTSIDE it so they can never be committed.");
  out("         Create a private copy with new-business-file.ps1 and fill that one in.");
  process.exit(2);
}

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(real, "utf8"));
} catch {
  out("REFUSED: the file is not valid JSON.");
  process.exit(2);
}

const report = checkBusinessFile(parsed);
const mark = { ok: "OK     ", missing: "MISSING", error: "ERROR  ", "optional-empty": "empty  " } as const;
out(`Business file check (${real.split(/[\\/]/).pop()}):`);
for (const [field, status] of Object.entries(report.fields)) out(`  ${mark[status]} ${field}`);
for (const e of report.errors) out(`  ! ${e.field}: ${e.message}`);
for (const m of report.missing) out(`  ! ${m.field}: ${m.message}`);
for (const w of report.warnings) out(`  ~ ${w.field}: ${w.message}`);
for (const n of report.notes) out(`  i ${n}`);
out(report.ok ? "RESULT: the file passes every rule the launcher and the runner apply." : "RESULT: the file does NOT pass; fix the items marked ! and run the check again.");
process.exit(report.ok ? 0 : 2);
void join;
