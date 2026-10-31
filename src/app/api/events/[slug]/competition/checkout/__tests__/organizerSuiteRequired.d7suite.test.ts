import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createEntitlementFakeDb, type Row } from "@/lib/billing/__tests__/entitlementFakeDb";

vi.mock("server-only", () => ({}));

/**
 * D7: competition registration checkout (route src/app/api/events/[slug]/competition/checkout/route.ts, payment step
 * beginCompetitionPayment in src/lib/competition/registrationCheckout.ts) vs the Organizer Suite entitlement.
 *
 * Owner decision P2-1: every NEW registration on an organizer event (paid, free and fully discounted alike) needs a current
 * Organizer Suite entitlement. Otherwise the registration is refused with code organizer_suite_required (409, "This organizer
 * is not accepting registrations for this event right now."), no Stripe session is created or attached, nothing is finalized,
 * and the pending order just created is released through release_competition_registration (reason "abandoned").
 * Owner decision P2-2: an unpaid pending order whose open Checkout Session is resumed after the lapse is refused too (the
 * session is expired first); finalized orders, completed sessions and replays of confirmed orders are never re-evaluated.
 * Events with no organizer are unaffected.
 */

type RpcHandler = (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null };

const state = vi.hoisted(() => ({
  db: null as unknown as { client: { from: (table: string) => unknown } },
  rpc: {} as Record<string, RpcHandler>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  stripeCreate: vi.fn(),
  stripeRetrieve: vi.fn(),
  stripeExpire: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => state.db.client.from(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      const handler = state.rpc[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      const result = handler(args);
      return { data: result.data ?? null, error: result.error ?? null };
    },
  }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: state.stripeCreate, retrieve: state.stripeRetrieve, expire: state.stripeExpire } },
  }),
}));
vi.mock("@/lib/documents/event-signing", () => ({ beginEventSigningCheckpoint: vi.fn() }));

const ORDER = "11111111-2222-4333-8444-555555555555";
const TOKEN = "99999999-2222-4333-8444-555555555555";
const STUDIO_ID = "studio-1";
const AMOUNT_CENTS = 10000;
const REFUSAL = "This organizer is not accepting registrations for this event right now.";
const STATUS_URL = `https://app.test/events/spring/competition/register/status?token=${TOKEN}`;

type Setup = { organizerId?: string | null; planCode?: string; entitlements?: Row[]; timezone?: string };

function seed(setup: Setup = {}) {
  const organizerId = setup.organizerId ?? null;
  state.db = createEntitlementFakeDb({
    events: [{ id: "event-1", slug: "spring", name: "Spring", studio_id: STUDIO_ID, organizer_id: organizerId }],
    studios: [
      {
        id: STUDIO_ID,
        timezone: setup.timezone ?? "America/New_York",
        stripe_connected_account_id: "acct_studioA",
        stripe_connect_onboarding_complete: true,
        stripe_connect_charges_enabled: true,
        stripe_connect_payouts_enabled: true,
      },
    ],
    studio_subscriptions: [
      { id: "sub-1", studio_id: STUDIO_ID, status: "active", subscription_plans: { code: setup.planCode ?? "pro" } },
    ],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO_ID, feature_key: "organizer_suite", ...row })),
  }) as unknown as typeof state.db;
  state.rpc = {
    quote_competition_registration: () => ({ data: { valid: true, errors: [], total_cents: AMOUNT_CENTS, currency: "USD" } }),
    start_competition_registration: () => ({ data: started() }),
    prepare_competition_registration_payment: () => ({ data: prepared({ organizer_id: organizerId }) }),
    attach_competition_registration_checkout: () => ({ data: { attached: true } }),
    release_competition_registration: () => ({ data: { outcome: "released" } }),
    finalize_competition_registration: () => ({ data: { outcome: "finalized" } }),
  };
}

