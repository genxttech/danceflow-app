import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LEGACY_PLATFORM_ACCOUNT_MARKER,
  loadLegacyPlatformContext,
  releaseEventCartOrder,
  retrieveCheckoutSessionForAttempt,
} from "@/lib/events/cartSettlement";
import { createFakeAdminClient, FakeTable } from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * PAY-WH-1B -- legacy platform-account Checkout Sessions (pre 2026-07-16 destination charges). The platform account is
 * consulted ONLY for a positively identified legacy order whose Session Stripe reports missing on the studio's connected
 * account, and the Session is used only when its metadata proves it is this order's destination charge for this studio.
 * A paid platform Session is never released as unpaid and never settled: settlement's account binding rejects it and
 * records a captured-payment exception. Non-legacy attempts stay strictly bound to their recorded account.
 */

const ORDER = "order-legacy";
const STUDIO = "studio-1";
const ACCOUNT = "acct_studio";
const SESSION = "cs_live_legacy";

type FakeSession = { id: string; status: string; payment_status?: string; payment_intent?: string; amount_total?: number; currency?: string; metadata?: Record<string, string> };

const legacyMetadata = (overrides: Record<string, string | undefined> = {}) =>
  Object.fromEntries(Object.entries({ source: "event_cart_order", order_id: ORDER, studio_id: STUDIO, connected_account_id: ACCOUNT, ...overrides }).filter(([, v]) => v !== undefined)) as Record<string, string>;

function missing() {
  return Object.assign(new Error("No such checkout.session"), { type: "StripeInvalidRequestError", code: "resource_missing" });
}

/** Stripe with SEPARATE object spaces: the platform account (no stripeAccount option) and each connected account. */
function fakeStripe(state: { platform?: Record<string, FakeSession>; connected?: Record<string, Record<string, FakeSession>>; connectedError?: Error }) {
  const space = (options?: { stripeAccount?: string }) => (options?.stripeAccount ? (state.connected?.[options.stripeAccount] ?? {}) : (state.platform ?? {}));
  const stripe = {
    checkout: {
      sessions: {
        retrieve: vi.fn(async (id: string, _params?: unknown, options?: { stripeAccount?: string }) => {
          if (options?.stripeAccount && state.connectedError) throw state.connectedError;
          const found = space(options)[id];
          if (!found) throw missing();
          return { ...found };
        }),
        expire: vi.fn(async (id: string, _params?: unknown, options?: { stripeAccount?: string }) => {
          const found = space(options)[id];
          if (!found) throw missing();
          found.status = "expired";
          return { ...found };
        }),
      },
    },
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
  };
  return stripe as unknown as Stripe & typeof stripe;
}

function db(options: { createdAt?: string; orderMetadata?: Record<string, unknown>; surface?: string; attemptAccount?: string; outcomes?: Record<string, unknown> } = {}) {
  const tables: Record<string, FakeTable> = { event_orders: new FakeTable(), studios: new FakeTable(), event_order_payment_attempts: new FakeTable() };
  tables.event_orders.rows.push({ id: ORDER, studio_id: STUDIO, created_at: options.createdAt ?? "2026-06-10T12:00:00Z", metadata: options.orderMetadata ?? { source: "event_cart_v1" } });
  tables.studios.rows.push({ id: STUDIO, stripe_connected_account_id: ACCOUNT });
  tables.event_order_payment_attempts.rows.push({ id: "att-1", order_id: ORDER, kind: "checkout_session", surface: options.surface ?? "legacy", stripe_account_id: options.attemptAccount ?? ACCOUNT });
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = createFakeAdminClient(tables) as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown> };
  client.rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "begin_event_cart_order_release") {
      return { data: options.outcomes?.begin ?? { outcome: "releasing", attempts: [{ attempt_id: "att-1", kind: "checkout_session", stripe_account_id: options.attemptAccount ?? ACCOUNT, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: null, status: "open" }] }, error: null };
    }
    if (fn === "finalize_event_cart_order_release") {
      const findings = args.p_findings as Array<{ stripe_state: string }>;
      return { data: findings.every((f) => f.stripe_state === "closed") ? { outcome: "released", final_state: args.p_final_state } : { outcome: "retry" }, error: null };
    }
    if (fn === "settle_event_cart_order") {
      // The real function: the attempt is bound to the studio's connected account, so platform evidence is a mismatch
      // and a captured-payment exception is recorded (sql-tests cover the database side).
      return { data: args.p_stripe_account === ACCOUNT ? { outcome: "settled", order_id: ORDER } : { outcome: "mismatch:account", order_id: ORDER, exception_id: "exc-1" }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  };
  return { admin: client as unknown as SupabaseClient, calls };
}

