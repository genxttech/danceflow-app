import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read side of the prepaid SMS credit screens. Every call goes through the signed-in user's own Supabase client, so the database (not this module) decides
 * what the user may see: the SECURITY DEFINER read functions check the caller's role at the studio and return only the caller's legal business.
 */
type Client = Pick<SupabaseClient, "rpc">;

export type CreditOverview = {
  legalBusiness: boolean;
  balanceCents: number;
  reservedCents: number;
  availableCents: number;
  onHold: boolean;
  lowBalance: boolean;
  lowBalanceThresholdCents: number;
  pendingCents: number;
  thisLocationNetChargesCents: number;
  pilotCeilingCents: number | null;
  pilotUsedCents: number;
};

export type CreditLedgerKind = "topup_settled" | "topup_reversed" | "reserve" | "release" | "capture" | "usage_charge" | "usage_refund" | "adjustment";
export type CreditActivity = { seq: number; createdAt: string; kind: CreditLedgerKind; balanceDeltaCents: number; thisLocation: boolean; hasLocation: boolean };
export type CreditPurchaseStatus = "pending" | "settled" | "failed" | "expired";
export type CreditPurchase = { createdAt: string; amountCents: number; refundedCents: number; disputedCents: number; status: CreditPurchaseStatus; thisLocation: boolean };
export type CreditPrice = { kind: string; customerPriceCents: number; description: string };

/** purchases is null when the list could not be read (for example the read function is not installed yet), so the screen never claims "no purchases". */
export type CreditView = { overview: CreditOverview; activity: CreditActivity[]; purchases: CreditPurchase[] | null; prices: CreditPrice[] };

const KINDS = new Set<string>(["topup_settled", "topup_reversed", "reserve", "release", "capture", "usage_charge", "usage_refund", "adjustment"]);
const PURCHASE_STATUS = new Set<string>(["pending", "settled", "failed", "expired"]);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseOverview(data: unknown): CreditOverview {
  const o = obj(data);
  return {
    legalBusiness: o.legal_business === true,
    balanceCents: num(o.balance_cents),
    reservedCents: num(o.reserved_cents),
    availableCents: num(o.available_cents),
    onHold: o.on_hold === true,
    lowBalance: o.low_balance === true,
    lowBalanceThresholdCents: num(o.low_balance_threshold_cents),
    pendingCents: num(o.pending_topups_cents),
    thisLocationNetChargesCents: num(o.this_location_net_charges_cents),
    pilotCeilingCents: o.pilot_ceiling_cents == null ? null : num(o.pilot_ceiling_cents),
    pilotUsedCents: num(o.pilot_used_cents),
  };
}

export function parseActivity(data: unknown): CreditActivity[] {
  return list(data).flatMap((row) => {
    const r = obj(row);
    if (!KINDS.has(String(r.kind))) return [];
    return [{ seq: num(r.seq), createdAt: String(r.created_at ?? ""), kind: r.kind as CreditLedgerKind, balanceDeltaCents: num(r.balance_delta_cents), thisLocation: r.this_location === true, hasLocation: r.location_id != null }];
  });
}

export function parsePurchases(data: unknown): CreditPurchase[] {
  return list(data).flatMap((row) => {
    const r = obj(row);
    if (!PURCHASE_STATUS.has(String(r.status))) return [];
    return [{ createdAt: String(r.created_at ?? ""), amountCents: num(r.amount_cents), refundedCents: num(r.refunded_cents), disputedCents: num(r.disputed_cents), status: r.status as CreditPurchaseStatus, thisLocation: r.this_location === true }];
  });
}

export function parsePrices(data: unknown): CreditPrice[] {
  return list(data).map((row) => {
    const r = obj(row);
    return { kind: String(r.kind ?? ""), customerPriceCents: num(r.customer_price_cents), description: String(r.description ?? "") };
  });
}

/** Everything the credit panel shows, or null when the caller may not see it (not an owner/administrator here) or credit is not installed yet. */
export async function getSmsCreditView(supabase: Client, studioId: string): Promise<CreditView | null> {
  const overviewResult = await supabase.rpc("sms_credit_overview", { p_studio_id: studioId });
  if (overviewResult.error) return null;
  const overview = parseOverview(overviewResult.data);
  if (!overview.legalBusiness) return { overview, activity: [], purchases: [], prices: [] };
  const [history, purchases, prices] = await Promise.all([
    supabase.rpc("sms_credit_history", { p_studio_id: studioId, p_limit: 30 }),
    supabase.rpc("sms_credit_purchases", { p_studio_id: studioId, p_limit: 10 }),
    supabase.rpc("sms_price_list"),
  ]);
  return {
    overview,
    activity: history.error ? [] : parseActivity(history.data),
    purchases: purchases.error ? null : parsePurchases(purchases.data),
    prices: prices.error ? [] : parsePrices(prices.data),
  };
}