function started(overrides: Row = {}) {
  return {
    cart_id: "cart", cart_token: TOKEN, order_id: ORDER, registration_id: "reg", order_status: "pending", payment_status: "pending",
    total_cents: AMOUNT_CENTS, currency: "USD", requires_signing: false, expires_at: null, checkout_session_id: null,
    stripe_account_id: null, entry_count: 2, replay: false, ...overrides,
  };
}

function prepared(overrides: Row = {}) {
  return {
    order_id: ORDER, state: "payable", event_id: "event-1", studio_id: STUDIO_ID, organizer_id: null,
    buyer_email: "b@example.test", amount_cents: AMOUNT_CENTS, currency: "USD",
    expires_at: new Date(Date.now() + 40 * 60 * 1000).toISOString(), checkout_session_id: null, stripe_account_id: null,
    entry_count: 2, ...overrides,
  };
}

function grant(overrides: Row = {}): Row {
  return { id: "grant-1", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides };
}

function stripeItem(overrides: Row = {}): Row {
  return { id: "item-1", source: "stripe_subscription_item", status: "active", period_start: null, period_end: null, ...overrides };
}

let ipCounter = 0;
const draft = { registrationMode: "individual", buyerName: "B", buyerEmail: "b@example.test", people: [], entries: [] };

async function post() {
  vi.resetModules();
  const { POST } = await import("@/app/api/events/[slug]/competition/checkout/route");
  ipCounter += 1;
  const request = new NextRequest("https://app.test/api/events/spring/competition/checkout", {
    method: "POST",
    body: JSON.stringify({ clientRequestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", draft }),
    headers: { "content-type": "application/json", "x-forwarded-for": `10.66.0.${ipCounter}` },
  });
  return POST(request, { params: Promise.resolve({ slug: "spring" }) });
}

function rpcNames() {
  return state.rpcCalls.map((call) => call.name);
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "organizer_suite_required", error: REFUSAL });
  expect(state.stripeCreate).not.toHaveBeenCalled();
  expect(rpcNames()).not.toContain("attach_competition_registration_checkout");
  expect(rpcNames()).not.toContain("finalize_competition_registration");
  // The pending order created by start_competition_registration is released, once, for exactly that order.
  const releases = state.rpcCalls.filter((call) => call.name === "release_competition_registration");
  expect(releases).toHaveLength(1);
  expect(releases[0].args).toMatchObject({ p_order_id: ORDER, p_reason: "abandoned" });
}

