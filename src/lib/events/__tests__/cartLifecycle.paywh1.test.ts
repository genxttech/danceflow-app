import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/events/settlementSideEffects", () => ({
  safeCaptureOrganizerEventRegistrationContact: vi.fn(async () => undefined),
  safeQueuePaidEventCartOrderConfirmation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/payments/stripeFeeSync", () => ({
  syncFeeDetailsForPaymentIntent: vi.fn(async () => true),
}));

const {
  checkoutSessionExpiresAtForHold,
  EVENT_CART_HOLD_MINUTES,
  newEventCartHoldUntil,
  releaseEventCartOrder,
  reconcileProcessingEventCartOrder,
} = await import("@/lib/events/cartSettlement");
const { handleEventCartCheckoutSessionEvent, handleEventCartPaymentIntentEvent } = await import("@/lib/events/cartWebhook");
const { drainEventSettlementOutbox } = await import("@/lib/events/settlementOutbox");
const sideEffects = await import("@/lib/events/settlementSideEffects");
const feeSync = await import("@/lib/payments/stripeFeeSync");

/** PAY-WH-1 application layer. The database functions themselves are tested against Postgres (sql-tests). */

type RpcCall = { fn: string; args: Record<string, unknown> };

function fakeAdmin(handlers: Record<string, (args: Record<string, unknown>) => unknown>, tableRows: Record<string, unknown[]> = {}) {
  const calls: RpcCall[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const handler = handlers[fn];
      if (!handler) return { data: null, error: { message: `unexpected rpc ${fn}`, code: "PGRST202" } };
      return { data: handler(args), error: null };
    },
    from: (table: string) => {
      const rows = tableRows[table] ?? [];
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

function fakeStripe(state: {
  sessions?: Record<string, { status: string; payment_status?: string; payment_intent?: string; amount_total?: number; currency?: string }>;
  intents?: Record<string, { status: string; amount?: number; amount_received?: number; currency?: string }>;
  sessionForIntent?: Record<string, string>;
  failExpire?: boolean;
  failRetrieve?: boolean;
}) {
  const sessions = state.sessions ?? {};
  const intents = state.intents ?? {};
  const stripe = {
    checkout: {
      sessions: {
        retrieve: vi.fn(async (id: string) => {
          if (state.failRetrieve) throw new Error("network");
          return { id, ...sessions[id] };
        }),
        expire: vi.fn(async (id: string) => {
          if (state.failExpire) throw new Error("cannot expire");
          sessions[id] = { ...sessions[id], status: "expired" };
          return { id, ...sessions[id] };
        }),
        list: vi.fn(async ({ payment_intent }: { payment_intent: string }) => ({
          data: state.sessionForIntent?.[payment_intent] ? [{ id: state.sessionForIntent[payment_intent] }] : [],
        })),
      },
    },
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({ id, ...intents[id] })),
      cancel: vi.fn(async (id: string) => {
        intents[id] = { ...intents[id], status: "canceled" };
        return { id, ...intents[id] };
      }),
    },
  };
  return stripe as unknown as Stripe & typeof stripe;
}

const ACCOUNT = "acct_studio";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("hold and Checkout Session expiry", () => {
  it("the Session always expires before the hold, and never violates Stripe's 30-minute minimum", () => {
    const now = Date.UTC(2027, 0, 1, 12, 0, 0);
    const hold = newEventCartHoldUntil(now);
    expect(Date.parse(hold) - now).toBe(EVENT_CART_HOLD_MINUTES * 60_000);
    const expiresAt = checkoutSessionExpiresAtForHold(hold, now)!;
    expect(expiresAt * 1000).toBeLessThan(Date.parse(hold));
    expect(expiresAt - now / 1000).toBeGreaterThanOrEqual(30 * 60);
  });

  it("refuses a Session for a hold too short to outlive Stripe's minimum (caller must extend the hold first)", () => {
    const now = Date.UTC(2027, 0, 1, 12, 0, 0);
    expect(checkoutSessionExpiresAtForHold(new Date(now + 30 * 60_000).toISOString(), now)).toBeNull();
    expect(checkoutSessionExpiresAtForHold(null, now)).toBeNull();
    expect(checkoutSessionExpiresAtForHold("not a date", now)).toBeNull();
  });
});

