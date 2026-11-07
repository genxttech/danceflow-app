// Post-run analysis: cleanup verification from the evidence, evidence hashing, redaction scan, key-expiry reminder, failure diagnosis and the
// decision-ready report. Pure functions over strings/objects (the runner does the file reads), so hostile content can be fed in by tests.

import { sha256 } from "./canon";
import type { Envelope } from "./envelope";
import { hasSecretFinding, sanitize, scanForSecrets, type Finding } from "./scan";

export type DecisionStatus = "PASS" | "FAIL" | "BLOCKED" | "UNVERIFIABLE";

export type FileHash = { name: string; sha256: string; bytes: number };

export type Analysis = {
  evidenceFound: boolean;
  evidenceParsed: boolean;
  outcome: string | null;
  checks: { pass: number; fail: number };
  verdictCounts: Record<string, number>;
  verdictV4: string;
  verdictV7: string;
  callsUsed: number | null;
  blockedBeforeNetwork: number | null;
  ceiling: number;
  cleanup: { verifiedEmpty: boolean; skipped: string | null; stoppedBecause: string | null; remaining: number; unverifiable: number; deletedInvoices: number; deletedCustomers: number } | null;
  abort: { code: string; message: string } | null;
  manifestMatches: boolean | null;
  failures: string[];
};

const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Interprets the proof's evidence JSON strictly: anything missing is a failure to verify, never a pass. */
export function analyzeEvidence(jsonText: string | null, e: Pick<Envelope, "apiCallCeiling" | "proof">): Analysis {
  const a: Analysis = {
    evidenceFound: jsonText !== null, evidenceParsed: false, outcome: null, checks: { pass: 0, fail: 0 }, verdictCounts: {}, verdictV4: "unknown", verdictV7: "unknown",
    callsUsed: null, blockedBeforeNetwork: null, ceiling: e.apiCallCeiling, cleanup: null, abort: null, manifestMatches: null, failures: [],
  };
  if (jsonText === null) {
    a.failures.push("no evidence JSON was written");
    return a;
  }
  let j: unknown;
  try {
    j = JSON.parse(jsonText);
  } catch {
    a.failures.push("evidence JSON is not parseable");
    return a;
  }
  if (!plain(j)) {
    a.failures.push("evidence JSON is not an object");
    return a;
  }
  a.evidenceParsed = true;
  a.outcome = typeof j.outcome === "string" ? j.outcome : null;
  if (a.outcome !== "OK") a.failures.push(`evidence outcome is ${JSON.stringify(a.outcome)}, not OK`);
  a.manifestMatches = j.scriptManifestSha256 === e.proof.manifestSha256;
  if (!a.manifestMatches) a.failures.push("evidence scriptManifestSha256 differs from the envelope");
  if (j.mode !== "live") a.failures.push(`evidence mode is ${JSON.stringify(j.mode)}, expected "live"`);
  for (const s of arr(j.scenarios)) for (const c of plain(s) ? arr(s.checks) : []) if (plain(c)) { if (c.ok === true) a.checks.pass++; else a.checks.fail++; }
  if (a.checks.fail > 0) a.failures.push(`${a.checks.fail} scenario check(s) failed`);
  if (a.checks.pass + a.checks.fail === 0) a.failures.push("evidence contains no scenario checks");
  if (plain(j.verdicts)) {
    for (const [k, v] of Object.entries(j.verdicts)) {
      const val = plain(v) && typeof v.verdict === "string" ? v.verdict : "unknown";
      a.verdictCounts[val] = (a.verdictCounts[val] ?? 0) + 1;
      if (k === "V4") a.verdictV4 = val;
      if (k === "V7") a.verdictV7 = val;
      if (val === "FAIL") a.failures.push(`verdict ${k} is FAIL`);
    }
  } else a.failures.push("evidence has no verdicts");
  a.callsUsed = asNum(j.callsUsed);
  a.blockedBeforeNetwork = asNum(j.blockedBeforeNetwork);
  if (a.callsUsed === null) a.failures.push("callsUsed missing");
  else if (a.callsUsed > e.apiCallCeiling) a.failures.push(`callsUsed ${a.callsUsed} exceeds the envelope ceiling ${e.apiCallCeiling}`);
  if (a.blockedBeforeNetwork === null) a.failures.push("blockedBeforeNetwork missing");
  else if (a.blockedBeforeNetwork > 0) a.failures.push(`${a.blockedBeforeNetwork} request(s) were refused by the allow-list (the script tried something not permitted)`);
  const c = j.cleanup;
  if (plain(c)) {
    a.cleanup = {
      verifiedEmpty: c.verifiedEmpty === true, skipped: typeof c.skipped === "string" ? c.skipped : null, stoppedBecause: typeof c.stoppedBecause === "string" ? c.stoppedBecause : null,
      remaining: arr(c.remainingInvoices).length + arr(c.remainingCustomers).length, unverifiable: arr(c.unverifiable).length, deletedInvoices: arr(c.deletedInvoices).length, deletedCustomers: arr(c.deletedCustomers).length,
    };
    if (!a.cleanup.verifiedEmpty) a.failures.push("cleanup did not verify an empty account");
    if (a.cleanup.skipped) a.failures.push("cleanup was skipped");
    if (a.cleanup.stoppedBecause) a.failures.push("cleanup stopped early");
    if (a.cleanup.remaining > 0) a.failures.push(`${a.cleanup.remaining} object(s) remain at Stripe`);
  } else a.failures.push("evidence has no cleanup report");
  if (plain(j.abort)) {
    a.abort = { code: String(j.abort.code ?? "unknown"), message: String(j.abort.message ?? "") };
    a.failures.push(`run aborted: ${a.abort.code}`);
  }
  return a;
}