async function expectAllowed(response: Response, feeCents: number | null) {
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ url: "https://stripe.test/cs_new", orderId: ORDER });
  expect(state.stripeCreate).toHaveBeenCalledTimes(1);
  const [params] = state.stripeCreate.mock.calls[0] as [{ payment_intent_data: { application_fee_amount?: number } }];
  expect(params.payment_intent_data.application_fee_amount ?? null).toBe(feeCents);
  expect(rpcNames()).toContain("attach_competition_registration_checkout");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  state.rpcCalls = [];
  state.stripeCreate.mockReset();
  state.stripeRetrieve.mockReset();
  state.stripeExpire.mockReset();
  state.stripeCreate.mockResolvedValue({ id: "cs_new", url: "https://stripe.test/cs_new" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("competition checkout: organizer events need a current Organizer Suite entitlement", () => {
  it.each([
    { name: "no entitlement at all", entitlements: [] as Row[] },
    { name: "a lapsed manual grant", entitlements: [grant({ period_end: "2026-12-01" })] },
    { name: "a revoked grant", entitlements: [grant({ status: "revoked" })] },
  ])("refuses $name with no Stripe session and nothing attached", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    await expectRefused(await post());
  });

  it.each([
    { name: "Pro + current grant", planCode: "pro", entitlements: [grant()], fee: 300 },
    { name: "Growth + current grant", planCode: "growth", entitlements: [grant()], fee: 325 },
    { name: "Starter + current grant", planCode: "starter", entitlements: [grant({ period_end: "2027-07-09" })], fee: 325 },
    { name: "Organizer plan, no add-on", planCode: "organizer", entitlements: [] as Row[], fee: 350 },
    { name: "Pro + lapsed grant + active Stripe add-on", planCode: "pro", entitlements: [grant({ period_end: "2026-12-01" }), stripeItem()], fee: 300 },
  ])("allows $name and creates the Checkout Session with the expected application fee", async ({ planCode, entitlements, fee }) => {
    seed({ organizerId: "org-1", planCode, entitlements });
    await expectAllowed(await post(), fee);
  });

  it("an event with no organizer is unaffected: no entitlement needed and no DanceFlow fee", async () => {
    seed({ organizerId: null, entitlements: [] });
    await expectAllowed(await post(), null);
  });
});

describe("DanceAbel boundary: grant period_end 2027-07-09, America/New_York", () => {
  it.each([
    { at: "2027-07-08T20:00:00Z", allowed: true },
    { at: "2027-07-09T03:59:59Z", allowed: true },
    { at: "2027-07-09T04:00:00Z", allowed: false },
  ])("at $at allowed=$allowed", async ({ at, allowed }) => {
    vi.setSystemTime(new Date(at));
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    const response = await post();
    if (allowed) await expectAllowed(response, 300);
    else await expectRefused(response);
  });
});

describe("completed and finalized registrations are not re-evaluated (Suite lapsed in every case)", () => {
  const lapsed = () => [grant({ period_end: "2026-12-01" })];

  it("resume of an order whose bound session already completed goes to the status page", async () => {
    seed({ organizerId: "org-1", entitlements: lapsed() });
    state.rpc.prepare_competition_registration_payment = () => ({
      data: prepared({ organizer_id: "org-1", checkout_session_id: "cs_paid", stripe_account_id: "acct_studioA" }),
    });
    state.stripeRetrieve.mockResolvedValue({ id: "cs_paid", status: "complete", url: null });
    const response = await post();
    expect(await response.json()).toMatchObject({ url: STATUS_URL });
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("a finalized order goes to the status page", async () => {
    seed({ organizerId: "org-1", entitlements: lapsed() });
    state.rpc.prepare_competition_registration_payment = () => ({ data: prepared({ organizer_id: "org-1", state: "finalized" }) });
    const response = await post();
    expect(await response.json()).toMatchObject({ url: STATUS_URL });
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("a replayed start of an already confirmed (paid) order goes straight to the status page", async () => {
    seed({ organizerId: "org-1", entitlements: lapsed() });
    state.rpc.start_competition_registration = () => ({ data: started({ order_status: "confirmed", payment_status: "paid", replay: true }) });
    const response = await post();
    expect(await response.json()).toMatchObject({ url: STATUS_URL, orderId: ORDER });
    expect(rpcNames()).toEqual(["quote_competition_registration", "start_competition_registration"]);
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });
});

describe("P2-1: free and fully discounted registrations need the entitlement too", () => {
  function freeOrder(organizerId: string | null) {
    state.rpc.quote_competition_registration = () => ({ data: { valid: true, errors: [], total_cents: 0, currency: "USD" } });
    state.rpc.prepare_competition_registration_payment = () => ({ data: prepared({ organizer_id: organizerId, state: "free", amount_cents: 0 }) });
  }

  it.each([
    { name: "no entitlement", entitlements: [] as Row[] },
    { name: "an expired grant", entitlements: [grant({ period_end: "2026-12-01" })] },
  ])("a $0 registration with $name is refused, nothing is finalized and the hold is released", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    freeOrder("org-1");
    await expectRefused(await post());
  });

  it("a $0 / 100%-discounted registration with a current grant is finalized without Stripe", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    freeOrder("org-1");
    const response = await post();
    expect(await response.json()).toMatchObject({ url: STATUS_URL });
    expect(rpcNames()).toContain("finalize_competition_registration");
    expect(rpcNames()).not.toContain("release_competition_registration");
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("a $0 registration on an event with no organizer needs no entitlement", async () => {
    seed({ organizerId: null, entitlements: [] });
    freeOrder(null);
    const response = await post();
    expect(await response.json()).toMatchObject({ url: STATUS_URL });
    expect(rpcNames()).toContain("finalize_competition_registration");
  });

  it("a partially discounted (still payable) registration is refused when lapsed", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })] });
    state.rpc.prepare_competition_registration_payment = () => ({ data: prepared({ organizer_id: "org-1", amount_cents: 2500 }) });
    await expectRefused(await post());
  });

  it("a partially discounted registration with a current grant is charged the discounted amount", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    state.rpc.prepare_competition_registration_payment = () => ({ data: prepared({ organizer_id: "org-1", amount_cents: 2500 }) });
    const response = await post();
    expect(response.status).toBe(200);
    const [params] = state.stripeCreate.mock.calls[0] as [{ line_items: Array<{ price_data: { unit_amount: number } }> }];
    expect(params.line_items[0].price_data.unit_amount).toBe(2500);
  });
});

