import { describe, expect, it, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import { resolveStudioBillingPlan } from "@/lib/billing/access";

/**
 * Regression coverage for the billing-override plan-resolution
 * inconsistency: `access.ts`'s `getCurrentStudioPlanForUser` and
 * `lumi/portal.ts`'s `resolveLumiPortalAccess` used to independently
 * re-derive an active `billing_override_*`'s effect on the resolved plan,
 * and disagreed whenever a studio also had a real `studio_subscriptions`
 * row on a different plan. Both now delegate to this one function, so these
 * tests are the proof there is no second implementation left to drift out
 * of sync with this one.
 */

let studiosTable: FakeTable;
let subscriptionsTable: FakeTable;

const STUDIO_ID = "studio-1";

function seedStudio(overrides: Record<string, unknown> = {}) {
  const row = {
    id: STUDIO_ID,
    billing_plan: "starter",
    subscription_status: "inactive",
    billing_override_enabled: false,
    billing_override_reason: null,
    billing_override_expires_at: null,
    ...overrides,
  };
  studiosTable.rows.push(row);
  return row;
}

function seedSubscription(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `sub-${subscriptionsTable.rows.length + 1}`,
    studio_id: STUDIO_ID,
    status: "active",
    subscription_plans: { code: "growth", name: "Growth" },
    ...overrides,
  };
  subscriptionsTable.rows.push(row);
  return row;
}

function fakeSupabase() {
  return createFakeAdminClient({
    studios: studiosTable,
    studio_subscriptions: subscriptionsTable,
  }) as never;
}

async function resolve() {
  return resolveStudioBillingPlan(fakeSupabase(), STUDIO_ID);
}

beforeEach(() => {
  studiosTable = new FakeTable();
  subscriptionsTable = new FakeTable();
});

describe("resolveStudioBillingPlan", () => {
  it("override active, no subscription row -> resolves to the override's billing_plan, status active", async () => {
    seedStudio({ billing_plan: "pro", billing_override_enabled: true });

    const result = await resolve();

    expect(result.planCode).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("the exact regression case: override active AND a real subscription on a DIFFERENT plan -> override wins outright, subscription is ignored", async () => {
    seedStudio({ billing_plan: "pro", billing_override_enabled: true });
    seedSubscription({ status: "active", subscription_plans: { code: "growth", name: "Growth" } });

    const result = await resolve();

    // Before the fix, access.ts would return "pro" here while
    // lumi/portal.ts would return "growth" for the identical studio state --
    // the exact disagreement this fix closes.
    expect(result.planCode).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("override disabled + real subscription -> resolves to the subscription's plan/status, unaffected by override remnants", async () => {
    seedStudio({
      billing_plan: "pro",
      billing_override_enabled: false,
      billing_override_reason: "ambassador",
      billing_override_expires_at: "2030-01-01T00:00:00.000Z",
    });
    seedSubscription({ status: "trialing", subscription_plans: { code: "growth", name: "Growth" } });

    const result = await resolve();

    expect(result.planCode).toBe("growth");
    expect(result.status).toBe("trialing");
  });

  it("override expired in the past + real subscription -> treated as inactive, subscription plan wins", async () => {
    seedStudio({
      billing_plan: "pro",
      billing_override_enabled: true,
      billing_override_expires_at: "2020-01-01T00:00:00.000Z",
    });
    seedSubscription({ status: "active", subscription_plans: { code: "growth", name: "Growth" } });

    const result = await resolve();

    expect(result.planCode).toBe("growth");
    expect(result.status).toBe("active");
  });

  it("override expiring at the exact current instant is still treated as active (inclusive boundary)", async () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now.getTime();

    try {
      seedStudio({
        billing_plan: "pro",
        billing_override_enabled: true,
        billing_override_expires_at: now.toISOString(),
      });
      seedSubscription({ status: "active", subscription_plans: { code: "growth", name: "Growth" } });

      const result = await resolve();

      expect(result.planCode).toBe("pro");
    } finally {
      Date.now = originalNow;
    }
  });

  it("no override, no subscription row -> falls back to the studio's own billing_plan/subscription_status", async () => {
    seedStudio({ billing_plan: "starter", subscription_status: "trialing" });

    const result = await resolve();

    expect(result.planCode).toBe("starter");
    expect(result.status).toBe("trialing");
  });
});
