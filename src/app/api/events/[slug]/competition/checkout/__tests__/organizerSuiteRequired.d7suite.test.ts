import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createEntitlementFakeDb, type Row } from "@/lib/billing/__tests__/entitlementFakeDb";

vi.mock("server-only", () => ({}));

/**
 * D7: competition registration checkout (route src/app/api/events/[slug]/competition/checkout/route.ts, payment step
 * beginCompetitionPayment in src/lib/competition/registrationCheckout.ts) vs the Organizer Suite entitlement.
 *
 * For a payable order on an organizer event the platform fee is read before the Checkout Session is created; a fee of
 * 0 means "Organizer Suite required" and the payment step refuses with code payment_not_ready (409, "DanceFlow organizer
 * checkout is not enabled for this listing.") with no Stripe call and no session attached. An order that already has
 * its bound Checkout Session (resume) or is finalized is not re-evaluated. Events with no organizer are unaffected.
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
const REFUSAL = "DanceFlow organizer checkout is not enabled for this listing.";
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
  expect(await response.json()).toMatchObject({ code: "payment_not_ready", error: REFUSAL });
  expect(state.stripeCreate).not.toHaveBeenCalled();
  expect(rpcNames()).not.toContain("attach_competition_registration_checkout");
  expect(rpcNames()).not.toContain("finalize_competition_registration");
  // NOTE (reported): the pending registration hold is created by start_competition_registration BEFORE the Suite
  // check (which lives in the payment step) and is not released here; it lapses with its hold expiry.
  expect(rpcNames()).toEqual(["quote_competition_registration", "start_competition_registration", "prepare_competition_registration_payment"]);
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

describe("existing registrations are not re-evaluated (Suite lapsed in every case)", () => {
  const lapsed = () => [grant({ period_end: "2026-12-01" })];

  it("resume of an order whose Checkout Session is already bound and open returns that session", async () => {
    seed({ organizerId: "org-1", entitlements: lapsed() });
    state.rpc.prepare_competition_registration_payment = () => ({
      data: prepared({ organizer_id: "org-1", checkout_session_id: "cs_bound", stripe_account_id: "acct_studioA" }),
    });
    state.stripeRetrieve.mockResolvedValue({ id: "cs_bound", status: "open", url: "https://stripe.test/cs_bound" });
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: "https://stripe.test/cs_bound" });
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

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

describe("FINDING (reported, not changed): free competition registrations skip the Suite check", () => {
  // registrationCheckout.ts finalizes a `free` order before the fee/Suite check, so a $0 competition registration on
  // an organizer event completes without any Organizer Suite entitlement (the student ticket route refuses the same
  // organizer listing regardless of total). No money moves and no fee is lost; this pins the current behaviour so a
  // policy change is a deliberate edit here.
  it("a $0 registration on an organizer event with no entitlement is finalized", async () => {
    seed({ organizerId: "org-1", entitlements: [] });
    state.rpc.quote_competition_registration = () => ({ data: { valid: true, errors: [], total_cents: 0, currency: "USD" } });
    state.rpc.prepare_competition_registration_payment = () => ({ data: prepared({ organizer_id: "org-1", state: "free", amount_cents: 0 }) });
    const response = await post();
    expect(await response.json()).toMatchObject({ url: STATUS_URL });
    expect(rpcNames()).toContain("finalize_competition_registration");
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });
});
