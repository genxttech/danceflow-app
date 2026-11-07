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
const SID = "sess-h1";
vi.mock("@/lib/auth/platform-assurance", () => ({
  stepUpChallengeUrl: (reason: string, returnTo: string) => `/platform-mfa/challenge?stepup=1&reason=${reason}&next=${encodeURIComponent(returnTo)}`,
  getVerifiedAal2SessionId: async () => (stepUpMode === "aal1" ? null : SID),
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
type Row = { route: string; studio_id: string; user_id: string; accessed_at?: number };
const auditRows: Row[] = [];
let seq = 0;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      const q: Record<string, unknown> = {
        insert: async (row: Row) => {
          order.push(`audit:${t}`);
          if (!auditOk) return { error: { code: "XX000" } };
          auditRows.push({ ...row, accessed_at: ++seq });
          return { error: null };
        },
        select: () => q,
        eq: (c: keyof Row, v: unknown) => (filters.push((r) => r[c] === v), q),
        like: (c: keyof Row, p: string) => (filters.push((r) => String(r[c]).startsWith(p.replace(/%$/, ""))), q),
        order: () => q,
        limit: () => q,
      };
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: auditRows.filter((r) => filters.every((f) => f(r))).sort((x, y) => (y.accessed_at ?? 0) - (x.accessed_at ?? 0)).slice(0, 1), error: null }).then(res);
      return q;
    },
  }),
}));
vi.mock("@/lib/student-identity/lifecycle", () => ({ linkExistingClientAccount: vi.fn() }));
vi.mock("@/lib/auth/verifiedIdentity", () => ({ getVerifiedEmailForUser: vi.fn(), verifiedEmailMatches: vi.fn() }));

import { newSupportNonce, signSupportCookie, verifySupportCookie } from "@/lib/auth/platform-support-cookie";
import { clearStudioContextAction, enterStudioContextAction } from "../actions";

/** Establish a genuine current support context for ADMIN in studio, as the entry action would: audit row + matching signed cookie. */
function seedContext(studioId: string): string {
  const nonce = newSupportNonce();
  auditRows.push({ studio_id: studioId, user_id: ADMIN, route: `platform_support:enter:jti=${nonce}`, accessed_at: ++seq });
  const token = signSupportCookie(ADMIN, studioId, SID, nonce)!;
  jar.set("platform_selected_studio_id", token);
  return token;
}

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
  seq = 0;
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
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ studio_id: S1, user_id: ADMIN });
    expect(auditRows[0].route).toMatch(/^platform_support:enter:jti=[0-9a-f]{32}$/);
    expect(cookieSets[0].value.split(".")[3]).toBe(auditRows[0].route.split("jti=")[1]);
    expect(cookieSets).toHaveLength(1);
    expect(verifySupportCookie(cookieSets[0].value, ADMIN, SID)).toBe(S1);
    expect(cookieSets[0].opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 });
  });

  it("audits a switch to a different studio with the previous studio recorded", async () => {
    seedContext(S2);
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    expect(auditRows[1].route).toMatch(new RegExp(`^platform_support:switch:from=${S2}:jti=[0-9a-f]{32}$`));
  });

  it("re-entering the same studio is an entry, not a switch", async () => {
    seedContext(S1);
    await expect(enterStudioContextAction(form(S1))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    expect(auditRows[1].route).toMatch(/^platform_support:enter:jti=/);
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
  expect(auditRows[0].route).toMatch(/^platform_support:enter:jti=/);
});

describe("clearStudioContextAction", () => {
  it("audits the exit of the current context and clears the cookie", async () => {
    seedContext(S1);
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(cookieDeletes).toEqual(["platform_selected_studio_id"]);
    expect(auditRows[1]).toMatchObject({ studio_id: S1, user_id: ADMIN, route: "platform_support:exit" });
  });

  it("lets an admin leave at AAL1 (exit never depends on step-up): cookie cleared; an AAL1 session can hold no context, so no exit row is needed", async () => {
    stepUpMode = "aal1"; // exit must NOT depend on step-up
    seedContext(S1);
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(cookieDeletes).toEqual(["platform_selected_studio_id"]);
    expect(auditRows.filter((r) => r.route === "platform_support:exit")).toHaveLength(0);
  });

  it("clears the cookie even when the exit audit write fails", async () => {
    seedContext(S1);
    auditOk = false;
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(cookieDeletes).toEqual(["platform_selected_studio_id"]);
  });

  it("writes no audit row when there is no active support context", async () => {
    await expect(clearStudioContextAction()).rejects.toThrow(/NEXT_REDIRECT:\/platform$/);
    expect(auditRows).toHaveLength(0);
  });
});
