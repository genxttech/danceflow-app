import { createHash, randomBytes } from "node:crypto";
import type { PilotEvidence } from "@/lib/sms/pilotApprovalEvidence";

/**
 * Shared test helper for the real-schema suites that call tw4_rfl_pilot_cover (20261229090000: the cover carries structured owner-authorization evidence).
 * `pilotCoverArgs` returns the argument list for the function the connected database actually has: the eleven-argument evidence signature when 20261229 is applied
 * (with VALID evidence built for this resource's fee: date three days ago, owner_written, scope pilot_period_cover, the published price of the fee, the same period,
 * a fresh document id and a fresh sha256), otherwise the four-argument signature of 20261209/20261225 (so a suite still runs at an older checkpoint).
 * Not a test file: no assertions here, nothing runs on import.
 */
export type PsqlFn = (sql: string) => string;

export type EvidenceOverride = Partial<{
  authorizedOn: string | null;
  role: string | null;
  scope: string | null;
  amountCents: number | null;
  evidencePeriod: string | null;
  documentRef: string | null;
  sha256: string | null;
}>;

const EVIDENCE_SIG = "public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)";
const cache = new WeakMap<PsqlFn, boolean>();

/** True when the connected database carries 20261229090000 (the eleven-argument evidence signature). */
export function evidenceApplied(psql: PsqlFn): boolean {
  const hit = cache.get(psql);
  if (hit !== undefined) return hit;
  const v = psql(`select to_regprocedure('${EVIDENCE_SIG}') is not null`) === "t";
  cache.set(psql, v);
  return v;
}

/** The published price (cents) of the fee a resource pays. */
export const priceOfResource = (psql: PsqlFn, resourceId: string): number =>
  Number(psql(`select p.customer_price_cents from public.studio_sms_provider_resources r join public.studio_sms_price_list p on p.kind = r.fee_kind and p.active where r.id = '${resourceId}'`));

const isoDay = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
export const evidenceDay = isoDay;

/** Valid evidence fields (the seven arguments after the actor), with optional per-field overrides (null = a missing field). */
export function evidenceFields(psql: PsqlFn, resourceId: string, period: string, over: EvidenceOverride = {}): unknown[] {
  const pick = <K extends keyof EvidenceOverride>(k: K, dflt: NonNullable<EvidenceOverride[K]>) => (k in over ? over[k] : dflt);
  return [
    pick("authorizedOn", isoDay(-3)), pick("role", "owner_written"), pick("scope", "pilot_period_cover"), pick("amountCents", priceOfResource(psql, resourceId)),
    pick("evidencePeriod", period), pick("documentRef", `AUTH-DOC-${randomBytes(4).toString("hex")}`), pick("sha256", randomBytes(32).toString("hex")),
  ];
}

/** Arguments for tw4_rfl_pilot_cover: (resource, period, reference, actor[, the seven evidence fields]). */
export function pilotCoverArgs(psql: PsqlFn, resourceId: string, period: string, approval: string, actor: string, over: EvidenceOverride = {}): unknown[] {
  if (!evidenceApplied(psql)) return [resourceId, period, approval, actor];
  // the default document id and hash are DERIVED from (resource, period, reference): the same logical approval always carries the same evidence, so a repeated call is a true replay
  // (the function refuses the same reference with different evidence). Tests that want different evidence pass an override.
  const seed = createHash("sha256").update(`${resourceId}|${period}|${approval}`).digest("hex");
  return [resourceId, period, approval, actor, ...evidenceFields(psql, resourceId, period, { documentRef: `AUTH-DOC-${seed.slice(0, 8)}`, sha256: seed, ...over })];
}

// ---------------------------------------------------------------------------------------------------------------
// 20261230 (pilot SPEND evidence): tw4_spend_authorize(..., 'pilot', studio) and tw4_pilot_exception_create carry the same structured evidence as the cover.
// The evidence is DERIVED from (entity, kind, studio) / (entity, ceiling), never from the reference, so a repeated or differently-spelled retry of the same approval is a true replay.
// ---------------------------------------------------------------------------------------------------------------

const SPEND_SIG = "public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)";
const spendCache = new WeakMap<PsqlFn, boolean>();
/** True when the connected database carries 20261230090000 (evidence-carrying tw4_spend_authorize / tw4_pilot_exception_create). */
export function spendEvidenceApplied(psql: PsqlFn): boolean {
  const hit = spendCache.get(psql);
  if (hit !== undefined) return hit;
  const v = psql(`select to_regprocedure('${SPEND_SIG}') is not null`) === "t";
  spendCache.set(psql, v);
  return v;
}