const DIAGNOSIS: Record<string, string> = {
  identity_mismatch: "The key does not belong to the pinned sandbox/connected account, or the connected account is not Express-equivalent. Stop: check the pinned ids and which sandbox the key was created in. No scenario ran.",
  identity_not_verified: "A request was attempted before the identity gate passed (script bug). Do not retry; report to the proof owner.",
  livemode_true: "A response reported livemode:true. Treat as a SAFETY incident: expire the key now, verify nothing was created, and do not run again until reviewed.",
  version_mismatch: "Stripe answered with a different API version than the pin. Check the sandbox/default version; the proof will not continue.",
  blocked_request: "The allow-list refused a request the script tried to send (script bug or hostile response). No cleanup call was made; reconcile manually.",
  budget_exceeded: "The call budget was exhausted. Inspect the transcript for retries/loops; reconcile manually.",
  unexpected_4xx_streak: "Repeated 4xx answers. Most likely a key-permission problem (the key lacks Invoices/Customers Write or connected-account Read).",
  server_error_streak: "Repeated 5xx answers from Stripe. Check status.stripe.com; unverifiable creates must be reconciled by hand.",
  rate_limited: "Stripe rate-limited the run. Wait and reconcile; a new run needs a fresh slot in the envelope.",
  interrupted: "The run was interrupted (Ctrl-C/termination). Cleanup may be incomplete: reconcile in the dashboard.",
  unexpected_error: "An unexpected error stopped the run. Read the redacted transcript; reconcile manually.",
  environment_refused: "The proof refused the environment (proxy/CA/NODE_OPTIONS/DB variable). Unexpected after sanitisation: investigate.",
  key_refused: "The proof refused the key shape (must be rk_test_).",
};
export const diagnose = (code: string | null | undefined): string => (code ? (DIAGNOSIS[code] ?? "Unknown abort code: read the redacted transcript.") : "No abort recorded.");

