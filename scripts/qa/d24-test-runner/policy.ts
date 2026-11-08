// Admin-owned policy ceilings (policy.json in the install root). Written only by the elevated installer; an envelope may be equal to or stricter than
// every value here, never looser. Pure apart from reading the installed proof's source for two constants.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSha256 } from "./installroot";
import { HARD_CEILING, MAX_LIFETIME_DAYS, MAX_RUNS_LIMIT, type Envelope } from "./envelope";

export type Policy = {
  v: 1;
  stripeMode: "test";
  keyKind: "rk_test";
  credentialStore: "dpapi-file";
  platformAcct: string;
  connectedAcct: string;
  /** must be <= the proof's HARD_CALL_CAP; the runner additionally requires the envelope ceiling to EQUAL the proof cap */
  maxCallsPerRun: number;
  maxRunsPerEnvelope: number;
  maxEnvelopeValidityDays: number;
  maxRunsPerDay: number;
  /** manifest sha256 of the proof folder: the request allow-list IS the proof's code */
  allowListSha256: string;
  /** highest total line amount (minor units) the proof's allow-list may permit */
  amountCeilingMinor: number;
  anchorFingerprint: string;
  runAsAccount: string;
  ownerAccount: string;
  /** the SIDs the ACL gate and the identity gate compare (names are display only) */
  runAsSid: string;
  ownerSid: string;
};
const KEYS = ["v", "stripeMode", "keyKind", "credentialStore", "platformAcct", "connectedAcct", "maxCallsPerRun", "maxRunsPerEnvelope", "maxEnvelopeValidityDays", "maxRunsPerDay", "allowListSha256", "amountCeilingMinor", "anchorFingerprint", "runAsAccount", "ownerAccount", "runAsSid", "ownerSid"];
const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LOCAL_SID = /^S-1-5-21(-\d+){4}$/;
const WIN_NAME = /^[A-Za-z0-9._-]{1,20}$/;

export function parsePolicy(raw: unknown, proofHardCap: number): { ok: true; policy: Policy } | { ok: false; problems: string[] } {
  const p: string[] = [];
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, problems: ["policy.json is not an object"] };
  for (const k of Object.keys(r)) if (!KEYS.includes(k)) p.push(`unknown policy field ${JSON.stringify(k.slice(0, 30))}`);
  for (const k of KEYS) if (!(k in r)) p.push(`missing policy field ${k}`);
  if (p.length > 0) return { ok: false, problems: p };
  const int = (k: string, lo: number, hi: number) => Number.isInteger(r[k]) && (r[k] as number) >= lo && (r[k] as number) <= hi;
  const capMax = Math.min(HARD_CEILING, proofHardCap);
  if (r.v !== 1) p.push("v must be 1");
  if (r.stripeMode !== "test") p.push('stripeMode must be exactly "test"');
  if (r.keyKind !== "rk_test") p.push('keyKind must be exactly "rk_test"');
  if (r.credentialStore !== "dpapi-file") p.push('credentialStore must be "dpapi-file" (the d24run-only store)');
  for (const k of ["platformAcct", "connectedAcct"]) if (typeof r[k] !== "string" || !ACCT.test(r[k] as string)) p.push(`${k} must be an acct_ id`);
  if (r.platformAcct === r.connectedAcct) p.push("platform and connected accounts must differ");
  if (!int("maxCallsPerRun", 1, capMax)) p.push(`maxCallsPerRun must be an integer 1..${capMax} (not above the proof's hard call cap)`);
  if (!int("maxRunsPerEnvelope", 1, MAX_RUNS_LIMIT)) p.push(`maxRunsPerEnvelope must be 1..${MAX_RUNS_LIMIT}`);
  if (!int("maxEnvelopeValidityDays", 1, MAX_LIFETIME_DAYS)) p.push(`maxEnvelopeValidityDays must be 1..${MAX_LIFETIME_DAYS}`);
  if (!int("maxRunsPerDay", 1, MAX_RUNS_LIMIT)) p.push(`maxRunsPerDay must be 1..${MAX_RUNS_LIMIT}`);
  if (typeof r.allowListSha256 !== "string" || !HEX64.test(r.allowListSha256)) p.push("allowListSha256 must be 64 hex");
  if (!int("amountCeilingMinor", 1, 1_000_000)) p.push("amountCeilingMinor must be an integer 1..1000000");
  if (typeof r.anchorFingerprint !== "string" || !HEX64.test(r.anchorFingerprint)) p.push("anchorFingerprint must be 64 hex");
  for (const k of ["runAsAccount", "ownerAccount"]) if (typeof r[k] !== "string" || !WIN_NAME.test(r[k] as string)) p.push(`${k} must be a plain Windows account name`);
  if (typeof r.runAsAccount === "string" && typeof r.ownerAccount === "string" && r.runAsAccount.toLowerCase() === r.ownerAccount.toLowerCase()) p.push("the run-as account must differ from the owner account");
  for (const k of ["runAsSid", "ownerSid"]) if (typeof r[k] !== "string" || !LOCAL_SID.test(r[k] as string)) p.push(`${k} must be a local-account SID (S-1-5-21-...)`);
  if (r.runAsSid === r.ownerSid) p.push("the run-as SID must differ from the owner SID");
  return p.length > 0 ? { ok: false, problems: p } : { ok: true, policy: r as unknown as Policy };
}
export const policySha256 = (p: Policy) => jsonSha256(p);
export const policyText = (p: Policy) => `${JSON.stringify(p, null, 2)}\n`;

