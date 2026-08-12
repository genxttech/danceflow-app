import { describe, expect, it } from "vitest";
import {
  PaymentHarnessSafetyError,
  assertConfirmed,
  assertPaymentHarnessClient,
  assertPaymentHarnessEnvironmentAllowed,
  assertPaymentHarnessStudio,
} from "@/lib/payment-harness/guards";
import type { PaymentHarnessConfig } from "@/lib/payment-harness/types";

function baseConfig(overrides: Partial<PaymentHarnessConfig> = {}): PaymentHarnessConfig {
  return {
    studioId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
    environment: "development",
    ...overrides,
  };
}

describe("PaymentHarnessSafetyError", () => {
  it("is a distinct Error subclass carrying a machine-readable code", () => {
    const error = new PaymentHarnessSafetyError("boom", "SOME_CODE");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PaymentHarnessSafetyError");
    expect(error.code).toBe("SOME_CODE");
    expect(error.message).toBe("boom");
  });
});

describe("assertPaymentHarnessEnvironmentAllowed", () => {
  it("passes for development", () => {
    expect(() => assertPaymentHarnessEnvironmentAllowed("development", "test")).not.toThrow();
  });

  it("passes for preview", () => {
    expect(() => assertPaymentHarnessEnvironmentAllowed("preview", "test")).not.toThrow();
  });

  it("throws for production -- positive allowlist, not a negative production-only check", () => {
    expect(() => assertPaymentHarnessEnvironmentAllowed("production", "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("throws for an unrecognized environment value", () => {
    expect(() => assertPaymentHarnessEnvironmentAllowed("staging", "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("throws for test (not on the allowlist, same as any other unrecognized value)", () => {
    expect(() => assertPaymentHarnessEnvironmentAllowed("test", "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("throws for null/undefined/empty", () => {
    expect(() => assertPaymentHarnessEnvironmentAllowed(null, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
    expect(() => assertPaymentHarnessEnvironmentAllowed(undefined, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
    expect(() => assertPaymentHarnessEnvironmentAllowed("", "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("uses the ENVIRONMENT_NOT_ALLOWED code for every rejection", () => {
    try {
      assertPaymentHarnessEnvironmentAllowed("production", "test");
      throw new Error("expected assertPaymentHarnessEnvironmentAllowed to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentHarnessSafetyError);
      expect((error as PaymentHarnessSafetyError).code).toBe("ENVIRONMENT_NOT_ALLOWED");
    }
  });
});

describe("assertPaymentHarnessStudio", () => {
  it("passes when the resolved studio id matches the configured one", () => {
    const config = baseConfig();
    expect(() => assertPaymentHarnessStudio(config, config.studioId, "test")).not.toThrow();
  });

  it("throws on a configured studio mismatch", () => {
    const config = baseConfig();
    expect(() =>
      assertPaymentHarnessStudio(config, "99999999-9999-4999-8999-999999999999", "test"),
    ).toThrow(PaymentHarnessSafetyError);
  });

  it("throws when the resolved studio id is missing", () => {
    const config = baseConfig();
    expect(() => assertPaymentHarnessStudio(config, null, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
    expect(() => assertPaymentHarnessStudio(config, undefined, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("uses the STUDIO_MISMATCH code", () => {
    const config = baseConfig();
    try {
      assertPaymentHarnessStudio(config, "wrong", "test");
      throw new Error("expected assertPaymentHarnessStudio to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STUDIO_MISMATCH");
    }
  });
});

describe("assertPaymentHarnessClient", () => {
  it("passes when the resolved client id matches the configured one", () => {
    const config = baseConfig();
    expect(() => assertPaymentHarnessClient(config, config.clientId, "test")).not.toThrow();
  });

  it("throws on a configured client mismatch", () => {
    const config = baseConfig();
    expect(() =>
      assertPaymentHarnessClient(config, "99999999-9999-4999-8999-999999999999", "test"),
    ).toThrow(PaymentHarnessSafetyError);
  });

  it("throws when the resolved client id is missing", () => {
    const config = baseConfig();
    expect(() => assertPaymentHarnessClient(config, null, "test")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("uses the CLIENT_MISMATCH code", () => {
    const config = baseConfig();
    try {
      assertPaymentHarnessClient(config, "wrong", "test");
      throw new Error("expected assertPaymentHarnessClient to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CLIENT_MISMATCH");
    }
  });

  it("a studio match does not imply a client match -- the two guards are independent", () => {
    const config = baseConfig();
    // Correct studio, wrong client: the studio guard alone would pass, so
    // the client guard must independently catch this rather than callers
    // being able to rely on only one of the two.
    expect(() => assertPaymentHarnessStudio(config, config.studioId, "test")).not.toThrow();
    expect(() =>
      assertPaymentHarnessClient(config, "99999999-9999-4999-8999-999999999999", "test"),
    ).toThrow(PaymentHarnessSafetyError);
  });
});

describe("assertConfirmed", () => {
  it("passes when confirmed is true", () => {
    expect(() => assertConfirmed(true, "test")).not.toThrow();
  });

  it("throws when confirmed is false", () => {
    expect(() => assertConfirmed(false, "test")).toThrow(PaymentHarnessSafetyError);
  });

  it("uses the NOT_CONFIRMED code", () => {
    try {
      assertConfirmed(false, "test");
      throw new Error("expected assertConfirmed to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("NOT_CONFIRMED");
    }
  });
});