export type RunSummary = {
  status: DecisionStatus;
  statusReason: string;
  envelope: Envelope;
  runNo: number;
  runId: string;
  startedUtc: string;
  finishedUtc: string;
  childExitCode: number | null;
  analysis: Analysis | null;
  safetyFindings: Finding[];
  fileHashes: FileHash[];
  gates: Array<{ id: string; ok: boolean; detail: string }>;
  dry: boolean;
  runnerManifestSha256: string;
  blockedAt?: string;
};

/** Hard failures outrank unverifiable; BLOCKED means the runner refused before any live call (no run consumed). */
export function decide(s: Pick<RunSummary, "analysis" | "safetyFindings" | "childExitCode" | "blockedAt"> & { timedOut?: boolean }): { status: DecisionStatus; reason: string } {
  if (s.blockedAt) return { status: "BLOCKED", reason: `refused before any live call at gate ${s.blockedAt}` };
  if (hasSecretFinding(s.safetyFindings)) return { status: "FAIL", reason: "SAFETY: a secret-shaped value was found in the run output. Expire the key immediately." };
  // a timed-out child may still have been calling Stripe: never PASS, and never clean, whatever partial evidence exists
  if (s.timedOut) return { status: "UNVERIFIABLE", reason: "the proof timed out and was killed (process tree): calls and cleanup are unverified; the run stays open in the ledger until reconciled in the Stripe dashboard" };
  const a = s.analysis;
  if (!a || !a.evidenceParsed) return { status: "UNVERIFIABLE", reason: "no readable evidence: the outcome cannot be verified; reconcile in the dashboard" };
  const hardFail = Boolean(a.abort) || a.checks.fail > 0 || (a.callsUsed ?? 0) > a.ceiling || (a.blockedBeforeNetwork ?? 0) > 0 || a.manifestMatches === false || (a.cleanup?.remaining ?? 0) > 0 || a.failures.some((f) => /^verdict V\d is FAIL|^evidence mode/.test(f));
  if (hardFail) return { status: "FAIL", reason: a.failures[0] ?? "run failed" };
  if ((a.cleanup?.unverifiable ?? 0) > 0 || !a.cleanup?.verifiedEmpty || a.outcome !== "OK") return { status: "UNVERIFIABLE", reason: `${a.cleanup?.unverifiable ?? "?"} create response(s) unverifiable, or cleanup not verified empty, or outcome not OK` };
  if (s.childExitCode !== 0) return { status: "FAIL", reason: `proof exited with code ${s.childExitCode}` };
  if (a.failures.length > 0) return { status: "FAIL", reason: a.failures[0] };
  return { status: "PASS", reason: "outcome OK, every check passed, cleanup verified an empty account, within the call ceiling, no secret-shaped output" };
}

export const hashFile = (name: string, content: string | Uint8Array): FileHash => ({ name, sha256: sha256(content), bytes: typeof content === "string" ? Buffer.byteLength(content) : content.length });

/** Scans every captured output. Returns findings WITHOUT the matched text. */
export function redactionScan(outputs: Array<{ name: string; text: string }>, literals: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const o of outputs) for (const f of scanForSecrets(o.text, literals)) out.push({ ...f, kind: `${f.kind} @ ${o.name}` });
  return out;
}

export function keyExpiryReminder(e: Pick<Envelope, "credential" | "expiresUtc">, now: Date): string {
  const exp = Date.parse(e.credential.keyExpiresUtc);
  const days = Math.floor((exp - now.getTime()) / 86_400_000);
  const when = exp <= now.getTime() ? `ALREADY PAST (${e.credential.keyExpiresUtc})` : `${e.credential.keyExpiresUtc} (${days} day(s) left)`;
  return `OWNER: expire the restricted key in the Stripe dashboard now unless another run is still planned; its configured expiry is ${when}. Then delete the stored credential (provision --remove). Verify the connected account has no customers or invoices.`;
}

