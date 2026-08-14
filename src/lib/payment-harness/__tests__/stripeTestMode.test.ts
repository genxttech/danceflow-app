import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertPaymentHarnessStripeTestModeKey,
  assertStripeObjectIsTestMode,
} from "@/lib/payment-harness/stripeTestMode";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

const ENV_KEYS = ["PAYMENT_HARNESS_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("assertPaymentHarnessStripeTestModeKey", () => {
  it("accepts an sk_test_ key and returns it", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_test_abc123";
    expect(assertPaymentHarnessStripeTestModeKey()).toBe("sk_test_abc123");
  });

  it("accepts an rk_test_ (restricted test) key and returns it", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "rk_test_abc123";
    expect(assertPaymentHarnessStripeTestModeKey()).toBe("rk_test_abc123");
  });

  it("rejects an sk_live_ key", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_live_abc123";
    expect(() => assertPaymentHarnessStripeTestModeKey()).toThrow(PaymentHarnessSafetyError);
  });

  it("rejects an rk_live_ key", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "rk_live_abc123";
    expect(() => assertPaymentHarnessStripeTestModeKey()).toThrow(PaymentHarnessSafetyError);
  });

  it("uses the STRIPE_KEY_LIVE_MODE code for a live key, distinct from a malformed one", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_live_abc123";
    try {
      assertPaymentHarnessStripeTestModeKey();
      throw new Error("expected assertPaymentHarnessStripeTestModeKey to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STRIPE_KEY_LIVE_MODE");
    }
  });

  it("rejects a missing key", () => {
    expect(() => assertPaymentHarnessStripeTestModeKey()).toThrow(PaymentHarnessSafetyError);
  });

  it("uses the STRIPE_KEY_MISSING code for a missing key", () => {
    try {
      assertPaymentHarnessStripeTestModeKey();
      throw new Error("expected assertPaymentHarnessStripeTestModeKey to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STRIPE_KEY_MISSING");
    }
  });

  it("rejects a malformed/unknown key prefix (e.g. a publishable key)", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "pk_test_abc123";
    expect(() => assertPaymentHarnessStripeTestModeKey()).toThrow(PaymentHarnessSafetyError);
  });

  it("uses the STRIPE_KEY_MALFORMED code for an unrecognized prefix", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "not_a_stripe_key_at_all";
    try {
      assertPaymentHarnessStripeTestModeKey();
      throw new Error("expected assertPaymentHarnessStripeTestModeKey to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STRIPE_KEY_MALFORMED");
    }
  });

  it("never falls back to the application's own STRIPE_SECRET_KEY", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_should_never_be_used_by_the_harness";
    // PAYMENT_HARNESS_STRIPE_SECRET_KEY deliberately left unset -- if this
    // succeeded, it would mean the app's own key was used as a fallback.
    expect(() => assertPaymentHarnessStripeTestModeKey()).toThrow(PaymentHarnessSafetyError);
  });

  it("never leaks the secret value into a thrown error message, even on a live-key rejection", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_live_marked_secret_value_zzz";
    let message = "";
    try {
      assertPaymentHarnessStripeTestModeKey();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("marked_secret_value_zzz");
  });

  it("never leaks the secret value into a thrown error message on a malformed-key rejection", () => {
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "totally_bogus_marked_value_zzz";
    let message = "";
    try {
      assertPaymentHarnessStripeTestModeKey();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("marked_value_zzz");
  });
});

describe("assertStripeObjectIsTestMode", () => {
  it("passes when livemode is false", () => {
    expect(() => assertStripeObjectIsTestMode({ livemode: false }, "test")).not.toThrow();
  });

  it("fails closed when livemode is true", () => {
    expect(() => assertStripeObjectIsTestMode({ livemode: true }, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("uses the STRIPE_LIVEMODE_TRUE code", () => {
    try {
      assertStripeObjectIsTestMode({ livemode: true }, "test");
      throw new Error("expected assertStripeObjectIsTestMode to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STRIPE_LIVEMODE_TRUE");
    }
  });

  it("fails closed when livemode is missing", () => {
    expect(() => assertStripeObjectIsTestMode({}, "test")).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when the object itself is null or undefined", () => {
    expect(() => assertStripeObjectIsTestMode(null, "test")).toThrow(PaymentHarnessSafetyError);
    expect(() => assertStripeObjectIsTestMode(undefined, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("fails closed when livemode is a non-boolean value -- e.g. a string or number that happens to look falsy/truthy", () => {
    expect(() => assertStripeObjectIsTestMode({ livemode: "false" }, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
    expect(() => assertStripeObjectIsTestMode({ livemode: 0 }, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
    expect(() => assertStripeObjectIsTestMode({ livemode: null }, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("uses the STRIPE_LIVEMODE_UNKNOWN code for missing/non-boolean livemode", () => {
    try {
      assertStripeObjectIsTestMode({ livemode: "false" }, "test");
      throw new Error("expected assertStripeObjectIsTestMode to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STRIPE_LIVEMODE_UNKNOWN");
    }
  });

  it("does not leak other object fields (e.g. an id) into the thrown message", () => {
    let message = "";
    try {
      assertStripeObjectIsTestMode(
        { livemode: true, id: "cs_test_marked_session_id_zzz" } as { livemode: unknown },
        "test",
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("marked_session_id_zzz");
  });
});
