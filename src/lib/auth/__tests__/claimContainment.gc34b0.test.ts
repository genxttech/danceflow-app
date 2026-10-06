import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GC-3.4B-0 (S4): an invitation-claim failure never blocks authentication.
 *
 * claim_client_account_invitation fails closed (raises) when, for example,
 * one verified email holds two open 'self' invitations in one studio. That
 * error used to propagate out of ensurePortalProfileAndClientLinks and fail
 * the callback (callback-sync-failed) and password login (raw database text
 * shown to the user). Now it is contained: a bounded code is logged, nothing
 * is reported as claimed, existing links are untouched, and sign-in proceeds.
 *
 * Uses the REAL portal-linking module end to end; only the Supabase clients
 * are faked.
 */

const RAW_DB_ERROR =
  'duplicate key value violates unique constraint "client_account_links_one_primary_per_user_studio"';

const h = vi.hoisted(() => ({
  claimError: null as null | { code: string; message: string },
  claimData: [] as Array<{ client_id: string }>,
  existingLinks: [] as Array<Record<string, unknown>>,
  verifiedEmail: "dancer@example.com" as string | null,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

function chain(result: () => { data: unknown; error: null }) {
  const builder: Record<string, unknown> = {};
  for (const op of ["select", "eq", "neq", "ilike", "in", "order", "limit"]) {
    builder[op] = () => builder;
  }
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.single = async () => ({ data: null, error: null });
  builder.upsert = async () => ({ error: null });
  builder.update = () => builder;
  builder.then = (resolve: (value: unknown) => unknown) => resolve(result());
  return builder;
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) =>
      chain(() => ({ data: table === "client_account_links" ? h.existingLinks : [], error: null })),
    rpc: async (fn: string, args: unknown) => {
      h.rpcCalls.push({ fn, args });
      if (fn === "claim_client_account_invitation") {
        return h.claimError ? { data: null, error: h.claimError } : { data: h.claimData, error: null };
      }
      return { data: null, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id } }, error: null }),
        signOut: async () => ({ error: null }),
      },
    },
  }),
}));

vi.mock("@/lib/student-identity/account-security", () => ({
  reactivateDanceFlowAccount: async () => undefined,
}));

vi.mock("@/lib/auth/studio", () => ({
  getAccessibleStudioRolesForUser: async () => [],
  isOrganizerRole: () => false,
}));

function sessionClient() {
  return {
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: "user-1", email: "dancer@example.com", user_metadata: {} } },
        error: null,
      }),
      verifyOtp: async () => ({ error: null }),
      exchangeCodeForSession: async () => ({ error: null }),
      getUser: async () => ({
        data: { user: { id: "user-1", email: "dancer@example.com", user_metadata: {} } },
        error: null,
      }),
      getSession: async () => ({ data: { session: { access_token: "t" } } }),
    },
    from: () => chain(() => ({ data: [], error: null })),
    rpc: async (fn: string) => {
      h.rpcCalls.push({ fn, args: null });
      if (fn === "my_verified_email") return { data: h.verifiedEmail, error: null };
      if (fn === "record_email_proof_web") return { data: "bound", error: null };
      return { data: 0, error: null };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => sessionClient() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: async () => "key",
  rateLimitErrorMessage: () => "limited",
}));

vi.mock("@/lib/public/attributionServer", () => ({
  readSignupAttributionMetadata: async () => ({}),
}));

const { ensurePortalProfileAndClientLinks } = await import("../portal-linking");
const { loginAction } = await import("@/app/(auth)/actions");
const { GET } = await import("@/app/(auth)/callback/route");

const CLASS_PATH = "/studios/studio-a/classes/11111111-1111-4111-8111-111111111111";
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.claimError = { code: "23505", message: RAW_DB_ERROR };
  h.claimData = [];
  h.existingLinks = [];
  h.verifiedEmail = "dancer@example.com";
  h.rpcCalls.length = 0;
  consoleError?.mockRestore();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function loggedText() {
  return JSON.stringify(consoleError.mock.calls);
}

