// Authorization envelope: the ONLY thing that authorises a TEST run. Pure validation, no I/O, no credential access.
// The runner can validate and enforce an envelope but cannot mint an owner approval: the approval text is supplied verbatim by a human
// (see createEnvelope) and must name the exact terms below, so an old approval cannot be reused for different terms.

import { AUTHORIZATION_PHRASE } from "../d24-m3d-proof/identity";
import { canonicalJson, sha256 } from "./canon";

/** Every rule id the proof's allow-list may contain (read-only identity reads, proof-created customers/draft invoices, two expected-403 reads). */
export const KNOWN_RULE_IDS = Object.freeze([
  "identity.platform", "identity.connected", "customer.create", "customer.delete", "invoice.create_draft", "invoice.add_lines",
  "invoice.read", "invoice.list_by_customer", "invoice.delete_draft", "negative.transfers", "negative.webhook_endpoints",
] as const);

/** Operation names that are fee-bearing, financial mutations or LIVE-mode and can NEVER appear in an envelope (named for clearer refusals). */
export const FORBIDDEN_OP_WORDS = /(finalize|send|pay|void|mark_uncollectible|refund|payout|charge|credit_note|subscription|capture|cancel|attach|payment|price|product|live|balance|api_key)/i;

export const REQUIRED_STOP_CONDITIONS = Object.freeze(["any-abort", "livemode-true", "identity-mismatch", "cleanup-unverified", "secret-in-output", "call-ceiling"] as const);
export const HARD_CEILING = 40;
export const CLEANUP_RESERVE = 8;
export const MAX_RUNS_LIMIT = 5;
export const MAX_LIFETIME_DAYS = 30;

export type ManualAttestation = { statement: string; attestedBy: string; reference: string };
export type Envelope = {
  schemaVersion: 1;
  envelopeId: string;
  mode: "TEST";
  createdUtc: string;
  expiresUtc: string;
  code: { commitSha: string; lockfileSha256: string };
  proof: { manifestSha256: string; fileCount: number };
  /** Hash of the runner folder itself (this enforcement code, excluding __tests__): a modified runner cannot run under an approved envelope. */
  runner: { manifestSha256: string; fileCount: number };
  accounts: { platformAcct: string; connectedAcct: string };
  permittedRuleIds: string[];
  apiCallCeiling: number;
  cleanupReserve: number;
  credential: { store: "windows-credential-manager" | "dpapi-file"; label: string; keyKind: "rk_test"; keyFingerprintSha256Prefix: string; keyExpiresUtc: string };
  cleanup: { required: true; mustVerifyEmpty: true };
  forbidden: { feeBearing: true; financialMutation: true; liveMode: true };
  stopConditions: string[];
  maxRuns: number;
  evidenceRoot: string;
  manualAttestations: Record<string, ManualAttestation>;
  ownerApproval: { text: string; textSha256: string; reference: string };
  envelopeSha256: string;
};

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;
export const LABEL_RE = /^[A-Za-z0-9._-]{3,64}$/;
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isAbs = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");

export const envelopeHash = (e: Omit<Envelope, "envelopeSha256"> | Envelope): string => {
  const rest: Record<string, unknown> = { ...(e as unknown as Record<string, unknown>) };
  delete rest.envelopeSha256;
  return sha256(canonicalJson(rest));
};

/** Every security-relevant field the owner approves, in one digest (everything except the approval record itself). */
const MATERIAL_KEYS = ["envelopeId", "createdUtc", "expiresUtc", "code", "proof", "runner", "accounts", "permittedRuleIds", "apiCallCeiling", "cleanupReserve", "credential", "stopConditions", "maxRuns", "evidenceRoot", "manualAttestations"] as const;
export function materialDigest(e: Record<string, unknown>): string {
  const m: Record<string, unknown> = {};
  for (const k of MATERIAL_KEYS) m[k] = e[k];
  return sha256(canonicalJson(m));
}

