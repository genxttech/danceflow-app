import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * PAY-DC-4A (S1): the four add-on routes act on studios.stripe_subscription_id only after proving the
 * subscription belongs to the studio's server-written billing customer. A foreign subscription gets
 * 0 Stripe mutations and 0 entitlement writes.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  mutations: [] as Array<{ table: string; op: string; values: Row }>,
  stripeCalls: [] as Array<{ method: string; args: unknown[] }>,
  subscriptions: {} as Record<string, Row>,
  context: { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false } as Record<string, unknown>,
  packs: {
    save: vi.fn(),
    sync: vi.fn(),
    cancel: vi.fn(),
  },
}));

function fakeAdmin() {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "update" | "upsert" = "select";
    let values: Row = {};
    const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
    const run = (single: boolean) => {
      if (op !== "select") {
        state.mutations.push({ table, op, values });
        return Promise.resolve({ data: null, error: null });
      }
      const found = rows();
      return Promise.resolve({ data: single ? (found[0] ?? null) : found, error: null });
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      limit: () => builder,
      update: (value: Row) => {
        op = "update";
        values = value;
        return builder;
      },
      upsert: (value: Row) => {
        op = "upsert";
        values = value;
        return run(false);
      },
      single: () => run(true),
      maybeSingle: () => run(true),
      then: (resolve: (value: unknown) => unknown) => run(false).then(resolve),
    };
    return builder;
  }
  return { from };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeAdmin() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => state.context }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...parts: string[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/billing/founderPricing", () => ({ isFounderPricingActive: () => false }));
vi.mock("@/lib/usage/ai-credit-packs", () => ({
  getAiCreditPack: (key: string) => (key === "small" ? { key: "small", stripePriceId: "price_ai", label: "AI" } : null),
  saveAiCreditPackEntitlementForStripeItem: state.packs.save,
  syncAiCreditPackEntitlementsForStudio: state.packs.sync,
  markAiCreditPackEntitlementCanceled: state.packs.cancel,
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string, ...args: unknown[]) => {
        state.stripeCalls.push({ method: "subscriptions.retrieve", args: [id, ...args] });
        const subscription = state.subscriptions[id];
        if (!subscription) throw new Error("No such subscription");
        return subscription;
      },
    },
    subscriptionItems: {
      create: async (...args: unknown[]) => {
        state.stripeCalls.push({ method: "subscriptionItems.create", args });
        return { id: "si_new", quantity: 1 };
      },
      del: async (...args: unknown[]) => {
        state.stripeCalls.push({ method: "subscriptionItems.del", args });
        return { id: "si_x", deleted: true };
      },
      retrieve: async (id: string) => {
        state.stripeCalls.push({ method: "subscriptionItems.retrieve", args: [id] });
        return { id, subscription: "sub_foreign" };
      },
    },
  }),
}));

import { GET as aiCheckout } from "@/app/api/billing/addons/ai/checkout/route";
import { GET as aiRemove } from "@/app/api/billing/addons/ai/remove/route";
import { GET as organizerCheckout } from "@/app/api/billing/addons/organizer-suite/checkout/route";
import { GET as organizerRemove } from "@/app/api/billing/addons/organizer-suite/remove/route";

const OWN = { id: "sub_own", customer: "cus_own", metadata: { studioId: "studio-1" }, items: { data: [] } };
const FOREIGN = { id: "sub_foreign", customer: "cus_victim", metadata: {}, items: { data: [] } };

function seed(options: { subscriptionId: string; status?: string; foreignHasItems?: boolean }) {
  state.tables = {
    studios: [
      {
        id: "studio-1",
        stripe_customer_id: "cus_own",
        stripe_subscription_id: options.subscriptionId,
        subscription_status: options.status ?? "active",
      },
    ],
    studio_billing_customers: [{ studio_id: "studio-1", stripe_customer_id: "cus_own" }],
    usage_addon_entitlements: [
      {
        id: "ent-1",
        studio_id: "studio-1",
        feature_key: "ai_action",
        source: "stripe_subscription_item",
        stripe_subscription_item_id: "si_x",
        status: "active",
      },
      {
        id: "ent-2",
        studio_id: "studio-1",
        feature_key: "organizer_suite",
        source: "stripe_subscription_item",
        stripe_subscription_item_id: "si_x",
        status: "active",
      },
    ],
  };
  const foreignItems = options.foreignHasItems
    ? [
        { id: "si_victim_ai", price: { id: "price_ai" }, quantity: 1 },
        { id: "si_victim_org", price: { id: "price_org" }, quantity: 1 },
      ]
    : [];
  state.subscriptions = {
    sub_own: OWN,
    sub_foreign: { ...FOREIGN, items: { data: foreignItems } },
  };
}

function request(path: string) {
  return new NextRequest(`https://app.test${path}`);
}

function mutatingStripeCalls() {
  return state.stripeCalls.filter((call) => call.method === "subscriptionItems.create" || call.method === "subscriptionItems.del");
}

function entitlementWrites() {
  return (
    state.mutations.filter((mutation) => mutation.table === "usage_addon_entitlements").length +
    state.packs.save.mock.calls.length +
    state.packs.sync.mock.calls.length +
    state.packs.cancel.mock.calls.length
  );
}

function errorOf(response: Response) {
  return new URL(response.headers.get("location") ?? "https://x").searchParams.get("error");
}