describe("two-phase release", () => {
  const attempt = (overrides: Record<string, unknown>) => ({
    attempt_id: "att-1", kind: "checkout_session", stripe_account_id: ACCOUNT,
    stripe_checkout_session_id: "cs_1", stripe_payment_intent_id: null, ...overrides,
  });

  it("passes through when the order is not releasable (paid / processing / already released)", async () => {
    for (const outcome of ["already_paid", "processing", "already_released"]) {
      const { admin, calls } = fakeAdmin({ begin_event_cart_order_release: () => ({ outcome }) });
      expect((await releaseEventCartOrder({ admin, stripe: fakeStripe({}), orderId: "o1", reason: "t" })).outcome).toBe(outcome);
      expect(calls.map((call) => call.fn)).toEqual(["begin_event_cart_order_release"]);
    }
  });

  it("expires an open Session on Stripe, then finalizes with the Stripe state read back", async () => {
    const stripe = fakeStripe({ sessions: { cs_1: { status: "open" } } });
    const { admin, calls } = fakeAdmin({
      begin_event_cart_order_release: () => ({ outcome: "releasing", attempts: [attempt({})] }),
      finalize_event_cart_order_release: () => ({ outcome: "released" }),
    });
    expect((await releaseEventCartOrder({ admin, stripe, orderId: "o1", reason: "t" })).outcome).toBe("released");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_1", {}, { stripeAccount: ACCOUNT });
    expect(calls.at(-1)?.args.p_findings).toEqual([{ attempt_id: "att-1", stripe_state: "closed" }]);
  });

  it("a Session paid during the release settles the order instead of releasing it (cancel/payment race)", async () => {
    const stripe = fakeStripe({ sessions: { cs_1: { status: "complete", payment_status: "paid", payment_intent: "pi_1", amount_total: 3000, currency: "usd" } } });
    const { admin, calls } = fakeAdmin({
      begin_event_cart_order_release: () => ({ outcome: "releasing", attempts: [attempt({})] }),
      settle_event_cart_order: () => ({ outcome: "settled", order_id: "o1" }),
    });
    expect((await releaseEventCartOrder({ admin, stripe, orderId: "o1", reason: "t" })).outcome).toBe("settled");
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(calls.find((call) => call.fn === "settle_event_cart_order")?.args).toMatchObject({
      p_source: "reconcile", p_stripe_account: ACCOUNT, p_session_id: "cs_1", p_payment_intent_id: "pi_1", p_amount_cents: 3000, p_currency: "usd",
    });
    expect(calls.some((call) => call.fn === "finalize_event_cart_order_release")).toBe(false);
  });

  it("a delayed payment still in flight keeps the order (processing), never releases it", async () => {
    const stripe = fakeStripe({ sessions: { cs_1: { status: "complete", payment_status: "unpaid" } } });
    const { admin, calls } = fakeAdmin({
      begin_event_cart_order_release: () => ({ outcome: "releasing", attempts: [attempt({})] }),
      finalize_event_cart_order_release: () => ({ outcome: "processing" }),
    });
    await releaseEventCartOrder({ admin, stripe, orderId: "o1", reason: "t" });
    expect(calls.at(-1)?.args.p_findings).toEqual([{ attempt_id: "att-1", stripe_state: "processing" }]);
  });

  it("Stripe unreachable -> the attempt stays 'open' and the database keeps the order releasing (retry)", async () => {
    const stripe = fakeStripe({ failRetrieve: true });
    const { admin, calls } = fakeAdmin({
      begin_event_cart_order_release: () => ({ outcome: "releasing", attempts: [attempt({})] }),
      finalize_event_cart_order_release: () => ({ outcome: "retry" }),
    });
    expect((await releaseEventCartOrder({ admin, stripe, orderId: "o1", reason: "t" })).outcome).toBe("retry");
    expect(calls.at(-1)?.args.p_findings).toEqual([{ attempt_id: "att-1", stripe_state: "open" }]);
  });

  it("without Stripe configured, an order with live attempts is never released blindly", async () => {
    const { admin, calls } = fakeAdmin({ begin_event_cart_order_release: () => ({ outcome: "releasing", attempts: [attempt({})] }) });
    expect((await releaseEventCartOrder({ admin, stripe: null, orderId: "o1", reason: "t" })).outcome).toBe("retry");
    expect(calls.map((call) => call.fn)).toEqual(["begin_event_cart_order_release"]);
  });

  it("cancels a payable native PaymentIntent before releasing", async () => {
    const stripe = fakeStripe({ intents: { pi_n: { status: "requires_payment_method" } } });
    const { admin, calls } = fakeAdmin({
      begin_event_cart_order_release: () => ({ outcome: "releasing", attempts: [attempt({ kind: "payment_intent", stripe_checkout_session_id: null, stripe_payment_intent_id: "pi_n" })] }),
      finalize_event_cart_order_release: () => ({ outcome: "released" }),
    });
    await releaseEventCartOrder({ admin, stripe, orderId: "o1", reason: "t" });
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_n", {}, { stripeAccount: ACCOUNT });
    expect(calls.at(-1)?.args.p_findings).toEqual([{ attempt_id: "att-1", stripe_state: "closed" }]);
  });
});