/** The tokens the owner's approval text must contain. The owner approves THIS text; the runner never generates the approval itself. */
export function approvalTokens(e: Pick<Envelope, "envelopeId" | "code" | "proof" | "maxRuns" | "expiresUtc">): string[] {
  const digest = materialDigest(e as unknown as Record<string, unknown>);
  return [AUTHORIZATION_PHRASE, `envelope=${e.envelopeId}`, `code=${e.code.commitSha.slice(0, 12)}`, `manifest=${e.proof.manifestSha256.slice(0, 12)}`, `maxRuns=${e.maxRuns}`, `expires=${e.expiresUtc}`, `terms=${digest.slice(0, 16)}`];
}
export const approvalTemplate = (e: Parameters<typeof approvalTokens>[0]): string => approvalTokens(e).join(" ");

export type EnvelopeIssue = { code: string; detail: string };

/** Structural + policy validation. Does NOT check expiry against the clock (see checkEnvelopeWindow) or run counts (ledger). */
export function validateEnvelope(raw: unknown): { ok: true; envelope: Envelope } | { ok: false; issues: EnvelopeIssue[] } {
  const issues: EnvelopeIssue[] = [];
  const bad = (code: string, detail: string) => issues.push({ code, detail });
  if (!plain(raw)) return { ok: false, issues: [{ code: "shape", detail: "envelope is not a JSON object" }] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = raw as Record<string, any>;
  const allowedTop = ["schemaVersion", "envelopeId", "mode", "createdUtc", "expiresUtc", "code", "proof", "runner", "accounts", "permittedRuleIds", "apiCallCeiling", "cleanupReserve", "credential", "cleanup", "forbidden", "stopConditions", "maxRuns", "evidenceRoot", "manualAttestations", "ownerApproval", "envelopeSha256"];
  for (const k of Object.keys(e)) if (!allowedTop.includes(k)) bad("unknown-field", `unknown top-level field ${JSON.stringify(k.slice(0, 40))}`);
  for (const k of allowedTop) if (!(k in e)) bad("missing-field", `missing ${k}`);
  if (issues.length > 0) return { ok: false, issues };

  if (e.schemaVersion !== 1) bad("schema-version", "schemaVersion must be 1");
  if (e.mode !== "TEST") bad("mode", 'mode must be exactly "TEST" (LIVE mode can never be authorised by an envelope)');
  if (typeof e.envelopeId !== "string" || !/^[a-z0-9-]{6,40}$/.test(e.envelopeId)) bad("envelope-id", "envelopeId must match [a-z0-9-]{6,40}");
  for (const k of ["createdUtc", "expiresUtc"] as const) if (typeof e[k] !== "string" || !ISO.test(e[k]) || Number.isNaN(Date.parse(e[k]))) bad("timestamp", `${k} must be an ISO-8601 UTC timestamp ending in Z`);
  if (typeof e.createdUtc === "string" && typeof e.expiresUtc === "string" && ISO.test(e.createdUtc) && ISO.test(e.expiresUtc)) {
    const span = Date.parse(e.expiresUtc) - Date.parse(e.createdUtc);
    if (span <= 0) bad("expiry", "expiresUtc must be after createdUtc");
    if (span > MAX_LIFETIME_DAYS * 86_400_000) bad("expiry", `an envelope may live at most ${MAX_LIFETIME_DAYS} days (a standing envelope is never unlimited)`);
  }
  if (!plain(e.code) || typeof e.code.commitSha !== "string" || !HEX(40).test(e.code.commitSha)) bad("code-sha", "code.commitSha must be a full 40-hex commit id");
  if (plain(e.code) && !(typeof e.code.lockfileSha256 === "string" && HEX(64).test(e.code.lockfileSha256))) bad("lockfile", "code.lockfileSha256 is required and must be 64 hex");
  if (!plain(e.runner) || typeof e.runner.manifestSha256 !== "string" || !HEX(64).test(e.runner.manifestSha256) || !(Number.isInteger(e.runner.fileCount) && Number(e.runner.fileCount) > 0)) bad("runner", "runner.manifestSha256 (64 hex) and runner.fileCount are required");
  if (!plain(e.proof) || typeof e.proof.manifestSha256 !== "string" || !HEX(64).test(e.proof.manifestSha256)) bad("manifest", "proof.manifestSha256 must be 64 hex");
  if (plain(e.proof) && !(Number.isInteger(e.proof.fileCount) && Number(e.proof.fileCount) > 0)) bad("manifest", "proof.fileCount must be a positive integer");
  if (!plain(e.accounts) || !ACCT.test(String(e.accounts.platformAcct)) || !ACCT.test(String(e.accounts.connectedAcct))) bad("accounts", "accounts.platformAcct and accounts.connectedAcct must be acct_ ids");
  else if (e.accounts.platformAcct === e.accounts.connectedAcct) bad("accounts", "platform and connected account ids must differ");

  if (!Array.isArray(e.permittedRuleIds) || e.permittedRuleIds.length === 0 || !e.permittedRuleIds.every((x: unknown) => typeof x === "string")) bad("rules", "permittedRuleIds must be a non-empty string array");
  else {
    const ids: string[] = e.permittedRuleIds;
    if (new Set(ids).size !== ids.length) bad("rules", "permittedRuleIds has duplicates");
    for (const id of ids) {
      if (!(KNOWN_RULE_IDS as readonly string[]).includes(id)) bad("unknown-operation", `operation ${JSON.stringify(id.slice(0, 60))} is not a known proof rule id${FORBIDDEN_OP_WORDS.test(id) ? " and names a fee-bearing, financial or LIVE operation (never permitted)" : ""}`);
    }
    if (JSON.stringify([...ids].sort()) !== JSON.stringify(ids)) bad("rules", "permittedRuleIds must be sorted");
  }
  if (!Number.isInteger(e.apiCallCeiling) || e.apiCallCeiling < 1 || e.apiCallCeiling > HARD_CEILING) bad("ceiling", `apiCallCeiling must be an integer 1..${HARD_CEILING} (cleanup calls included)`);
  if (e.cleanupReserve !== CLEANUP_RESERVE) bad("ceiling", `cleanupReserve must be ${CLEANUP_RESERVE}`);
  if (Number.isInteger(e.apiCallCeiling) && e.apiCallCeiling <= CLEANUP_RESERVE) bad("ceiling", "apiCallCeiling must exceed the cleanup reserve");

  const c = e.credential;
  if (!plain(c)) bad("credential", "credential must be an object");
  else {
    if (c.store !== "windows-credential-manager" && c.store !== "dpapi-file") bad("credential", "credential.store must be windows-credential-manager or dpapi-file");
    if (typeof c.label !== "string" || !LABEL_RE.test(c.label)) bad("credential", "credential.label must match [A-Za-z0-9._-]{3,64}");
    if (c.keyKind !== "rk_test") bad("credential", 'credential.keyKind must be "rk_test" (restricted TEST key; sk_, pk_ and live keys are refused)');
    if (typeof c.keyFingerprintSha256Prefix !== "string" || !HEX(16).test(c.keyFingerprintSha256Prefix)) bad("credential", "credential.keyFingerprintSha256Prefix must be 16 hex");
    if (typeof c.keyExpiresUtc !== "string" || !ISO.test(c.keyExpiresUtc)) bad("credential", "credential.keyExpiresUtc must be an ISO UTC timestamp");
    else if (typeof e.expiresUtc === "string" && ISO.test(e.expiresUtc) && Date.parse(c.keyExpiresUtc) < Date.parse(e.expiresUtc)) bad("credential", "the key must outlive the envelope (keyExpiresUtc >= expiresUtc) or the envelope is not enforceable");
  }
  if (!plain(e.cleanup) || e.cleanup.required !== true || e.cleanup.mustVerifyEmpty !== true) bad("cleanup", "cleanup.required and cleanup.mustVerifyEmpty must both be true");
  if (!plain(e.forbidden) || e.forbidden.feeBearing !== true || e.forbidden.financialMutation !== true || e.forbidden.liveMode !== true) bad("forbidden", "forbidden.feeBearing/financialMutation/liveMode must all be true");
  if (!Array.isArray(e.stopConditions) || !(REQUIRED_STOP_CONDITIONS as readonly string[]).every((s) => e.stopConditions.includes(s))) bad("stop-conditions", `stopConditions must include: ${REQUIRED_STOP_CONDITIONS.join(", ")}`);
  if (!Number.isInteger(e.maxRuns) || e.maxRuns < 1 || e.maxRuns > MAX_RUNS_LIMIT) bad("max-runs", `maxRuns must be an integer 1..${MAX_RUNS_LIMIT} (never unlimited)`);
  if (typeof e.evidenceRoot !== "string" || !isAbs(e.evidenceRoot) || e.evidenceRoot.split(/[\\/]/).includes("..")) bad("evidence-root", "evidenceRoot must be an absolute path without .. segments");
  if (!plain(e.manualAttestations)) bad("manual", "manualAttestations must be an object");
  else {
    for (const [id, a] of Object.entries(e.manualAttestations)) {
      if (!plain(a) || typeof a.statement !== "string" || a.statement.length < 10 || typeof a.attestedBy !== "string" || a.attestedBy.length < 2 || typeof a.reference !== "string" || a.reference.length < 3) bad("manual", `attestation ${JSON.stringify(id.slice(0, 40))} needs statement, attestedBy and reference`);
    }
  }
  const a = e.ownerApproval;
  if (!plain(a) || typeof a.text !== "string" || typeof a.textSha256 !== "string" || typeof a.reference !== "string" || a.reference.length < 3) bad("approval", "ownerApproval needs text, textSha256 and reference");
  else {
    if (sha256(a.text) !== a.textSha256) bad("approval", "ownerApproval.textSha256 does not match the recorded text (approval text was altered)");
    if (issues.every((i) => !["envelope-id", "code-sha", "manifest", "max-runs", "timestamp", "lockfile", "runner", "accounts", "rules", "ceiling", "credential", "evidence-root", "manual", "stop-conditions"].includes(i.code))) {
      for (const t of approvalTokens(e as Envelope)) if (!a.text.includes(t)) bad("approval", `ownerApproval.text does not contain the term ${JSON.stringify(t.length > 60 ? t.slice(0, 60) : t)} (the approval must name the exact terms)`);
    }
  }
  if (issues.length === 0 && envelopeHash(e as Envelope) !== e.envelopeSha256) bad("hash", "envelopeSha256 does not match the canonical hash of the envelope (it was edited after creation)");
  return issues.length > 0 ? { ok: false, issues } : { ok: true, envelope: e as Envelope };
}

/** Clock check, separate so tests can inject `now`. */
export function checkEnvelopeWindow(e: Envelope, now: Date): EnvelopeIssue[] {
  const out: EnvelopeIssue[] = [];
  if (now.getTime() >= Date.parse(e.expiresUtc)) out.push({ code: "expired", detail: `envelope expired at ${e.expiresUtc}` });
  if (now.getTime() < Date.parse(e.createdUtc) - 5 * 60_000) out.push({ code: "not-yet-valid", detail: "envelope createdUtc is in the future" });
  if (now.getTime() >= Date.parse(e.credential.keyExpiresUtc)) out.push({ code: "key-expired", detail: `the credential was due to expire at ${e.credential.keyExpiresUtc}` });
  return out;
}

export type EnvelopeSpec = Omit<Envelope, "envelopeSha256" | "ownerApproval" | "schemaVersion" | "mode" | "cleanup" | "forbidden">;

/**
 * Builds an envelope from a spec plus an owner approval text supplied by a human. The runner never invents the text: term-less text is refused
 * by validation. NOTE: the approval text is NOT the control (anything that can write a file can write it). The control is the detached owner
 * Ed25519 signature over `envelopeSha256` (see ownersig.ts), which the runner verifies against a pinned public key before any live run.
 */
export function createEnvelope(spec: EnvelopeSpec, approvalText: string, approvalReference: string): { ok: true; envelope: Envelope } | { ok: false; issues: EnvelopeIssue[] } {
  const base = {
    schemaVersion: 1 as const,
    mode: "TEST" as const,
    cleanup: { required: true as const, mustVerifyEmpty: true as const },
    forbidden: { feeBearing: true as const, financialMutation: true as const, liveMode: true as const },
    ...spec,
    ownerApproval: { text: approvalText, textSha256: sha256(approvalText), reference: approvalReference },
  };
  const envelope = { ...base, envelopeSha256: envelopeHash(base as unknown as Envelope) } as Envelope;
  return validateEnvelope(envelope);
}
