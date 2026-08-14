import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import {
  assertAllowedNavigationOrigin,
  assertDisplayedBalanceMatches,
  assertSameCheckoutSession,
  assertStripeCheckoutUrlIsTestMode,
  parseDisplayedBalanceCents,
  parseStripeCheckoutSessionId,
  runFirstCheckoutSubmitPhase,
  runFixtureAndPortalStatePhase,
  runPaymentHarnessFloorRentalBrowserScenario,
  runPrePaymentReadinessPhase,
  runReuseVerificationPhase,
  runVerifyCompletedPaymentPhase,
  type PaymentHarnessBrowserPage,
} from "@/lib/payment-harness/browser";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";
import { readPaymentHarnessRunById } from "@/lib/payment-harness/evidence";
import type { PaymentHarnessCheckoutCapture, PaymentHarnessConfig } from "@/lib/payment-harness/types";

/**
 * Regression coverage for the Payment Harness browser wrapper (Slice 4).
 * No real Playwright browser is ever launched here -- orchestration tests
 * inject a FakePage implementing the same narrow
 * `PaymentHarnessBrowserPage` interface the real Playwright-backed
 * implementation does, and DB access goes through the same
 * FakeTable/createFakeAdminClient fixture already shared across the
 * payments test suite. No real Stripe account or network access is
 * required for any test in this file.
 */

const CONFIG: PaymentHarnessConfig = Object.freeze({
  studioId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  environment: "development",
  baseUrl: "https://harness-qa.example.com",
  portalLoginEmail: "harness-qa@example.com",
});

const FIRST_CHECKOUT_URL =
  "https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4E5F6G7H8I9J0#fidkdWxOYHwnPyd1blpxYHZxWjA0SWRGf2RC";
const SECOND_CHECKOUT_URL_SAME_SESSION =
  "https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4E5F6G7H8I9J0#a-different-fragment-same-session";
const DIFFERENT_SESSION_URL =
  "https://checkout.stripe.com/c/pay/cs_test_ZZZZZZZZZZZZZZZZZZZZ#fidkdWxOYHwnPyd1blpxYHZxWjA0SWRGf2RC";
