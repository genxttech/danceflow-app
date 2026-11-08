import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H1 regression: a platform admin whose VERIFIED session is not aal2 must not obtain cross-studio, studio-owner-equivalent authority through
 * `getCurrentStudioContext` / `getStudioContextForStudio`, whatever the support cookie says. Ordinary studio users are not subject to the check.
 */

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined) }),
}));

const USER = "a6000000-0000-4000-8000-000000000601";
const OTHER = "a6000000-0000-4000-8000-000000000602";
const SUPPORT_STUDIO = "b6000000-0000-4000-8000-000000000001";
const OWN_STUDIO = "b6000000-0000-4000-8000-000000000002";

let platformRole: string | null = "platform_admin";
let ownRoles: { studio_id: string; role: string }[] = [];
vi.mock("../platform", () => ({
  requireAuthenticatedUser: async () => ({ id: USER, email: "u@example.test", platform_role: platformRole }),
  isPlatformAdmin: async () => platformRole === "platform_admin",
}));

type ClaimsResult = { data: { claims: Record<string, unknown> } | null; error: { message: string } | null };
let claimsResult: ClaimsResult | "throw" = { data: null, error: null };
let getClaimsCalls = 0;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        getClaimsCalls += 1;
        if (claimsResult === "throw") throw new Error("boom");
        return claimsResult;
      },
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const terminal = async () => ({
        data:
          table === "user_studio_roles"
            ? ownRoles.map((r) => ({ ...r, active: true, created_at: "2026-01-01T00:00:00Z", studios: { id: r.studio_id, name: "Own Studio", slug: null, public_name: null } }))
            : [],
        error: null,
      });
      for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => terminal().then(res);
      return chain;
    },
  }),
}));
// The admin's latest support audit row: a support cookie is only a context while its nonce is on this row (see platform-support-audit.ts).
const NONCE = "ab".repeat(16);
const SID = "session-aaaa";
let latestSupportRow: { studio_id: string; route: string } | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "like", "order", "limit"]) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: latestSupportRow ? [latestSupportRow] : [], error: null }).then(res);
    return { from: () => q };
  },
}));

import { signSupportCookie } from "../platform-support-cookie";
import { getCurrentStudioContext, getStudioContextForStudio } from "../studio";

const NOW = () => Math.floor(Date.now() / 1000);
const aal2 = (over: Record<string, unknown> = {}) => ({
  data: { claims: { sub: USER, session_id: SID, exp: NOW() + 3000, aal: "aal2", amr: [{ method: "totp", timestamp: NOW() - 60 }], ...over } },
  error: null,
});
const aal1 = () => ({ data: { claims: { sub: USER, session_id: SID, exp: NOW() + 3000, aal: "aal1", amr: [{ method: "password", timestamp: NOW() - 60 }] } }, error: null });

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-for-hmac";
  redirects.length = 0;
  cookieJar.clear();
  cookieJar.set("platform_selected_studio_id", signSupportCookie(USER, SUPPORT_STUDIO, SID, NONCE)!);
  latestSupportRow = { studio_id: SUPPORT_STUDIO, route: `platform_support:enter:jti=${NONCE}` };
  platformRole = "platform_admin";
  ownRoles = [];
  claimsResult = aal2();
  getClaimsCalls = 0;
});

describe("getCurrentStudioContext - platform admin support context", () => {
  it("grants the support context to a verified aal2 platform admin", async () => {
    const ctx = await getCurrentStudioContext();
    expect(ctx).toMatchObject({ studioId: SUPPORT_STUDIO, studioRole: "platform_admin", isPlatformAdmin: true, userId: USER });
  });

  it("H1: refuses the support context to an aal1 platform admin and sends them to the step-up challenge", async () => {
    claimsResult = aal1();
    await expect(getCurrentStudioContext()).rejects.toThrow(/NEXT_REDIRECT:\/platform-mfa\/challenge\?stepup=1&reason=aal1/);
  });

  it("H1: an aal1 platform admin with an OWN studio role gets only that role, never the cookie studio", async () => {
    claimsResult = aal1();
    ownRoles = [{ studio_id: OWN_STUDIO, role: "studio_owner" }];
    const ctx = await getCurrentStudioContext();
    expect(ctx).toMatchObject({ studioId: OWN_STUDIO, studioRole: "studio_owner", isPlatformAdmin: false });
  });

  it.each([
    ["claims error", { data: null, error: { message: "x" } } as ClaimsResult],
    ["claims throw", "throw" as const],
    ["no claims", { data: null, error: null } as ClaimsResult],
    ["subject mismatch", aal2({ sub: OTHER })],
    ["expired token", aal2({ exp: NOW() - 5 })],
    ["aal2 without totp", aal2({ amr: [{ method: "password", timestamp: NOW() }] })],
  ])("H1 fail closed: %s is not a support context", async (_n, result) => {
    claimsResult = result;
    await expect(getCurrentStudioContext()).rejects.toThrow(/NEXT_REDIRECT:\/platform-mfa\/challenge/);
  });

  it("a stale-but-aal2 session still holds the context (aal2 tier, no recency window)", async () => {
    claimsResult = aal2({ amr: [{ method: "totp", timestamp: NOW() - 3 * 3600 }] });
    expect((await getCurrentStudioContext()).isPlatformAdmin).toBe(true);
  });

  it("a platform admin with no support cookie is still sent to pick a studio (unchanged)", async () => {
    cookieJar.delete("platform_selected_studio_id");
    await expect(getCurrentStudioContext()).rejects.toThrow(/NEXT_REDIRECT:\/platform\/studios/);
  });
});

