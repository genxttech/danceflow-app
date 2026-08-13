import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadPaymentHarnessConfig } from "@/lib/payment-harness/config";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

const ENV_KEYS = [
  "PAYMENT_HARNESS_STUDIO_ID",
  "PAYMENT_HARNESS_CLIENT_ID",
  "PAYMENT_HARNESS_ENVIRONMENT",
  "PAYMENT_HARNESS_BASE_URL",
  "PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL",
  "VERCEL_ENV",
  // Application/runtime secrets this module must never fall back to.
  "STRIPE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  // Production Synthetic Harness variables this module must never fall
  // back to, even though they serve a conceptually similar purpose.
  "SYNTHETIC_STUDIO_ID",
  "SYNTHETIC_STUDENT_CLIENT_ID",
] as const;

const VALID_STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const VALID_CLIENT_ID = "22222222-2222-4222-8222-222222222222";

// All-digit UUIDs (like the two above) round-trip through upper/lowercase
// trivially and can't actually demonstrate case normalization. This one
// contains real hex letters so case-normalization tests are meaningful.
const HEX_LETTER_ID = "abcdef12-3456-4abc-89ab-cdefabcdef12";

function toMixedCase(value: string) {
  return value
    .split("")
    .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
    .join("");
}

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

const VALID_BASE_URL = "https://harness-qa.example.com";
const VALID_PORTAL_LOGIN_EMAIL = "harness-qa@example.com";

function setValidBase() {
  process.env.PAYMENT_HARNESS_STUDIO_ID = VALID_STUDIO_ID;
  process.env.PAYMENT_HARNESS_CLIENT_ID = VALID_CLIENT_ID;
  process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
  process.env.PAYMENT_HARNESS_BASE_URL = VALID_BASE_URL;
  process.env.PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL = VALID_PORTAL_LOGIN_EMAIL;
}

