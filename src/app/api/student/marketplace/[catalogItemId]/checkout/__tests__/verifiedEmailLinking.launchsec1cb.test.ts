import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * LAUNCH-SEC-1C-B (T1-B): marketplace auto-linking requires the buyer's
 * verified current email, exact normalized matching, never steals a client
 * held by another account and never revives a closed relationship.
 */

const USER_ID = "user-1";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const STUDIO_ID = "studio-1";

let verifiedEmail: string | null = null;
let candidateClients: Array<{ id: string; email: string }> = [];
let clientLinks: Array<{ id: string; user_id: string | null; status: string }> = [];
const writes: Array<{ table: string; op: string; payload: unknown }> = [];
const queried: string[] = [];

function chainFor(table: string) {
  const ops: Array<[string, unknown[]]> = [];
  queried.push(table);
  const resolve = () => {
    if (table === "commerce_catalog_items") {
      return {
        data: {
          id: ITEM_ID, studio_id: STUDIO_ID, name: "Course", item_type: "digital_video", price: 10, currency: "usd",
          active: true, published: true, marketplace_visible: true,
          studios: { subscription_status: "active", stripe_connected_account_id: "acct_1", stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true, stripe_connect_onboarding_complete: true },
          commerce_digital_content: { status: "published", release_at: null, mux_upload_status: "ready" },
        },
        error: null,
      };
    }
    if (table === "clients") return { data: candidateClients, error: null };
    if (table === "client_account_links") {
      const selectCols = String(ops.find(([op]) => op === "select")?.[1][0] ?? "");
      if (selectCols === "id, user_id, status") return { data: clientLinks, error: null };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "neq", "in", "ilike", "order", "limit"]) {
    chain[op] = (...args: unknown[]) => {
      ops.push([op, args]);
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve(resolve());
  chain.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(resolve()).then(onFulfilled);
  chain.insert = (payload: unknown) => {
    writes.push({ table, op: "insert", payload });
    const inserted = { select: () => ({ single: async () => ({ data: { id: "new-client" }, error: null }) }), then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) };
    return inserted;
  };
  chain.update = (payload: unknown) => {
    writes.push({ table, op: "update", payload });
    return { eq: async () => ({ error: null }) };
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (table: string) => chainFor(table) }) }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "ip",
  rateLimitKey: (...parts: unknown[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/auth/studentApiAuth", () => ({
  getStudentApiUser: async () => ({ id: USER_ID, email: "Pat_X@Example.test", user_metadata: {} }),
  normalizeStudentApiUuid: (value: string) => value,
  createStudentApiUserScopedClient: async () => ({
    rpc: async (fn: string) => ({ data: fn === "my_verified_email" ? verifiedEmail : null, error: null }),
  }),
}));

const { POST } = await import("../route");

async function checkout() {
  try {
    return await POST(new NextRequest(`https://app.example/api/student/marketplace/${ITEM_ID}/checkout`, { method: "POST" }), {
      params: Promise.resolve({ catalogItemId: ITEM_ID }),
    });
  } catch {
    return null; // later Stripe steps are out of scope for these tests
  }
}

const linkWrites = () => writes.filter((write) => write.table === "client_account_links");

beforeEach(() => {
  verifiedEmail = "pat_x@example.test";
  candidateClients = [];
  clientLinks = [];
  writes.length = 0;
  queried.length = 0;
});

describe("LAUNCH-SEC-1C-B marketplace auto-linking (T1-B)", () => {
  it("an unverified buyer is asked to verify; no client lookup or link", async () => {
    verifiedEmail = null;
    const response = await checkout();
    expect(response?.status).toBe(403);
    expect(queried).not.toContain("clients");
    expect(linkWrites()).toEqual([]);
  });

  it("links an eligible existing client on exact normalized email", async () => {
    candidateClients = [{ id: "client-1", email: "PAT_X@example.test" }];
    await checkout();
    expect(linkWrites()).toHaveLength(1);
    expect(linkWrites()[0]).toMatchObject({ op: "insert", payload: { client_id: "client-1", user_id: USER_ID, status: "linked" } });
  });

  it("a wildcard-like stored address is never treated as the buyer's identity", async () => {
    candidateClients = [{ id: "client-wild", email: "patyx@example.test" }];
    await checkout();
    expect(writes.find((write) => write.table === "clients" && write.op === "insert")).toBeTruthy();
    expect(linkWrites()[0]).toMatchObject({ payload: { client_id: "new-client" } });
  });

  it("does not steal a client already linked to another account", async () => {
    candidateClients = [{ id: "client-1", email: "pat_x@example.test" }];
    clientLinks = [{ id: "l-other", user_id: "someone-else", status: "linked" }];
    const response = await checkout();
    expect(response?.status).toBe(409);
    expect(linkWrites()).toEqual([]);
  });

  it.each(["disconnected", "former_client", "rejected", "conflict"])(
    "does not revive the buyer's %s relationship",
    async (status) => {
      candidateClients = [{ id: "client-1", email: "pat_x@example.test" }];
      clientLinks = [{ id: "l-mine", user_id: USER_ID, status }];
      const response = await checkout();
      expect(response?.status).toBe(409);
      expect(linkWrites()).toEqual([]);
    },
  );
});
