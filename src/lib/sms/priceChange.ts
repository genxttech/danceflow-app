import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * D4-1: dual-controlled SMS price changes, application side. A thin, typed, SERVER-ONLY wrapper over `tw4_price_propose` / `tw4_price_approve` / `tw4_price_reject` /
 * `tw4_price_requests_list` (migration 20270204090000). These functions are executable by the authenticated role only and take the identity from the CALLER'S OWN verified
 * session (auth.uid(), aal2, a recent authenticator code): there is no actor argument and the service-role key is never used on this path. The client passed in must
 * therefore be the USER-scoped client of the signed-in administrator, never the admin client. The caller (a server action or page) has already run requirePlatformAdmin and,
 * for a write, requirePlatformStepUp; the database checks the session, the protected approver registry, the separation of duties and every state rule again. Reads never
 * throw (a missing function reads as "not available"). Writes throw `PriceChangeError` carrying the SQLSTATE only, never the database message. Nothing here calls Twilio or
 * Stripe, moves money or publishes a price by itself: only an approval does, in the database.
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
  /** single-owner mode: one owner, a 24 h cooling-off and a hardware-key authorization; team mode: a second registered administrator */
  approvalMode: "owner" | "team";
  coolingUntil: string | null;
  proposalVersion: number;
};
export type PriceChangeOverview = { active: ActivePrice[]; requests: PriceChangeRequest[]; mode: "single_owner" | "team"; frozen: boolean };

/** What the owner must read before signing: produced by the DATABASE (never by the page that starts the ceremony). */
export type AuthzChallenge = {
  nonce: string;
  challenge: string;
  rpId: string;
  allowCredentials: string[];
  expiresInSeconds: number;
  summary: { kind: string; scope: string; oldCustomerCents: number | null; oldProviderCents: number | null; newCustomerCents: number; newProviderCents: number; description: string; proposalVersion: number; requestId: string; hash: string };
};
const B64U = /^[A-Za-z0-9_-]{1,4096}$/;
export const isB64u = (v: unknown): v is string => typeof v === "string" && B64U.test(v);

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
      approvalMode: o.approval_mode === "owner" ? "owner" : "team", coolingUntil: str(o.cooling_until), proposalVersion: int(o.proposal_version) ?? 1,
    });
  }
  return out;
}

/** The active prices and the latest requests, or `null` = "not available" (not installed, caller not an administrator, any error). Never throws. */
export async function loadPriceChanges(client: Client): Promise<PriceChangeOverview | null> {
  try {
    const res = await client.rpc("tw4_price_requests_list");
    if (res.error) return null;
    const o = obj(res.data);
    if (!o) return null;
    return { active: parseActive(o.active), requests: parseRequests(o.requests), mode: o.mode === "team" ? "team" : "single_owner", frozen: o.frozen === true };
  } catch {
    return null;
  }
}

export class PriceChangeStore {
  constructor(private readonly client: Client) {}

  private async call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: { data: unknown; error: { code?: string } | null };
    try {
      res = (await this.client.rpc(fn, args)) as typeof res;
    } catch {
      throw new PriceChangeError("unknown");
    }
    if (res.error) throw new PriceChangeError(String(res.error.code ?? "unknown"));
    return obj(res.data) ?? {};
  }

  async propose(args: { kind: string; customerCents: number; providerCents: number; description: string; reason: string }): Promise<{ requestId: string | null; replayed: boolean }> {
    const row = await this.call("tw4_price_propose", {
      p_kind: args.kind, p_customer_cents: args.customerCents, p_provider_cents: args.providerCents, p_description: args.description, p_reason: args.reason,
    });
    return { requestId: uuid(row.request_id), replayed: row.replayed === true };
  }

  async approve(requestId: string, note: string): Promise<{ status: string | null; replayed: boolean }> {
    const row = await this.call("tw4_price_approve", { p_request_id: requestId, p_note: note });
    return { status: str(row.status), replayed: row.replayed === true };
  }

  async reject(requestId: string, note: string): Promise<{ status: string | null; withdrawn: boolean }> {
    const row = await this.call("tw4_price_reject", { p_request_id: requestId, p_note: note });
    return { status: str(row.status), withdrawn: row.withdrawn === true };
  }

  /** step 1 of the ceremony: the database issues the challenge (and the summary the owner reads) for ONE proposal, to this session */
  async authzBegin(requestId: string): Promise<AuthzChallenge> {
    const row = await this.call("tw4_price_authz_begin", { p_request_id: requestId });
    const s = obj(row.summary) ?? {};
    const nonce = row.nonce;
    const challenge = row.challenge;
    const rpId = str(row.rp_id);
    const ids = Array.isArray(row.allow_credentials) ? row.allow_credentials.filter(isB64u) : [];
    const newC = int(s.new_customer_cents);
    const newP = int(s.new_provider_cents);
    if (!isB64u(nonce) || !isB64u(challenge) || !rpId || ids.length === 0 || newC === null || newP === null) throw new PriceChangeError("unknown");
    return {
      nonce, challenge, rpId, allowCredentials: ids, expiresInSeconds: int(row.expires_in_seconds) ?? 300,
      summary: { kind: str(s.kind) ?? "", scope: str(s.scope) ?? "", oldCustomerCents: int(s.old_customer_cents), oldProviderCents: int(s.old_provider_cents), newCustomerCents: newC, newProviderCents: newP,
        description: str(s.description) ?? "", proposalVersion: int(s.proposal_version) ?? 1, requestId: str(s.request_id) ?? requestId, hash: str(s.hash) ?? "" },
    };
  }

  /** step 2: the signed assertion goes to the database, which verifies it and publishes (or answers 'rejected' with the reason) */
  async authzFinish(a: { requestId: string; nonce: string; credentialId: string; authData: string; clientData: string; signature: string }): Promise<{ status: string | null; reason: string | null }> {
    const row = await this.call("tw4_price_authz_finish", {
      p_request_id: a.requestId, p_nonce: a.nonce, p_credential_id: a.credentialId, p_auth_data: a.authData, p_client_data: a.clientData, p_signature: a.signature,
    });
    return { status: str(row.status), reason: str(row.reason) };
  }

  async revise(requestId: string, args: { customerCents: number; providerCents: number; description: string; reason: string }): Promise<{ requestId: string | null; version: number }> {
    const row = await this.call("tw4_price_revise", { p_request_id: requestId, p_customer_cents: args.customerCents, p_provider_cents: args.providerCents, p_description: args.description, p_reason: args.reason });
    return { requestId: uuid(row.request_id), version: int(row.version) ?? 1 };
  }

  /** suspends publication; it can never publish anything */
  async freeze(reason: string): Promise<{ replayed: boolean }> {
    const row = await this.call("tw4_price_freeze", { p_reason: reason });
    return { replayed: row.replayed === true };
  }

  async reportCompromise(note: string): Promise<void> {
    await this.call("tw4_price_report_compromise", { p_note: note });
  }
}
