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
  assertConnectListenerReadinessUnavailable,
  runFirstCheckoutSubmitPhase,
  runFixtureAndPortalStatePhase,
  runFulfillmentVerificationPhase,
  runPaymentCompletionPhase,
  runPaymentHarnessFloorRentalBrowserScenario,
  runReuseVerificationPhase,
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
  private successRedirectUrl: string | null = null;
  readonly gotoUrls: string[] = [];
  submitCount = 0;
  completeTestPaymentCount = 0;

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

  async completeTestPayment() {
    this.completeTestPaymentCount += 1;
    if (this.successRedirectUrl) this.currentUrl = this.successRedirectUrl;
  }

  setPageText(text: string) {
    this.pageText = text;
  }

  setNextCheckoutUrl(url: string | null) {
    this.nextCheckoutUrl = url;
  }

  setSuccessRedirectUrl(url: string | null) {
    this.successRedirectUrl = url;
  }
}

function readyWebhookFetch(status = 400) {
  return async () => ({ status });
}

function testModeStripeClient(livemode = false) {
  return () => ({
    checkout: { sessions: { retrieve: async () => ({ livemode }) } },
  });
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

function fakeAdmin() {
  const base = createFakeAdminClient({
    clients: clientsTable,
    appointments: appointmentsTable,
    studios: studiosTable,
    payments: paymentsTable,
    payment_harness_runs: runsTable,
    profiles: profilesTable,
    client_account_links: clientAccountLinksTable,
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
// Slice 5: payment completion + fulfillment verification
// ---------------------------------------------------------------------------

describe("assertConnectListenerReadinessUnavailable", () => {
  it("always throws PaymentHarnessSafetyError with the CONNECT_LISTENER_READINESS_UNAVAILABLE code", () => {
    expect(() => assertConnectListenerReadinessUnavailable("t")).toThrow(PaymentHarnessSafetyError);
    try {
      assertConnectListenerReadinessUnavailable("t");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_UNAVAILABLE");
    }
  });
});

describe("runPaymentCompletionPhase", () => {
  function readyPage() {
    const page = new FakePage(FIRST_CHECKOUT_URL);
    page.setSuccessRedirectUrl(
      `${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals?client=${CONFIG.clientId}&success=balance_payment_submitted`,
    );
    return page;
  }

  const firstCheckout: PaymentHarnessCheckoutCapture = {
    url: FIRST_CHECKOUT_URL,
    sessionId: "cs_test_a1B2c3D4E5F6G7H8I9J0",
  };

  it("fails closed before entering card details when the app webhook route is not ready", async () => {
    seedPendingPayment();
    const page = readyPage();

    await expect(
      runPaymentCompletionPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        firstCheckout,
        fetchImpl: readyWebhookFetch(503),
        createStripeClient: testModeStripeClient(false),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
    expect(page.completeTestPaymentCount).toBe(0);
  });

  it("fails closed before entering card details when the app webhook route probe responds unexpectedly", async () => {
    seedPendingPayment();
    const page = readyPage();

    await expect(
      runPaymentCompletionPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        firstCheckout,
        fetchImpl: readyWebhookFetch(200),
        createStripeClient: testModeStripeClient(false),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
    expect(page.completeTestPaymentCount).toBe(0);
  });

  it("fails closed before entering card details when the Checkout Session resolves to livemode", async () => {
    seedPendingPayment();
    const page = readyPage();

    await expect(
      runPaymentCompletionPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        firstCheckout,
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(true),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
    expect(page.completeTestPaymentCount).toBe(0);
  });

  // Slice 5 safety correction: even when the app webhook route check and
  // the Stripe test-mode session check both succeed -- proving those two
  // pieces of scaffolding are independently sound -- payment completion
  // must still fail closed, unconditionally, because no deterministic
  // Connect-listener-liveness mechanism exists yet.
  it("fails closed with CONNECT_LISTENER_READINESS_UNAVAILABLE even when app-route readiness and test-mode verification both succeed, and never calls completeTestPayment", async () => {
    seedPendingPayment();
    const page = readyPage();

    try {
      await runPaymentCompletionPhase({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        firstCheckout,
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(false),
      });
      throw new Error("expected runPaymentCompletionPhase to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_UNAVAILABLE");
    }
    expect(page.completeTestPaymentCount).toBe(0);
  });
});

describe("runFulfillmentVerificationPhase", () => {
  const expectedSessionId = "cs_test_a1B2c3D4E5F6G7H8I9J0";

  function noopSleep() {
    return async () => {};
  }

  it("reports fulfilled immediately when the payment row is already paid", async () => {
    const payable = seedPayableAppointment({ payment_status: "paid" });
    const paid = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: expectedSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    const snapshotBefore = new Map<string, { status: string; paymentStatus: string }>();

    const outcome = await runFulfillmentVerificationPhase({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      paymentId: paid.id,
      expectedSessionId,
      expectedBalanceCents: 4000,
      payableAppointmentIds: [payable.id],
      appointmentSnapshotBefore: snapshotBefore,
      maxAttempts: 1,
      intervalMs: 0,
      sleepFn: noopSleep(),
    });

    expect(outcome.result).toBe("fulfilled");
    expect(outcome.paymentIntentId).toBe("pi_test_fake123");
    expect(outcome.checkpoint.status).toBe("passed");
  });

  it("reports fulfilled when the payment row transitions to paid partway through the poll", async () => {
    const payable = seedPayableAppointment({ payment_status: "unpaid" });
    const pending = seedPendingPayment({ amount: 40 });
    let sleepCalls = 0;
    const sleepFn = async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        markPaymentPaid(pending, { stripe_checkout_session_id: expectedSessionId });
        payable.payment_status = "paid";
      }
    };

    const outcome = await runFulfillmentVerificationPhase({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      paymentId: pending.id,
      expectedSessionId,
      expectedBalanceCents: 4000,
      payableAppointmentIds: [payable.id],
      appointmentSnapshotBefore: new Map(),
      maxAttempts: 5,
      intervalMs: 0,
      sleepFn,
    });

    expect(outcome.result).toBe("fulfilled");
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
  });

  it("times out (not_fulfilled_within_timeout) and preserves the payment id when the row never transitions", async () => {
    const pending = seedPendingPayment();

    const outcome = await runFulfillmentVerificationPhase({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      paymentId: pending.id,
      expectedSessionId,
      expectedBalanceCents: 4000,
      payableAppointmentIds: [],
      appointmentSnapshotBefore: new Map(),
      maxAttempts: 3,
      intervalMs: 0,
      sleepFn: noopSleep(),
    });

    expect(outcome.result).toBe("not_fulfilled_within_timeout");
    expect(outcome.paymentId).toBe(pending.id);
    expect(outcome.checkpoint.status).toBe("failed");
    // The harness never mutated the row while "waiting".
    expect(pending.status).toBe("pending");
  });

  it("requires a PaymentIntent id after the row transitions to paid", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: expectedSessionId,
      stripe_payment_intent_id: null,
    });

    await expect(
      runFulfillmentVerificationPhase({
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        paymentId: pending.id,
        expectedSessionId,
        expectedBalanceCents: 4000,
        payableAppointmentIds: [],
        appointmentSnapshotBefore: new Map(),
        maxAttempts: 1,
        intervalMs: 0,
        sleepFn: noopSleep(),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when a non-payable appointment changed unexpectedly during fulfillment", async () => {
    const unrelated = seedPayableAppointment({ status: "cancelled", payment_status: "unpaid" });
    const before = new Map([[unrelated.id, { status: "cancelled", paymentStatus: "unpaid" }]]);
    const pending = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: expectedSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    // Simulates a bug/regression: this cancelled appointment was mutated
    // even though it is not part of the payable set.
    unrelated.status = "scheduled";

    await expect(
      runFulfillmentVerificationPhase({
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        paymentId: pending.id,
        expectedSessionId,
        expectedBalanceCents: 4000,
        payableAppointmentIds: [],
        appointmentSnapshotBefore: before,
        maxAttempts: 1,
        intervalMs: 0,
        sleepFn: noopSleep(),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when a duplicate paid payment row exists", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 40,
      stripe_checkout_session_id: expectedSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });
    seedPendingPayment({ status: "paid", amount: 40, stripe_payment_intent_id: "pi_test_other" });

    await expect(
      runFulfillmentVerificationPhase({
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        paymentId: pending.id,
        expectedSessionId,
        expectedBalanceCents: 4000,
        payableAppointmentIds: [],
        appointmentSnapshotBefore: new Map(),
        maxAttempts: 1,
        intervalMs: 0,
        sleepFn: noopSleep(),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when the paid amount does not match the expected fixture balance", async () => {
    const pending = seedPendingPayment({
      status: "paid",
      amount: 99,
      stripe_checkout_session_id: expectedSessionId,
      stripe_payment_intent_id: "pi_test_fake123",
    });

    await expect(
      runFulfillmentVerificationPhase({
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        paymentId: pending.id,
        expectedSessionId,
        expectedBalanceCents: 4000,
        payableAppointmentIds: [],
        appointmentSnapshotBefore: new Map(),
        maxAttempts: 1,
        intervalMs: 0,
        sleepFn: noopSleep(),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });
});

describe("runPaymentHarnessFloorRentalBrowserScenario (completePayment: true)", () => {
  function scriptedCompletePaymentPage() {
    const page = new FakePage("about:blank");
    page.setPageText("Balance due right now\n$40.00");
    page.setNextCheckoutUrl(FIRST_CHECKOUT_URL);
    page.setSuccessRedirectUrl(
      `${CONFIG.baseUrl}/portal/qa-studio/floor-space/my-rentals?client=${CONFIG.clientId}&success=balance_payment_submitted`,
    );
    return page;
  }

  function seedHappyPathState() {
    const payable = seedPayableAppointment({ price_amount: 40 });
    const pending = seedPendingPayment({ amount: 40 });
    return { payable, pending };
  }

  function fulfillOnFirstSleep(pending: Record<string, unknown>, payable: Record<string, unknown>) {
    let calls = 0;
    return async () => {
      calls += 1;
      if (calls === 1) {
        markPaymentPaid(pending, {
          stripe_checkout_session_id: "cs_test_a1B2c3D4E5F6G7H8I9J0",
        });
        payable.payment_status = "paid";
      }
    };
  }

  // Slice 5 safety correction: no current public Payment Harness scenario
  // can complete a real payment. Even a fully valid happy-path setup
  // (fixture, checkout capture, reuse verification, app-route readiness,
  // test-mode session verification, and a fulfillment poll primed to
  // succeed) is blocked before card entry, unconditionally.
  it("cannot complete a real payment even with a fully valid happy-path setup", async () => {
    const { payable, pending } = seedHappyPathState();
    const page = scriptedCompletePaymentPage();

    try {
      await runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        completePayment: true,
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(false),
        fulfillmentPoll: { maxAttempts: 5, intervalMs: 0, sleepFn: fulfillOnFirstSleep(pending, payable) },
      });
      throw new Error("expected runPaymentHarnessFloorRentalBrowserScenario to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_UNAVAILABLE");
    }

    expect(page.completeTestPaymentCount).toBe(0);
    // The pending row is untouched -- fulfillment (which would have
    // marked it paid via this test's own sleepFn simulation) was never
    // reached.
    expect(pending.status).toBe("pending");
  });

  it("stops before any card entry when the app webhook route is not ready", async () => {
    seedHappyPathState();
    const page = scriptedCompletePaymentPage();

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        completePayment: true,
        fetchImpl: readyWebhookFetch(503),
        createStripeClient: testModeStripeClient(false),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
    expect(page.completeTestPaymentCount).toBe(0);
  });

  it("stops before any card entry when the Checkout Session is live-mode", async () => {
    seedHappyPathState();
    const page = scriptedCompletePaymentPage();

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        completePayment: true,
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(true),
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
    expect(page.completeTestPaymentCount).toBe(0);
  });

  it("marks the evidence run failed with CONNECT_LISTENER_READINESS_UNAVAILABLE, preserving the session ids already recorded by earlier phases", async () => {
    seedHappyPathState();
    const page = scriptedCompletePaymentPage();

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        completePayment: true,
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(false),
        evidence: { runId: "run-listener-unavailable", scenario: "floor-rental-open-balance", deploymentSha: "abc123" },
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    expect(page.completeTestPaymentCount).toBe(0);

    const record = await readPaymentHarnessRunById({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-listener-unavailable",
    });
    expect(record?.status).toBe("failed");
    expect(record?.failureReason ?? "").toContain("no deterministic Stripe Connect webhook listener readiness check");
    // Earlier phases' session ids are still recorded -- nothing already
    // written is cleared just because a later phase failed closed.
    expect(record?.firstSessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    expect(record?.reusedSessionId).toBe("cs_test_a1B2c3D4E5F6G7H8I9J0");
    // Payment completion never ran, so no payment id was ever captured to record.
    expect(record?.paymentId).toBeNull();
  });

  it("never includes card details in evidence, even on this fail-closed path", async () => {
    seedHappyPathState();
    const page = scriptedCompletePaymentPage();

    await expect(
      runPaymentHarnessFloorRentalBrowserScenario({
        page,
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        confirmed: true,
        completePayment: true,
        fetchImpl: readyWebhookFetch(400),
        createStripeClient: testModeStripeClient(false),
        evidence: { runId: "run-no-card-data", scenario: "floor-rental-open-balance", deploymentSha: "abc123" },
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    const record = await readPaymentHarnessRunById({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-no-card-data",
    });
    expect(JSON.stringify(record)).not.toContain("4242424242424242");
  });
});

// ---------------------------------------------------------------------------
// Structural: no payment-completion code exists in this slice
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
    // Slice 5 legitimately adds real card-entry code (see the next two
    // tests) -- what must never exist, in this file or any other in this
    // module tree (confirmed above: no `stripe` import at all), is a
    // lower-level payment-completion primitive that bypasses hosted
    // Checkout itself.
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

  it("the test card number appears exactly once, encapsulated inside the real browser's card-entry helper", () => {
    const occurrences = (codeOnly.match(/4242424242424242/g) ?? []).length;
    expect(occurrences).toBe(1);

    const helperStart = codeOnly.indexOf("export async function createPaymentHarnessBrowser");
    const nextExportAfter = codeOnly.indexOf("\nexport ", helperStart + 1);
    const helperBody = codeOnly.slice(helperStart, nextExportAfter === -1 ? undefined : nextExportAfter);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperBody.includes("4242424242424242")).toBe(true);
  });
});