describe("ensurePortalProfileAndClientLinks claim containment", () => {
  it("a failing claim resolves with claimFailed, no claimed ids, and existing links intact", async () => {
    h.existingLinks = [{ client_id: "already-linked" }];

    const result = await ensurePortalProfileAndClientLinks({
      userId: "user-1",
      email: "dancer@example.com",
      verifiedEmail: "dancer@example.com",
    });

    expect(result).toEqual({ linkedClientIds: ["already-linked"], claimFailed: true });
  });

  it("logs a bounded code only: no raw message, email or ids", async () => {
    await ensurePortalProfileAndClientLinks({
      userId: "user-1",
      email: "dancer@example.com",
      verifiedEmail: "dancer@example.com",
    });

    expect(consoleError).toHaveBeenCalledWith("portal_invitation_claim_failed", { code: "23505" });
    expect(loggedText()).not.toMatch(/duplicate key|dancer@example\.com|user-1/);
  });

  it("a successful claim still links and reports claimFailed false", async () => {
    h.claimError = null;
    h.claimData = [{ client_id: "claimed-client" }];

    const result = await ensurePortalProfileAndClientLinks({
      userId: "user-1",
      email: "dancer@example.com",
      verifiedEmail: "dancer@example.com",
    });

    expect(result).toEqual({ linkedClientIds: ["claimed-client"], claimFailed: false });
  });

  it("a retry after a contained failure calls the claim again (no stuck state)", async () => {
    const params = { userId: "user-1", email: "dancer@example.com", verifiedEmail: "dancer@example.com" };
    await ensurePortalProfileAndClientLinks(params);
    h.claimError = null;
    h.claimData = [{ client_id: "claimed-client" }];
    const retry = await ensurePortalProfileAndClientLinks(params);

    expect(h.rpcCalls.filter((call) => call.fn === "claim_client_account_invitation")).toHaveLength(2);
    expect(retry.linkedClientIds).toEqual(["claimed-client"]);
  });

  it("an unverified session still never calls the claim (LAUNCH-SEC-1C-B unchanged)", async () => {
    const result = await ensurePortalProfileAndClientLinks({
      userId: "user-1",
      email: "dancer@example.com",
      verifiedEmail: null,
    });

    expect(h.rpcCalls.some((call) => call.fn === "claim_client_account_invitation")).toBe(false);
    expect(result.claimFailed).toBe(false);
  });
});

describe("password login survives a claim failure", () => {
  it("completes sign-in and continues to next, exposing no database text", async () => {
    const data = new FormData();
    data.set("email", "dancer@example.com");
    data.set("password", "correct horse battery");
    data.set("next", CLASS_PATH);

    let outcome: unknown;
    try {
      outcome = await loginAction(data);
    } catch (error) {
      outcome = error;
    }

    expect(outcome).toMatchObject({ message: "NEXT_REDIRECT", url: CLASS_PATH });
    expect(h.rpcCalls.some((call) => call.fn === "claim_client_account_invitation")).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("duplicate key");
  });
});

describe("auth callback survives a claim failure", () => {
  it.each([
    ["token_hash (mailbox) callback", "token_hash=th&type=magiclink"],
    ["PKCE code callback", "code=abc"],
  ])("%s completes and continues to next", async (_label, query) => {
    const response = await GET(
      new NextRequest(`http://localhost:3000/callback?${query}&next=${encodeURIComponent(CLASS_PATH)}`),
    );
    const location = new URL(response.headers.get("location") ?? "", "http://localhost:3000");

    expect(location.pathname).toBe(CLASS_PATH);
    expect(location.searchParams.get("error")).toBeNull();
    expect(h.rpcCalls.some((call) => call.fn === "claim_client_account_invitation")).toBe(true);
  });

  it("a repeated callback retries the claim and still completes", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await GET(new NextRequest(`http://localhost:3000/callback?code=abc&next=${encodeURIComponent(CLASS_PATH)}`));
      expect(new URL(response.headers.get("location") ?? "").pathname).toBe(CLASS_PATH);
    }
    expect(h.rpcCalls.filter((call) => call.fn === "claim_client_account_invitation")).toHaveLength(2);
  });
});
