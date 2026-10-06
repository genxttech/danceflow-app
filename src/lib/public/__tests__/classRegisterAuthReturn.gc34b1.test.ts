import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GC-3.4B-1: the class identity route is carried through the EXISTING auth
 * flows as a validated local `next` (no new redirect mechanism): password
 * login, magic-link / mailbox callback, first-proof binding, and the
 * verify-email path. External or malformed `next` values are dropped.
 */

const REGISTER = "/studios/salsa-house/classes/11111111-1111-4111-8111-111111111111/register";
const REGISTER_WITH_DANCER = `${REGISTER}?dancer=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;

const h = vi.hoisted(() => ({
  proof: "bound" as string,
  rpcCalls: [] as string[],
}));

function chain() {
  const builder: Record<string, unknown> = {};
  for (const op of ["select", "eq", "neq", "ilike", "in", "order", "limit"]) builder[op] = () => builder;
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.upsert = async () => ({ error: null });
  builder.update = () => builder;
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
  return builder;
}

function sessionClient() {
  return {
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: "user-1", email: "dancer@example.com", user_metadata: {} } },
        error: null,
      }),
      verifyOtp: async () => ({ error: null }),
      exchangeCodeForSession: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: "user-1", email: "dancer@example.com", user_metadata: {} } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: "t" } } }),
    },
    from: () => chain(),
    rpc: async (fn: string) => {
      h.rpcCalls.push(fn);
      if (fn === "my_verified_email") return { data: "dancer@example.com", error: null };
      if (fn === "record_email_proof_web") return { data: h.proof, error: null };
      return { data: [], error: null };
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => sessionClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => chain(),
    rpc: async () => ({ data: [], error: null }),
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id } }, error: null }), signOut: async () => ({ error: null }) } },
  }),
}));
vi.mock("@/lib/student-identity/account-security", () => ({ reactivateDanceFlowAccount: async () => undefined }));
vi.mock("@/lib/auth/studio", () => ({ getAccessibleStudioRolesForUser: async () => [], isOrganizerRole: () => false }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Map() }));
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
vi.mock("@/lib/public/attributionServer", () => ({ readSignupAttributionMetadata: async () => ({}) }));

const { loginAction } = await import("@/app/(auth)/actions");
const { GET, resolveEmailBindingDestination } = await import("@/app/(auth)/callback/route");
const { normalizeLocalRedirectPath } = await import("@/lib/security/redirects");
const { buildEmailVerificationPath } = await import("@/lib/auth/verifiedEmail");

beforeEach(() => {
  h.proof = "bound";
  h.rpcCalls.length = 0;
});

async function passwordLogin(next: string) {
  const data = new FormData();
  data.set("email", "dancer@example.com");
  data.set("password", "correct horse battery");
  data.set("next", next);
  try {
    await loginAction(data);
  } catch (error) {
    return (error as { url?: string }).url;
  }
  return undefined;
}

async function callback(query: string) {
  const response = await GET(new NextRequest(`http://localhost:3000/callback?${query}`));
  const location = new URL(response.headers.get("location") ?? "", "http://localhost:3000");
  return `${location.pathname}${location.search}`;
}

describe("GC-3.4B-1 auth return to the class identity step", () => {
  it("the register path (with or without ?dancer) is a valid local next; external and malformed values are not", () => {
    expect(normalizeLocalRedirectPath(REGISTER)).toBe(REGISTER);
    expect(normalizeLocalRedirectPath(REGISTER_WITH_DANCER)).toBe(REGISTER_WITH_DANCER);
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "studios/x"]) {
      expect(normalizeLocalRedirectPath(bad)).toBe("");
    }
  });

  it("3. password login returns to the same register route", async () => {
    expect(await passwordLogin(REGISTER)).toBe(REGISTER);
  });

  it("2. password login drops a malicious external next", async () => {
    const url = await passwordLogin("https://evil.example/phish");
    expect(url).toBeDefined();
    expect(url).not.toContain("evil.example");
    expect(url?.startsWith("/")).toBe(true);
  });

  it("magic-link / mailbox callback (token_hash and PKCE) returns to the same register route", async () => {
    expect(await callback(`token_hash=th&type=magiclink&next=${encodeURIComponent(REGISTER)}`)).toBe(REGISTER);
    expect(await callback(`code=abc&next=${encodeURIComponent(REGISTER)}`)).toBe(REGISTER);
  });

  it("the callback drops an external next", async () => {
    expect(await callback(`code=abc&next=${encodeURIComponent("https://evil.example/phish")}`)).not.toContain("evil.example");
  });

  it("a first mailbox proof goes through binding and keeps the register route as next", async () => {
    h.proof = "binding_required";
    const destination = await callback(`token_hash=th&type=magiclink&next=${encodeURIComponent(REGISTER)}`);
    expect(destination).toBe(`/account/verify-email?next=${encodeURIComponent(REGISTER)}`);
    expect(resolveEmailBindingDestination(REGISTER, false)).toBe(destination);
  });

  it("the verify-email hand-off from /register preserves the exact route", () => {
    expect(buildEmailVerificationPath(REGISTER)).toBe(`/account/verify-email?next=${encodeURIComponent(REGISTER)}`);
  });
});