const release = (admin: SupabaseClient, stripe: Stripe) => releaseEventCartOrder({ admin, stripe, orderId: ORDER, reason: "hold_expired", finalState: "expired" });

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));

describe("legacy platform-account Sessions (positively identified legacy orders only)", () => {
  it("an expired platform Session releases the order normally (looked up on the platform account only)", async () => {
    const stripe = fakeStripe({ platform: { [SESSION]: { id: SESSION, status: "expired", metadata: legacyMetadata() } } });
    const { admin, calls } = db();
    expect(await release(admin, stripe)).toEqual({ outcome: "released", final_state: "expired" });
    expect(stripe.checkout.sessions.retrieve.mock.calls.map((call) => call[2])).toEqual([{ stripeAccount: ACCOUNT }, undefined]);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(["begin_event_cart_order_release", "finalize_event_cart_order_release"]);
  });

  it("an open platform Session is verified first, expired ON THE PLATFORM, read back, then released", async () => {
    const stripe = fakeStripe({ platform: { [SESSION]: { id: SESSION, status: "open", metadata: legacyMetadata() } } });
    const { admin } = db();
    expect(await release(admin, stripe)).toMatchObject({ outcome: "released" });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(SESSION, {}, undefined);
  });

  it("a PAID platform Session is never released as unpaid and never settled: a captured-payment exception is recorded", async () => {
    const stripe = fakeStripe({ platform: { [SESSION]: { id: SESSION, status: "complete", payment_status: "paid", payment_intent: "pi_legacy", amount_total: 14500, currency: "usd", metadata: legacyMetadata() } } });
    const { admin, calls } = db();
    const outcome = await release(admin, stripe);
    expect(outcome).toEqual({ outcome: "mismatch:account", order_id: ORDER, exception_id: "exc-1" });
    expect(calls.map((c) => c.fn)).toEqual(["begin_event_cart_order_release", "settle_event_cart_order"]); // no finalize: never released
    expect(calls[1].args).toMatchObject({ p_stripe_account: LEGACY_PLATFORM_ACCOUNT_MARKER, p_session_id: SESSION, p_payment_intent_id: "pi_legacy", p_amount_cents: 14500, p_currency: "usd" });
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it("a completed-but-unpaid platform Session is not treated as closed (keeps reconciling)", async () => {
    const stripe = fakeStripe({ platform: { [SESSION]: { id: SESSION, status: "complete", payment_status: "unpaid", metadata: legacyMetadata() } } });
    const { admin, calls } = db();
    expect(await release(admin, stripe)).toEqual({ outcome: "retry" });
    // reported as still open (keep reconciling) -- never as closed, and never as a delayed payment on the connected account
    expect(calls.find((c) => c.fn === "finalize_event_cart_order_release")?.args.p_findings).toEqual([{ attempt_id: "att-1", stripe_state: "open" }]);
  });

  it.each([
    ["another order", { order_id: "order-other" }],
    ["another studio", { studio_id: "studio-other" }],
    ["another destination account", { connected_account_id: "acct_other" }],
    ["a direct-charge Session", { charge_model: "direct" }],
    ["another flow", { source: "competition_registration" }],
  ])("a platform Session whose metadata names %s is never used: not expired, not released, not settled", async (_label, overrides) => {
    for (const status of ["open", "expired", "complete"]) {
      const stripe = fakeStripe({ platform: { [SESSION]: { id: SESSION, status, payment_status: status === "complete" ? "paid" : undefined, metadata: legacyMetadata(overrides) } } });
      const { admin, calls } = db();
      expect(await release(admin, stripe)).toEqual({ outcome: "retry" });
      expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
      expect(calls.map((c) => c.fn)).not.toContain("settle_event_cart_order");
    }
  });

  it("missing on the platform too -> stays a retry (the sweeper escalates a genuinely stuck order)", async () => {
    const stripe = fakeStripe({});
    const { admin } = db();
    expect(await release(admin, stripe)).toEqual({ outcome: "retry" });
  });

  it("replay: a second release of an already released order makes no Stripe call", async () => {
    const stripe = fakeStripe({ platform: { [SESSION]: { id: SESSION, status: "expired", metadata: legacyMetadata() } } });
    const { admin } = db({ outcomes: { begin: { outcome: "already_released", state: "expired" } } });
    expect(await release(admin, stripe)).toEqual({ outcome: "already_released", state: "expired" });
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });
});

describe("no fallback outside positively identified legacy orders (new payments stay strictly bound)", () => {
  const platformPaid = { [SESSION]: { id: SESSION, status: "expired", metadata: legacyMetadata() } };

  it.each([
    ["a non-legacy (web) attempt", { surface: "web" }],
    ["an order created after the direct-charge cutover", { createdAt: "2026-08-01T00:00:00Z" }],
    ["an order marked as a direct charge", { orderMetadata: { source: "event_cart_v1", charge_model: "direct" } }],
    ["a competition order", { orderMetadata: { source: "competition_registration" } }],
    ["an attempt recorded on another account", { attemptAccount: "acct_other" }],
  ])("%s: a missing Session is NOT looked up on the platform account", async (_label, options) => {
    const stripe = fakeStripe({ platform: platformPaid });
    const { admin } = db(options);
    expect(await release(admin, stripe)).toEqual({ outcome: "retry" });
    expect(stripe.checkout.sessions.retrieve.mock.calls.every((call) => call[2] !== undefined)).toBe(true);
  });

  it("a legacy attempt whose lookup fails for any reason other than resource_missing is NOT looked up on the platform", async () => {
    const stripe = fakeStripe({ platform: platformPaid, connectedError: Object.assign(new Error("connection reset"), { type: "StripeConnectionError" }) });
    const { admin } = db();
    expect(await release(admin, stripe)).toEqual({ outcome: "retry" });
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
  });

  it("a Session found on the connected account is used there (no platform lookup at all)", async () => {
    const stripe = fakeStripe({ connected: { [ACCOUNT]: { [SESSION]: { id: SESSION, status: "expired" } } }, platform: platformPaid });
    const { admin } = db();
    expect(await release(admin, stripe)).toMatchObject({ outcome: "released" });
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
  });

  it("context loading ignores non-legacy attempts even if the database returns them", async () => {
    const { admin } = db({ surface: "web" });
    const original = (admin as unknown as { from: (t: string) => unknown }).from.bind(admin);
    // a store that ignores the surface filter must still not make a web attempt legacy
    (admin as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = original(table) as Record<string, (...args: unknown[]) => unknown>;
      if (table !== "event_order_payment_attempts") return builder;
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      const passthrough = original(table) as { select: () => { eq: (...a: unknown[]) => unknown } };
      chain.select = () => chain;
      chain.eq = (column: unknown, value: unknown) => (column === "surface" ? chain : chain);
      chain.then = (resolve: unknown) => (passthrough.select() as unknown as { then: (r: unknown) => unknown }).then(resolve);
      return chain;
    };
    expect(await loadLegacyPlatformContext(admin, ORDER)).toBeNull();
  });

  it("context loading identifies legacy orders only", async () => {
    expect(await loadLegacyPlatformContext(db().admin, ORDER)).toMatchObject({ orderId: ORDER, studioId: STUDIO, studioAccount: ACCOUNT });
    expect(await loadLegacyPlatformContext(db({ surface: "web" }).admin, ORDER)).toBeNull();
    expect(await loadLegacyPlatformContext(db({ createdAt: "2026-07-18T00:00:00Z" }).admin, ORDER)).toBeNull();
  });

  it("the shared lookup helper (used by release AND resume) rethrows for an unidentified attempt", async () => {
    const stripe = fakeStripe({ platform: platformPaid });
    await expect(retrieveCheckoutSessionForAttempt(stripe, { attempt_id: "att-1", stripe_account_id: ACCOUNT, stripe_checkout_session_id: SESSION }, null))
      .rejects.toMatchObject({ code: "resource_missing" });
    const context = await loadLegacyPlatformContext(db().admin, ORDER);
    await expect(retrieveCheckoutSessionForAttempt(stripe, { attempt_id: "att-other", stripe_account_id: ACCOUNT, stripe_checkout_session_id: SESSION }, context))
      .rejects.toMatchObject({ code: "resource_missing" });
    await expect(retrieveCheckoutSessionForAttempt(stripe, { attempt_id: "att-1", stripe_account_id: ACCOUNT, stripe_checkout_session_id: SESSION }, context))
      .resolves.toMatchObject({ onPlatform: true });
    // the identified attempt, but looked up on ANOTHER account: never falls back to the platform
    await expect(retrieveCheckoutSessionForAttempt(stripe, { attempt_id: "att-1", stripe_account_id: "acct_other", stripe_checkout_session_id: SESSION }, context))
      .rejects.toMatchObject({ code: "resource_missing" });
  });
});
