import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H1: enterStudioContextAction with the REAL platform-assurance gate and a mocked claims read. The sibling test mocks the gate; this one proves the
 * gate itself is wired in: aal1 rejected, verified aal2 accepted, and transient/invalid assurance reads never grant privileged access.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ADMIN = "a6000000-0000-4000-8000-000000000801";
const OTHER = "a6000000-0000-4000-8000-000000000802";
const S1 = "b6000000-0000-4000-8000-000000000021";

const jar = new Map<string, string>();
const cookieSets: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined),
    set: (name: string, value: string) => {
      cookieSets.push({ name, value });
      jar.set(name, value);
    },
    delete: (n: string) => void jar.delete(n),
  }),
}));

vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: ADMIN }) }));

type ClaimsResult = { data: { claims: Record<string, unknown> } | null; error: { message: string } | null };
let claimsResult: ClaimsResult | "throw" = { data: null, error: null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        if (claimsResult === "throw") throw new Error("transient");
        return claimsResult;
      },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: { id: S1 }, error: null });
      return c;
    },
  }),
}));

const auditRows: { route: string }[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: async (row: { route: string }) => {
        auditRows.push(row);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/student-identity/lifecycle", () => ({ linkExistingClientAccount: vi.fn() }));
vi.mock("@/lib/auth/verifiedIdentity", () => ({ getVerifiedEmailForUser: vi.fn(), verifiedEmailMatches: vi.fn() }));

import { verifySupportCookie } from "@/lib/auth/platform-support-cookie";
import { enterStudioContextAction } from "../actions";

const NOW = () => Math.floor(Date.now() / 1000);
const aal2 = (over: Record<string, unknown> = {}): ClaimsResult => ({
  data: { claims: { sub: ADMIN, exp: NOW() + 3000, aal: "aal2", amr: [{ method: "totp", timestamp: NOW() - 60 }], ...over } },
  error: null,
});
const form = () => {
  const f = new FormData();
  f.set("studioId", S1);
  return f;
};

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-for-hmac";
  jar.clear();
  cookieSets.length = 0;
  auditRows.length = 0;
  claimsResult = aal2();
});

describe("enterStudioContextAction - real assurance gate", () => {
  it("rejects an aal1 session: redirects to the challenge, no cookie, no audit row", async () => {
    claimsResult = { data: { claims: { sub: ADMIN, exp: NOW() + 3000, aal: "aal1", amr: [{ method: "password", timestamp: NOW() - 60 }] } }, error: null };
    await expect(enterStudioContextAction(form())).rejects.toThrow("NEXT_REDIRECT:/platform-mfa/challenge?stepup=1&reason=aal1&next=%2Fplatform%2Fstudios");
    expect(cookieSets).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("accepts a verified aal2 totp session for an authorized admin: audit row then a cookie bound to that admin", async () => {
    await expect(enterStudioContextAction(form())).rejects.toThrow("NEXT_REDIRECT:/app");
    expect(auditRows).toEqual([{ studio_id: S1, user_id: ADMIN, route: "platform_support:enter" }]);
    expect(cookieSets).toHaveLength(1);
    expect(verifySupportCookie(cookieSets[0].value, ADMIN)).toBe(S1);
    expect(verifySupportCookie(cookieSets[0].value, OTHER)).toBeNull();
  });

  it.each([
    ["claims read error", { data: null, error: { message: "upstream 503" } } as ClaimsResult],
    ["claims read throws", "throw" as const],
    ["no claims returned", { data: null, error: null } as ClaimsResult],
    ["token subject is a different user", aal2({ sub: OTHER })],
    ["expired token", aal2({ exp: NOW() - 5 })],
    ["aal2 claim without a totp method", aal2({ amr: [{ method: "password", timestamp: NOW() }] })],
  ])("fails closed on %s: no cookie, no audit row", async (_name, result) => {
    claimsResult = result;
    await expect(enterStudioContextAction(form())).rejects.toThrow(/NEXT_REDIRECT:\/platform-mfa\/challenge/);
    expect(cookieSets).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});