describe("H1 support cookie is signed, user-bound and time-bounded", () => {
  it.each([
    ["a bare studio id set by hand", () => SUPPORT_STUDIO],
    ["a token signed for another admin", () => signSupportCookie(OTHER, SUPPORT_STUDIO, SID, NONCE)!],
    ["a token with a tampered studio", () => signSupportCookie(USER, SUPPORT_STUDIO, SID, NONCE)!.replace(SUPPORT_STUDIO, OWN_STUDIO)],
    ["an expired token", () => signSupportCookie(USER, SUPPORT_STUDIO, SID, NONCE, NOW() - 9 * 3600)!],
    ["garbage", () => "v1...."],
  ])("%s does not resolve a support studio even at aal2", async (_n, make) => {
    cookieJar.set("platform_selected_studio_id", make());
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });
});

describe("getStudioContextForStudio - platform admin", () => {
  it("grants any studio to a verified aal2 platform admin", async () => {
    expect(await getStudioContextForStudio(SUPPORT_STUDIO)).toMatchObject({ studioId: SUPPORT_STUDIO, isPlatformAdmin: true });
  });

  it("H1: an aal2 admin gets no authority over a studio that is not their entered (audited) support context", async () => {
    await expect(getStudioContextForStudio(OWN_STUDIO)).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("H1: an aal2 admin with no support cookie gets no authority over any studio by id alone", async () => {
    cookieJar.delete("platform_selected_studio_id");
    await expect(getStudioContextForStudio(SUPPORT_STUDIO)).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("H1: an aal2 admin keeps ordinary access to a studio they genuinely belong to, outside the support context", async () => {
    ownRoles = [{ studio_id: OWN_STUDIO, role: "studio_owner" }];
    expect(await getStudioContextForStudio(OWN_STUDIO)).toMatchObject({ studioId: OWN_STUDIO, studioRole: "studio_owner", isPlatformAdmin: false });
  });

  it("H1: an aal1 platform admin gets no authority over a studio they have no role in", async () => {
    claimsResult = aal1();
    await expect(getStudioContextForStudio(SUPPORT_STUDIO)).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("H1: an aal1 platform admin keeps authority over a studio they genuinely belong to, as an ordinary user", async () => {
    claimsResult = aal1();
    ownRoles = [{ studio_id: OWN_STUDIO, role: "studio_owner" }];
    expect(await getStudioContextForStudio(OWN_STUDIO)).toMatchObject({ studioId: OWN_STUDIO, studioRole: "studio_owner", isPlatformAdmin: false });
  });
});

describe("ordinary studio users are not subject to platform assurance", () => {
  it("never reads claims for a non-admin and ignores any support cookie", async () => {
    platformRole = null;
    ownRoles = [{ studio_id: OWN_STUDIO, role: "studio_owner" }];
    claimsResult = aal1();
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: OWN_STUDIO, studioRole: "studio_owner", isPlatformAdmin: false });
    expect(await getStudioContextForStudio(OWN_STUDIO)).toMatchObject({ studioId: OWN_STUDIO, isPlatformAdmin: false });
    expect(getClaimsCalls).toBe(0);
  });

  it("a non-admin cannot use another studio's id through getStudioContextForStudio", async () => {
    platformRole = null;
    ownRoles = [{ studio_id: OWN_STUDIO, role: "studio_owner" }];
    await expect(getStudioContextForStudio(SUPPORT_STUDIO)).rejects.toThrow(/NEXT_REDIRECT:\/app/);
  });
});