describe("P2-1 / P2-2: hold cleanup is scoped and failures are safe", () => {
  it("a refused registration that requires signing is refused BEFORE the signing checkpoint is created", async () => {
    seed({ organizerId: "org-1", entitlements: [] });
    state.rpc.start_competition_registration = () => ({ data: started({ requires_signing: true }) });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "organizer_suite_required" });
    const { beginEventSigningCheckpoint } = await import("@/lib/documents/event-signing");
    expect(beginEventSigningCheckpoint).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("prepare_competition_registration_payment");
    expect(rpcNames().filter((name) => name === "release_competition_registration")).toHaveLength(1);
  });

  it("a release failure after the refusal does not change the customer-facing result", async () => {
    seed({ organizerId: "org-1", entitlements: [] });
    state.rpc.release_competition_registration = () => ({ error: { message: "boom" } });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "organizer_suite_required", error: REFUSAL });
  });

  it("an already paid order is not touched by the refusal path (database reports already_paid)", async () => {
    seed({ organizerId: "org-1", entitlements: [] });
    state.rpc.release_competition_registration = () => ({ data: { outcome: "already_paid" } });
    const response = await post();
    expect(response.status).toBe(409);
    expect(state.stripeCreate).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("finalize_competition_registration");
  });
});

describe("P2-2: resuming an unpaid pending order with an open Checkout Session after the lapse", () => {
  function resumeOpen() {
    state.rpc.prepare_competition_registration_payment = () => ({
      data: prepared({ organizer_id: "org-1", checkout_session_id: "cs_bound", stripe_account_id: "acct_studioA" }),
    });
    state.stripeRetrieve.mockResolvedValue({ id: "cs_bound", status: "open", url: "https://stripe.test/cs_bound" });
  }

  it("is refused, the open session is expired first and the order is released against that session", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })] });
    resumeOpen();
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "organizer_suite_required", error: REFUSAL });
    expect(state.stripeExpire).toHaveBeenCalledWith("cs_bound", {}, { stripeAccount: "acct_studioA" });
    const releases = state.rpcCalls.filter((call) => call.name === "release_competition_registration");
    expect(releases).toHaveLength(1);
    expect(releases[0].args).toMatchObject({ p_order_id: ORDER, p_reason: "abandoned", p_checkout_session_id: "cs_bound", p_stripe_account_id: "acct_studioA" });
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("is refused without releasing when the open session cannot be expired (a payment could still complete)", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })] });
    resumeOpen();
    state.stripeExpire.mockRejectedValue(new Error("already paid"));
    const response = await post();
    expect(response.status).toBe(409);
    expect(rpcNames()).not.toContain("release_competition_registration");
  });

  it("is still allowed with a current entitlement", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    resumeOpen();
    const response = await post();
    expect(await response.json()).toMatchObject({ url: "https://stripe.test/cs_bound" });
    expect(state.stripeExpire).not.toHaveBeenCalled();
  });
});
