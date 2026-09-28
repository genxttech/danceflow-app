import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * PAY-DC-2C: membership action failures redirect with fixed codes only. Raw Stripe,
 * database or configuration text (account ids, %-sequences, SQL errors) never reaches
 * a redirect URL.
 */

const RAW_TEXT = "No such customer: 'cus_9' on account acct_secret_1; relation \"x\" 100%zz failed";

const state = vi.hoisted(() => ({
  fake: null as unknown,
  contextError: null as Error | null,
  stripeError: null as Error | null,
  manualPaymentError: null as Error | null,
  reconcileError: null as Error | null,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => (state.fake as { client: unknown }).client,
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => {
    if (state.contextError) throw state.contextError;
    return {
      studioId: "studio-1",
      studioRole: "studio_owner",
      isPlatformAdmin: false,
      userId: "user-1",
      email: "owner@example.test",
    };
  },
}));

vi.mock("@/lib/payments/stripe", () => {
  const maybeFail = (result: unknown) => async () => {
    if (state.stripeError) throw state.stripeError;
    return result;
  };
  return {
    getStripe: () => ({
      checkout: { sessions: { create: maybeFail({ url: "https://checkout.test/session" }) } },
      customers: { create: maybeFail({ id: "cus_new" }) },
      products: { create: maybeFail({ id: "prod_new" }) },
      prices: { create: maybeFail({ id: "price_new" }) },
    }),
  };
});

vi.mock("@/lib/memberships/manual-payment", () => ({
  recordManualMembershipPayment: async () => {
    if (state.manualPaymentError) throw state.manualPaymentError;
  },
}));

vi.mock("@/lib/memberships/renewal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memberships/renewal")>();
  return {
    ...actual,
    reconcileStudioMembershipPeriods: async () => {
      if (state.reconcileError) throw state.reconcileError;
      return { advancedCount: 0 };
    },
  };
});

const actions = await import("../actions");
const { MembershipActionError } = await import("@/lib/memberships/membershipErrors");

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";

function seed(studio: Record<string, unknown> = {}) {
  state.fake = createFakeSupabase({
    studios: [
      {
        id: "studio-1",
        stripe_connected_account_id: "acct_studio_1",
        stripe_connect_onboarding_complete: true,
        stripe_connect_charges_enabled: true,
        stripe_connect_payouts_enabled: true,
        ...studio,
      },
    ],
    clients: [{ id: CLIENT_ID, studio_id: "studio-1", first_name: "Alex", last_name: "Rivera", email: "alex@example.test" }],
    membership_plans: [
      { id: PLAN_ID, studio_id: "studio-1", name: "Monthly", active: true, billing_interval: "monthly", price: 100 },
    ],
    membership_connected_prices: [],
    stripe_connected_customers: [],
    client_memberships: [],
    payments: [],
  });
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function errorParam(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    const url = digest.split(";")[2] ?? "";
    return new URL(url, "https://app.test").searchParams.get("error");
  }
  throw new Error("expected a redirect");
}

function expectFixedCode(value: string | null, code: string) {
  expect(value).toBe(code);
  expect(value).not.toMatch(/acct_|cus_|%|relation|No such/);
}

beforeEach(() => {
  seed();
  state.contextError = null;
  state.stripeError = null;
  state.manualPaymentError = null;
  state.reconcileError = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("raw failures become fixed codes", () => {
  const sellForm = () =>
    form({ clientId: CLIENT_ID, membershipPlanId: PLAN_ID, startsOn: "2026-10-01", returnTo: "/app/sell?type=membership" });

  it.each([
    ["sellMembershipAction", () => actions.sellMembershipAction(sellForm()), "membership_sale_failed"],
    [
      "startMembershipPaymentMethodSetupAction",
      () => actions.startMembershipPaymentMethodSetupAction(form({ clientId: CLIENT_ID })),
      "membership_card_setup_failed",
    ],
    [
      "collectReplacementPaymentMethodAction",
      () => actions.collectReplacementPaymentMethodAction(form({ clientId: CLIENT_ID })),
      "membership_payment_method_update_failed",
    ],
  ])("%s: raw Stripe error -> fixed code", async (_name, run, code) => {
    state.stripeError = new Error(RAW_TEXT);
    expectFixedCode(await errorParam(run()), code);
  });

  it.each([
    ["sellMembershipAction", () => actions.sellMembershipAction(sellForm()), "membership_sale_failed"],
    [
      "startTerminalMembershipEnrollmentAction",
      () =>
        actions.startTerminalMembershipEnrollmentAction(
          form({ clientId: CLIENT_ID, membershipPlanId: PLAN_ID, startsOn: "2026-10-01", recurringConsent: "on" }),
        ),
      "terminal_membership_failed",
    ],
    [
      "recordExternalMembershipPaymentAction",
      () =>
        actions.recordExternalMembershipPaymentAction(
          form({ clientId: CLIENT_ID, clientMembershipId: MEMBERSHIP_ID, amount: "20", paymentMethod: "cash" }),
        ),
      "membership_payment_failed",
    ],
    ["reconcileMembershipRenewalsAction", () => actions.reconcileMembershipRenewalsAction(form({})), "membership_reconcile_failed"],
  ])("%s: raw database/context error -> fixed code", async (_name, run, code) => {
    state.contextError = new Error(`Failed to load studio workspaces: ${RAW_TEXT}`);
    expectFixedCode(await errorParam(run()), code);
  });

  it("readiness failure maps to its specific code", async () => {
    seed({ stripe_connect_charges_enabled: false });
    expectFixedCode(await errorParam(actions.sellMembershipAction(sellForm())), "membership_stripe_setup_incomplete");

    seed({ stripe_connected_account_id: null });
    expectFixedCode(await errorParam(actions.sellMembershipAction(sellForm())), "membership_stripe_not_connected");
  });

  it("external payment: raw database text -> fallback; coded business error -> its code", async () => {
    const run = () =>
      actions.recordExternalMembershipPaymentAction(
        form({ clientId: CLIENT_ID, clientMembershipId: MEMBERSHIP_ID, amount: "20", paymentMethod: "cash" }),
      );

    state.manualPaymentError = new Error(RAW_TEXT);
    expectFixedCode(await errorParam(run()), "membership_payment_failed");

    state.manualPaymentError = new MembershipActionError(
      "membership_payment_exceeds_balance",
      "This payment is greater than the remaining membership balance.",
    );
    expectFixedCode(await errorParam(run()), "membership_payment_exceeds_balance");
  });

  it("reconcile: raw renewal error -> fixed code", async () => {
    state.reconcileError = new Error(`Could not load memberships needing renewal: ${RAW_TEXT}`);
    expectFixedCode(await errorParam(actions.reconcileMembershipRenewalsAction(form({}))), "membership_reconcile_failed");
  });

  it("logs the code only, never the raw message", async () => {
    state.stripeError = Object.assign(new Error(RAW_TEXT), { type: "StripeInvalidRequestError", code: "resource_missing" });
    await errorParam(actions.sellMembershipAction(sellForm()));
    const logged = vi.mocked(console.error).mock.calls.flat().map((value) => JSON.stringify(value)).join(" ");
    expect(logged).toContain("membership_sale_failed");
    expect(logged).not.toMatch(/acct_secret_1|No such customer|relation/);
  });
});