export function renderReport(s: RunSummary, now: Date): string {
  const a = s.analysis;
  const e = s.envelope;
  const L: string[] = [];
  L.push(`# D24 TEST runner report - ${s.status}`, "");
  L.push(`**Decision: ${s.status}** - ${s.statusReason}`, "");
  L.push("| Field | Value |", "|---|---|");
  L.push(`| Mode | ${s.dry ? "DRY (fake child, no credential store, no network)" : "LIVE Stripe TEST via proof --live"} |`);
  L.push(`| Envelope | ${e.envelopeId} (sha256 ${e.envelopeSha256.slice(0, 16)}), run ${s.runNo} of max ${e.maxRuns} |`);
  L.push(`| Run id | ${s.runId} |`, `| Started / finished (UTC) | ${s.startedUtc} / ${s.finishedUtc} |`);
  L.push(`| Pinned code | ${e.code.commitSha} |`, `| Proof manifest | ${e.proof.manifestSha256} |`, `| Runner folder manifest | ${s.runnerManifestSha256} |`);
  L.push(`| Child exit code | ${s.childExitCode} |`, "");
  L.push("## Gates", "", "| Gate | Result | Detail |", "|---|---|---|");
  for (const g of s.gates) L.push(`| ${g.id} | ${g.ok ? "PASS" : "FAIL"} | ${g.detail} |`);
  L.push("");
  if (a) {
    L.push("## Counts", "");
    L.push(`- Scenario checks: PASS ${a.checks.pass}, FAIL ${a.checks.fail}`);
    L.push(`- Verdicts: ${Object.entries(a.verdictCounts).map(([k, v]) => `${k} x${v}`).join(", ") || "none"}`);
    L.push(`- Requests: ${a.callsUsed ?? "?"} used of ceiling ${a.ceiling} (hard cap 40, 8 reserved for cleanup); refused before network (BLOCKED by allow-list): ${a.blockedBeforeNetwork ?? "?"}`);
    L.push(`- UNVERIFIABLE creates: ${a.cleanup?.unverifiable ?? "?"}`);
    L.push(`- V4 (ledger convergence): ${a.verdictV4}; V7 (operator attach): ${a.verdictV7}. The ledger half of V4/V7 is NOT TESTED by this proof revision regardless of a Stripe-side PASS.`, "");
    L.push("## Cleanup disposition", "");
    if (a.cleanup) {
      L.push(`- verifiedEmpty: ${a.cleanup.verifiedEmpty}; skipped: ${a.cleanup.skipped ?? "no"}; stopped early: ${a.cleanup.stoppedBecause ?? "no"}`);
      L.push(`- deleted invoices ${a.cleanup.deletedInvoices}, deleted customers ${a.cleanup.deletedCustomers}, remaining objects ${a.cleanup.remaining}`);
    } else L.push("- no cleanup report in the evidence: treat the account as NOT clean until checked in the dashboard");
    L.push("", "## Abort / failure diagnosis", "");
    L.push(a.abort ? `- abort ${a.abort.code}: ${diagnose(a.abort.code)}` : "- no abort recorded");
    for (const f of a.failures) L.push(`- ${f}`);
    L.push("");
  } else L.push("## Counts", "", "- no run evidence (refused before running, or no evidence written)", "");
  L.push("## Safety findings (redaction scan of all captured output)", "");
  if (s.safetyFindings.length === 0) L.push("- none: no key, webhook secret, bearer token, authorization header or email pattern found; the exact credential value was not present in any output");
  else for (const f of s.safetyFindings) L.push(`- ${f.severity.toUpperCase()}: ${f.kind} x${f.count}`);
  L.push("", "## Evidence hashes (SHA-256)", "");
  if (s.fileHashes.length === 0) L.push("- none");
  for (const h of s.fileHashes) L.push(`- ${h.sha256}  ${h.name} (${h.bytes} bytes)`);
  L.push("", "## Next steps", "", `- ${keyExpiryReminder(e, now)}`, "- The Stripe-side proof only; ledger / orchestrator behaviour is NOT TESTED.", "");
  return sanitize(L.join("\n"));
}
