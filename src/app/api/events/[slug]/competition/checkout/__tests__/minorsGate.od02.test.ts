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
  getStripe: () => ({ checkout: { sessions: { create: state.stripeCreate, retrieve: vi.fn(), expire: vi.fn() } } }),
}));
vi.mock("@/lib/documents/event-signing", () => ({ beginEventSigningCheckpoint: state.beginSigning }));

const ORDER = "11111111-2222-4333-8444-555555555555";
const TOKEN = "99999999-2222-4333-8444-555555555555";
const REQUEST_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const READY_STUDIO = { stripe_connected_account_id: "acct_studioA", stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true };

function request(body: unknown) {
  return new NextRequest("https://app.test/api/events/spring/competition/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `10.1.0.${Math.floor(Math.random() * 200)}` } });
}
async function load() {
  vi.resetModules();
  return (await import("@/app/api/events/[slug]/competition/checkout/route")).POST;
}
const person = (clientId: string, dateOfBirth?: string) => ({ clientId, firstName: "A", lastName: "B", personType: "dancer", ...(dateOfBirth === undefined ? {} : { dateOfBirth }) });
const base = { registrationMode: "individual", buyerName: "Buyer", buyerEmail: "b@example.test" };
const SOME_DB_CALLS = ["quote_competition_registration", "start_competition_registration"];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.user = null;
  state.rpcCalls = [];
  state.stripeCreate.mockReset();
  state.beginSigning.mockReset();
  state.tables = { events: { id: "event-1", slug: "spring", name: "Spring", studio_id: "studio-1", organizer_id: null }, studios: READY_STUDIO };
  state.rpc = {
    quote_competition_registration: () => ({ data: { valid: true, errors: [], total_cents: 0, currency: "USD" } }),
    start_competition_registration: () => ({ data: { cart_id: "c", cart_token: TOKEN, order_id: ORDER, registration_id: "reg", order_status: "confirmed", payment_status: "paid", total_cents: 0, currency: "USD", requires_signing: false, expires_at: null, checkout_session_id: null, stripe_account_id: null, entry_count: 1, replay: false } }),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function post(draft: unknown) {
  const POST = await load();
  return POST(request({ clientRequestId: REQUEST_ID, draft }), { params: Promise.resolve({ slug: "spring" }) });
}

describe("OD-02: under-18 competitors are refused server-side before any database call", () => {
  it("refuses a minor in a couple entry: 422, no quote / start RPC, no Stripe", async () => {
    const response = await post({ ...base, people: [person("a", "1990-01-01"), person("kid", "2012-05-05")], entries: [{ clientId: "e1", participantIds: ["a", "kid"] }] });
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json).toMatchObject({ code: "minors_not_permitted", blocked: [{ personClientId: "kid", reason: "under_minimum_age" }] });
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.stripeCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(json)).not.toMatch(/2012/);
  });

  it("refuses a team entry containing one minor among adults (every roster member evaluated)", async () => {
    const team = ["a", "b", "c", "d"].map((id, i) => person(id, i === 3 ? "2011-01-01" : "1991-01-01"));
    const response = await post({ ...base, registrationMode: "studio", registeringStudioName: "S", people: team, entries: [{ clientId: "e1", participantIds: ["a", "b", "c", "d"], teamName: "T" }] });
    expect(response.status).toBe(422);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("fails closed with age_not_established when a competitor has no date of birth", async () => {
    const response = await post({ ...base, people: [person("a")], entries: [{ clientId: "e1", participantIds: ["a"] }] });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "age_not_established" });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("evaluates the competitor, not the buyer: an adult buyer registering a minor is refused even when signed in", async () => {
    state.user = { id: "adult-parent" };
    const response = await post({ ...base, people: [{ ...person("kid", "2013-03-03"), isSelf: false }], entries: [{ clientId: "e1", participantIds: ["kid"] }] });
    expect(response.status).toBe(422);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("a replayed request (same clientRequestId) is refused the same way", async () => {
    const draft = { ...base, people: [person("kid", "2012-05-05")], entries: [{ clientId: "e1", participantIds: ["kid"] }] };
    expect((await post(draft)).status).toBe(422);
    expect((await post(draft)).status).toBe(422);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("lets an all-adult draft continue to the database quote and start", async () => {
    const response = await post({ ...base, people: [person("a", "1990-01-01"), person("b", "1988-02-02")], entries: [{ clientId: "e1", participantIds: ["a", "b"] }] });
    expect(response.status).toBe(200);
    expect(state.rpcCalls.map((call) => call.name)).toEqual(SOME_DB_CALLS);
  });
});
