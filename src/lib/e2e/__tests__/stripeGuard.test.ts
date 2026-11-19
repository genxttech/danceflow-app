import { describe, expect, it } from "vitest";
import { classifyStripeError, runStripeGuard, type GuardConfig } from "../stripeGuard";

const PLATFORM = "acct_PLATFORM1";
const CONNECTED = "acct_CONNECTED1";
const config: GuardConfig = { expectPlatform: PLATFORM, connectedAccount: CONNECTED, successUrl: "http://127.0.0.1:3000/ok", cancelUrl: "http://127.0.0.1:3000/no" };
const KEY = "sk_test_unit123";

type Overrides = Partial<{
  live: boolean; platformId: string; createError: unknown; confirmError: unknown; fee: number | null; chargeFee: string | null; received: number; expireStatus: string;
}>;

type FakeSession = { id: string; status: string; payment_status: string; livemode: boolean; payment_intent: string | null; customer_email: null };

/** A Stripe-shaped fake that records calls; every call that needs the connected account must pass stripeAccount. */
function fakeStripe(o: Overrides = {}) {
  const calls: string[] = [];
  const sessions = new Map<string, FakeSession>();
  let n = 0;
  const stripe = {
    balance: { retrieve: async () => ({ livemode: o.live ?? false }) },
    accounts: {
      retrieve: async (id: string) => (
        { id, charges_enabled: false, payouts_enabled: false, capabilities: { card_payments: "inactive", transfers: "inactive" }, requirements: { currently_due: new Array(7).fill("x"), disabled_reason: "requirements.past_due" } }
      ),
    },
    checkout: {
      sessions: {
        create: async (_params: unknown, opts: { stripeAccount?: string }) => {
          calls.push(`create:${opts?.stripeAccount}`);
          if (o.createError) throw o.createError;
          const id = `cs_test_${++n}`;
          sessions.set(id, { id, status: "open", payment_status: "unpaid", livemode: false, payment_intent: null, customer_email: null });
          return sessions.get(id)!;
        },
        expire: async (id: string, _p: unknown, opts: { stripeAccount?: string }) => {
          calls.push(`expire:${opts?.stripeAccount}`);
          const s = sessions.get(id)!;
          s.status = o.expireStatus ?? "expired";
          return s;
        },
        retrieve: async (id: string) => sessions.get(id)!,
      },
    },
    paymentMethods: { create: async () => ({ id: "pm_1" }) },
    rawRequest: async (method: string, path: string) => {
      if (method === "POST") {
        calls.push("confirm");
        if (o.confirmError) throw o.confirmError;
        const s = sessions.get(path.split("/")[3])!;
        s.status = "complete";
        s.payment_status = "paid";
        s.payment_intent = "pi_1";
        return {};
      }
      if (path === "/v1/account") return { id: o.platformId ?? PLATFORM };
      return { livemode: false, total_summary: { due: 100 } };
    },
    paymentIntents: {
      retrieve: async () => ({
        amount_received: o.received ?? 100,
        application_fee_amount: o.fee === undefined ? 10 : o.fee,
        latest_charge: { application_fee: o.chargeFee === undefined ? "fee_1" : o.chargeFee },
      }),
    },
  };
  return { stripe: stripe as never, calls };
}

const stripeError = (over: Record<string, unknown>) => Object.assign(new Error(String(over.message)), over);

describe("stripe guard", () => {
  it("passes: records the restricted account state, proves session creation, then proves payment and the application fee", async () => {
    const { stripe, calls } = fakeStripe();
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(report.ok).toBe(true);
    expect(report.connected).toMatchObject({ charges_enabled: false, card_payments: "inactive", currently_due_count: 7 });
    expect(report.steps.map((s) => s.name).filter((name) => name.startsWith("canary"))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("create")).every((c) => c === `create:${CONNECTED}`)).toBe(true);
    expect(calls).toContain(`expire:${CONNECTED}`);
    expect(calls).toContain("confirm");
  });

  it("refuses a live key shape before any Stripe call, and a live balance", async () => {
    const a = fakeStripe();
    expect((await runStripeGuard({ stripe: a.stripe, key: "sk_live_abc123", config })).ok).toBe(false);
    expect(a.calls).toEqual([]);
    const b = await runStripeGuard({ stripe: fakeStripe({ live: true }).stripe, key: KEY, config });
    expect(b.ok).toBe(false);
    expect(b.stop?.step).toBe("identity");
  });

  it("refuses a key from a different Stripe account", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ platformId: "acct_OTHER" }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toBe("identity");
  });

  it("a capability error on session creation STOPS and reports Stripe's exact error and request id, and says not to request onboarding", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", code: "account_invalid", param: "stripe_account", message: "The account is restricted: card_payments capability is not active.", raw: { request_id: "req_abc123", statusCode: 400 } });
    const report = await runStripeGuard({ stripe: fakeStripe({ createError: err }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.failure).toMatchObject({ kind: "capability", code: "account_invalid", requestId: "req_abc123", statusCode: 400 });
    expect(report.stop?.message).toMatch(/Do not request sandbox onboarding/);
    expect(report.stop?.step).toMatch(/canary A/);
  });

  it("a payment-confirmation failure on a capability STOPS in canary B with the exact error (canary A passing proves session creation only)", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", message: "This account cannot process charges until its requirements are completed.", raw: { request_id: "req_pay1" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ confirmError: err }).stripe, key: KEY, config });
    expect(report.steps.some((s) => s.name.startsWith("canary A") && s.ok)).toBe(true);
    expect(report.stop?.step).toMatch(/canary B/);
    expect(report.stop?.failure).toMatchObject({ kind: "capability", requestId: "req_pay1" });
  });

  it("a plain card decline is not a capability error", async () => {
    const err = stripeError({ type: "StripeCardError", code: "card_declined", message: "Your card was declined.", raw: { request_id: "req_d" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ confirmError: err }).stripe, key: KEY, config });
    expect(report.stop?.failure).toMatchObject({ kind: "other", code: "card_declined" });
  });

  it("fails when the application fee is missing or wrong, or the amount is wrong", async () => {
    for (const over of [{ fee: null }, { fee: 5 }, { chargeFee: null }, { received: 99 }] as Overrides[]) {
      const report = await runStripeGuard({ stripe: fakeStripe(over).stripe, key: KEY, config });
      expect(report.ok, JSON.stringify(over)).toBe(false);
      expect(report.stop?.step).toMatch(/canary B/);
    }
  });

  it("fails if the canary session does not expire", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ expireStatus: "open" }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toMatch(/canary A/);
  });

  it("classifies authentication failures and reads raw fields", () => {
    expect(classifyStripeError(stripeError({ type: "StripeAuthenticationError", message: "Invalid API Key provided", statusCode: 401 })).kind).toBe("authentication");
    expect(classifyStripeError(stripeError({ message: "x", raw: { code: "rate_limit", request_id: "req_9" } }))).toMatchObject({ code: "rate_limit", requestId: "req_9", kind: "other" });
  });
});
