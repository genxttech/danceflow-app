/**
 * TW-4F pilot approval evidence (owner decision U-4) and the ONE approval-reference length shared by the UI, the server action, the store and the database
 * (docs/twilio/TW-4F_RFL_Pilot_Approval_Evidence.md). Pure module: no server-only imports, so the form and the tests can use the same constants as the action.
 *
 * A written approval reference alone is not authorization. The pilot cover records the owner's dated written authorization as hashed evidence:
 * the authorization date, the authorizing role as stated, the scope, the amount in cents (the database requires it to EQUAL the published price), the period, a reference
 * to the retained document and the sha256 of its text. The text itself is never collected, sent or stored.
 */

/** The approval reference length in every layer (counted in characters after trimming, like the database's char_length(btrim(...))). */
export const APPROVAL_REF_MIN = 10;
export const APPROVAL_REF_MAX = 200;

/** The authorization may not be older than this many days (database: 400 days before the UTC date). */
export const EVIDENCE_MAX_AGE_DAYS = 400;

export const EVIDENCE_ROLES = ["founder_written", "owner_written"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export const EVIDENCE_SCOPES = ["pilot_period_cover"] as const;
export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number];

export const EVIDENCE_ROLE_LABEL: Record<EvidenceRole, string> = {
  founder_written: "Founder, in writing",
  owner_written: "Studio owner, in writing",
};

/** An opaque document id (6 to 120 characters) or a plain https link without a query string or credentials (the database applies the same two patterns). */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#=+-]{5,119}$/;
export const DOCUMENT_LINK_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/;
export const DOCUMENT_REF_MAX = 500;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Length in characters (code points), as the database counts. */
export const charLength = (s: string): number => Array.from(s).length;

export const approvalRefInRange = (ref: string): boolean => {
  const n = charLength(ref.trim());
  return n >= APPROVAL_REF_MIN && n <= APPROVAL_REF_MAX;
};

export const documentRefValid = (ref: string): boolean => ref.length <= DOCUMENT_REF_MAX && ((DOCUMENT_ID_PATTERN.test(ref) && !ref.includes("://")) || DOCUMENT_LINK_PATTERN.test(ref));

export type PilotEvidenceInput = {
  authorizedOn: string;
  authorizedByRole: string;
  scope: string;
  amountCents: string | number;
  periodKey: string;
  documentRef: string;
  documentSha256: string;
};

export type PilotEvidence = {
  authorizedOn: string;
  authorizedByRole: EvidenceRole;
  scope: EvidenceScope;
  amountCents: number;
  periodKey: string;
  documentRef: string;
  documentSha256: string;
};

/** "25", "25.0" or "25.00" (dollars, no sign, no separators) to whole cents; null for anything else. The operator types dollars; the database compares the cents with the published price. */
export function usdToCents(raw: string): number | null {
  const m = /^([0-9]{1,5})(?:\.([0-9]{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * Server-side shape check of the evidence (the database repeats every rule and additionally requires the amount to equal the published price and the period to equal the
 * cover's period). Returns a fixed sentence on refusal; nothing is echoed back.
 */
export function validatePilotEvidence(input: PilotEvidenceInput, periodKey: string, nowMs: number): { ok: true; value: PilotEvidence } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  const m = ISO_DATE.exec(input.authorizedOn.trim());
  if (!m) return bad("Give the date of the owner's written authorization.");
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return bad("The authorization date is not a real date.");
  // the database allows one day of slack beyond the UTC date (a business can already be on the next calendar day)
  if (utcDay(ms) > utcDay(nowMs) + 1) return bad("The authorization date is in the future.");
  if (utcDay(ms) < utcDay(nowMs) - EVIDENCE_MAX_AGE_DAYS) return bad(`The authorization is older than ${EVIDENCE_MAX_AGE_DAYS} days: obtain a current written authorization.`);
  const role = input.authorizedByRole.trim();
  if (!(EVIDENCE_ROLES as readonly string[]).includes(role)) return bad("Choose who authorized this in writing (founder or studio owner).");
  const scope = input.scope.trim();
  if (!(EVIDENCE_SCOPES as readonly string[]).includes(scope)) return bad("The scope must be a pilot period cover.");
  const rawAmount = String(input.amountCents).trim();
  if (!/^[0-9]{1,7}$/.test(rawAmount) || Number(rawAmount) <= 0) return bad("Give the authorized amount in dollars. It must equal the published price.");
  if (!PERIOD.test(input.periodKey.trim()) || input.periodKey.trim() !== periodKey) return bad("The authorized period must be the period being covered.");
  const documentRef = input.documentRef.trim();
  if (!documentRefValid(documentRef)) return bad("Give the retained document as an id (6 to 120 letters, digits or . _ : / # = + -) or a plain https link without a query string or credentials.");
  const sha = input.documentSha256.trim();
  if (!SHA256_PATTERN.test(sha)) return bad("Give the sha256 of the retained authorization text: 64 lowercase hex characters.");
  return {
    ok: true,
    value: {
      authorizedOn: input.authorizedOn.trim(), authorizedByRole: role as EvidenceRole, scope: scope as EvidenceScope, amountCents: Number(rawAmount), periodKey,
      documentRef, documentSha256: sha,
    },
  };
}
