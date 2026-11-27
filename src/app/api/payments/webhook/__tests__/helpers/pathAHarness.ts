/**
 * CF1 Path A offline harness. Everything here is a fake: no network, no Stripe API, no database.
 * - signedEvent / checkoutEvent build payloads that are signed with Stripe's own test-header generator.
 * - StatefulPaymentDb mimics the leased claim (claim_payment_provider_event / complete_payment_provider_event)
 *   and the competition lifecycle RPCs closely enough to observe duplicate, concurrent and retry behaviour.
 */

export const ORDER_ID = "11111111-2222-4333-8444-555555555555";
export const SESSION_ID = "cs_comp_1";
export const ACCOUNT_ID = "acct_studioA";

export type EventOverrides = { id?: string; account?: string | null; type?: string };

export function checkoutEventBody(
  sessionOverrides: Record<string, unknown> = {},
  overrides: EventOverrides = {},
) {
  const account = overrides.account === undefined ? ACCOUNT_ID : overrides.account;
  return JSON.stringify({
    id: overrides.id ?? "evt_pathA_1",
    object: "event",
    type: overrides.type ?? "checkout.session.completed",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: SESSION_ID,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        livemode: false,
        amount_total: 10330,
        currency: "usd",
        payment_intent: "pi_1",
        metadata: { source: "competition_registration", order_id: ORDER_ID },
        ...sessionOverrides,
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(account ? { account } : {}),
  });
}

export type RpcCall = { fn: string; args: Record<string, unknown> };
type ClaimRow = { status: "processing" | "processed" | "failed"; owner: string; leaseExpiresAt: number; attempts: number; lastError: string | null };

export class StatefulPaymentDb {
  calls: RpcCall[] = [];
  claims = new Map<string, ClaimRow>();
  finalizedOrders = new Set<string>();
  latePaidOrders = new Set<string>();
  /** What the database has bound to each order (session, connected account, price). The real functions refuse any other binding. */
  bindings = new Map<string, { sessionId: string; accountId: string; amountCents: number; currency: string }>([
    [ORDER_ID, { sessionId: SESSION_ID, accountId: ACCOUNT_ID, amountCents: 10330, currency: "USD" }],
  ]);
  releasedOrders = new Set<string>();
  /** Set to make a lifecycle RPC fail once (database refusal). */
  failNext: Record<string, string | undefined> = {};
  now = () => Date.now();

  count(fn: string) {
    return this.calls.filter((call) => call.fn === fn).length;
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
    this.calls.push({ fn, args });
    const failure = this.failNext[fn];
    if (failure) {
      this.failNext[fn] = undefined;
      return { data: null, error: { message: failure } };
    }
    switch (fn) {
      case "claim_payment_provider_event": {
        const id = String(args.p_provider_event_id);
        const row = this.claims.get(id);
        if (row?.status === "processed") return { data: { outcome: "already_processed" }, error: null };
        if (row?.status === "processing" && row.leaseExpiresAt > this.now()) return { data: { outcome: "in_progress" }, error: null };
        this.claims.set(id, {
          status: "processing",
          owner: String(args.p_owner),
          leaseExpiresAt: this.now() + Number(args.p_lease_seconds) * 1000,
          attempts: (row?.attempts ?? 0) + 1,
          lastError: row?.lastError ?? null,
        });
        return { data: { outcome: "claimed" }, error: null };
      }
      case "complete_payment_provider_event": {
        const id = String(args.p_provider_event_id);
        const row = this.claims.get(id);
        if (!row || row.owner !== args.p_owner || row.status !== "processing") return { data: false, error: null };
        row.status = args.p_status === "processed" ? "processed" : "failed";
        row.lastError = (args.p_error as string | null | undefined) ?? null;
        return { data: true, error: null };
      }
      case "finalize_competition_registration": {
        const order = String(args.p_order_id);
        const bound = this.bindings.get(order);
        if (!bound || bound.sessionId !== args.p_checkout_session_id || bound.accountId !== args.p_stripe_account_id) {
          return { data: null, error: { message: "COMP10C_BINDING_MISMATCH" } };
        }
        if (bound.amountCents !== args.p_amount_cents || bound.currency !== args.p_currency) {
          return { data: null, error: { message: "COMP10C_AMOUNT_MISMATCH" } };
        }
        if (this.finalizedOrders.has(order)) return { data: { outcome: "already_finalized" }, error: null };
        if (this.releasedOrders.has(order)) {
          this.latePaidOrders.add(order);
          return { data: { outcome: "late_payment_after_release" }, error: null };
        }
        this.finalizedOrders.add(order);
        return { data: { outcome: "finalized" }, error: null };
      }
      case "release_competition_registration": {
        const order = String(args.p_order_id);
        const bound = this.bindings.get(order);
        const sessionId = args.p_checkout_session_id;
        const accountId = args.p_stripe_account_id;
        if (!bound || (sessionId && sessionId !== bound.sessionId) || (accountId && accountId !== bound.accountId)) {
          return { data: null, error: { message: "COMP10C_BINDING_MISMATCH" } };
        }
        if (this.finalizedOrders.has(order)) return { data: { outcome: "already_paid" }, error: null };
        const outcome = this.releasedOrders.has(order) ? "already_released" : "released";
        this.releasedOrders.add(order);
        return { data: { outcome }, error: null };
      }
      default:
        return { data: null, error: { message: `unexpected rpc in Path A harness: ${fn}` } };
    }
  }
}

export function stripeError(code: string) {
  return Object.assign(new Error(`stripe: ${code}`), { code, type: "StripeInvalidRequestError" });
}