const LIVE_MODE_URL = "https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4E5F6G7H8I9J0#fidkd";
const LEGACY_SHAPE_URL = "https://checkout.stripe.com/pay/cs_test_legacyShapeId123#fidkd";

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("assertAllowedNavigationOrigin", () => {
  it("accepts the configured app origin", () => {
    expect(
      assertAllowedNavigationOrigin(`${CONFIG.baseUrl}/portal/some-studio/floor-space/my-rentals`, CONFIG, "t"),
    ).toBe("app");
  });

  it("rejects an unexpected app-like origin", () => {
    expect(() =>
      assertAllowedNavigationOrigin("https://not-the-configured-origin.example.com/portal", CONFIG, "t"),
    ).toThrow(PaymentHarnessSafetyError);
  });

  it("accepts the expected Stripe Checkout origin", () => {
    expect(assertAllowedNavigationOrigin(FIRST_CHECKOUT_URL, CONFIG, "t")).toBe("stripe_checkout");
  });

  it("rejects an unexpected external origin", () => {
    expect(() => assertAllowedNavigationOrigin("https://evil.example.com/phishing", CONFIG, "t")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("rejects an unparseable URL", () => {
    expect(() => assertAllowedNavigationOrigin("not a url at all", CONFIG, "t")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("uses the BROWSER_UNEXPECTED_ORIGIN code for a rejected origin", () => {
    try {
      assertAllowedNavigationOrigin("https://evil.example.com", CONFIG, "t");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("BROWSER_UNEXPECTED_ORIGIN");
    }
  });
});

describe("parseStripeCheckoutSessionId", () => {
  it("parses the session id from the current hosted Checkout URL shape (/c/pay/cs_test_...)", () => {
    expect(parseStripeCheckoutSessionId(FIRST_CHECKOUT_URL)).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
  });

  it("parses the session id from the legacy hosted Checkout URL shape (/pay/cs_test_...)", () => {
    expect(parseStripeCheckoutSessionId(LEGACY_SHAPE_URL)).toBe("cs_test_legacyShapeId123");
  });

  it("returns null for a URL with no cs_ session id", () => {
    expect(parseStripeCheckoutSessionId("https://checkout.stripe.com/c/pay/")).toBeNull();
  });
});

describe("assertStripeCheckoutUrlIsTestMode", () => {
  it("accepts a cs_test_ session id and returns it", () => {
    expect(assertStripeCheckoutUrlIsTestMode(FIRST_CHECKOUT_URL, "t")).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
  });

  it("rejects a cs_live_ session id", () => {
    expect(() => assertStripeCheckoutUrlIsTestMode(LIVE_MODE_URL, "t")).toThrow(PaymentHarnessSafetyError);
  });

  it("uses the CHECKOUT_SESSION_LIVEMODE code for a live-mode session id", () => {
    try {
      assertStripeCheckoutUrlIsTestMode(LIVE_MODE_URL, "t");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CHECKOUT_SESSION_LIVEMODE");
    }
  });

  it("rejects a URL with no parseable session id", () => {
    expect(() => assertStripeCheckoutUrlIsTestMode("https://checkout.stripe.com/c/pay/", "t")).toThrow(
      PaymentHarnessSafetyError,
    );
  });
});

describe("parseDisplayedBalanceCents", () => {
  it("parses a dollar amount immediately after the balance label", () => {
    expect(parseDisplayedBalanceCents("Balance due right now\n$40.00\n2 unpaid rentals")).toBe(4000);
  });

  it("parses an amount with a thousands separator", () => {
    expect(parseDisplayedBalanceCents("Balance due right now\n$1,234.56")).toBe(123456);
  });

  it("returns null when the label is not present", () => {
    expect(parseDisplayedBalanceCents("Nothing relevant here")).toBeNull();
  });

  it("returns null when no dollar amount follows the label", () => {
    expect(parseDisplayedBalanceCents("Balance due right now\nno amount here")).toBeNull();
  });
});

describe("assertDisplayedBalanceMatches", () => {
  it("passes and returns the parsed cents when it matches", () => {
    expect(assertDisplayedBalanceMatches("Balance due right now\n$40.00", 4000, "t")).toBe(4000);
  });

  it("fails closed on a mismatch", () => {
    expect(() => assertDisplayedBalanceMatches("Balance due right now\n$40.00", 5000, "t")).toThrow(
      PaymentHarnessSafetyError,
    );
  });

  it("fails closed when unparseable", () => {
    expect(() => assertDisplayedBalanceMatches("nothing here", 4000, "t")).toThrow(PaymentHarnessSafetyError);
  });
});

describe("assertSameCheckoutSession", () => {
  it("passes when both captures share the same session id", () => {
    const first: PaymentHarnessCheckoutCapture = { url: FIRST_CHECKOUT_URL, sessionId: "cs_test_same" };
    const second: PaymentHarnessCheckoutCapture = {
      url: SECOND_CHECKOUT_URL_SAME_SESSION,
      sessionId: "cs_test_same",
    };
    expect(() => assertSameCheckoutSession(first, second, "t")).not.toThrow();
  });

  it("fails closed when the second capture has a different session id", () => {
    const first: PaymentHarnessCheckoutCapture = { url: FIRST_CHECKOUT_URL, sessionId: "cs_test_first" };
    const second: PaymentHarnessCheckoutCapture = { url: DIFFERENT_SESSION_URL, sessionId: "cs_test_second" };
    expect(() => assertSameCheckoutSession(first, second, "t")).toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when either session id is null", () => {
    const withNull: PaymentHarnessCheckoutCapture = { url: FIRST_CHECKOUT_URL, sessionId: null };
    const withId: PaymentHarnessCheckoutCapture = { url: FIRST_CHECKOUT_URL, sessionId: "cs_test_x" };
    expect(() => assertSameCheckoutSession(withNull, withId, "t")).toThrow(PaymentHarnessSafetyError);
  });
});

// ---------------------------------------------------------------------------
// Orchestration, with a fake page + fake Supabase admin client
// ---------------------------------------------------------------------------

class FakePage implements PaymentHarnessBrowserPage {
  private currentUrl: string;
  private pageText = "";
  private nextCheckoutUrl: string | null = null;
  readonly gotoUrls: string[] = [];
  submitCount = 0;

  constructor(startUrl: string) {
    this.currentUrl = startUrl;
  }

  async goto(url: string) {
    this.gotoUrls.push(url);
    this.currentUrl = url;
  }

  url() {
    return this.currentUrl;
  }

  async getDisplayedPageText() {
    return this.pageText;
  }

  async submitPayOpenBalance() {
    this.submitCount += 1;
    if (this.nextCheckoutUrl) this.currentUrl = this.nextCheckoutUrl;
  }

  setPageText(text: string) {
    this.pageText = text;
  }

  setNextCheckoutUrl(url: string | null) {
    this.nextCheckoutUrl = url;
  }
}

function readyWebhookFetch(status = 400) {
  return async () => ({ status });
}

function testModeStripeClient(livemode = false, url: string | null = FIRST_CHECKOUT_URL) {
  return () => ({
    checkout: { sessions: { retrieve: async () => ({ livemode, url: url ?? undefined }) } },
  });
}

// ---------------------------------------------------------------------------
// Slice 5 Connect-listener readiness DI fakes -- never touches the real
// Stripe CLI or Stripe API. seedReadinessProbeRow() must be called (with a
// created_at at/after CONNECT_READINESS_FIXED_NOW) for validConnectReadiness()
// to find a match; failingConnectReadiness() fails at the CLI-trigger step,
// before any DB lookup, so it needs no seeded row.
// ---------------------------------------------------------------------------

const CONNECT_READINESS_EVENT_ID = "evt_test_fake_readiness_probe";
const CONNECT_READINESS_FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const STUDIO_CONNECTED_ACCOUNT_ID = "acct_test_fake_not_real";

type ConnectReadinessDI = NonNullable<
  Parameters<typeof runPrePaymentReadinessPhase>[0]["connectReadiness"]
>;

function seedReadinessProbeRow(overrides: Record<string, unknown> = {}) {
  paymentProviderEventsTable.rows.push({
    id: `readiness-row-${paymentProviderEventsTable.rows.length + 1}`,
    provider: "stripe",
    event_type: "product.updated",
    status: "processed",
    provider_event_id: CONNECT_READINESS_EVENT_ID,
    created_at: "2026-01-01T00:00:05.000Z",
    ...overrides,
  });
}

function validConnectReadiness(): ConnectReadinessDI {
  return {
    triggerFn: async () => ({ exitCode: 0, stdout: "Trigger succeeded!", stderr: "" }),
    now: () => CONNECT_READINESS_FIXED_NOW,
    sleepFn: async () => {},
    pollMaxAttempts: 1,
    pollIntervalMs: 0,
    createStripeEventClient: () => ({
      events: {
        retrieve: async () => ({
          id: CONNECT_READINESS_EVENT_ID,
          type: "product.updated",
          livemode: false,
          account: STUDIO_CONNECTED_ACCOUNT_ID,
        }),
      },
    }),
  };
}

function failingConnectReadiness(): ConnectReadinessDI {
  return {
    triggerFn: async () => ({ exitCode: 1, stdout: "", stderr: "simulated CLI failure" }),
    now: () => CONNECT_READINESS_FIXED_NOW,
    sleepFn: async () => {},
    pollMaxAttempts: 1,
    pollIntervalMs: 0,
  };
}

const AUTH_USER_ID = "auth-user-1";
const FAKE_TOKEN_HASH = "fake-token-hash-not-a-real-secret";

let clientsTable: FakeTable;
let appointmentsTable: FakeTable;
let studiosTable: FakeTable;
let paymentsTable: FakeTable;
let runsTable: FakeTable;
let profilesTable: FakeTable;
let clientAccountLinksTable: FakeTable;
let paymentProviderEventsTable: FakeTable;

function fakeAdmin() {
  const base = createFakeAdminClient({
    clients: clientsTable,
    appointments: appointmentsTable,
    studios: studiosTable,
    payments: paymentsTable,
    payment_harness_runs: runsTable,
    profiles: profilesTable,
    client_account_links: clientAccountLinksTable,
    payment_provider_events: paymentProviderEventsTable,
  });

  return {
    ...base,
    auth: {
      admin: {
        async generateLink() {
          return { data: { properties: { hashed_token: FAKE_TOKEN_HASH } }, error: null };
        },
      },
    },
  } as never;
}

/** A minimal always-erroring `.from(table).select(...).eq(...)...` chain,
 * for simulating a genuine DB lookup failure -- fakeSupabase.ts's FakeTable
 * has no built-in hook for an arbitrary SELECT error, so this is a
 * purpose-built thenable that resolves to `{ data: null, error }` after any
 * number of chained `.eq()` calls. */
function failingSelectChain(message: string) {
  const chain: { eq: () => typeof chain; then: (resolve: (result: unknown) => void) => void } = {
    eq: () => chain,
    then: (resolve) => resolve({ data: null, error: { message } }),
  };
  return chain;
}

function fakeAdminWithFailingTable(failingTable: "profiles" | "client_account_links") {
  const base = fakeAdmin() as { from: (table: string) => unknown };
  return {
    ...base,
    from(table: string) {
      if (table === failingTable) {
        return { select: () => failingSelectChain("simulated lookup failure") };
      }
      return base.from(table);
    },
  } as never;
}

const STRIPE_ENV_KEYS = ["PAYMENT_HARNESS_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"] as const;
let savedStripeEnv: Partial<Record<(typeof STRIPE_ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  clientsTable = new FakeTable();
  appointmentsTable = new FakeTable();
  studiosTable = new FakeTable();
  paymentsTable = new FakeTable();
  runsTable = new FakeTable();
  profilesTable = new FakeTable();
  clientAccountLinksTable = new FakeTable();
  paymentProviderEventsTable = new FakeTable();

  clientsTable.rows.push({ id: CONFIG.clientId, studio_id: CONFIG.studioId });
  studiosTable.rows.push({
    id: CONFIG.studioId,
    slug: "qa-studio",
    stripe_connected_account_id: "acct_test_fake_not_real",
  });
  profilesTable.rows.push({ id: AUTH_USER_ID, email: CONFIG.portalLoginEmail });
  clientAccountLinksTable.rows.push({
    user_id: AUTH_USER_ID,
    client_id: CONFIG.clientId,
    studio_id: CONFIG.studioId,
    status: "linked",
  });

  savedStripeEnv = {};
  for (const key of STRIPE_ENV_KEYS) {
    savedStripeEnv[key] = process.env[key];
  }
  process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_test_fake_harness_key_not_real";
});

afterEach(() => {
  for (const key of STRIPE_ENV_KEYS) {
    if (savedStripeEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedStripeEnv[key];
  }
});

function seedPayableAppointment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `apt-${appointmentsTable.rows.length + 1}`,
    studio_id: CONFIG.studioId,
    client_id: CONFIG.clientId,
    appointment_type: "floor_space_rental",
    status: "scheduled",
    payment_status: "unpaid",
    price_amount: 40,
    starts_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  appointmentsTable.rows.push(row);
  return row;
}

function seedPendingPayment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `pay-${paymentsTable.rows.length + 1}`,
    studio_id: CONFIG.studioId,
    client_id: CONFIG.clientId,
    source: "floor_rental",
    status: "pending",
    ...overrides,
  };
  paymentsTable.rows.push(row);
  return row;
}

function markPaymentPaid(paymentRow: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  Object.assign(paymentRow, {
    status: "paid",
    stripe_payment_intent_id: "pi_test_fake123",
    ...overrides,
  });
}

describe("runFixtureAndPortalStatePhase", () => {
  it("establishes the fixture, authenticates, and confirms the displayed balance matches", async () => {
    seedPayableAppointment({ price_amount: 40 });
    const page = new FakePage("about:blank");
    page.setPageText("Balance due right now\n$40.00\n1 unpaid rental");

    const result = await runFixtureAndPortalStatePhase({ page, adminSupabase: fakeAdmin(), config: CONFIG });

    expect(result.expectedBalanceCents).toBe(4000);
    expect(result.displayedBalanceCents).toBe(4000);
    expect(result.checkpoint.status).toBe("passed");
    expect(page.gotoUrls.some((u) => u.includes("/callback"))).toBe(true);
    expect(page.gotoUrls.some((u) => u.includes("/floor-space/my-rentals"))).toBe(true);
  });

  it("fails closed when the displayed balance does not match the fixture's expected balance", async () => {
    seedPayableAppointment({ price_amount: 40 });
    const page = new FakePage("about:blank");
    page.setPageText("Balance due right now\n$99.00");

    await expect(
      runFixtureAndPortalStatePhase({ page, adminSupabase: fakeAdmin(), config: CONFIG }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });
});

describe("post-login portal identity verification (via runFixtureAndPortalStatePhase)", () => {
  function readyPage() {
    const page = new FakePage("about:blank");
    page.setPageText("Balance due right now\n$40.00\n1 unpaid rental");
    return page;
  }

  it("passes when the configured email is linked to the configured client", async () => {
    seedPayableAppointment({ price_amount: 40 });

    await expect(
      runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG }),
    ).resolves.toMatchObject({ expectedBalanceCents: 4000 });
  });

  it("fails closed when the configured email is linked to a different client", async () => {
    clientAccountLinksTable.rows = [
      { user_id: AUTH_USER_ID, client_id: "33333333-3333-4333-8333-333333333333", studio_id: CONFIG.studioId, status: "linked" },
    ];
    seedPayableAppointment({ price_amount: 40 });

    await expect(
      runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when the linked relationship's studio does not match the configured studio", async () => {
    const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
    clientAccountLinksTable.rows = [
      { user_id: AUTH_USER_ID, client_id: CONFIG.clientId, studio_id: OTHER_STUDIO_ID, status: "linked" },
    ];
    seedPayableAppointment({ price_amount: 40 });

    try {
      await runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG });
      throw new Error("expected runFixtureAndPortalStatePhase to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STUDIO_MISMATCH");
    }
  });

  it("fails closed when no relationship links the configured email to the configured client", async () => {
    clientAccountLinksTable.rows = [];
    seedPayableAppointment({ price_amount: 40 });

    await expect(
      runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when multiple relationships link the configured email to the configured client", async () => {
    clientAccountLinksTable.rows.push({
      user_id: AUTH_USER_ID,
      client_id: CONFIG.clientId,
      studio_id: CONFIG.studioId,
      status: "linked",
    });
    seedPayableAppointment({ price_amount: 40 });

    try {
      await runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG });
      throw new Error("expected runFixtureAndPortalStatePhase to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("PORTAL_IDENTITY_AMBIGUOUS");
    }
  });

  it("fails closed when multiple portal profiles match the configured login email", async () => {
    profilesTable.rows.push({ id: "auth-user-2", email: CONFIG.portalLoginEmail });
    seedPayableAppointment({ price_amount: 40 });

    try {
      await runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG });
      throw new Error("expected runFixtureAndPortalStatePhase to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("PORTAL_IDENTITY_AMBIGUOUS");
    }
  });

  it("fails closed when the profile lookup itself fails", async () => {
    seedPayableAppointment({ price_amount: 40 });

    await expect(
      runFixtureAndPortalStatePhase({
        page: readyPage(),
        adminSupabase: fakeAdminWithFailingTable("profiles"),
        config: CONFIG,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when the client_account_links lookup itself fails", async () => {
    seedPayableAppointment({ price_amount: 40 });

    await expect(
      runFixtureAndPortalStatePhase({
        page: readyPage(),
        adminSupabase: fakeAdminWithFailingTable("client_account_links"),
        config: CONFIG,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("performs no DB writes during identity verification", async () => {
    seedPayableAppointment({ price_amount: 40 });
    const profilesBefore = profilesTable.rows.length;
    const linksBefore = clientAccountLinksTable.rows.length;

    await runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG });

    expect(profilesTable.rows).toHaveLength(profilesBefore);
    expect(clientAccountLinksTable.rows).toHaveLength(linksBefore);
  });

  it("never leaks the magic-link token/hash through an identity-verification failure", async () => {
    clientAccountLinksTable.rows = [];
    seedPayableAppointment({ price_amount: 40 });

    let message = "";
    try {
      await runFixtureAndPortalStatePhase({ page: readyPage(), adminSupabase: fakeAdmin(), config: CONFIG });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(FAKE_TOKEN_HASH);
  });
});

describe("runFirstCheckoutSubmitPhase", () => {
  it("captures the first Checkout URL and session id", async () => {
    const page = new FakePage(`${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`);
    page.setNextCheckoutUrl(FIRST_CHECKOUT_URL);

    const result = await runFirstCheckoutSubmitPhase({ page, config: CONFIG });

    expect(result.checkout.url).toBe(FIRST_CHECKOUT_URL);
    expect(result.checkout.sessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    expect(result.checkpoint.status).toBe("passed");
  });

  it("fails closed when the submit does not navigate to Stripe Checkout", async () => {
    const page = new FakePage(`${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`);
    page.setNextCheckoutUrl(null); // stays on the app origin instead of navigating away

    await expect(runFirstCheckoutSubmitPhase({ page, config: CONFIG })).rejects.toThrow(
      PaymentHarnessSafetyError,
    );
  });
});

describe("runReuseVerificationPhase", () => {
  const firstCheckout: PaymentHarnessCheckoutCapture = {
    url: FIRST_CHECKOUT_URL,
    sessionId: "cs_test_a1B2c3D4E5F6G7H8I9J0",
  };

  it("passes when the second submit reuses the same session and exactly one pending payment exists", async () => {
    seedPendingPayment();
    const page = new FakePage(`${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`);
    page.setNextCheckoutUrl(SECOND_CHECKOUT_URL_SAME_SESSION);

    const result = await runReuseVerificationPhase({
      page,
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      myRentalsUrl: `${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`,
      firstCheckout,
    });

    expect(result.checkout.sessionId).toBe(firstCheckout.sessionId);
    expect(result.checkpoint.status).toBe("passed");
  });

  it("fails closed when the second submit creates a different Checkout Session", async () => {
    seedPendingPayment();
    const page = new FakePage(`${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`);
    page.setNextCheckoutUrl(DIFFERENT_SESSION_URL);

    await expect(
      runReuseVerificationPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        myRentalsUrl: `${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`,
        firstCheckout,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when zero pending floor-rental payment rows exist", async () => {
    // paymentsTable deliberately left empty.
    const page = new FakePage(`${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`);
    page.setNextCheckoutUrl(SECOND_CHECKOUT_URL_SAME_SESSION);

    await expect(
      runReuseVerificationPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        myRentalsUrl: `${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`,
        firstCheckout,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when more than one pending floor-rental payment row exists", async () => {
    seedPendingPayment();
    seedPendingPayment();
    const page = new FakePage(`${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`);
    page.setNextCheckoutUrl(SECOND_CHECKOUT_URL_SAME_SESSION);

    await expect(
      runReuseVerificationPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        myRentalsUrl: `${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals`,
        firstCheckout,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });
});

describe("runPaymentHarnessFloorRentalBrowserScenario", () => {
  function scriptedHappyPathPage() {
    const page = new FakePage("about:blank");
    page.setPageText("Balance due right now\n$40.00");
    return page;
  }

  it("fails closed before any browser action when not confirmed", async () => {
    seedPayableAppointment({ price_amount: 40 });
    const page = scriptedHappyPathPage();

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: false,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    expect(page.gotoUrls).toHaveLength(0);
    expect(page.submitCount).toBe(0);
  });

  it("fails closed before any browser action when the environment is not allowed", async () => {
    seedPayableAppointment({ price_amount: 40 });
    const page = scriptedHappyPathPage();
    const tamperedConfig = { ...CONFIG, environment: "production" } as unknown as PaymentHarnessConfig;

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: tamperedConfig,
        confirmed: true,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    expect(page.gotoUrls).toHaveLength(0);
  });

  it("runs phases 1-3 end to end and reports checkout as reused", async () => {
    seedPayableAppointment({ price_amount: 40 });
    // Stands in for the real checkout route's write, which the FakePage
    // doesn't itself simulate -- runReuseVerificationPhase's DB check
    // requires this row to exist by the time phase 3 runs.
    seedPendingPayment();
    const page = scriptedHappyPathPage();
    page.setNextCheckoutUrl(FIRST_CHECKOUT_URL);

    // submitPayOpenBalance is called twice (phase 2 and phase 3); both
    // should land on the same session for a genuine reuse. FakePage always
    // navigates to whatever `nextCheckoutUrl` currently is, so setting it
    // once and never changing it models a real reused session correctly.
    const result = await runPaymentHarnessFloorRentalBrowserScenario({
      page,
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      confirmed: true,
    });

    expect(result.checkoutReused).toBe(true);
    expect(result.firstCheckout?.sessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    expect(result.secondCheckout?.sessionId).toBe(result.firstCheckout?.sessionId);
    expect(result.checkpoints).toHaveLength(3);
    expect(result.checkpoints.every((c) => c.status === "passed")).toBe(true);
  });

  it("records expected balance and both session ids via the DI evidence layer when provided", async () => {
    seedPayableAppointment({ price_amount: 40 });
    seedPendingPayment();
    const page = scriptedHappyPathPage();
    page.setNextCheckoutUrl(FIRST_CHECKOUT_URL);

    await runPaymentHarnessFloorRentalBrowserScenario({
      page,
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      confirmed: true,
      evidence: { runId: "run-1", scenario: "floor-rental-open-balance", deploymentSha: "abc123" },
    });

    const record = await readPaymentHarnessRunById({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-1" });
    expect(record).not.toBeNull();
    expect(record?.expectedBalanceCents).toBe(4000);
    expect(record?.firstSessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    expect(record?.reusedSessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    expect(record?.status).toBe("passed");
    expect(record?.checkpoints).toHaveLength(3);
  });

  it("marks the evidence run failed (without masking the original error) when a phase fails", async () => {
    seedPayableAppointment({ price_amount: 40 });
    const page = scriptedHappyPathPage();
    // Phase 1 (balance check) passes -- the evidence run is started -- but
    // phase 2's submit never navigates away from the app origin, so it
    // fails after a run row already exists to mark failed.
    page.setNextCheckoutUrl(null);

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        evidence: { runId: "run-2", scenario: "floor-rental-open-balance", deploymentSha: "abc123" },
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    const record = await readPaymentHarnessRunById({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-2" });
    expect(record?.status).toBe("failed");
  });

  it("never creates a payment row directly", async () => {
    seedPayableAppointment({ price_amount: 40 });
    seedPendingPayment(); // simulates the real checkout route having created one
    const page = scriptedHappyPathPage();
    page.setNextCheckoutUrl(FIRST_CHECKOUT_URL);

    await runPaymentHarnessFloorRentalBrowserScenario({
      page,
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      confirmed: true,
    });

    // Only the one payment row this test itself seeded (standing in for
    // the real checkout route's write) exists -- the scenario only ever
    // reads the payments table (verifyExactlyOnePendingFloorRentalPayment),
    // it never inserts/updates/deletes one.
    expect(paymentsTable.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Slice 7: Stage A (pre-payment readiness) + Stage B (verify completed
// payment) -- automated card entry (formerly Slice 5's phase 4b /
// `runPaymentCompletionPhase`) has been retired outright. See browser.ts's
// module doc comment for why.
// ---------------------------------------------------------------------------

describe("runPrePaymentReadinessPhase", () => {
  const firstCheckout: PaymentHarnessCheckoutCapture = {
    url: FIRST_CHECKOUT_URL,
    sessionId: "cs_test_a1B2c3D4E5F6G7H8I9J0",
  };

  function readyParams(overrides: Record<string, unknown> = {}) {
    return {
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      firstCheckout,
      expectedBalanceCents: 4000,
      payableAppointmentIds: ["apt-1"],
      fetchImpl: readyWebhookFetch(400),
      createStripeClient: testModeStripeClient(false),
      connectReadiness: validConnectReadiness(),
      ...overrides,
    };
  }

  it("executes app-route readiness, Checkout Session test-mode verification, and Connect listener readiness, and returns matching evidence plus safe manual-handoff data", async () => {
    seedPendingPayment();
    seedReadinessProbeRow();

    const result = await runPrePaymentReadinessPhase(readyParams());

    expect(result.paymentId).toBeTruthy();
    expect(result.connectedAccountId).toBe(STUDIO_CONNECTED_ACCOUNT_ID);
    expect(result.checkoutSessionId).toBe(firstCheckout.sessionId);
    expect(result.checkoutUrl).toBe(FIRST_CHECKOUT_URL);
    expect(result.expectedBalanceCents).toBe(4000);
    expect(result.payableAppointmentIds).toEqual(["apt-1"]);
    expect(result.connectReadiness).toEqual({
      providerEventId: CONNECT_READINESS_EVENT_ID,
      eventType: "product.updated",
      dbStatus: "processed",
      stripeEventAccount: STUDIO_CONNECTED_ACCOUNT_ID,
      livemode: false,
      verifiedAt: expect.any(String),
    });
    expect(result.checkpoint.status).toBe("passed");
  });

  it("returns a null checkoutUrl (without failing) when Stripe's session response has no url", async () => {
    seedPendingPayment();
    seedReadinessProbeRow();

    const result = await runPrePaymentReadinessPhase(
      readyParams({ createStripeClient: testModeStripeClient(false, null) }),
    );

    expect(result.checkoutUrl).toBeNull();
    expect(result.checkpoint.status).toBe("passed");
  });

  it("fails closed (before returning) when the app webhook route is not ready", async () => {
    seedPendingPayment();
    await expect(
      runPrePaymentReadinessPhase(readyParams({ fetchImpl: readyWebhookFetch(503) })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed (before returning) when the Checkout Session resolves to livemode", async () => {
    seedPendingPayment();
    await expect(
      runPrePaymentReadinessPhase(readyParams({ createStripeClient: testModeStripeClient(true) })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed (before returning) when the Connect listener readiness gate fails, even though the earlier checks succeeded", async () => {
    seedPendingPayment();
    await expect(
      runPrePaymentReadinessPhase(readyParams({ connectReadiness: failingConnectReadiness() })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("never mutates the payments or appointments tables", async () => {
    seedPendingPayment();
    seedReadinessProbeRow();
    const payableAppointment = seedPayableAppointment({ price_amount: 40 });
    const paymentsBefore = JSON.parse(JSON.stringify(paymentsTable.rows));
    const appointmentsBefore = JSON.parse(JSON.stringify(appointmentsTable.rows));

    await runPrePaymentReadinessPhase(readyParams());

    expect(paymentsTable.rows).toEqual(paymentsBefore);
    expect(appointmentsTable.rows).toEqual(appointmentsBefore);
    // Sanity: the fixture row really was in scope, not accidentally absent.
    expect(payableAppointment.id).toBeTruthy();
  });

  it("never writes to payment_provider_events during readiness verification", async () => {
    seedPendingPayment();
    seedReadinessProbeRow();
    const rowsBefore = paymentProviderEventsTable.rows.length;

    await runPrePaymentReadinessPhase(readyParams());

    expect(paymentProviderEventsTable.rows).toHaveLength(rowsBefore);
  });

  it("the returned evidence contains only safe Checkout/manual-handoff data -- never the Stripe secret key or card data", async () => {
    seedPendingPayment();
    seedReadinessProbeRow();
    const secretMarker = "sk_test_marked_secret_value_prepayment_zzz";
    const savedKey = process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY;
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = secretMarker;

    try {
      const result = await runPrePaymentReadinessPhase(readyParams());

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretMarker);
      expect(serialized).not.toContain("4242424242424242");
      // Every field is exactly what the operator needs for the manual
      // handoff -- ids, a URL, a dollar amount, a checkpoint -- nothing else.
      expect(Object.keys(result).sort()).toEqual(
        [
          "paymentId",
          "connectedAccountId",
          "checkoutSessionId",
          "checkoutUrl",
          "expectedBalanceCents",
          "payableAppointmentIds",
          "appointmentSnapshot",
          "paidPaymentIdsSnapshot",
          "connectReadiness",
          "checkpoint",
        ].sort(),
      );
    } finally {
      process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = savedKey;
    }
  });

  it("takes no `page` parameter and never references a card-entry method or selector -- structurally incapable of manipulating Stripe's hosted card form", () => {
    const source = readFileSync(join(__dirname, "..", "browser.ts"), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    const fnStart = codeOnly.indexOf("export async function runPrePaymentReadinessPhase");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const nextExportAfter = codeOnly.indexOf("\nexport ", fnStart + 1);
    const fnBody = codeOnly.slice(fnStart, nextExportAfter === -1 ? undefined : nextExportAfter);

    // No `page:` parameter in the signature, and no reference to any
    // card-entry method/selector/technique anywhere in the function body --
    // a structural guarantee, not just a runtime observation, that a caller
    // of this specific function can never reach card entry through it,
    // however it's invoked.
    expect(fnBody).not.toContain("page:");
    for (const term of ["completeTestPayment", "cardNumber", "cardExpiry", "cardCvc", "frameLocator", "dispatchEvent"]) {
      expect(fnBody).not.toContain(term);
    }
  });
});

describe("runVerifyCompletedPaymentPhase", () => {
  const checkoutSessionId = "cs_test_a1B2c3D4E5F6G7H8I9J0";

  function noopSleep() {
    return async () => {};
  }

  /** Builds an appointment-snapshot entry the same shape Stage A returns. */
  function snapshotEntry(
    appt: Record<string, unknown>,
    overrides: { payable?: boolean } = {},
  ): { id: string; status: string; paymentStatus: string; payable: boolean } {
    return {
      id: appt.id as string,
      status: appt.status as string,
      paymentStatus: appt.payment_status as string,
      payable: overrides.payable ?? false,
    };
  }

  type StageBParams = Parameters<typeof runVerifyCompletedPaymentPhase>[0];

  function baseParams(paymentId: string, overrides: Partial<StageBParams> = {}): StageBParams {
    return {
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      paymentId,
      checkoutSessionId,
      expectedBalanceCents: 4000,
      payableAppointmentIds: [],
      appointmentSnapshot: [],
      paidPaymentIdsSnapshot: [],
      maxAttempts: 1,
      intervalMs: 0,
      sleepFn: noopSleep(),
      ...overrides,
    };
  }

  it("1. the current payable appointment becomes paid -> pass", async () => {
    const payable = seedPayableAppointment({ payment_status: "unpaid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    payable.payment_status = "paid"; // simulates the real webhook's write

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(paid.id, {
        payableAppointmentIds: [payable.id],
        appointmentSnapshot: [snapshotEntry({ ...payable, payment_status: "unpaid" }, { payable: true })],
      }),
    );

    expect(outcome.result).toBe("fulfilled");
    expect(outcome.paymentId).toBe(paid.id);
    expect(outcome.paymentIntentId).toBe("pi_test_fake123");
    expect(outcome.checkpoint.status).toBe("passed");
  });

  it("2. a cancelled/non-payable appointment remains unchanged -> pass", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const cancelled = seedPayableAppointment({ status: "cancelled", payment_status: "unpaid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(paid.id, {
        payableAppointmentIds: [payable.id],
        appointmentSnapshot: [
          snapshotEntry(payable, { payable: true }),
          snapshotEntry(cancelled),
        ],
      }),
    );

    expect(outcome.result).toBe("fulfilled");
  });

  it("3. an excluded appointment changes during the run -> fail", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const excluded = seedPayableAppointment({ status: "cancelled", payment_status: "unpaid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    // Simulates a bug/regression: this excluded appointment changed even
    // though it was never part of the payable set.
    excluded.status = "scheduled";

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(paid.id, {
          payableAppointmentIds: [payable.id],
          appointmentSnapshot: [
            snapshotEntry(payable, { payable: true }),
            snapshotEntry({ ...excluded, status: "cancelled" }),
          ],
        }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_UNRELATED_APPOINTMENT_CHANGED");
    }
  });

  it("4. a historical unrelated appointment already paid before Stage A -> pass", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    // Already paid before this run even started -- legitimate history,
    // not contamination, as long as it stays exactly as Stage A saw it.
    const historicalPaid = seedPayableAppointment({ payment_status: "paid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(paid.id, {
        payableAppointmentIds: [payable.id],
        appointmentSnapshot: [
          snapshotEntry(payable, { payable: true }),
          snapshotEntry(historicalPaid), // paid: true in the "before" snapshot too
        ],
      }),
    );

    expect(outcome.result).toBe("fulfilled");
  });

  it("5. a historical voided appointment -> pass", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const historicalVoided = seedPayableAppointment({ status: "voided", payment_status: "unpaid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(paid.id, {
        payableAppointmentIds: [payable.id],
        appointmentSnapshot: [
          snapshotEntry(payable, { payable: true }),
          snapshotEntry(historicalVoided),
        ],
      }),
    );

    expect(outcome.result).toBe("fulfilled");
  });

  it("6. a newly paid unrelated appointment that was not paid in the Stage A snapshot -> fail", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const unrelated = seedPayableAppointment({ payment_status: "unpaid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    // Contamination: this unrelated appointment was unpaid in the Stage A
    // snapshot but is paid now.
    unrelated.payment_status = "paid";

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(paid.id, {
          payableAppointmentIds: [payable.id],
          appointmentSnapshot: [
            snapshotEntry(payable, { payable: true }),
            snapshotEntry({ ...unrelated, payment_status: "unpaid" }),
          ],
        }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_UNRELATED_APPOINTMENT_CHANGED");
    }
  });

  it("7. an expected appointment disappears -> fail closed", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(paid.id, {
          payableAppointmentIds: [payable.id],
          appointmentSnapshot: [
            snapshotEntry(payable, { payable: true }),
            // An appointment Stage A saw, but that no longer exists now.
            { id: "apt-vanished", status: "scheduled", paymentStatus: "unpaid", payable: false },
          ],
        }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_APPOINTMENT_MISSING");
    }
  });

  it("8. an unexpected relevant appointment appears and makes verification ambiguous -> fail closed", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    // Exists now, but Stage A never observed it at all.
    seedPayableAppointment({ payment_status: "unpaid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(paid.id, {
          payableAppointmentIds: [payable.id],
          appointmentSnapshot: [snapshotEntry(payable, { payable: true })],
        }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_UNEXPECTED_APPOINTMENT");
    }
  });

  it("9. historical unrelated paid/voided payment rows do not count as a duplicate of the current payment", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    const historicalPaid = seedPendingPayment({ status: "paid", amount: 25, stripe_payment_intent_id: "pi_test_historical" });
    seedPendingPayment({ status: "voided", amount: 15 });

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(paid.id, {
        payableAppointmentIds: [payable.id],
        appointmentSnapshot: [snapshotEntry(payable, { payable: true })],
        paidPaymentIdsSnapshot: [historicalPaid.id as string],
      }),
    );

    expect(outcome.result).toBe("fulfilled");
  });

  it("10. a true duplicate current payment still fails", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    // A second, genuinely new paid row -- not in the Stage A "already
    // paid" snapshot, and not the expected payment id either.
    seedPendingPayment({ status: "paid", amount: 40, stripe_payment_intent_id: "pi_test_other" });

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(paid.id, {
          payableAppointmentIds: [payable.id],
          appointmentSnapshot: [snapshotEntry(payable, { payable: true })],
        }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_DUPLICATE_PAYMENT");
    }
  });

  it("reports fulfilled when the payment row transitions to paid partway through the (bounded) poll", async () => {
    const payable = seedPayableAppointment({ payment_status: "unpaid" });
    const pending = seedPendingPayment({ amount: 40 });
    let sleepCalls = 0;
    const sleepFn = async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        markPaymentPaid(pending, { stripe_checkout_session_id: checkoutSessionId });
        payable.payment_status = "paid";
      }
    };

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(pending.id, {
        payableAppointmentIds: [payable.id],
        appointmentSnapshot: [snapshotEntry({ ...payable, payment_status: "unpaid" }, { payable: true })],
        maxAttempts: 5,
        sleepFn,
      }),
    );

    expect(outcome.result).toBe("fulfilled");
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
  });

  it("a pending payment times out (not_fulfilled_within_timeout) safely, without retrying or mutating the row", async () => {
    const pending = seedPendingPayment();

    const outcome = await runVerifyCompletedPaymentPhase(
      baseParams(pending.id, { maxAttempts: 3 }),
    );

    expect(outcome.result).toBe("not_fulfilled_within_timeout");
    expect(outcome.paymentId).toBe(pending.id);
    expect(outcome.checkpoint.status).toBe("failed");
    // The harness never mutated the row while "waiting".
    expect(pending.status).toBe("pending");
  });

  it("a different payment id (row returned does not match the queried id) fails closed", async () => {
    // The real Supabase/PostgREST client would never return a row whose id
    // differs from an `.eq("id", paymentId)` filter -- this simulates a
    // defensive-code-only scenario (a corrupted/mismatched read) via a
    // purpose-built fake, the same "can't happen with a real DB, but the
    // check exists anyway" pattern as failingSelectChain().
    const paymentId = "pay-expected";
    const baseAdmin = fakeAdmin() as { from: (table: string) => unknown };
    const mismatchedAdmin = {
      from(table: string) {
        if (table !== "payments") {
          return baseAdmin.from(table);
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "pay-different",
                  status: "paid",
                  amount: 40,
                  stripe_checkout_session_id: checkoutSessionId,
                  stripe_payment_intent_id: "pi_test_fake123",
                },
                error: null,
              }),
            }),
          }),
        };
      },
    } as never;

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(paymentId, { adminSupabase: mismatchedAdmin }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_PAYMENT_ID_MISMATCH");
    }
  });

  it("a different Checkout Session fails", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: "cs_test_totally_different_session",
      stripe_payment_intent_id: "pi_test_fake123",
    });

    try {
      await runVerifyCompletedPaymentPhase(baseParams(pending.id));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_SESSION_MISMATCH");
    }
  });

  it("amount mismatch fails", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 99,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    try {
      await runVerifyCompletedPaymentPhase(baseParams(pending.id));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_AMOUNT_MISMATCH");
    }
  });

  it("missing PaymentIntent fails", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: null,
    });

    try {
      await runVerifyCompletedPaymentPhase(baseParams(pending.id));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_PAYMENT_INTENT_MISSING");
    }
  });

  it("an unpaid expected (payable) appointment fails", async () => {
    const payable = seedPayableAppointment({ payment_status: "unpaid" });
    const pending = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    try {
      await runVerifyCompletedPaymentPhase(
        baseParams(pending.id, {
          payableAppointmentIds: [payable.id],
          appointmentSnapshot: [snapshotEntry(payable, { payable: true })],
        }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("FULFILLMENT_APPOINTMENT_NOT_PAID");
    }
  });

  it("never creates a Checkout Session or takes a `page` parameter -- structurally read-only DB verification only", () => {
    const source = readFileSync(join(__dirname, "..", "browser.ts"), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    const fnStart = codeOnly.indexOf("export async function runVerifyCompletedPaymentPhase");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const nextExportAfter = codeOnly.indexOf("\nexport ", fnStart + 1);
    const fnBody = codeOnly.slice(fnStart, nextExportAfter === -1 ? undefined : nextExportAfter);

    expect(fnBody).not.toContain("page:");
    expect(fnBody).not.toContain("submitPayOpenBalance");
    expect(fnBody).not.toContain("completeTestPayment");
    expect(/\.update\(/.test(fnBody)).toBe(false);
    expect(/\.insert\(/.test(fnBody)).toBe(false);
    expect(/\.delete\(/.test(fnBody)).toBe(false);
  });

  it("never leaks a secret or card data through a thrown error's message", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 99, // deliberately wrong, to force a throw
      stripe_checkout_session_id: checkoutSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    let message = "";
    try {
      await runVerifyCompletedPaymentPhase({
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        paymentId: pending.id,
        checkoutSessionId,
        expectedBalanceCents: 4000,
        payableAppointmentIds: [],
        appointmentSnapshot: [],
        paidPaymentIdsSnapshot: [],
        maxAttempts: 1,
        intervalMs: 0,
        sleepFn: noopSleep(),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("sk_test_");
    expect(message).not.toContain("sk_live_");
    expect(message).not.toContain("4242424242424242");
  });
});

describe('runPaymentHarnessFloorRentalBrowserScenario (executionMode: "pre_payment_readiness")', () => {
  function scriptedReadinessPage() {
    const page = new FakePage("about:blank");
    page.setPageText("Balance due right now\n$40.00");
    page.setNextCheckoutUrl(FIRST_CHECKOUT_URL);
    return page;
  }

  function seedHappyPathState() {
    const payable = seedPayableAppointment({ price_amount: 40 });
    const pending = seedPendingPayment({ amount: 40 });
    return { payable, pending };
  }

  it("runs phases 1-3 then Stage A pre-payment readiness, and returns everything needed for the manual handoff", async () => {
    seedHappyPathState();
    seedReadinessProbeRow();
    const page = scriptedReadinessPage();

    const result = await runPaymentHarnessFloorRentalBrowserScenario({
      page,
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      confirmed: true,
      executionMode: "pre_payment_readiness",
      fetchImpl: readyWebhookFetch(400),
      createStripeClient: testModeStripeClient(false),
      connectReadiness: validConnectReadiness(),
    });

    expect(result.prePaymentReadiness).not.toBeNull();
    expect(result.prePaymentReadiness?.connectReadiness.dbStatus).toBe("processed");
    expect(result.prePaymentReadiness?.checkoutUrl).toBe(FIRST_CHECKOUT_URL);
    expect(result.prePaymentReadiness?.expectedBalanceCents).toBe(4000);
    expect(result.prePaymentReadiness?.payableAppointmentIds).toEqual(["apt-1"]);
    expect(result.checkpoints).toHaveLength(4);
  });

  it("fails closed when the Connect listener readiness gate fails", async () => {
    seedHappyPathState();
    const page = scriptedReadinessPage();

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        executionMode: "pre_payment_readiness",
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(false),
        connectReadiness: failingConnectReadiness(),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("records Stage A evidence (payment id, connected account, Checkout Session id, provider event id) without a PaymentIntent id", async () => {
    seedHappyPathState();
    seedReadinessProbeRow();
    const page = scriptedReadinessPage();

    await runPaymentHarnessFloorRentalBrowserScenario({
      page,
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      confirmed: true,
      executionMode: "pre_payment_readiness",
      fetchImpl: readyWebhookFetch(400),
      createStripeClient: testModeStripeClient(false),
      connectReadiness: validConnectReadiness(),
      evidence: { runId: "run-pre-payment-readiness", scenario: "floor-rental-open-balance", deploymentSha: "abc123" },
    });

    const record = await readPaymentHarnessRunById({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-pre-payment-readiness",
    });
    expect(record?.status).toBe("passed");
    expect(record?.paymentId).toBeTruthy();
    expect(record?.stripeCheckoutSessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    expect(record?.stripeConnectedAccountId).toBe(STUDIO_CONNECTED_ACCOUNT_ID);
    expect(record?.stripeWebhookEventId).toBe(CONNECT_READINESS_EVENT_ID);
    // Never records a PaymentIntent id -- payment was never completed
    // (and this orchestrator has no code path that ever could).
    expect(record?.stripePaymentIntentId).toBeNull();
  });

  it("no public automated path in this mode ever references a card-entry method or selector", () => {
    const source = readFileSync(join(__dirname, "..", "browser.ts"), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // Structural, not just behavioral: the capability doesn't exist
    // anywhere in this module, under any name.
    for (const term of [
      "completeTestPayment",
      "#cardNumber",
      "#cardExpiry",
      "#cardCvc",
      "frameLocator",
      "dispatchEvent",
      "force: true",
    ]) {
      expect(codeOnly).not.toContain(term);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural: no automated card-entry/payment-completion code exists in
// this module at all (Slice 7 retired it outright -- see the module doc
// comment for why).
// ---------------------------------------------------------------------------

describe("browser.ts source", () => {
  const source = readFileSync(join(__dirname, "..", "browser.ts"), "utf8");
  // Strip comments first -- the module doc comment legitimately *names*
  // some of these terms to describe what this slice does NOT do ("no
  // PaymentIntent.confirm"), which would otherwise false-positive against
  // a naive raw-string search.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("has no Stripe SDK dependency at all", () => {
    expect(/from\s+["']stripe["']/.test(codeOnly)).toBe(false);
    expect(codeOnly.includes('require("stripe")')).toBe(false);
  });

  it("contains no PaymentIntent-confirmation or Charge-creation calls", () => {
    const forbidden = [
      "confirmCardPayment",
      "confirmPayment(",
      "PaymentIntent.confirm",
      "paymentIntents.confirm",
      "stripe.charges.create",
      "charges.create(",
    ];

    for (const term of forbidden) {
      expect(codeOnly.includes(term)).toBe(false);
    }
  });

  it("contains no direct write (insert/update/delete) to any database table", () => {
    expect(/\.update\(/.test(codeOnly)).toBe(false);
    expect(/\.insert\(/.test(codeOnly)).toBe(false);
    expect(/\.delete\(/.test(codeOnly)).toBe(false);
  });

  // Slice 7: the entire automated card-entry capability -- CSS selectors
  // for Stripe's card fields, iframe/frameLocator traversal, forced
  // clicks, dispatchEvent, keyboard workarounds, the test card number
  // itself, and the method/phase that used to call any of it -- has been
  // removed outright, not merely unused. This is the structural proof
  // that no public automated path in this harness can manipulate Stripe's
  // hosted card form.
  it("contains no Stripe card-field selectors, iframe reverse-engineering, forced clicks, dispatchEvent, or the test card number", () => {
    const forbidden = [
      "#cardNumber",
      "#cardExpiry",
      "#cardCvc",
      "cardnumber",
      "cc-number",
      "frameLocator",
      "dispatchEvent",
      "force: true",
      "force:true",
      "4242424242424242",
    ];

    for (const term of forbidden) {
      expect(codeOnly.toLowerCase().includes(term.toLowerCase())).toBe(false);
    }
  });

  it("has no completeTestPayment method, no runPaymentCompletionPhase, and no buildFutureTestCardExpiry helper", () => {
    for (const term of ["completeTestPayment", "runPaymentCompletionPhase", "buildFutureTestCardExpiry"]) {
      expect(codeOnly.includes(term)).toBe(false);
    }
  });

  it("PaymentHarnessBrowserPage has exactly the four non-payment methods -- no card-entry method in its interface", () => {
    const ifaceStart = codeOnly.indexOf("export interface PaymentHarnessBrowserPage");
    expect(ifaceStart).toBeGreaterThanOrEqual(0);
    const ifaceEnd = codeOnly.indexOf("}", ifaceStart);
    const ifaceBody = codeOnly.slice(ifaceStart, ifaceEnd);

    expect(ifaceBody).toContain("goto(");
    expect(ifaceBody).toContain("url(");
    expect(ifaceBody).toContain("getDisplayedPageText(");
    expect(ifaceBody).toContain("submitPayOpenBalance(");
    expect(ifaceBody).not.toContain("completeTestPayment");
  });
});
