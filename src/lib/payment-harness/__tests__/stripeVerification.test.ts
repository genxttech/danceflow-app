import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { verifyCheckoutSessionIsTestMode } from "@/lib/payment-harness/stripeVerification";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

/**
 * Regression coverage for the Payment Harness Slice 5 Stripe test-mode
 * re-verification. Never constructs a real `Stripe` client -- every test
 * injects a fake `createStripeClient` implementing only the
 * `checkout.sessions.retrieve` method this module actually calls, so no
 * real network/Stripe account is touched.
 */

const ENV_KEYS = ["PAYMENT_HARNESS_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_test_fake_key_not_real";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function fakeStripeClient(session: { livemode?: unknown } | (() => Promise<{ livemode?: unknown }>)) {
  return () => ({
    checkout: {
      sessions: {
        retrieve: async () => (typeof session === "function" ? session() : session),
      },
    },
  });
}

describe("verifyCheckoutSessionIsTestMode", () => {
  it("passes when the retrieved session has livemode === false", async () => {
    await expect(
      verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: fakeStripeClient({ livemode: false }),
      }),
    ).resolves.not.toThrow();
  });

  it("fails closed when the retrieved session has livemode === true", async () => {
    await expect(
      verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: fakeStripeClient({ livemode: true }),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed before even attempting retrieval when the configured key is a live key", async () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_live_fake_key_not_real";
    let retrieveCalled = false;

    await expect(
      verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: () => ({
          checkout: {
            sessions: {
              retrieve: async () => {
                retrieveCalled = true;
                return { livemode: false };
              },
            },
          },
        }),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
    expect(retrieveCalled).toBe(false);
  });

  it("never falls back to the application's own STRIPE_SECRET_KEY", async () => {
    delete process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_should_never_be_used_by_the_harness";

    await expect(
      verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: fakeStripeClient({ livemode: false }),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed (ambiguous context) when session retrieval itself fails", async () => {
    await expect(
      verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: fakeStripeClient(() => {
          throw new Error("simulated retrieval failure");
        }),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("uses the CHECKOUT_SESSION_CONTEXT_AMBIGUOUS code when retrieval fails", async () => {
    try {
      await verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: fakeStripeClient(() => {
          throw new Error("simulated retrieval failure");
        }),
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CHECKOUT_SESSION_CONTEXT_AMBIGUOUS");
    }
  });

  it("fails closed when livemode is missing/non-boolean on the retrieved session", async () => {
    await expect(
      verifyCheckoutSessionIsTestMode({
        sessionId: "cs_test_abc",
        connectedAccountId: "acct_123",
        context: "t",
        createStripeClient: fakeStripeClient({}),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });
});
