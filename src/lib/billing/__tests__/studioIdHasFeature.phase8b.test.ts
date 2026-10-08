import { beforeEach, describe, expect, it } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import { studioIdHasFeature } from "@/lib/billing/access";

/**
 * Phase 8B: the studio-id feature check used by server jobs (the document-operations cron) must follow exactly the
 * same rules as the signed-in `studioHasFeature`: the canonical plan resolver (override > subscription > studio
 * fallback), an active / trialing status, the plan feature list, then the Organizer Suite add-on.
 */

const STUDIO_ID = "studio-1";
let studios: FakeTable;
let subscriptions: FakeTable;
let addons: FakeTable;

function client() {
  return createFakeAdminClient({
    studios,
    studio_subscriptions: subscriptions,
    usage_addon_entitlements: addons,
  }) as never;
}

function seedStudio(overrides: Record<string, unknown> = {}) {
  studios.rows.push({
    id: STUDIO_ID,
    billing_plan: "starter",
    subscription_status: "inactive",
    billing_override_enabled: false,
    billing_override_reason: null,
    billing_override_expires_at: null,
    ...overrides,
  });
}

beforeEach(() => {
  studios = new FakeTable();
  subscriptions = new FakeTable();
  addons = new FakeTable();
});

describe("studioIdHasFeature", () => {
  it("grants documents to an active Growth subscription", async () => {
    seedStudio();
    subscriptions.rows.push({ id: "sub-1", studio_id: STUDIO_ID, status: "active", subscription_plans: { code: "growth", name: "Growth" } });
    expect(await studioIdHasFeature(client(), STUDIO_ID, "documents")).toBe(true);
  });

  it("denies documents to Starter", async () => {
    seedStudio();
    subscriptions.rows.push({ id: "sub-1", studio_id: STUDIO_ID, status: "active", subscription_plans: { code: "starter", name: "Starter" } });
    expect(await studioIdHasFeature(client(), STUDIO_ID, "documents")).toBe(false);
  });

  it("denies documents when the subscription is not active or trialing", async () => {
    seedStudio();
    subscriptions.rows.push({ id: "sub-1", studio_id: STUDIO_ID, status: "past_due", subscription_plans: { code: "pro", name: "Pro" } });
    expect(await studioIdHasFeature(client(), STUDIO_ID, "documents")).toBe(false);
  });

  it("honours an active billing override exactly like the signed-in check", async () => {
    seedStudio({ billing_plan: "pro", billing_override_enabled: true });
    expect(await studioIdHasFeature(client(), STUDIO_ID, "documents")).toBe(true);
  });

  it("grants an Organizer Suite feature through an active add-on", async () => {
    seedStudio();
    subscriptions.rows.push({ id: "sub-1", studio_id: STUDIO_ID, status: "active", subscription_plans: { code: "starter", name: "Starter" } });
    expect(await studioIdHasFeature(client(), STUDIO_ID, "event_waivers")).toBe(false);
    addons.rows.push({ id: "addon-1", studio_id: STUDIO_ID, feature_key: "organizer_suite", source: "manual_grant", status: "active" });
    expect(await studioIdHasFeature(client(), STUDIO_ID, "event_waivers")).toBe(true);
    expect(await studioIdHasFeature(client(), STUDIO_ID, "documents")).toBe(false);
  });
});
