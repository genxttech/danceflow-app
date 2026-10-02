import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LAUNCH-SEC-1C-B: email-based client-invitation and group-recap claims need
 * the caller session's verified email; matching is exact normalized equality.
 */

const rpcCalls: Array<{ fn: string; args: unknown }> = [];
const updates: Array<{ table: string; payload: unknown }> = [];
const queries: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
let recapRows: Array<Record<string, unknown>> = [];
let tokenRecipient: Record<string, unknown> | null = null;

function query(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  queries.push(entry);
  const result = () => {
    if (table === "group_lesson_recap_recipients") {
      if (entry.ops.some(([op]) => op === "maybeSingle")) {
        const tokenLookup = entry.ops.some(([op, args]) => op === "eq" && args[0] === "secure_token");
        return { data: tokenLookup ? tokenRecipient : null, error: null };
      }
      return { data: recapRows, error: null };
    }
    if (table === "client_account_links") return { data: [{ client_id: "already-linked-client" }], error: null };
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "neq", "ilike", "limit", "maybeSingle", "order"]) {
    chain[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return op === "maybeSingle" ? Promise.resolve(result()) : chain;
    };
  }
  chain.then = (resolve: (value: unknown) => unknown) => resolve(result());
  chain.upsert = async () => ({ error: null });
  chain.update = (payload: unknown) => {
    updates.push({ table, payload });
    const tail = { eq: () => tail, neq: () => Promise.resolve({ error: null }) };
    return tail;
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => query(table),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { data: [{ client_id: "claimed-client" }], error: null };
    },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id } }, error: null }) } },
  }),
}));

vi.mock("@/lib/student-identity/account-security", () => ({
  reactivateDanceFlowAccount: async () => undefined,
}));

const { ensurePortalProfileAndClientLinks, claimGroupLessonRecapsForUser } = await import("../portal-linking");

beforeEach(() => {
  rpcCalls.length = 0;
  updates.length = 0;
  queries.length = 0;
  recapRows = [];
  tokenRecipient = null;
});

describe("LAUNCH-SEC-1C-B client invitation claims", () => {
  it("an unverified session never calls the claim RPC but keeps existing links", async () => {
    const result = await ensurePortalProfileAndClientLinks({ userId: "u1", email: "pat@example.test", verifiedEmail: null });
    expect(rpcCalls).toEqual([]);
    expect(result.linkedClientIds).toEqual(["already-linked-client"]);
  });

  it("a verified email for a different address does not claim", async () => {
    await ensurePortalProfileAndClientLinks({ userId: "u1", email: "pat@example.test", verifiedEmail: "other@example.test" });
    expect(rpcCalls).toEqual([]);
  });

  it("the verified current email claims (the database re-checks the bound proof)", async () => {
    const result = await ensurePortalProfileAndClientLinks({ userId: "u1", email: " Pat@Example.test ", verifiedEmail: "pat@example.test", studioId: "s1" });
    expect(rpcCalls).toEqual([
      { fn: "claim_client_account_invitation", args: { p_user_id: "u1", p_email: "pat@example.test", p_studio_id: "s1" } },
    ]);
    expect(result.linkedClientIds).toEqual(["claimed-client", "already-linked-client"]);
  });
});

describe("LAUNCH-SEC-1C-B group recap email claims", () => {
  it("unverified: no email lookup and no claim; the secure token path still works", async () => {
    tokenRecipient = { id: "r-token", recap_id: "recap-1", delivery_status: "sent" };
    const result = await claimGroupLessonRecapsForUser({
      userId: "u1",
      email: "pat@example.test",
      verifiedEmail: null,
      recapToken: "11111111-1111-4111-8111-111111111111",
    });
    expect(queries.some((q) => q.ops.some(([op]) => op === "ilike"))).toBe(false);
    expect(result.claimedCount).toBe(1);
  });

  it("verified: exact normalized equality; wildcard-like and different addresses are not claimed", async () => {
    recapRows = [
      { id: "r1", recap_id: "recap-1", delivery_status: "sent", guest_email: "PAT_X@example.test" },
      { id: "r2", recap_id: "recap-2", delivery_status: "sent", guest_email: "patyx@example.test" },
    ];
    const result = await claimGroupLessonRecapsForUser({ userId: "u1", email: "pat_x@example.test", verifiedEmail: "pat_x@example.test" });
    const ilike = queries.flatMap((q) => q.ops).find(([op]) => op === "ilike");
    expect(ilike?.[1]).toEqual(["guest_email", "pat\\_x@example.test"]);
    expect(result.claimedCount).toBe(1);
  });
});