/** What the owner should be told. Order matters: the most blocking state wins. */
export type CreditState = "no_business" | "on_hold" | "negative" | "insufficient" | "low" | "ok";
export function deriveCreditState(o: CreditOverview): CreditState {
  if (!o.legalBusiness) return "no_business";
  if (o.onHold) return "on_hold";
  if (o.balanceCents < 0) return "negative";
  if (o.availableCents <= 0) return "insufficient";
  if (o.lowBalance || o.availableCents < o.lowBalanceThresholdCents) return "low";
  return "ok";
}

export const CREDIT_MAX_BALANCE_CENTS = 50_000;
export const CREDIT_PACKS_CENTS = [2500, 5000, 10000] as const;

/** A pack is offered only if the business could receive it: balance plus live pending plus the pack must stay within the ceiling (the database re-checks under a lock). */
export function packFits(o: CreditOverview, packCents: number): boolean {
  return Math.max(o.balanceCents, 0) + o.pendingCents + packCents <= CREDIT_MAX_BALANCE_CENTS;
}

export const ACTIVITY_LABEL: Record<CreditLedgerKind, string> = {
  topup_settled: "Credit added",
  topup_reversed: "Credit taken back (refund or dispute)",
  reserve: "Held for a setup step",
  release: "Hold released",
  capture: "Setup fee charged",
  usage_charge: "Texting usage",
  usage_refund: "Usage refunded",
  adjustment: "Adjustment by DanceFlow",
};

export const PURCHASE_LABEL: Record<CreditPurchaseStatus, string> = {
  pending: "Waiting for payment",
  settled: "Paid, credit added",
  failed: "Payment failed",
  expired: "Not completed",
};

export const PRICE_LABEL: Record<string, string> = {
  brand: "Business registration",
  brand_low_volume: "Business registration (low volume)",
  campaign_vetting: "Messaging registration review",
  number: "Texting phone number",
  monthly: "Monthly service",
  monthly_low_volume: "Monthly service (low volume)",
  sms_usage: "Per text message",
};

export const formatUsd = (cents: number): string => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------------------------------------------
// platform administrators
// ---------------------------------------------------------------------------------------------------------------
export type AdminCreditOverview = {
  prices: { kind: string; customerPriceCents: number; providerCostCents: number; description: string }[];
  accounts: { legalEntityId: string; legalName: string; balanceCents: number; reservedCents: number; hold: boolean; holdReason: string | null; lowBalance: boolean; pendingCents: number; locations: number; attention: boolean }[];
  stalePending: { legalName: string; amountCents: number; createdAt: string; expiresAt: string | null }[];
  variances: { legalName: string; kind: string; providerCostCents: number; expectedCostCents: number | null; varianceCents: number | null; createdAt: string }[];
  pilot: { legalName: string; ceilingCents: number; usedCents: number } | null;
};

export function parseAdminOverview(data: unknown): AdminCreditOverview {
  const o = obj(data);
  const pilot = o.pilot == null ? null : obj(o.pilot);
  return {
    prices: list(o.prices).map((r) => ({ kind: String(obj(r).kind ?? ""), customerPriceCents: num(obj(r).customer_price_cents), providerCostCents: num(obj(r).provider_cost_cents), description: String(obj(r).description ?? "") })),
    accounts: list(o.accounts).map((r) => {
      const a = obj(r);
      return { legalEntityId: String(a.legal_entity_id ?? ""), legalName: String(a.legal_name ?? ""), balanceCents: num(a.balance_cents), reservedCents: num(a.reserved_cents), hold: a.hold === true, holdReason: a.hold_reason == null ? null : String(a.hold_reason), lowBalance: a.low_balance === true, pendingCents: num(a.pending_cents), locations: num(a.locations), attention: a.attention === true };
    }),
    stalePending: list(o.stale_pending).map((r) => ({ legalName: String(obj(r).legal_name ?? ""), amountCents: num(obj(r).amount_cents), createdAt: String(obj(r).created_at ?? ""), expiresAt: obj(r).expires_at == null ? null : String(obj(r).expires_at) })),
    variances: list(o.variances).map((r) => {
      const v = obj(r);
      return { legalName: String(v.legal_name ?? ""), kind: String(v.kind ?? ""), providerCostCents: num(v.provider_cost_cents), expectedCostCents: v.expected_cost_cents == null ? null : num(v.expected_cost_cents), varianceCents: v.variance_cents == null ? null : num(v.variance_cents), createdAt: String(v.created_at ?? "") };
    }),
    pilot: pilot ? { legalName: String(pilot.legal_name ?? ""), ceilingCents: num(pilot.ceiling_cents), usedCents: num(pilot.used_cents) } : null,
  };
}

/** Null when the caller is not a platform administrator or credit is not installed. */
export async function getAdminCreditOverview(supabase: Client): Promise<AdminCreditOverview | null> {
  const { data, error } = await supabase.rpc("sms_credit_admin_overview");
  if (error) return null;
  return parseAdminOverview(data);
}
