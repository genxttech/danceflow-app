import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * PAY-DC-1: studio-client membership Stripe operations run only in the verified
 * connected account that owns them. Missing or mismatched account context fails
 * closed with zero Stripe calls and never falls back to the GenX platform account.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));
const stripeCalls = vi.hoisted(() => [] as Array<{ method: string; args: unknown[] }>);
const stripeBehavior = vi.hoisted(() => ({ failSubscriptionUpdate: false }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fake.current!.client,
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "studio-1",
    studioRole: "studio_owner",
    isPlatformAdmin: false,
    userId: "user-1",
    email: "owner@example.test",
  }),
}));

vi.mock("@/lib/payments/stripe", () => {
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      stripeCalls.push({ method, args });
      return Promise.resolve(result);
    };

  return {
    getStripe: () => ({
      checkout: {
        sessions: { create: record("checkout.sessions.create", { url: "https://checkout.test/session" }) },
      },
      customers: { create: record("customers.create", { id: "cus_new" }) },
      products: { create: record("products.create", { id: "prod_new" }) },
      prices: { create: record("prices.create", { id: "price_new" }) },
      subscriptions: {
        update: (...args: unknown[]) => {
          stripeCalls.push({ method: "subscriptions.update", args });
          if (stripeBehavior.failSubscriptionUpdate) {
            return Promise.reject(
              new Error("No such subscription: 'sub_1' on account acct_secret_internal"),
            );
          }
          return Promise.resolve({
            status: "active",
            items: { data: [{ current_period_end: 1_793_000_000 }] },
          });
        },
      },
      invoices: {
        list: record("invoices.list", {
          data: [{ id: "in_1", collection_method: "charge_automatically" }],
        }),
        pay: record("invoices.pay", { id: "in_1" }),
      },
    }),
  };
});

const {
  sellMembershipAction,
  startMembershipPaymentMethodSetupAction,
  collectReplacementPaymentMethodAction,
  cancelMembershipAtPeriodEndAction,
  reactivateMembershipAutoRenewAction,
  retryDelinquentMembershipBillingAction,
} = await import("../actions");

const STUDIO_ACCOUNT = "acct_studio_1";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";

function seed(options: {
  studio?: Partial<FakeRow>;
  subscriptionAccount?: string | null;
  membership?: Partial<FakeRow>;
} = {}) {
  fake.current = createFakeSupabase({
    studios: [
      {
        id: "studio-1",
        stripe_connected_account_id: STUDIO_ACCOUNT,
        stripe_connect_onboarding_complete: true,
        stripe_connect_charges_enabled: true,
        stripe_connect_payouts_enabled: true,
        ...options.studio,
      },
    ],
    clients: [
      {
        id: CLIENT_ID,
        studio_id: "studio-1",
        first_name: "Alex",
        last_name: "Rivera",
        email: "alex@example.test",
      },
    ],
    membership_plans: [
      {
        id: PLAN_ID,
        studio_id: "studio-1",
        name: "Monthly Unlimited",
        active: true,
        billing_interval: "monthly",
        price: 100,
        stripe_product_id: null,
        stripe_price_id: null,
      },
    ],
    membership_connected_prices: [
      {
        membership_plan_id: PLAN_ID,
        stripe_account_id: STUDIO_ACCOUNT,
        stripe_product_id: "prod_1",
        stripe_price_id: "price_1",
        unit_amount_cents: 10000,
        billing_interval: "monthly",
      },
    ],
    stripe_connected_customers: [
      {
        studio_id: "studio-1",
        client_id: CLIENT_ID,
        stripe_account_id: STUDIO_ACCOUNT,
        stripe_customer_id: "cus_studio_1",
      },
    ],
    client_memberships: options.membership
      ? [
          {
            id: MEMBERSHIP_ID,
            client_id: CLIENT_ID,
            studio_id: "studio-1",
            status: "past_due",
            current_period_end: "2026-11-01",
            cancel_at_period_end: false,
            auto_renew: true,
            ...options.membership,
          },
        ]
      : [],
    stripe_subscriptions:
      options.subscriptionAccount === undefined
        ? []
        : [
            {
              id: "ss_1",
              client_membership_id: MEMBERSHIP_ID,
              studio_id: "studio-1",
              stripe_subscription_id: "sub_1",
              stripe_account_id: options.subscriptionAccount,
              stripe_customer_id: "cus_studio_1",
              default_payment_method_id: "pm_1",
              status: "past_due",
            },
          ],
  });
  return fake.current;
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function redirectTarget(promise: Promise<unknown>) {
  const error = await promise.catch((e) => e);
  const digest = String((error as { digest?: string })?.digest ?? "");
  return digest.split(";")[2] ?? "";
}

const manageForm = () =>
  formDataFor({
    clientId: CLIENT_ID,
    clientMembershipId: MEMBERSHIP_ID,
    returnTo: `/app/clients/${CLIENT_ID}?tab=billing`,
  });

function callsFor(method: string) {
  return stripeCalls.filter((call) => call.method === method);
}

function requestOptions(call: { args: unknown[] }) {
  return call.args[call.args.length - 1] as { stripeAccount?: string } | undefined;
}

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  stripeCalls.length = 0;
  stripeBehavior.failSubscriptionUpdate = false;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
  vi.restoreAllMocks();
});

