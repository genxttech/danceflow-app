import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string; details?: string } | null }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  tables: {} as Record<string, unknown>,
  stripeCreate: vi.fn(),
  beginSigning: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      const handler = state.rpc[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      const result = handler(args);
      return { data: result.data ?? null, error: result.error ?? null };
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: (state.tables[table] as object) ?? null, error: null }),
        then: (resolve: (value: { data: unknown; error: null }) => void) => resolve({ data: state.tables[`${table}[]`] ?? [], error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: state.stripeCreate, retrieve: vi.fn(), expire: vi.fn() } },
  }),
}));

vi.mock("@/lib/documents/event-signing", () => ({ beginEventSigningCheckpoint: state.beginSigning }));

const ORDER = "11111111-2222-4333-8444-555555555555";
const TOKEN = "99999999-2222-4333-8444-555555555555";
const REQUEST_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const READY_STUDIO = { stripe_connected_account_id: "acct_studioA", stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true };

function started(overrides: Record<string, unknown> = {}) {
  return { cart_id: "cart", cart_token: TOKEN, order_id: ORDER, registration_id: "reg", order_status: "pending", payment_status: "pending", total_cents: 10330, currency: "USD", requires_signing: false, expires_at: null, checkout_session_id: null, stripe_account_id: null, entry_count: 3, replay: false, ...overrides };
}

function request(body: unknown) {
  return new NextRequest("https://app.test/api/events/spring/competition/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` } });
}

async function load() {
  vi.resetModules();
  return (await import("@/app/api/events/[slug]/competition/checkout/route")).POST;
}

const draft = { registrationMode: "individual", buyerName: "B", buyerEmail: "b@example.test", people: [], entries: [], total: 0.01, quote: { total: 0.01 } };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.user = null;
  state.rpcCalls = [];
  state.stripeCreate.mockReset();
  state.beginSigning.mockReset();
  state.tables = { events: { id: "event-1", slug: "spring", name: "Spring", studio_id: "studio-1", organizer_id: null }, studios: READY_STUDIO };
  state.rpc = {
    quote_competition_registration: () => ({ data: { valid: true, errors: [], total_cents: 10330, currency: "USD" } }),
    start_competition_registration: () => ({ data: started() }),
    prepare_competition_registration_payment: () => ({ data: { order_id: ORDER, state: "payable", event_id: "event-1", studio_id: "studio-1", organizer_id: null, buyer_email: "b@example.test", amount_cents: 10330, currency: "USD", expires_at: new Date(Date.now() + 40 * 60 * 1000).toISOString(), checkout_session_id: null, stripe_account_id: null, entry_count: 3 } }),
    attach_competition_registration_checkout: () => ({ data: { attached: true } }),
  };
  state.stripeCreate.mockResolvedValue({ id: "cs_new", url: "https://stripe.test/cs_new" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/events/[slug]/competition/checkout (Phase 10C)", () => {
  it("is unavailable while the public flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED", "false");
    const POST = await load();
    const response = await POST(request({ clientRequestId: REQUEST_ID, draft }), { params: Promise.resolve({ slug: "spring" }) });
    expect(response.status).toBe(404);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("requires a client request id (idempotency key)", async () => {
    const POST = await load();
    const response = await POST(request({ draft }), { params: Promise.resolve({ slug: "spring" }) });
    expect(response.status).toBe(400);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("starts in the database with the server-verified actor and charges the database amount, ignoring client totals", async () => {
    state.user = { id: "user-1" };
    const POST = await load();
    const response = await POST(request({ clientRequestId: REQUEST_ID, draft, actorUserId: "forged-user" }), { params: Promise.resolve({ slug: "spring" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: "https://stripe.test/cs_new", orderId: ORDER });
    const start = state.rpcCalls.find((call) => call.name === "start_competition_registration")!;
    expect(start.args).toMatchObject({ p_event_id: "event-1", p_client_request_id: REQUEST_ID, p_actor_user_id: "user-1" });
    const [params, options] = state.stripeCreate.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(10330);
    expect(options.idempotencyKey).toMatch(new RegExp(`^comp10c:${ORDER}:checkout-session:\\d+$`));
    expect(state.rpcCalls.map((call) => call.name)).toEqual(["quote_competition_registration", "start_competition_registration", "prepare_competition_registration_payment", "attach_competition_registration_checkout"]);
  });

  it("sends required documents to the Phase 8 signing checkpoint before any payment", async () => {
    state.rpc.start_competition_registration = () => ({ data: started({ requires_signing: true }) });
    state.tables["event_document_requirements[]"] = [{ id: "req-1" }];
    state.beginSigning.mockResolvedValue({ checkpointId: "cp", signingUrl: "https://app.test/sign/tok" });
    const POST = await load();
    const response = await POST(request({ clientRequestId: REQUEST_ID, draft }), { params: Promise.resolve({ slug: "spring" }) });
    expect(await response.json()).toMatchObject({ url: "https://app.test/sign/tok", signing: true });
    expect(state.beginSigning).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER, registrationIds: ["reg"], requirementIds: ["req-1"] }));
    expect(state.stripeCreate).not.toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === "prepare_competition_registration_payment")).toBe(false);
  });

  it("a confirmed free registration goes straight to the server status page", async () => {
    state.rpc.quote_competition_registration = () => ({ data: { valid: true, errors: [], total_cents: 0, currency: "USD" } });
    state.rpc.start_competition_registration = () => ({ data: started({ order_status: "confirmed", payment_status: "paid", total_cents: 0 }) });
    const POST = await load();
    const response = await POST(request({ clientRequestId: REQUEST_ID, draft }), { params: Promise.resolve({ slug: "spring" }) });
    expect((await response.json()).url).toBe(`https://app.test/events/spring/competition/register/status?token=${TOKEN}`);
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("surfaces database refusals as safe errors (closed / identity / idempotency)", async () => {
    for (const [message, status, code] of [
      ["COMP10C_CLOSED: competition registration is not open.", 409, "closed"],
      ["COMP10C_IDENTITY_UNVERIFIED: verify your email", 403, "identity_unverified"],
      ["COMP10C_IDEMPOTENCY_CONFLICT: already submitted", 409, "idempotency_conflict"],
    ] as const) {
      state.rpc.start_competition_registration = () => ({ error: { message } });
      const POST = await load();
      const response = await POST(request({ clientRequestId: REQUEST_ID, draft }), { params: Promise.resolve({ slug: "spring" }) });
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(code);
    }
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("refuses a paid registration when the studio cannot take payments, before creating anything", async () => {
    state.tables.studios = { ...READY_STUDIO, stripe_connect_payouts_enabled: false };
    const POST = await load();
    const response = await POST(request({ clientRequestId: REQUEST_ID, draft }), { params: Promise.resolve({ slug: "spring" }) });
    expect(response.status).toBe(409);
    expect(state.rpcCalls.map((call) => call.name)).toEqual(["quote_competition_registration"]);
  });
});
