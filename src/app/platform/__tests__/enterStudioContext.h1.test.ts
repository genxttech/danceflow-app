import { beforeEach, describe, expect, it, vi } from "vitest";

/** H1: entering / switching / leaving the platform-admin support context - assurance, audit, fail-closed behaviour. */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ADMIN = "a6000000-0000-4000-8000-000000000701";
const S1 = "b6000000-0000-4000-8000-000000000011";
const S2 = "b6000000-0000-4000-8000-000000000012";

const jar = new Map<string, string>();
const cookieSets: { name: string; value: string; opts: Record<string, unknown> }[] = [];
const cookieDeletes: string[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      cookieSets.push({ name, value, opts });
      jar.set(name, value);
    },
    delete: (n: string) => {
      cookieDeletes.push(n);
      jar.delete(n);
    },
  }),
}));

const order: string[] = [];
let stepUpMode: "ok" | "aal1" = "ok";
vi.mock("@/lib/auth/platform-assurance", () => ({
  requirePlatformStepUp: async (tier: string) => {
    order.push(`stepup:${tier}`);
    if (stepUpMode === "aal1") throw new Error("NEXT_REDIRECT:/platform-mfa/challenge?stepup=1&reason=aal1&next=%2Fplatform%2Fstudios");
    return { id: ADMIN };
  },
}));
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    order.push("role");
    return { id: ADMIN };
  },
}));

let studioExists = true;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: studioExists ? { id: S1 } : null, error: null });
      return c;
    },
  }),
}));

let auditOk = true;
const auditRows: { route: string; studio_id: string; user_id: string }[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => ({
      insert: async (row: { route: string; studio_id: string; user_id: string }) => {
        order.push(`audit:${t}`);
        if (!auditOk) return { error: { code: "XX000" } };
        auditRows.push(row);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/student-identity/lifecycle", () => ({ linkExistingClientAccount: vi.fn() }));
vi.mock("@/lib/auth/verifiedIdentity", () => ({ getVerifiedEmailForUser: vi.fn(), verifiedEmailMatches: vi.fn() }));

import { signSupportCookie, verifySupportCookie } from "@/lib/auth/platform-support-cookie";
import { clearStudioContextAction, enterStudioContextAction } from "../actions";

const form = (studioId: string) => {
  const f = new FormData();
  f.set("studioId", studioId);
  return f;
};

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-for-hmac";
  jar.clear();
  cookieSets.length = 0;
  cookieDeletes.length = 0;
  order.length = 0;
  auditRows.length = 0;
  stepUpMode = "ok";
  studioExists = true;
  auditOk = true;
});

describe("enterStudioContextAction", () => {
  it("H1: an aal1 admin is redirected to the challenge; no cookie is set and nothing is audited", async () => {
    stepUpMode = "aal1";
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/platform-mfa\/challenge\?stepup=1&reason=aal1/);
    expect(cookieSets).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("requires the aal2 tier, checked before any other work", async () => {
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    expect(order[0]).toBe("stepup:aal2");
  });

  it("audits entry BEFORE setting a time-bounded httpOnly cookie", async () => {
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    expect(auditRows).toEqual([{ studio_id: S1, user_id: ADMIN, route: "platform_support:enter" }]);
    expect(cookieSets).toHaveLength(1);
    expect(verifySupportCookie(cookieSets[0].value, ADMIN)).toBe(S1);
    expect(cookieSets[0].opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 });
  });

  it("audits a switch to a different studio with the previous studio recorded", async () => {
    jar.set("platform_selected_studio_id", signSupportCookie(ADMIN, S2)!);
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    expect(auditRows[0].route).toBe(`platform_support:switch:from=${S2}`);
  });

  it("re-entering the same studio is an entry, not a switch", async () => {
    jar.set("platform_selected_studio_id", signSupportCookie(ADMIN, S1)!);
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    expect(auditRows[0].route).toBe("platform_support:enter");
  });

  it("fails closed: when the audit write fails no support cookie is set", async () => {
    auditOk = false;
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/platform\/studios/);
    expect(cookieSets).toHaveLength(0);
  });

  it("an unknown studio sets no cookie and writes no audit row", async () => {
    studioExists = false;
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/platform\/studios/);
    expect(cookieSets).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("a malformed studio id is rejected before any database or cookie work", async () => {
    await expect(enterStudioContextAction(form("not-a-uuid"))).rejects.toThrow(/NEXT_REDIRECT:\/platform\/studios/);
    expect(cookieSets).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});

it("a hand-set cookie is not trusted as the previous studio (entry, not switch)", async () => {
  jar.set("platform_selected_studio_id", S2);
  await expect(enterStudioContextAction(form(S1))).rejects.toThrow("NEXT_REDIRECT:/app");
  expect(auditRows[0].route).toBe("platform_support:enter");
});

describe("clearStudioContextAction", () => {
  it("lets an admin leave a studio at any assurance level, audits the exit and clears the cookie", async () => {
    stepUpMode = "aal1"; // exit must NOT depend on step-up
    jar.set("platform_selected_studio_id", signSupportCookie(ADMIN, S1)!);
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(cookieDeletes).toEqual(["platform_selected_studio_id"]);
    expect(auditRows).toEqual([{ studio_id: S1, user_id: ADMIN, route: "platform_support:exit" }]);
  });

  it("clears the cookie even when the exit audit write fails", async () => {
    auditOk = false;
    jar.set("platform_selected_studio_id", signSupportCookie(ADMIN, S1)!);
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(cookieDeletes).toEqual(["platform_selected_studio_id"]);
  });

  it("writes no audit row when there is no active support context", async () => {
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(auditRows).toHaveLength(0);
  });
});