describe("webhook events -> lifecycle functions (the order is never selected by metadata)", () => {
  const claim = { eventId: "evt_1", owner: "owner-1" };
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: "cs_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 3000, currency: "usd",
    metadata: { source: "event_cart_order", order_id: "metadata-order" }, ...overrides,
  }) as unknown as Stripe.Checkout.Session;
  const intent = (overrides: Record<string, unknown> = {}) => ({
    id: "pi_1", status: "succeeded", amount: 3000, amount_received: 3000, currency: "usd",
    metadata: { source: "event_cart_order", order_id: "metadata-order" }, ...overrides,
  }) as unknown as Stripe.PaymentIntent;

  it("ignores Stripe objects of other flows", async () => {
    const { admin, calls } = fakeAdmin({});
    expect(await handleEventCartCheckoutSessionEvent({ admin, stripe: fakeStripe({}), session: session({ metadata: { source: "competition_registration" } }), eventType: "checkout.session.completed", stripeAccountId: ACCOUNT, claim })).toBeNull();
    expect(await handleEventCartPaymentIntentEvent({ admin, stripe: fakeStripe({}), paymentIntent: intent({ metadata: {} }), eventType: "payment_intent.succeeded", stripeAccountId: ACCOUNT, claim })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("PaymentIntent before Session: resolves the Session from Stripe on the signed account, then settles", async () => {
    const stripe = fakeStripe({ sessionForIntent: { pi_1: "cs_1" } });
    const { admin, calls } = fakeAdmin({ settle_event_cart_order: () => ({ outcome: "settled", order_id: "o1" }), claim_event_settlement_outbox: () => [] });
    await handleEventCartPaymentIntentEvent({ admin, stripe, paymentIntent: intent(), eventType: "payment_intent.succeeded", stripeAccountId: ACCOUNT, claim });
    expect(stripe.checkout.sessions.list).toHaveBeenCalledWith({ payment_intent: "pi_1", limit: 1 }, { stripeAccount: ACCOUNT });
    expect(calls[0]).toMatchObject({ fn: "settle_event_cart_order", args: { p_session_id: "cs_1", p_payment_intent_id: "pi_1", p_claim_owner: "owner-1", p_stripe_event_id: "evt_1" } });
    expect(JSON.stringify(calls[0].args)).not.toContain("metadata-order");
  });

  it("native PaymentIntent (no Session) settles as its own attempt", async () => {
    const { admin, calls } = fakeAdmin({ settle_event_cart_order: () => ({ outcome: "settled", order_id: "o1" }), claim_event_settlement_outbox: () => [] });
    await handleEventCartPaymentIntentEvent({ admin, stripe: fakeStripe({}), paymentIntent: intent(), eventType: "payment_intent.succeeded", stripeAccountId: ACCOUNT, claim });
    expect(calls[0].args).toMatchObject({ p_session_id: null, p_payment_intent_id: "pi_1" });
  });

  it("drains the settlement outbox for the order right after a settlement commits", async () => {
    const { admin, calls } = fakeAdmin({ settle_event_cart_order: () => ({ outcome: "settled", order_id: "o1" }), claim_event_settlement_outbox: () => [] });
    await handleEventCartCheckoutSessionEvent({ admin, stripe: fakeStripe({}), session: session(), eventType: "checkout.session.completed", stripeAccountId: ACCOUNT, claim });
    expect(calls.map((call) => call.fn)).toEqual(["settle_event_cart_order", "claim_event_settlement_outbox"]);
    expect(calls[1].args).toMatchObject({ p_order_id: "o1" });
  });

  it("business outcomes are acknowledged; mismatches throw (the delivery fails visibly and Stripe retries)", async () => {
    for (const outcome of ["already_settled", "duplicate_payment", "late_payment_after_release"]) {
      const { admin } = fakeAdmin({ settle_event_cart_order: () => ({ outcome }) });
      await expect(handleEventCartCheckoutSessionEvent({ admin, stripe: fakeStripe({}), session: session(), eventType: "checkout.session.completed", stripeAccountId: ACCOUNT, claim })).resolves.toMatchObject({ outcome });
    }
    const { admin } = fakeAdmin({ settle_event_cart_order: () => ({ outcome: "mismatch:amount" }) });
    await expect(handleEventCartCheckoutSessionEvent({ admin, stripe: fakeStripe({}), session: session(), eventType: "checkout.session.completed", stripeAccountId: ACCOUNT, claim })).rejects.toThrow("event_cart_mismatch_amount");
  });

  it("a completed but unpaid Session (delayed method) marks processing; async success settles; async failure is final", async () => {
    const { admin, calls } = fakeAdmin({
      mark_event_cart_order_processing: () => ({ outcome: "processing" }),
      settle_event_cart_order: () => ({ outcome: "already_settled" }),
      fail_event_cart_payment_attempt: () => ({ outcome: "released" }),
    });
    const stripe = fakeStripe({});
    await handleEventCartCheckoutSessionEvent({ admin, stripe, session: session({ payment_status: "unpaid" }), eventType: "checkout.session.completed", stripeAccountId: ACCOUNT, claim });
    await handleEventCartCheckoutSessionEvent({ admin, stripe, session: session(), eventType: "checkout.session.async_payment_succeeded", stripeAccountId: ACCOUNT, claim });
    await handleEventCartCheckoutSessionEvent({ admin, stripe, session: session({ payment_status: "unpaid" }), eventType: "checkout.session.async_payment_failed", stripeAccountId: ACCOUNT, claim });
    await handleEventCartCheckoutSessionEvent({ admin, stripe, session: session({ payment_status: "unpaid" }), eventType: "checkout.session.expired", stripeAccountId: ACCOUNT, claim });
    expect(calls.map((call) => call.fn)).toEqual(["mark_event_cart_order_processing", "settle_event_cart_order", "fail_event_cart_payment_attempt", "fail_event_cart_payment_attempt"]);
    expect(calls[2].args).toMatchObject({ p_final: true, p_final_state: "failed" });
    expect(calls[3].args).toMatchObject({ p_final: true, p_final_state: "expired" });
  });

  it("a declined card is NOT final (the buyer can retry on the same Session/PaymentIntent)", async () => {
    const { admin, calls } = fakeAdmin({ fail_event_cart_payment_attempt: () => ({ outcome: "recorded" }) });
    await handleEventCartPaymentIntentEvent({ admin, stripe: fakeStripe({ sessionForIntent: { pi_1: "cs_1" } }), paymentIntent: intent({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } }), eventType: "payment_intent.payment_failed", stripeAccountId: ACCOUNT, claim });
    expect(calls[0].args).toMatchObject({ p_final: false, p_reason: "card_declined" });
  });

  it("a canceled PaymentIntent is final only for native attempts (a Checkout one is finalized by session.expired)", async () => {
    const native = fakeAdmin({ fail_event_cart_payment_attempt: () => ({ outcome: "released" }) });
    await handleEventCartPaymentIntentEvent({ admin: native.admin, stripe: fakeStripe({}), paymentIntent: intent({ status: "canceled" }), eventType: "payment_intent.canceled", stripeAccountId: ACCOUNT, claim });
    expect(native.calls[0].args).toMatchObject({ p_final: true });
    const checkout = fakeAdmin({ fail_event_cart_payment_attempt: () => ({ outcome: "recorded" }) });
    await handleEventCartPaymentIntentEvent({ admin: checkout.admin, stripe: fakeStripe({ sessionForIntent: { pi_1: "cs_1" } }), paymentIntent: intent({ status: "canceled" }), eventType: "payment_intent.canceled", stripeAccountId: ACCOUNT, claim });
    expect(checkout.calls[0].args).toMatchObject({ p_final: false });
  });

  it("refuses account-less (platform) cart events and events without a webhook claim", async () => {
    const { admin, calls } = fakeAdmin({});
    await expect(handleEventCartCheckoutSessionEvent({ admin, stripe: fakeStripe({}), session: session(), eventType: "checkout.session.completed", stripeAccountId: null, claim })).rejects.toThrow("event_cart_mismatch_account");
    await expect(handleEventCartPaymentIntentEvent({ admin, stripe: fakeStripe({}), paymentIntent: intent(), eventType: "payment_intent.succeeded", stripeAccountId: ACCOUNT, claim: null })).rejects.toThrow("requires a webhook claim");
    expect(calls).toEqual([]);
  });
});

