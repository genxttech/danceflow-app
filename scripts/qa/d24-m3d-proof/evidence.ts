// Evidence handling (plan section 9). The run writes a redacted evidence pack ONLY when the owner sets D24_PROOF_EVIDENCE_DIR; otherwise nothing is written.
// The directory must be absolute and, after resolving links and junctions, outside this checkout and outside ANY git checkout or worktree (so the pack can never
// be committed). No key, no Authorization header, no webhook secret, no email and no full idempotency key is ever written or printed; account ids are masked
// everywhere (files and terminal).

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redactText } from "./redact";

export const EVIDENCE_ENV = "D24_PROOF_EVIDENCE_DIR";

/** Account ids are identifiers, not secrets, but they are masked anyway: short ids keep 2 characters, longer ones 3 + the last 2 (at least 6 characters hidden). */
export function maskAccountIds(s: string): string {
  return s.replace(/acct_[A-Za-z0-9]{6,}/g, (m) => {
    const body = m.slice(5);
    return body.length < 12 ? `acct_${body.slice(0, 2)}…` : `acct_${body.slice(0, 3)}…${body.slice(-2)}`;
  });
}

/** Everything printed or written passes through this: secrets removed, account ids masked. */
export function sanitize(s: string): string {
  return maskAccountIds(redactText(s));
}

/** The nearest ancestor of `p` that exists, resolved through links and junctions. */
function realExisting(p: string): string {
  let cur = resolve(p);
  for (;;) {
    if (existsSync(cur)) return realpathSync(cur);
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

const GIT_ENTRY = ".git";

/** null = acceptable. */
export function evidenceDirProblem(dir: string | undefined, repoRoot: string): string | null {
  if (dir === undefined || dir === "") return null;
  if (!isAbsolute(dir)) return `${EVIDENCE_ENV} must be an absolute path`;
  const real = realExisting(dir);
  const root = realExisting(repoRoot);
  const rel = relative(root, real);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return `${EVIDENCE_ENV} must be outside the repository so evidence can never be committed`;
  for (let cur = real; ; cur = dirname(cur)) {
    if (existsSync(join(cur, GIT_ENTRY))) return `${EVIDENCE_ENV} is inside a git checkout or worktree (${cur}); choose a directory outside any repository`;
    if (dirname(cur) === cur) break;
  }
  return null;
}

export type EvidenceInput = {
  runId: string;
  mode: "dry-run" | "live";
  scriptSha256: string;
  apiVersionPinned: string;
  apiVersionsReported: string[];
  callsUsed: number;
  blocked: number;
  scenarios: unknown;
  verdicts: unknown;
  cleanup: unknown;
  abort: { code: string; message: string } | null;
  /** OK only when nothing aborted, every check passed AND cleanup verified the account empty */
  outcome: "OK" | "FAILED";
  transcriptText: string;
  finishedUtc: string;
};

/**
 * Re-validates the directory immediately before writing (a live run lasts minutes: a link swapped in meanwhile is caught), creates it, validates the resolved
 * real directory again, and writes only into that real directory with exclusive-create (an existing file or a pre-planted link is never written through).
 */
export function writeEvidence(dir: string, e: EvidenceInput, repoRoot: string): { json: string; transcript: string } {
  const before = evidenceDirProblem(dir, repoRoot);
  if (before) throw new Error(before);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realDir = realpathSync(dir);
  const after = evidenceDirProblem(realDir, repoRoot);
  if (after) throw new Error(after);
  const body = {
    outcome: e.outcome,
    runId: e.runId,
    mode: e.mode,
    finishedUtc: e.finishedUtc,
    scriptManifestSha256: e.scriptSha256,
    stripeApiVersionPinned: e.apiVersionPinned,
    stripeApiVersionsReportedByStripe: e.apiVersionsReported,
    accountDefaultApiVersion: "RECORD BY HAND from the dashboard (the proof pins its own version on every request)",
    callsUsed: e.callsUsed,
    blockedBeforeNetwork: e.blocked,
    scenarios: e.scenarios,
    verdicts: e.verdicts,
    cleanup: e.cleanup,
    abort: e.abort,
    ownerAfterwards: "expire the restricted key, clear the shell variable and its history entry, verify the connected account has no invoices or customers",
  };
  const json = join(realDir, `evidence-${e.runId}.json`);
  const transcript = join(realDir, `transcript-${e.runId}.txt`);
  writeFileSync(json, sanitize(JSON.stringify(body, null, 2)), { mode: 0o600, flag: "wx" });
  writeFileSync(transcript, sanitize(e.transcriptText), { mode: 0o600, flag: "wx" });
  return { json, transcript };
}
