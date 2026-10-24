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
/** Every pilot spend approval carries evidence (20261230): the scope names the action. */
export const EVIDENCE_SCOPES = ["pilot_exception", "pilot_onboarding_fee", "pilot_campaign_fee", "pilot_number_purchase", "pilot_period_cover"] as const;
export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number];
export const COVER_SCOPES: readonly EvidenceScope[] = ["pilot_period_cover"];
export const EXCEPTION_SCOPES: readonly EvidenceScope[] = ["pilot_exception"];
export const SPEND_SCOPES: readonly EvidenceScope[] = ["pilot_onboarding_fee", "pilot_campaign_fee", "pilot_number_purchase", "pilot_period_cover"];

/**
 * The fee kinds each spend scope allows (the database applies the same map). EXHAUSTIVE and fail closed: a scope or a kind outside the map is refused, never defaulted.
 * `pilot_exception` allows no fee kind (it is not a fee).
 */
export const SCOPE_KINDS: Record<EvidenceScope, readonly string[]> = {
  pilot_exception: [],
  pilot_onboarding_fee: ["brand", "brand_low_volume"],
  pilot_campaign_fee: ["campaign_vetting", "monthly", "monthly_low_volume"],
  pilot_number_purchase: ["number"],
  pilot_period_cover: ["number", "monthly", "monthly_low_volume"],
};
export const scopeAllowsKind = (scope: string, kind: string): boolean => (EVIDENCE_SCOPES as readonly string[]).includes(scope) && SCOPE_KINDS[scope as EvidenceScope].includes(kind);
export const SCOPE_LABEL: Record<EvidenceScope, string> = {
  pilot_exception: "Pilot exception (the ceiling)",
  pilot_onboarding_fee: "Onboarding fee (brand registration)",
  pilot_campaign_fee: "Campaign fee (vetting or monthly)",
  pilot_number_purchase: "Phone number purchase",
  pilot_period_cover: "Period cover",
};
/** The scopes an operator may choose for one fee kind (what the form offers). */
export const scopesForKind = (kind: string): EvidenceScope[] => SPEND_SCOPES.filter((s) => scopeAllowsKind(s, kind) && s !== "pilot_period_cover");

export const EVIDENCE_ROLE_LABEL: Record<EvidenceRole, string> = {
  founder_written: "Founder, in writing",
  owner_written: "Studio owner, in writing",
};

/** An opaque document id (6 to 120 characters) or a plain https link without a query string or credentials (the database applies the same two patterns). */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$/;
/** No query string, fragment, credentials, percent-escapes, semicolons, ampersands or equals signs: the link is stored permanently and must never carry a token or a name. */
export const DOCUMENT_LINK_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~!$'()*+,:@/-]*)?$/;
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

export const documentRefValid = (ref: string): boolean => ref.length <= DOCUMENT_REF_MAX && (DOCUMENT_ID_PATTERN.test(ref) || DOCUMENT_LINK_PATTERN.test(ref));

export type PilotEvidenceInput = {
  authorizedOn: string;
  authorizedByRole: string;
  scope: string;
  amountCents: string | number;
  /** The period named by the authorization (a period cover only); null or empty for every other scope. */
  periodKey: string | null;
  documentRef: string;
  documentSha256: string;
};

export type PilotEvidence = {
  authorizedOn: string;
  authorizedByRole: EvidenceRole;
  scope: EvidenceScope;
  amountCents: number;
  periodKey: string | null;
  documentRef: string;
  documentSha256: string;
};