describe("loadPaymentHarnessConfig", () => {
  it("fails closed when PAYMENT_HARNESS_STUDIO_ID is missing", () => {
    process.env.PAYMENT_HARNESS_CLIENT_ID = VALID_CLIENT_ID;
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when PAYMENT_HARNESS_CLIENT_ID is missing", () => {
    process.env.PAYMENT_HARNESS_STUDIO_ID = VALID_STUDIO_ID;
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed on a malformed (non-UUID) studio id", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_STUDIO_ID = "not-a-uuid";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed on a malformed (non-UUID) client id", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_CLIENT_ID = "not-a-uuid";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when the environment is production, even with otherwise-valid studio/client ids", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "production";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when the environment is unresolved", () => {
    process.env.PAYMENT_HARNESS_STUDIO_ID = VALID_STUDIO_ID;
    process.env.PAYMENT_HARNESS_CLIENT_ID = VALID_CLIENT_ID;
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("succeeds with valid studio/client ids and environment=development", () => {
    setValidBase();
    const config = loadPaymentHarnessConfig();
    expect(config).toEqual({
      studioId: VALID_STUDIO_ID,
      clientId: VALID_CLIENT_ID,
      environment: "development",
      baseUrl: VALID_BASE_URL,
      portalLoginEmail: VALID_PORTAL_LOGIN_EMAIL,
    });
  });

  it("fails closed when PAYMENT_HARNESS_BASE_URL is missing", () => {
    setValidBase();
    delete process.env.PAYMENT_HARNESS_BASE_URL;
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed on a malformed PAYMENT_HARNESS_BASE_URL", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_BASE_URL = "not-a-url";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed on a non-http(s) PAYMENT_HARNESS_BASE_URL", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_BASE_URL = "ftp://harness-qa.example.com";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("stores PAYMENT_HARNESS_BASE_URL as a normalized origin, dropping any path/query", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_BASE_URL = "https://harness-qa.example.com/some/path?x=1";
    const config = loadPaymentHarnessConfig();
    expect(config.baseUrl).toBe("https://harness-qa.example.com");
  });

  it("fails closed when PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL is missing", () => {
    setValidBase();
    delete process.env.PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL;
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed on a malformed PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL = "not-an-email";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("never falls back to the application's own NEXT_PUBLIC_APP_URL/NEXT_PUBLIC_SITE_URL for the base URL", () => {
    process.env.PAYMENT_HARNESS_STUDIO_ID = VALID_STUDIO_ID;
    process.env.PAYMENT_HARNESS_CLIENT_ID = VALID_CLIENT_ID;
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    process.env.PAYMENT_HARNESS_PORTAL_LOGIN_EMAIL = VALID_PORTAL_LOGIN_EMAIL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    process.env.NEXT_PUBLIC_SITE_URL = "https://site.example.com";
    // PAYMENT_HARNESS_BASE_URL deliberately left unset.
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("succeeds with environment=preview", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "preview";
    const config = loadPaymentHarnessConfig();
    expect(config.environment).toBe("preview");
  });

  it("never falls back to the application's own Stripe/Supabase secrets", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    process.env.STRIPE_SECRET_KEY = "sk_test_should_never_be_used_by_the_harness";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "should-never-be-used-either";
    // Deliberately leave PAYMENT_HARNESS_STUDIO_ID/CLIENT_ID unset -- if
    // this succeeded, it would mean one of the app secrets above was
    // somehow used as a stand-in identifier, which must never happen.
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("never falls back to the Production Synthetic Harness's SYNTHETIC_* variables", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    process.env.SYNTHETIC_STUDIO_ID = VALID_STUDIO_ID;
    process.env.SYNTHETIC_STUDENT_CLIENT_ID = VALID_CLIENT_ID;
    // Both SYNTHETIC_* values are valid-looking UUIDs on purpose -- this
    // proves the failure is genuinely "no fallback occurred," not just
    // "the fallback value happened to be malformed."
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("does not leak a configured secret-shaped value into a thrown error message", () => {
    process.env.PAYMENT_HARNESS_ENVIRONMENT = "development";
    process.env.STRIPE_SECRET_KEY = "sk_test_super_secret_value_zzz";
    let message = "";
    try {
      loadPaymentHarnessConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("sk_test_super_secret_value_zzz");
  });

  it("returns a frozen config object", () => {
    setValidBase();
    const config = loadPaymentHarnessConfig();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("cannot be mutated after loading -- reassigning a field throws rather than silently succeeding", () => {
    setValidBase();
    const config = loadPaymentHarnessConfig();
    expect(() => {
      (config as { studioId: string }).studioId = "attempted-mutation";
    }).toThrow(TypeError);
    // The value genuinely did not change -- this is what actually matters,
    // the thrown TypeError is just the mechanism that guarantees it.
    expect(config.studioId).toBe(VALID_STUDIO_ID);
  });

  it("accepts an uppercase UUID and stores it lowercase", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_STUDIO_ID = HEX_LETTER_ID.toUpperCase();
    process.env.PAYMENT_HARNESS_CLIENT_ID = VALID_CLIENT_ID;
    const config = loadPaymentHarnessConfig();
    expect(config.studioId).toBe(HEX_LETTER_ID);
  });

  it("accepts a mixed-case UUID and stores it lowercase", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_STUDIO_ID = VALID_STUDIO_ID;
    process.env.PAYMENT_HARNESS_CLIENT_ID = toMixedCase(HEX_LETTER_ID);
    const config = loadPaymentHarnessConfig();
    expect(config.clientId).toBe(HEX_LETTER_ID);
  });

  it("lowercase UUID behavior is unchanged", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_STUDIO_ID = HEX_LETTER_ID;
    process.env.PAYMENT_HARNESS_CLIENT_ID = VALID_CLIENT_ID;
    const config = loadPaymentHarnessConfig();
    expect(config.studioId).toBe(HEX_LETTER_ID);
  });

  it("still fails closed on a malformed studio id, even after case normalization", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_STUDIO_ID = "NOT-A-UUID";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });

  it("still fails closed on a malformed client id, even after case normalization", () => {
    setValidBase();
    process.env.PAYMENT_HARNESS_CLIENT_ID = "NOT-A-UUID";
    expect(() => loadPaymentHarnessConfig()).toThrow(PaymentHarnessSafetyError);
  });
});