/** The scope an operator would choose for a fee kind (the database refuses a scope that does not allow the kind). */
export function scopeForKind(kind: string): "pilot_onboarding_fee" | "pilot_campaign_fee" | "pilot_number_purchase" {
  if (kind === "brand" || kind === "brand_low_volume") return "pilot_onboarding_fee";
  if (kind === "campaign_vetting" || kind === "monthly" || kind === "monthly_low_volume") return "pilot_campaign_fee";
  if (kind === "number") return "pilot_number_purchase";
  throw new Error(`no pilot spend scope for fee kind ${kind}`);
}
const seedOf = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");

/** Valid evidence for one pilot fee approval, as the store/UI object. */
export function pilotSpendEvidenceFor(kind: string, entity: string, studio: string | null, cents: number, over: Partial<PilotEvidence> = {}): PilotEvidence {
  const seed = seedOf("spend", entity, kind, studio ?? "");
  return { authorizedOn: isoDay(-3), authorizedByRole: "owner_written", scope: scopeForKind(kind), amountCents: cents, periodKey: null, documentRef: `AUTH-DOC-${seed.slice(0, 8)}`, documentSha256: seed, ...over };
}
/** Valid evidence for the pilot exception (the ceiling), as the store/UI object. */
export function pilotExceptionEvidenceFor(entity: string, ceilingCents: number, over: Partial<PilotEvidence> = {}): PilotEvidence {
  const seed = seedOf("exception", entity);
  return { authorizedOn: isoDay(-3), authorizedByRole: "founder_written", scope: "pilot_exception", amountCents: ceilingCents, periodKey: null, documentRef: `AUTH-DOC-${seed.slice(0, 8)}`, documentSha256: seed, ...over };
}

/** Named RPC parameters (PostgREST-style suites): the evidence of a pilot fee approval, or nothing for a credit one. */
export function spendEvidenceRpc(funding: string, kind: string, entity: string, studio: string | null, cents: number): Record<string, unknown> {
  if (funding !== "pilot") return {};
  const e = pilotSpendEvidenceFor(kind, entity, studio, cents);
  return {
    p_evidence_authorized_on: e.authorizedOn, p_evidence_role: e.authorizedByRole, p_evidence_scope: e.scope, p_evidence_amount_cents: e.amountCents, p_evidence_period_key: null,
    p_evidence_document_ref: e.documentRef, p_evidence_sha256: e.documentSha256,
  };
}
/** Named RPC parameters (PostgREST-style suites): the evidence of the pilot exception. */
export function exceptionEvidenceRpc(entity: string, ceilingCents: number): Record<string, unknown> {
  const e = pilotExceptionEvidenceFor(entity, ceilingCents);
  return { p_evidence_authorized_on: e.authorizedOn, p_evidence_role: e.authorizedByRole, p_evidence_scope: e.scope, p_evidence_amount_cents: e.amountCents, p_evidence_document_ref: e.documentRef, p_evidence_sha256: e.documentSha256 };
}

/** Positional arguments for tw4_spend_authorize: (entity, kind, cents, ref, actor, funding, studio[, the seven evidence fields for a pilot approval when 20261230 is applied]). */
export function pilotSpendArgs(psql: PsqlFn, entity: string, kind: string, cents: number, approval: string, actor: string, funding: "credit" | "pilot" = "credit", studio: string | null = null, over: Partial<PilotEvidence> = {}): unknown[] {
  const base = [entity, kind, cents, approval, actor, funding, studio];
  if (funding !== "pilot" || !spendEvidenceApplied(psql)) return base;
  // 20261231100000 (owner rule 2026-10-25: one written document per approval): the document and hash also depend on the approval reference (normalized like the database does: case and whitespace),
  // so a legitimate SECOND approval of the same kind at the same location carries a new document, while a differently-spelled retry of the SAME approval is still a true replay.
  const norm = approval.normalize("NFKC").toLowerCase().replace(/s+/g, " ").trim();
  const seed = seedOf("spend", entity, kind, studio ?? "", norm);
  const e = pilotSpendEvidenceFor(kind, entity, studio, cents, { documentRef: `AUTH-DOC-${seed.slice(0, 8)}`, documentSha256: seed, ...over });
  return [...base, e.authorizedOn, e.authorizedByRole, e.scope, e.amountCents, e.periodKey, e.documentRef, e.documentSha256];
}
/** Positional arguments for tw4_pilot_exception_create: (entity, ceiling, ref, actor[, the six evidence fields when 20261230 is applied]). */
export function pilotExceptionArgs(psql: PsqlFn, entity: string, ceilingCents: number, approval: string, actor: string, over: Partial<PilotEvidence> = {}): unknown[] {
  const base = [entity, ceilingCents, approval, actor];
  if (!spendEvidenceApplied(psql)) return base;
  const e = pilotExceptionEvidenceFor(entity, ceilingCents, over);
  return [...base, e.authorizedOn, e.authorizedByRole, e.scope, e.amountCents, e.documentRef, e.documentSha256];
}
