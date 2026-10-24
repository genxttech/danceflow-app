// Pure helpers for `run-chain.mjs rehearse` (no docker, no git, no network): the manifest's apply order, its hash table, and the plan built from them.
// Unit-tested by rehearsalPlan.test.mjs (`node --test scripts/qa/tw4f/rehearsalPlan.test.mjs`).
import { createHash } from "node:crypto";

export const sha256 = (t) => createHash("sha256").update(t).digest("hex");
/** The manifest's hash convention: LF-normalised (git show | tr -d '\r' | sha256sum). */
export const lfSha256 = (t) => sha256(String(t).replace(/\r/g, ""));

/**
 * One token of the manifest section 4 order line -> a 14-digit migration version.
 *   1205 -> 20261205090000    1119_090 -> 20261119090000    1119_092100 -> 20261119092100    1202_140 -> 20261202140000
 *   1231b -> 20261231100000 (the second slot of the same day, 10:00)    20261231100000 -> itself
 * Years other than 2026 must be written as a full 14-digit version.
 */
export function tokenToVersion(tok) {
  const t = tok.trim();
  let m;
  if (/^\d{14}$/.test(t)) return t;
  if ((m = t.match(/^(\d{4})b$/))) return `2026${m[1]}100000`;
  if ((m = t.match(/^(\d{4})$/))) return `2026${m[1]}090000`;
  if ((m = t.match(/^(\d{4})_(\d{3,6})$/))) return `2026${m[1]}${m[2].padEnd(6, "0")}`;
  throw new Error(`cannot read the apply-order token '${tok}'`);
}

/** The apply order of manifest section 4 (the first backticked line with arrows after the '## 4.' heading). `[1215, merged]` is read as 1215. Duplicates are an error. */
export function parseApplyOrder(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^## 4\./.test(l));
  if (start < 0) throw new Error("manifest has no '## 4.' section");
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const body = lines.slice(start, end < 0 ? undefined : end);
  const line = body.find((l) => l.includes("→") && l.includes("`"));
  if (!line) throw new Error("manifest section 4 has no apply-order line");
  const versions = line.replace(/`/g, "").split("→").map((s) => s.replace(/\[|\]/g, "").split(",")[0]).map(tokenToVersion);
  const dup = versions.find((v, i) => versions.indexOf(v) !== i);
  if (dup) throw new Error(`apply order lists ${dup} twice`);
  return versions;
}

/** Rows of the manifest hash table: `| <14 digits> | <file>.sql | <forward sha256> | <rollback sha256 or other> | ...`. A row whose forward hash is not 64 hex characters is ignored (slots). */
export function parseHashTable(md) {
  const rows = new Map();
  for (const l of md.replace(/\r/g, "").split("\n")) {
    if (!/^\| `?\d{14}/.test(l)) continue;
    const c = l.split("|").map((s) => s.replace(/[ `]/g, ""));
    const [, version, file, sha, rbsha] = c;
    if (!/^\d{14}$/.test(version) || !/^[0-9a-f]{64}$/.test(sha)) continue;
    if (rows.has(version)) throw new Error(`manifest hash table lists ${version} twice`);
    rows.set(version, { file, sha, rollbackSha: /^[0-9a-f]{64}$/.test(rbsha) ? rbsha : null });
  }
  return rows;
}

/**
 * Cross-checks order, hash table and the files on the ref; returns the plan in manifest order.
 *   filesAtRef: forward migration file names on the ref (no rollback dir).
 *   cutoff: highest version already inside the baseline image; every order entry must be above it.
 * Errors (all collected): an order entry without a manifest row or without a file on the ref; a file on the ref in the TW-4F range that is not in the order; a row whose file name differs.
 */
export function buildRehearsalPlan({ order, table, filesAtRef, cutoff }) {
  const problems = [];
  const byVersion = new Map();
  for (const f of filesAtRef) byVersion.set(f.slice(0, 14), [...(byVersion.get(f.slice(0, 14)) ?? []), f]);
  const plan = [];
  for (const version of order) {
    if (version <= cutoff) problems.push(`${version} is not above the baseline cutoff ${cutoff}: it is already inside the image`);
    const row = table.get(version);
    const files = byVersion.get(version) ?? [];
    if (!row) problems.push(`${version} is in the apply order but has no manifest hash row`);
    if (files.length !== 1) problems.push(`${version} must exist exactly once on the ref (found ${files.length})`);
    if (row && files.length === 1 && row.file !== files[0]) problems.push(`${version}: manifest names ${row.file}, the ref has ${files[0]}`);
    if (row && files.length === 1) plan.push({ version, file: files[0], sha: row.sha, rollbackSha: row.rollbackSha });
  }
  const inOrder = new Set(order);
  const first = order.map((v) => v).sort()[0];
  for (const [version, files] of byVersion) {
    if (first && version >= first && /(sms|twilio|tw4)/i.test(files[0]) && !inOrder.has(version)) problems.push(`${files[0]} is on the ref in the TW-4F range but not in the manifest apply order`);
  }
  if (problems.length) throw Object.assign(new Error(`rehearsal plan refused:\n  - ${problems.join("\n  - ")}`), { problems });
  return plan;
}

/** Catalog lines the strict rollback is KNOWN to leave behind (tracker KI-2): widened CHECK constraints. Masked for the per-step comparisons; reported separately at the end. */
export const KI2_CONSTRAINTS = ["studio_sms_approval_refs_shape", "studio_sms_approval_refs_source_check", "studio_sms_onboarding_audit_action_check"];
const isKi2 = (line) => line.startsWith("con ") && KI2_CONSTRAINTS.some((n) => line.split(" ")[2] === n);
export const maskKi2 = (lines) => lines.filter((l) => !isKi2(l));

/** Compares two fingerprints. `exact` = identical; `maskedEqual` = identical once the KI-2 constraint lines are removed from both sides. */
export function compareFp(a, b) {
  const B = new Set(b), A = new Set(a);
  const onlyBefore = a.filter((x) => !B.has(x)), onlyAfter = b.filter((x) => !A.has(x));
  const mb = onlyBefore.filter((x) => !isKi2(x)), ma = onlyAfter.filter((x) => !isKi2(x));
  return { exact: onlyBefore.length === 0 && onlyAfter.length === 0, maskedEqual: mb.length === 0 && ma.length === 0, onlyBefore, onlyAfter };
}

/**
 * The final verdict of the structural stages. PASS only if every stage is an exact match. A KI-2 residue (and nothing else) is KNOWN (exit 6, never green). Anything else FAIL.
 * stages: [{ name, cmp }] with cmp from compareFp.
 */
export function judgeStages(stages) {
  if (stages.some((s) => !s.cmp.maskedEqual)) return "FAIL";
  if (stages.every((s) => s.cmp.exact)) return "PASS";
  return "KNOWN";
}