/** The proof's enforced per-invoice cap, read from the (hash-verified) installed allow-list source. null when unreadable. */
export function proofMaxLineCents(proofDir: string): number | null {
  try {
    const m = /maxLineCents:\s*([\d_]+)/.exec(readFileSync(join(proofDir, "allowlist.ts"), "utf8"));
    const n = m ? Number(m[1].replace(/_/g, "")) : NaN;
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}
export function proofHardCap(proofDir: string): number | null {
  try {
    const n = Number(/HARD_CALL_CAP\s*=\s*(\d+)/.exec(readFileSync(join(proofDir, "config.ts"), "utf8"))?.[1] ?? NaN);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export type ClampCtx = { proofManifestSha256: string; proofMaxLineCents: number | null; evidenceRootAllowed: (p: string) => boolean; runsToday: number };
/** Reasons the envelope exceeds the policy (empty = within every ceiling). The envelope is never modified: it is refused, not silently narrowed. */
export function clampEnvelopeToPolicy(e: Envelope, pol: Policy, c: ClampCtx): string[] {
  const out: string[] = [];
  if (e.mode !== "TEST") out.push("mode is not TEST");
  if (e.accounts.platformAcct !== pol.platformAcct) out.push("platform account is not the policy pin");
  if (e.accounts.connectedAcct !== pol.connectedAcct) out.push("connected account is not the policy pin");
  if (e.apiCallCeiling > pol.maxCallsPerRun) out.push(`apiCallCeiling ${e.apiCallCeiling} exceeds the policy ceiling ${pol.maxCallsPerRun}`);
  if (e.maxRuns > pol.maxRunsPerEnvelope) out.push(`maxRuns ${e.maxRuns} exceeds the policy ceiling ${pol.maxRunsPerEnvelope}`);
  const days = (Date.parse(e.expiresUtc) - Date.parse(e.createdUtc)) / 86_400_000;
  if (!(days <= pol.maxEnvelopeValidityDays)) out.push(`validity ${days.toFixed(2)} days exceeds the policy ceiling ${pol.maxEnvelopeValidityDays}`);
  if (c.runsToday >= pol.maxRunsPerDay) out.push(`${c.runsToday} runs already started today; the policy allows ${pol.maxRunsPerDay} per day`);
  if (e.proof.manifestSha256 !== pol.allowListSha256) out.push("the envelope's proof manifest is not the one the policy pins (the allow-list is the proof's code)");
  if (c.proofManifestSha256 !== pol.allowListSha256) out.push("the installed proof folder is not the one the policy pins");
  if (c.proofMaxLineCents === null || c.proofMaxLineCents > pol.amountCeilingMinor) out.push(`the proof's per-invoice cap (${c.proofMaxLineCents ?? "unreadable"}) exceeds the policy amount ceiling ${pol.amountCeilingMinor}`);
  if (e.hardwareAnchorFingerprintSha256 !== pol.anchorFingerprint) out.push("the envelope names a different hardware anchor than the policy pin");
  if (e.credential.keyKind !== pol.keyKind) out.push("key kind is not rk_test");
  if (e.credential.store !== pol.credentialStore) out.push(`credential store must be ${pol.credentialStore} for installed runs`);
  if (!c.evidenceRootAllowed(e.evidenceRoot)) out.push("evidenceRoot is not inside the install root's evidence directory");
  return out;
}
