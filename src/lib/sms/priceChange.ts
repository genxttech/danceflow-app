import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * D4-1: dual-controlled SMS price changes, application side. A thin, typed, SERVER-ONLY wrapper over `tw4_price_propose` / `tw4_price_approve` / `tw4_price_reject` /
 * `tw4_price_requests_list` (migration 20270204090000). It adds no authorization of its own: the CALLER (a server action or page that already ran `requirePlatformAdmin`
 * and, for a write, `requirePlatformStepUp`) passes the actor it derived from the session, and the database checks the platform-admin actor, the separation of duties
 * (the approver is never the requester) and every state rule again. Reads never throw (a missing function reads as "not available"). Writes throw `PriceChangeError`
 * carrying the SQLSTATE only, never the database message. Nothing here calls Twilio or Stripe, moves money or publishes a price by itself: only an approval does, in the database.
 */

type Client = Pick<SupabaseClient, "rpc">;

/** The result banner travels in this short-lived httpOnly cookie (see panelFlash.ts), never in the URL. */
export const PRICE_FLASH_COOKIE = "tw4_price_flash";

export class PriceChangeError extends Error {
  constructor(readonly code: string) {
    super(`price change: ${code}`);
    this.name = "PriceChangeError";
  }
}

export type PriceChangeStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated" | "applied";
const STATUSES: readonly PriceChangeStatus[] = ["pending", "approved", "rejected", "expired", "invalidated", "applied"];

export type ActivePrice = { priceId: string; kind: string; customerPriceCents: number; providerCostCents: number; description: string; createdAt: string | null };
export type PriceChangeRequest = {
  requestId: string;
  kind: string;
  customerPriceCents: number;
  providerCostCents: number;
  description: string;
  reason: string;
  baseCustomerPriceCents: number | null;
  baseProviderCostCents: number | null;
  status: PriceChangeStatus;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedPriceId: string | null;
  baseChanged: boolean;
};
export type PriceChangeOverview = { active: ActivePrice[]; requests: PriceChangeRequest[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/** The price kinds a studio can be charged for, with the words an administrator sees. */
export const PRICE_KIND_TEXT: Record<string, string> = {
  brand: "Brand registration",
  brand_low_volume: "Brand registration (Low-Volume Standard)",
  campaign_vetting: "Campaign vetting",
  number: "Phone number (monthly)",
  monthly: "Campaign (monthly)",
  monthly_low_volume: "Campaign (monthly, Low-Volume Standard)",
  sms_usage: "Outbound message",
  sms_inbound: "Inbound message",
};
export const PRICE_KINDS = Object.keys(PRICE_KIND_TEXT);

function parseActive(v: unknown): ActivePrice[] {
  if (!Array.isArray(v)) return [];
  const out: ActivePrice[] = [];
  for (const e of v) {
    const o = obj(e);
    const priceId = uuid(o?.price_id);
    const kind = str(o?.kind);
    const customer = int(o?.customer_price_cents);
    const provider = int(o?.provider_cost_cents);
    if (!o || !priceId || !kind || customer === null || provider === null) continue;
    out.push({ priceId, kind, customerPriceCents: customer, providerCostCents: provider, description: str(o.description) ?? "", createdAt: str(o.created_at) });
  }
  return out;
}

function parseRequests(v: unknown): PriceChangeRequest[] {
  if (!Array.isArray(v)) return [];
  const out: PriceChangeRequest[] = [];
  for (const e of v) {
    const o = obj(e);
    const requestId = uuid(o?.request_id);
    const status = STATUSES.find((s) => s === o?.status);
    const kind = str(o?.kind);
    const customer = int(o?.customer_price_cents);
    const provider = int(o?.provider_cost_cents);
    const requestedBy = uuid(o?.requested_by);
    const requestedAt = str(o?.requested_at);
    const expiresAt = str(o?.expires_at);
    if (!o || !requestId || !status || !kind || customer === null || provider === null || !requestedBy || !requestedAt || !expiresAt) continue;
    out.push({
      requestId, kind, customerPriceCents: customer, providerCostCents: provider, description: str(o.description) ?? "", reason: str(o.reason) ?? "",
      baseCustomerPriceCents: int(o.base_customer_price_cents), baseProviderCostCents: int(o.base_provider_cost_cents), status, requestedBy, requestedAt, expiresAt,
      decidedBy: uuid(o.decided_by), decidedAt: str(o.decided_at), decisionNote: str(o.decision_note), appliedPriceId: uuid(o.applied_price_id), baseChanged: o.base_changed === true,
    });
  }
  return out;
}

/** The active prices and the latest requests, or `null` = "not available" (not installed, caller not an administrator, any error). Never throws. */
export async function loadPriceChanges(admin: Client, actorId: string): Promise<PriceChangeOverview | null> {
  try {
    const res = await admin.rpc("tw4_price_requests_list", { p_actor: actorId });
    if (res.error) return null;
    const o = obj(res.data);
    if (!o) return null;
    return { active: parseActive(o.active), requests: parseRequests(o.requests) };
  } catch {
    return null;
  }
}

export class PriceChangeStore {
  constructor(private readonly admin: Client) {}

  private async call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: { data: unknown; error: { code?: string } | null };
    try {
      res = (await this.admin.rpc(fn, args)) as typeof res;
    } catch {
      throw new PriceChangeError("unknown");
    }
    if (res.error) throw new PriceChangeError(String(res.error.code ?? "unknown"));
    return obj(res.data) ?? {};
  }

  async propose(args: { kind: string; customerCents: number; providerCents: number; description: string; reason: string }, actorId: string): Promise<{ requestId: string | null; replayed: boolean }> {
    const row = await this.call("tw4_price_propose", {
      p_kind: args.kind, p_customer_cents: args.customerCents, p_provider_cents: args.providerCents, p_description: args.description, p_reason: args.reason, p_actor: actorId,
    });
    return { requestId: uuid(row.request_id), replayed: row.replayed === true };
  }

  async approve(requestId: string, note: string, actorId: string): Promise<{ status: string | null; replayed: boolean }> {
    const row = await this.call("tw4_price_approve", { p_request_id: requestId, p_actor: actorId, p_note: note });
    return { status: str(row.status), replayed: row.replayed === true };
  }

  async reject(requestId: string, note: string, actorId: string): Promise<{ status: string | null; withdrawn: boolean }> {
    const row = await this.call("tw4_price_reject", { p_request_id: requestId, p_actor: actorId, p_note: note });
    return { status: str(row.status), withdrawn: row.withdrawn === true };
  }
}
