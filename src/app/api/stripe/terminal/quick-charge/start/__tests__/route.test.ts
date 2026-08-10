import { describe, expect, it, vi, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";

/**
 * P0.1 regression coverage for quick-charge/start: confirms the idempotency
 * refactor (delegating creation to startQuickCharge) left the route's
 * existing auth/tenant-scoping gates untouched.
 */

let currentUser: { id: string } | null = { id: "user-1" };
let authError: { message: string } | null = null;
let studioContext: { studioId: string | null; studioRole: string | null; isPlatformAdmin: boolean } | null = {
  studioId: "studio-1",
  studioRole: "front_desk",
  isPlatformAdmin: false,
};

let tables: { studios: FakeTable; stripe_terminal_readers: FakeTable; payments: FakeTable; terminal_payment_sessions: FakeTable; commerce_orders: FakeTable };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: currentUser }, error: authError }),
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeAdminClient(tables),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => studioContext,
}));

vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    accounts: {
      retrieve: async () => ({ charges_enabled: true, capabilities: { card_payments: "active" } }),
    },
    paymentIntents: {
      create: vi.fn(async (_params: unknown, requestOptions: { idempotencyKey?: string }) => ({
        id: `pi_${requestOptions?.idempotencyKey ?? "x"}`,
        status: "requires_payment_method",
      })),
      cancel: vi.fn(async () => ({ id: "pi_cancelled" })),
    },
    terminal: {
      readers: {
        processPaymentIntent: vi.fn(async () => ({ id: "reader_action" })),
      },
    },
  }),
}));

function seedTables() {
  tables = {
    studios: new FakeTable(),
    stripe_terminal_readers: new FakeTable(),
    payments: new FakeTable(),
    terminal_payment_sessions: new FakeTable(),
    commerce_orders: new FakeTable(),
  };
  tables.payments.uniqueColumns = ["studio_id", "client_request_id"];

  tables.studios.rows.push({ id: "studio-1", name: "Studio One", stripe_connected_account_id: "acct_studio_1" });
  tables.studios.rows.push({ id: "studio-2", name: "Studio Two", stripe_connected_account_id: "acct_studio_2" });

  tables.stripe_terminal_readers.rows.push({
    id: "33333333-3333-4333-8333-333333333333",
    studio_id: "studio-1",
    terminal_location_id: "loc-1",
    stripe_reader_id: "tmr_1",
    stripe_location_id: "tml_1",
    label: "Front Desk",
    status: "online",
    active: true,
    updated_at: "t1",
  });
}

function fakeRequest(body: Record<string, unknown>) {
  return { json: async () => body } as never;
}

const VALID_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /api/stripe/terminal/quick-charge/start", () => {
  beforeEach(() => {
    seedTables();
    currentUser = { id: "user-1" };
    authError = null;
    studioContext = { studioId: "studio-1", studioRole: "front_desk", isPlatformAdmin: false };
  });

  it("rejects an unauthenticated request with 401", async () => {
    currentUser = null;
    authError = { message: "not signed in" };

    const { POST } = await import("../route");
    const response = await POST(
      fakeRequest({ category: "group_class", amount: 20, readerId: "33333333-3333-4333-8333-333333333333", clientRequestId: VALID_ID }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a request with no studio workspace selected", async () => {
    studioContext = { studioId: null, studioRole: null, isPlatformAdmin: false };

    const { POST } = await import("../route");
    const response = await POST(
      fakeRequest({ category: "group_class", amount: 20, readerId: "33333333-3333-4333-8333-333333333333", clientRequestId: VALID_ID }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a role without terminal-collection permission with 403", async () => {
    studioContext = { studioId: "studio-1", studioRole: "client", isPlatformAdmin: false };

    const { POST } = await import("../route");
    const response = await POST(
      fakeRequest({ category: "group_class", amount: 20, readerId: "33333333-3333-4333-8333-333333333333", clientRequestId: VALID_ID }),
    );

    expect(response.status).toBe(403);
  });

  it("only ever touches the caller's own studio, even with another studio's rows present", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      fakeRequest({ category: "group_class", amount: 20, readerId: "33333333-3333-4333-8333-333333333333", clientRequestId: VALID_ID }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    const payment = tables.payments.rows.find((r) => r.id === json.paymentId);
    expect(payment?.studio_id).toBe("studio-1");
    expect(tables.payments.rows.every((r) => r.studio_id === "studio-1")).toBe(true);
  });
});