describe("new sales and card flows run on the studio's connected account", () => {
  it("online membership sale creates the subscription Checkout Session on the studio account", async () => {
    seed();

    const target = await redirectTarget(
      sellMembershipAction(
        formDataFor({ clientId: CLIENT_ID, membershipPlanId: PLAN_ID, startsOn: "2026-10-01" }),
      ),
    );

    expect(target).toBe("https://checkout.test/session");
    const [session] = callsFor("checkout.sessions.create");
    expect((session.args[0] as { mode: string }).mode).toBe("subscription");
    expect(requestOptions(session)).toEqual({ stripeAccount: STUDIO_ACCOUNT });
    expect(stripeCalls.every((call) => requestOptions(call)?.stripeAccount === STUDIO_ACCOUNT)).toBe(true);
  });

  it("card setup and card replacement run on the studio account", async () => {
    seed();
    await redirectTarget(startMembershipPaymentMethodSetupAction(formDataFor({ clientId: CLIENT_ID })));
    seed();
    await redirectTarget(collectReplacementPaymentMethodAction(formDataFor({ clientId: CLIENT_ID })));

    const sessions = callsFor("checkout.sessions.create");
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect((session.args[0] as { mode: string }).mode).toBe("setup");
      expect(requestOptions(session)).toEqual({ stripeAccount: STUDIO_ACCOUNT });
    }
  });

  it("a studio whose connected account cannot accept charges cannot start a membership sale", async () => {
    seed({ studio: { stripe_connect_charges_enabled: false } });

    const target = await redirectTarget(
      sellMembershipAction(
        formDataFor({ clientId: CLIENT_ID, membershipPlanId: PLAN_ID, startsOn: "2026-10-01" }),
      ),
    );

    expect(target).toContain("error=");
    expect(decodeURIComponent(target)).toContain("has not completed Stripe payment setup");
    expect(stripeCalls).toHaveLength(0);
  });
});

describe("existing memberships are managed only in their stored connected account", () => {
  it("cancel uses the stored connected account", async () => {
    seed({ subscriptionAccount: STUDIO_ACCOUNT, membership: {} });

    const target = await redirectTarget(cancelMembershipAtPeriodEndAction(manageForm()));

    expect(target).toContain("success=membership_cancel_at_period_end");
    const [update] = callsFor("subscriptions.update");
    expect(update.args[0]).toBe("sub_1");
    expect(requestOptions(update)).toEqual({ stripeAccount: STUDIO_ACCOUNT });
  });

  it("reactivate uses the stored connected account", async () => {
    seed({ subscriptionAccount: STUDIO_ACCOUNT, membership: { cancel_at_period_end: true } });

    const target = await redirectTarget(reactivateMembershipAutoRenewAction(manageForm()));

    expect(target).toContain("success=membership_auto_renew_restored");
    const [update] = callsFor("subscriptions.update");
    expect(requestOptions(update)).toEqual({ stripeAccount: STUDIO_ACCOUNT });
  });

  it("retry updates, lists and pays the invoice on the stored connected account", async () => {
    seed({ subscriptionAccount: STUDIO_ACCOUNT, membership: {} });

    const target = await redirectTarget(retryDelinquentMembershipBillingAction(manageForm()));

    expect(target).toContain("success=membership_retry_submitted");
    expect(stripeCalls.map((call) => call.method)).toEqual([
      "subscriptions.update",
      "invoices.list",
      "invoices.pay",
    ]);
    for (const call of stripeCalls) {
      expect(requestOptions(call)).toEqual({ stripeAccount: STUDIO_ACCOUNT });
    }
  });
});

describe("missing or mismatched account context fails closed with zero Stripe calls", () => {
  const actions = [
    ["cancel", cancelMembershipAtPeriodEndAction, {}],
    ["reactivate", reactivateMembershipAutoRenewAction, { cancel_at_period_end: true }],
    ["retry", retryDelinquentMembershipBillingAction, {}],
  ] as const;

  for (const [name, action, membership] of actions) {
    it(`${name}: null stored account -> unverified, no Stripe call, no platform fallback`, async () => {
      seed({ subscriptionAccount: null, membership });

      const target = await redirectTarget(action(manageForm()));

      expect(target).toContain("error=membership_payment_account_unverified");
      expect(stripeCalls).toHaveLength(0);
    });

    it(`${name}: stored account differs from the studio's account -> unverified, no Stripe call`, async () => {
      seed({ subscriptionAccount: "acct_someone_else", membership });

      const target = await redirectTarget(action(manageForm()));

      expect(target).toContain("error=membership_payment_account_unverified");
      expect(stripeCalls).toHaveLength(0);
    });

    it(`${name}: studio has no connected account -> unverified, no Stripe call`, async () => {
      seed({
        subscriptionAccount: STUDIO_ACCOUNT,
        membership,
        studio: { stripe_connected_account_id: null },
      });

      const target = await redirectTarget(action(manageForm()));

      expect(target).toContain("error=membership_payment_account_unverified");
      expect(stripeCalls).toHaveLength(0);
    });
  }
});

describe("provider error text is never exposed", () => {
  it.each([
    ["cancel", cancelMembershipAtPeriodEndAction, {}, "membership_cancel_failed"],
    ["reactivate", reactivateMembershipAutoRenewAction, { cancel_at_period_end: true }, "membership_reactivate_failed"],
    ["retry", retryDelinquentMembershipBillingAction, {}, "membership_retry_failed"],
  ] as const)("%s: a Stripe failure redirects with a fixed code only", async (_name, action, membership, code) => {
    seed({ subscriptionAccount: STUDIO_ACCOUNT, membership });
    stripeBehavior.failSubscriptionUpdate = true;

    const target = decodeURIComponent(await redirectTarget(action(manageForm())));

    expect(target).toContain(`error=${code}`);
    expect(target).not.toContain("No such subscription");
    expect(target).not.toContain("acct_secret_internal");
  });
});
