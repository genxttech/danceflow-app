import { randomBytes } from "node:crypto";

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
  return evidenceApplied(psql) ? [resourceId, period, approval, actor, ...evidenceFields(psql, resourceId, period, over)] : [resourceId, period, approval, actor];
}