beforeEach(() => {
  state.mutations = [];
  state.stripeCalls = [];
  state.packs.save.mockReset();
  state.packs.sync.mockReset();
  state.packs.cancel.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
  process.env.STRIPE_PRICE_ORGANIZER_SUITE_ADDON_STANDARD = "price_org";
});

describe("foreign subscription id on the studio row", () => {
  it.each([
    ["AI checkout", false, () => aiCheckout(request("/api/billing/addons/ai/checkout?pack=small"))],
    ["AI remove", true, () => aiRemove(request("/api/billing/addons/ai/remove?entitlement=ent-1"))],
    ["Organizer Suite checkout", false, () => organizerCheckout(request("/api/billing/addons/organizer-suite/checkout"))],
    ["Organizer Suite remove", true, () => organizerRemove(request("/api/billing/addons/organizer-suite/remove?entitlement=ent-2"))],
  ])("%s: 0 Stripe mutations, 0 entitlement writes", async (_label, keepEntitlements, call) => {
    seed({ subscriptionId: "sub_foreign" });
    // Checkout only proceeds when the studio has no active add-on entitlement yet.
    if (!keepEntitlements) state.tables.usage_addon_entitlements = [];
    const response = await call();
    expect(errorOf(response)).toBe("saas_subscription_unverified");
    expect(mutatingStripeCalls()).toHaveLength(0);
    expect(entitlementWrites()).toBe(0);
  });

  it("a trialing studio (tenant-created default) with a foreign subscription gets nothing", async () => {
    seed({ subscriptionId: "sub_foreign", status: "trialing" });
    state.tables.usage_addon_entitlements = [];
    for (const call of [
      () => aiCheckout(request("/api/billing/addons/ai/checkout?pack=small")),
      () => organizerCheckout(request("/api/billing/addons/organizer-suite/checkout")),
    ]) {
      expect(errorOf(await call())).toBe("saas_subscription_unverified");
    }
    expect(mutatingStripeCalls()).toHaveLength(0);
    expect(entitlementWrites()).toBe(0);
  });

  it("an add-on already on the foreign subscription is not granted to the caller", async () => {
    seed({ subscriptionId: "sub_foreign", foreignHasItems: true });
    state.tables.usage_addon_entitlements = [];
    expect(errorOf(await aiCheckout(request("/api/billing/addons/ai/checkout?pack=small")))).toBe(
      "saas_subscription_unverified",
    );
    expect(errorOf(await organizerCheckout(request("/api/billing/addons/organizer-suite/checkout")))).toBe(
      "saas_subscription_unverified",
    );
    expect(entitlementWrites()).toBe(0);
    expect(mutatingStripeCalls()).toHaveLength(0);
  });

  it("a metadata studio mismatch fails closed even when the customer matches", async () => {
    seed({ subscriptionId: "sub_own" });
    state.subscriptions.sub_own = { ...OWN, metadata: { studioId: "studio-2" } };
    const response = await aiCheckout(request("/api/billing/addons/ai/checkout?pack=small"));
    expect(errorOf(response)).toBe("saas_subscription_unverified");
    expect(mutatingStripeCalls()).toHaveLength(0);
    expect(entitlementWrites()).toBe(0);
  });

  it("no trusted billing customer fails closed", async () => {
    seed({ subscriptionId: "sub_own" });
    state.tables.studio_billing_customers = [];
    state.tables.studios[0].stripe_customer_id = null;
    const response = await aiCheckout(request("/api/billing/addons/ai/checkout?pack=small"));
    expect(errorOf(response)).toBe("saas_subscription_unverified");
    expect(state.stripeCalls).toHaveLength(0);
  });
});

describe("the studio's own subscription behaves as before", () => {
  it("AI checkout adds the item and saves the entitlement", async () => {
    seed({ subscriptionId: "sub_own" });
    const response = await aiCheckout(request("/api/billing/addons/ai/checkout?pack=small"));
    expect(new URL(response.headers.get("location")!).searchParams.get("success")).toBe("ai_pack_added");
    expect(mutatingStripeCalls().map((call) => call.method)).toEqual(["subscriptionItems.create"]);
    expect(mutatingStripeCalls()[0].args[0]).toMatchObject({ subscription: "sub_own", price: "price_ai" });
    expect(state.packs.save).toHaveBeenCalledTimes(1);
  });

  it("Organizer Suite checkout adds the item and upserts the entitlement", async () => {
    seed({ subscriptionId: "sub_own" });
    state.tables.usage_addon_entitlements = [];
    const response = await organizerCheckout(request("/api/billing/addons/organizer-suite/checkout"));
    expect(new URL(response.headers.get("location")!).searchParams.get("success")).toBe("organizer_suite_added");
    expect(mutatingStripeCalls()[0].args[0]).toMatchObject({ subscription: "sub_own", price: "price_org" });
    expect(state.mutations.filter((mutation) => mutation.table === "usage_addon_entitlements")).toHaveLength(1);
  });

  it("the trusted customer falls back to studios.stripe_customer_id when no mapping row exists", async () => {
    seed({ subscriptionId: "sub_own" });
    state.tables.studio_billing_customers = [];
    const response = await aiCheckout(request("/api/billing/addons/ai/checkout?pack=small"));
    expect(new URL(response.headers.get("location")!).searchParams.get("success")).toBe("ai_pack_added");
  });
});
