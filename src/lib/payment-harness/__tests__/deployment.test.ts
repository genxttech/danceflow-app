import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolvePaymentHarnessEnvironment } from "@/lib/payment-harness/deployment";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

const ENV_KEYS = ["PAYMENT_HARNESS_ENVIRONMENT", "VERCEL_ENV", "NODE_ENV"] as const;

// NODE_ENV is typed read-only by Next.js's ambient types; this is a test
// file deliberately exercising env-var fallback behavior, so it needs
// write access to it -- same cast used by
// src/lib/synthetic/__tests__/deployment.test.ts for the identical reason.
const env = process.env as Record<string, string | undefined>;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = env[key];
    delete env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete env[key];
    } else {
      env[key] = savedEnv[key];
    }
  }
});

describe("resolvePaymentHarnessEnvironment", () => {
  it("fails closed when nothing is set", () => {
    expect(() => resolvePaymentHarnessEnvironment()).toThrow(PaymentHarnessSafetyError);
  });

  it("resolves development from PAYMENT_HARNESS_ENVIRONMENT", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    expect(resolvePaymentHarnessEnvironment()).toBe("development");
  });

  it("resolves preview from PAYMENT_HARNESS_ENVIRONMENT", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "preview";
    expect(resolvePaymentHarnessEnvironment()).toBe("preview");
  });

  it("rejects production", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "production";
    expect(() => resolvePaymentHarnessEnvironment()).toThrow(PaymentHarnessSafetyError);
  });

  it("rejects test -- not on the allowlist even though the design discusses automated-test contexts elsewhere", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "test";
    expect(() => resolvePaymentHarnessEnvironment()).toThrow(PaymentHarnessSafetyError);
  });

  it("rejects an unrecognized value", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "staging";
    expect(() => resolvePaymentHarnessEnvironment()).toThrow(PaymentHarnessSafetyError);
  });

  it("falls back to VERCEL_ENV when PAYMENT_HARNESS_ENVIRONMENT is unset", () => {
    process.env.VERCEL_ENV = "preview";
    expect(resolvePaymentHarnessEnvironment()).toBe("preview");
  });

  it("PAYMENT_HARNESS_ENVIRONMENT takes precedence over VERCEL_ENV when both are set", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "preview";
    process.env.VERCEL_ENV = "production";
    expect(resolvePaymentHarnessEnvironment()).toBe("preview");
  });

  it("never falls back to NODE_ENV", () => {
    env.NODE_ENV = "development";
    // Neither PAYMENT_HARNESS_ENVIRONMENT nor VERCEL_ENV is set -- if this
    // resolved successfully it would mean NODE_ENV silently leaked in as a
    // fallback, which it must not.
    expect(() => resolvePaymentHarnessEnvironment()).toThrow(PaymentHarnessSafetyError);
  });

  it("treats an empty-string PAYMENT_HARNESS_ENVIRONMENT as unset, not as a value to validate literally", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "   ";
    process.env.VERCEL_ENV = "development";
    expect(resolvePaymentHarnessEnvironment()).toBe("development");
  });
});
