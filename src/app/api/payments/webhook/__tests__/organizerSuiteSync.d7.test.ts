import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createEntitlementFakeDb, type Row } from "@/lib/billing/__tests__/entitlementFakeDb";

/**
 * D7: syncOrganizerSuiteAddonEntitlements keys each Stripe Suite item on stripe_subscription_item_id (the only
 * unique index that exists; there is none on (studio_id, feature_key)), never touches a manual_grant row, keeps
 * every Stripe item, and is idempotent on replay.
 */

vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));

const { syncOrganizerSuiteAddonEntitlements } = await import("@/app/api/payments/webhook/route");

const STUDIO = "studio-1";
const SUITE_PRICE = "price_suite_standard";

function subscription(status: string, items: Array<{ id: string; price?: string; metadata?: Record<string, string> }>) {
  return {
    id: "sub_1",
    status,
    items: { data: items.map((item) => ({ id: item.id, price: { id: item.price ?? SUITE_PRICE }, metadata: item.metadata ?? {} })) },
    metadata: { source: "studio_subscription", studioId: STUDIO },
  } as unknown as Stripe.Subscription;
}

const grant = (fields: Row = {}): Row => ({
  id: "grant-1",
  studio_id: STUDIO,
  workspace_type: "studio",
  feature_key: "organizer_suite",
  source: "manual_grant",
  stripe_subscription_item_id: null,
  quantity_included: 1,
  status: "active",
  period_start: null,
  period_end: "2027-07-09",
  ...fields,
});

let fake: ReturnType<typeof createEntitlementFakeDb>;

async function sync(sub: Stripe.Subscription) {
  await syncOrganizerSuiteAddonEntitlements({ supabase: fake.client, studioId: STUDIO, subscription: sub });
}

const suiteRows = () => fake.rows("usage_addon_entitlements").filter((row) => row.feature_key === "organizer_suite");
const stripeRows = () => suiteRows().filter((row) => row.source === "stripe_subscription_item");
const grantRow = () => suiteRows().find((row) => row.source === "manual_grant");

beforeEach(() => {
  vi.stubEnv("STRIPE_PRICE_ORGANIZER_SUITE_ADDON_STANDARD", SUITE_PRICE);
  vi.stubEnv("STRIPE_PRICE_ORGANIZER_SUITE_ADDON_FOUNDER", "");
  fake = createEntitlementFakeDb({ usage_addon_entitlements: [grant()] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Organizer Suite webhook sync (D7)", () => {
  it("a Suite item produces one upsert keyed on the Stripe item id", async () => {
    const before = JSON.parse(JSON.stringify(grantRow()));
    await sync(subscription("active", [{ id: "si_plan", price: "price_plan" }, { id: "si_suite" }]));
    const upserts = fake.writes.filter((write) => write.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].values).toMatchObject({ stripe_subscription_item_id: "si_suite", source: "stripe_subscription_item", status: "active", studio_id: STUDIO });
    expect(stripeRows()).toEqual([expect.objectContaining({ stripe_subscription_item_id: "si_suite", status: "active" })]);
    expect(grantRow()).toEqual(before);
  });

  it("the old (studio_id, feature_key) conflict target is what failed: the fake rejects it like PROD (42P10)", async () => {
    const result = await (fake.client as unknown as { from: (t: string) => { upsert: (v: Row, o: { onConflict: string }) => Promise<{ error: { code: string } | null }> } })
      .from("usage_addon_entitlements")
      .upsert({ studio_id: STUDIO, feature_key: "organizer_suite" }, { onConflict: "studio_id,feature_key" });
    expect(result.error?.code).toBe("42P10");
  });

  it("an item recognised only by metadata.featureKey is synced too", async () => {
    await sync(subscription("trialing", [{ id: "si_meta", price: "price_other", metadata: { featureKey: "organizer_suite" } }]));
    expect(stripeRows()).toEqual([expect.objectContaining({ stripe_subscription_item_id: "si_meta", status: "active" })]);
  });

  it("a manual grant for the same studio is never modified or canceled, through add, removal and cancellation", async () => {
    const before = JSON.parse(JSON.stringify(grantRow()));
    await sync(subscription("active", [{ id: "si_suite" }]));
    await sync(subscription("active", [{ id: "si_plan", price: "price_plan" }])); // Suite item removed
    await sync(subscription("canceled", [{ id: "si_suite" }]));
    await sync(subscription("past_due", [{ id: "si_suite" }]));
    expect(grantRow()).toEqual(before);
    const touchedGrant = fake.writes.some((write) => write.ids.includes("grant-1") || write.values.source === "manual_grant");
    expect(touchedGrant).toBe(false);
  });

  it("an open-ended (no period_end) manual grant is not extended or rewritten either", async () => {
    fake = createEntitlementFakeDb({ usage_addon_entitlements: [grant({ period_end: null })] });
    await sync(subscription("canceled", []));
    expect(grantRow()).toMatchObject({ status: "active", period_end: null });
    expect(fake.writes).toEqual([]);
  });

  it("two Stripe Suite items for the same studio both persist", async () => {
    await sync(subscription("active", [{ id: "si_suite_a" }, { id: "si_suite_b" }]));
    expect(stripeRows().map((row) => [row.stripe_subscription_item_id, row.status]).sort()).toEqual([
      ["si_suite_a", "active"],
      ["si_suite_b", "active"],
    ]);
    expect(grantRow()?.status).toBe("active");
  });

  it("replaying the same event is idempotent: same rows, same values", async () => {
    const sub = subscription("active", [{ id: "si_suite_a" }, { id: "si_suite_b" }]);
    await sync(sub);
    const strip = (rows: Row[]) => rows.map((row) => ({ ...row, updated_at: "<ignored>" }));
    const first = strip(JSON.parse(JSON.stringify(suiteRows())));
    await sync(sub);
    await sync(sub);
    expect(strip(suiteRows())).toEqual(first);
    expect(suiteRows()).toHaveLength(3);
  });

  it("a removed Suite item is canceled by the sweep; the other item and the grant stay active", async () => {
    await sync(subscription("active", [{ id: "si_suite_a" }, { id: "si_suite_b" }]));
    await sync(subscription("active", [{ id: "si_suite_b" }]));
    const byItem = Object.fromEntries(stripeRows().map((row) => [row.stripe_subscription_item_id, row.status]));
    expect(byItem).toEqual({ si_suite_a: "canceled", si_suite_b: "active" });
    expect(grantRow()?.status).toBe("active");
  });

  it("unchanged open decision: a past_due subscription still cancels its Stripe Suite rows (never the grant)", async () => {
    await sync(subscription("active", [{ id: "si_suite" }]));
    await sync(subscription("past_due", [{ id: "si_suite" }]));
    expect(stripeRows()).toEqual([expect.objectContaining({ stripe_subscription_item_id: "si_suite", status: "canceled" })]);
    expect(grantRow()?.status).toBe("active");
    // Recovery re-activates the same row (no duplicate).
    await sync(subscription("active", [{ id: "si_suite" }]));
    expect(stripeRows()).toEqual([expect.objectContaining({ stripe_subscription_item_id: "si_suite", status: "active" })]);
  });

  it("another studio's Stripe Suite rows are never swept", async () => {
    fake.tables.usage_addon_entitlements.push({ ...grant(), id: "other-stripe", studio_id: "studio-2", source: "stripe_subscription_item", stripe_subscription_item_id: "si_other", period_end: null });
    await sync(subscription("canceled", [{ id: "si_suite" }]));
    expect(fake.rows("usage_addon_entitlements").find((row) => row.id === "other-stripe")?.status).toBe("active");
  });
});
