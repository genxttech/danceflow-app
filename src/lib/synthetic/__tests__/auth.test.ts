import { describe, expect, it, vi, beforeEach } from "vitest";
import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { SyntheticConfig } from "@/lib/synthetic/types";

/**
 * signInSyntheticRole is the single most safety-critical function in the
 * harness: every suite's every write is gated on it having correctly
 * resolved (and verified) the synthetic tenant before returning. These
 * tests exercise the fail-closed property directly -- a session that does
 * NOT resolve to the configured synthetic studio must never be returned
 * successfully, regardless of why (wrong tenant, no role row, RLS denies
 * the lookup, wrong client_account_links status, etc).
 */

type QueryState = {
  table: string;
  filters: Record<string, unknown>;
};

let signInResult: { data: { user: { id: string } | null; session: object | null }; error: { message: string } | null };
let queryResponses: Record<string, unknown>;

function makeFakeSupabaseJsClient() {
  return {
    auth: {
      signInWithPassword: vi.fn(async () => signInResult),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from(table: string) {
      const state: QueryState = { table, filters: {} };
      const builder = {
        select: () => builder,
        eq(col: string, val: unknown) {
          state.filters[col] = val;
          return builder;
        },
        async maybeSingle() {
          const key = `${state.table}:${JSON.stringify(state.filters)}`;
          return { data: (queryResponses as Record<string, unknown>)[key] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

let fakeClient: ReturnType<typeof makeFakeSupabaseJsClient>;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fakeClient,
}));

const { signInSyntheticRole } = await import("@/lib/synthetic/auth");

const CONFIG: SyntheticConfig = {
  studioId: "studio-syn",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key",
  identities: {
    owner: { email: "owner@synthetic.invalid", password: "x" },
    student: { email: "student@synthetic.invalid", password: "x", clientId: "client-syn" },
  },
  eventFixture: null,
};

beforeEach(() => {
  fakeClient = makeFakeSupabaseJsClient();
  signInResult = { data: { user: { id: "user-1" }, session: {} }, error: null };
  queryResponses = {};
});

describe("signInSyntheticRole", () => {
  it("throws when no identity is configured for the requested role", async () => {
    await expect(signInSyntheticRole("organizer", CONFIG)).rejects.toThrow(SyntheticSafetyError);
  });

  it("throws when Supabase sign-in itself fails", async () => {
    signInResult = { data: { user: null, session: null }, error: { message: "invalid credentials" } };
    await expect(signInSyntheticRole("owner", CONFIG)).rejects.toThrow(/Synthetic sign-in failed/);
  });

  it("resolves and returns a session when user_studio_roles matches the configured synthetic studio (owner)", async () => {
    queryResponses[`user_studio_roles:${JSON.stringify({ user_id: "user-1", studio_id: "studio-syn", active: true })}`] = {
      studio_id: "studio-syn",
      active: true,
    };

    const session = await signInSyntheticRole("owner", CONFIG);
    expect(session.studioId).toBe("studio-syn");
    expect(session.userId).toBe("user-1");
    expect(session.role).toBe("owner");
  });

  it("fails closed when the owner's user_studio_roles row does not exist for the synthetic studio", async () => {
    // queryResponses left empty -- maybeSingle() returns null, simulating
    // no active role row for this user at the configured studio.
    await expect(signInSyntheticRole("owner", CONFIG)).rejects.toThrow(SyntheticSafetyError);
    await expect(signInSyntheticRole("owner", CONFIG)).rejects.toMatchObject({ code: "TENANT_MISMATCH" });
  });

  it("resolves via client_account_links for the student role when status is linked", async () => {
    queryResponses[
      `client_account_links:${JSON.stringify({ user_id: "user-1", studio_id: "studio-syn", status: "linked" })}`
    ] = { studio_id: "studio-syn", client_id: "client-syn", status: "linked" };

    const session = await signInSyntheticRole("student", CONFIG);
    expect(session.studioId).toBe("studio-syn");
    expect(session.role).toBe("student");
  });

  it("fails closed for the student role when there is no linked client_account_links row", async () => {
    await expect(signInSyntheticRole("student", CONFIG)).rejects.toThrow(SyntheticSafetyError);
  });

  it("never trusts a studio_id resolved for a DIFFERENT studio than configured -- the query itself is always scoped to config.studioId", async () => {
    // Simulate a misconfigured or malicious response containing a
    // different studio_id under a key that wouldn't match our scoped
    // query filters at all -- proving the resolver can't accidentally
    // pick this up because it never queries without an explicit
    // studio_id = configured-synthetic-studio filter.
    queryResponses[
      `user_studio_roles:${JSON.stringify({ user_id: "user-1", studio_id: "some-other-studio", active: true })}`
    ] = { studio_id: "some-other-studio", active: true };

    await expect(signInSyntheticRole("owner", CONFIG)).rejects.toThrow(SyntheticSafetyError);
  });
});