/** "25", "25.0" or "25.00" (dollars, no sign, no separators) to whole cents; null for anything else. The operator types dollars; the database compares the cents with the published price. */
export function usdToCents(raw: string): number | null {
  const m = /^([0-9]{1,5})(?:\.([0-9]{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

/** Whole cents to the dollar text `usdToCents` reads back ("2500" to "25.00"); null unless a positive whole number of cents the form accepts (up to $99,999.99). */
export function centsToUsd(cents: number | null | undefined): string | null {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0 || cents > 9_999_999) return null;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

const DAY_MS =86_400_000;
const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * Server-side shape check of the evidence (the database repeats every rule and additionally requires the amount to equal the published price and the period to equal the
 * cover's period). Returns a fixed sentence on refusal; nothing is echoed back.
 */
export function validatePilotEvidence(
  input: PilotEvidenceInput, periodKey: string | null, nowMs: number, allowedScopes: readonly EvidenceScope[] = COVER_SCOPES,
): { ok: true; value: PilotEvidence } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  const m = ISO_DATE.exec(input.authorizedOn.trim());
  if (!m) return bad("Give the date of the owner's written authorization.");
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return bad("The authorization date is not a real date.");
  // not later than the UTC date (the database applies the same rule; the pilot business is behind UTC, so its local date never exceeds it)
  if (utcDay(ms) > utcDay(nowMs)) return bad("The authorization date is in the future.");
  if (utcDay(ms) < utcDay(nowMs) - EVIDENCE_MAX_AGE_DAYS) return bad(`The authorization is older than ${EVIDENCE_MAX_AGE_DAYS} days: obtain a current written authorization.`);
  const role = input.authorizedByRole.trim();
  if (!(EVIDENCE_ROLES as readonly string[]).includes(role)) return bad("Choose who authorized this in writing (founder or studio owner).");
  const scope = input.scope.trim();
  if (!(allowedScopes as readonly string[]).includes(scope)) return bad("Choose what the written authorization covers.");
  const rawAmount = String(input.amountCents).trim();
  if (!/^[0-9]{1,7}$/.test(rawAmount) || Number(rawAmount) <= 0) return bad("Give the authorized amount in dollars. It must equal the published price.");
  const inPeriod = (input.periodKey ?? "").trim();
  if (periodKey === null ? inPeriod !== "" : !PERIOD.test(inPeriod) || inPeriod !== periodKey) return bad("The authorized period must be the period being covered (and only a period cover names one).");
  const documentRef = input.documentRef.trim();
  if (!documentRefValid(documentRef)) return bad("Give the retained document as an id (6 to 120 letters, digits or . _ / # + -) or a plain https link without a query string, credentials or any of ; & = %.");
  const sha = input.documentSha256.trim();
  if (!SHA256_PATTERN.test(sha)) return bad("Give the sha256 of the retained authorization text: 64 hex characters (SHA-256 of the exact bytes of the retained file).");
  return {
    ok: true,
    value: {
      authorizedOn: input.authorizedOn.trim(), authorizedByRole: role as EvidenceRole, scope: scope as EvidenceScope, amountCents: Number(rawAmount), periodKey,
      documentRef, documentSha256: sha,
    },
  };
}

/** RPC parameters for tw4_spend_authorize's evidence arguments (all null when absent: a pilot authorization is then refused by the database, a credit one needs none). */
export const spendEvidenceParams = (e?: PilotEvidence | null) => ({
  p_evidence_authorized_on: e?.authorizedOn ?? null, p_evidence_role: e?.authorizedByRole ?? null, p_evidence_scope: e?.scope ?? null, p_evidence_amount_cents: e?.amountCents ?? null,
  p_evidence_period_key: e?.periodKey ?? null, p_evidence_document_ref: e?.documentRef ?? null, p_evidence_sha256: e?.documentSha256 ?? null,
});

/** RPC parameters for tw4_pilot_exception_create's evidence arguments (no period: the exception is not a period). */
export const exceptionEvidenceParams = (e?: PilotEvidence | null) => ({
  p_evidence_authorized_on: e?.authorizedOn ?? null, p_evidence_role: e?.authorizedByRole ?? null, p_evidence_scope: e?.scope ?? null, p_evidence_amount_cents: e?.amountCents ?? null,
  p_evidence_document_ref: e?.documentRef ?? null, p_evidence_sha256: e?.documentSha256 ?? null,
});
