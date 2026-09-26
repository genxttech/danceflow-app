import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";
import {
  MEMBERSHIP_PAYMENT_ACCOUNT_UNVERIFIED,
  resolveMembershipStripeAccount,
} from "@/lib/payments/membershipStripeAccount";

/** PAY-DC-1: membership Stripe account verification and platform-fallback guards. */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

function supabaseWithStudio(account: string | null) {
  return createFakeSupabase({
    studios: [{ id: "studio-1", stripe_connected_account_id: account }],
  }).client as unknown as SupabaseClient;
}

describe("resolveMembershipStripeAccount", () => {
  const unverified = { ok: false, code: MEMBERSHIP_PAYMENT_ACCOUNT_UNVERIFIED };

  it("null stored account -> fails (never assumed to be platform or connected)", async () => {
    expect(
      await resolveMembershipStripeAccount({
        supabase: supabaseWithStudio("acct_studio_1"),
        studioId: "studio-1",
        stripeAccountId: null,
      }),
    ).toEqual(unverified);
  });

  it("stored account that differs from the studio's account -> fails", async () => {
    expect(
      await resolveMembershipStripeAccount({
        supabase: supabaseWithStudio("acct_studio_1"),
        studioId: "studio-1",
        stripeAccountId: "acct_other",
      }),
    ).toEqual(unverified);
  });

  it("studio without a connected account, or unknown studio -> fails", async () => {
    expect(
      await resolveMembershipStripeAccount({
        supabase: supabaseWithStudio(null),
        studioId: "studio-1",
        stripeAccountId: "acct_studio_1",
      }),
    ).toEqual(unverified);
    expect(
      await resolveMembershipStripeAccount({
        supabase: supabaseWithStudio("acct_studio_1"),
        studioId: "studio-missing",
        stripeAccountId: "acct_studio_1",
      }),
    ).toEqual(unverified);
  });

  it("exact match -> success with that account", async () => {
    expect(
      await resolveMembershipStripeAccount({
        supabase: supabaseWithStudio("acct_studio_1"),
        studioId: "studio-1",
        stripeAccountId: "acct_studio_1",
      }),
    ).toEqual({ ok: true, stripeAccount: "acct_studio_1" });
  });

  it("the helper never calls Stripe", () => {
    const source = read("src", "lib", "payments", "membershipStripeAccount.ts");
    expect(source).not.toMatch(/getStripe|from "stripe"/);
  });
});

describe("no platform fallback remains", () => {
  const actions = read("src", "app", "app", "memberships", "actions.ts");
  const webhook = read("src", "app", "api", "payments", "webhook", "route.ts");

  it("membership actions never build a conditional stripeAccount that can be undefined", () => {
    expect(actions).not.toMatch(/stripe_account_id\s*\?\s*\{\s*stripeAccount/);
    expect(actions).not.toMatch(/\?\s*\{\s*stripeAccount:[^}]*\}\s*:\s*undefined/);
    expect(actions.match(/resolveMembershipStripeAccount\(/g)).toHaveLength(3);
  });

  it("the webhook membership payment-method helper always scopes to a connected account", () => {
    expect(webhook).toMatch(/stripe\.paymentMethods\.retrieve\(\s*paymentMethodId,\s*\{\},\s*connectedAccountOptions/);
    expect(webhook).toMatch(/stripe\.setupIntents\.retrieve\(\s*setupIntentId,\s*\{\},\s*connectedAccountOptions/);
    expect(webhook).toMatch(/stripe_account_id: stripeAccountId \?\? null/);
  });

  it("the dead platform-scoped helpers are removed", () => {
    const subscriptions = read("src", "lib", "payments", "subscriptions.ts");
    const customer = read("src", "lib", "payments", "customer.ts");

    expect(subscriptions).not.toContain("ensureStripeRecurringPrice(");
    expect(subscriptions).not.toContain("createStripeMembershipSubscription(");
    expect(customer).not.toContain("ensureStripeCustomer(");
    expect(customer).not.toContain('from("stripe_customers")');

    // Every remaining Stripe create in these helpers is connected-account scoped.
    for (const source of [subscriptions, customer]) {
      const creates = source.match(/stripe\.(customers|products|prices|subscriptions)\.create\(/g) ?? [];
      const scoped = source.match(/stripeAccount: stripeAccountId/g) ?? [];
      expect(scoped.length).toBeGreaterThanOrEqual(creates.length);
    }
  });
});