describe("sweeper reconcile of a lapsed delayed payment", () => {
  it("settles, keeps processing or fails from the PaymentIntent state Stripe reports (never closes it)", async () => {
    for (const [status, fn] of [["succeeded", "settle_event_cart_order"], ["processing", "mark_event_cart_order_processing"], ["canceled", "fail_event_cart_payment_attempt"]] as const) {
      const stripe = fakeStripe({ sessions: { cs_1: { status: "complete", payment_status: "unpaid", payment_intent: "pi_1" } }, intents: { pi_1: { status, amount: 3000, currency: "usd" } } });
      const { admin, calls } = fakeAdmin(
        { [fn]: () => ({ outcome: "ok" }) },
        { event_order_payment_attempts: [{ id: "att-1", kind: "checkout_session", stripe_account_id: ACCOUNT, stripe_checkout_session_id: "cs_1", stripe_payment_intent_id: null }] },
      );
      await reconcileProcessingEventCartOrder({ admin, stripe, orderId: "o1" });
      expect(calls.map((call) => call.fn)).toEqual([fn]);
      expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
      expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    }
  });
});

describe("settlement outbox worker", () => {
  const row = (effect: string, extra: Record<string, unknown> = {}) => ({ id: `row-${effect}`, order_id: "o1", studio_id: "s1", effect, subject_id: "reg-1", payload: {}, attempts: 1, ...extra });

  it("completes an effect only after its post-condition holds; otherwise records a retryable failure", async () => {
    const completions: Array<Record<string, unknown>> = [];
    const { admin } = fakeAdmin({
      claim_event_settlement_outbox: () => [row("organizer_contact")],
      complete_event_settlement_outbox: (args) => {
        completions.push(args);
        return true;
      },
    }, {
      organizer_contact_registrations: [],
      event_registrations: [{ attendee_email: "pat@example.com", events: { organizer_id: "org-1" } }],
    });
    const result = await drainEventSettlementOutbox({ admin, stripe: null, owner: "w1" });
    expect(sideEffects.safeCaptureOrganizerEventRegistrationContact).toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, done: 0, failed: 1 });
    expect(completions[0]).toMatchObject({ p_owner: "w1", p_ok: false });
    expect(String(completions[0].p_error)).toContain("not recorded yet");
  });

  it("an organizer contact the capture deliberately skips (no attendee email) is done, not retried until dead", async () => {
    vi.mocked(sideEffects.safeCaptureOrganizerEventRegistrationContact).mockClear();
    const completions: Array<Record<string, unknown>> = [];
    const { admin } = fakeAdmin({
      claim_event_settlement_outbox: () => [row("organizer_contact")],
      complete_event_settlement_outbox: (args) => {
        completions.push(args);
        return true;
      },
    }, {
      organizer_contact_registrations: [],
      event_registrations: [{ attendee_email: null, events: { organizer_id: "org-1" } }],
    });
    expect(await drainEventSettlementOutbox({ admin, stripe: null, owner: "w1" })).toEqual({ claimed: 1, done: 1, failed: 0 });
    expect(sideEffects.safeCaptureOrganizerEventRegistrationContact).not.toHaveBeenCalled();
    expect(completions[0]).toMatchObject({ p_ok: true });
  });

  it("fee sync needs Stripe and real fee details (a false result is retried, not marked done)", async () => {
    vi.mocked(feeSync.syncFeeDetailsForPaymentIntent).mockResolvedValueOnce(false);
    const completions: Array<Record<string, unknown>> = [];
    const { admin } = fakeAdmin({
      claim_event_settlement_outbox: () => [row("fee_sync", { payload: { payment_intent_id: "pi_1", stripe_account_id: ACCOUNT } })],
      complete_event_settlement_outbox: (args) => {
        completions.push(args);
        return true;
      },
    });
    await drainEventSettlementOutbox({ admin, stripe: fakeStripe({}), owner: "w1" });
    expect(completions[0]).toMatchObject({ p_ok: false });
  });

  it("a lost lease is never counted as done", async () => {
    const { admin } = fakeAdmin({
      claim_event_settlement_outbox: () => [row("studio_lead")],
      capture_event_registration_lead: () => ({ outcome: "captured" }),
      complete_event_settlement_outbox: () => false,
    });
    expect(await drainEventSettlementOutbox({ admin, stripe: null, owner: "w1" })).toEqual({ claimed: 1, done: 0, failed: 1 });
  });

  it("lead capture runs through the serialized database function", async () => {
    const { admin, calls } = fakeAdmin({
      claim_event_settlement_outbox: () => [row("studio_lead")],
      capture_event_registration_lead: () => ({ outcome: "captured" }),
      complete_event_settlement_outbox: () => true,
    });
    expect(await drainEventSettlementOutbox({ admin, stripe: null, owner: "w1" })).toEqual({ claimed: 1, done: 1, failed: 0 });
    expect(calls.find((call) => call.fn === "capture_event_registration_lead")?.args).toEqual({ p_registration_id: "reg-1" });
  });
});
