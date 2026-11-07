import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H1 follow-up: replay of a previously valid support-context cookie. Real enter/exit actions and the real resolver run against a stateful in-memory
 * audit table. After an exit or a switch, an old (still authentic, still unexpired) cookie must NOT restore studio authority without a new audited entry.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (n: string) => void jar.delete(n),
  }),
}));

const ADMIN = "a6000000-0000-4000-8000-000000000901";
const OTHER_ADMIN = "a6000000-0000-4000-8000-000000000902";
const S1 = "b6000000-0000-4000-8000-000000000031";
const S2 = "b6000000-0000-4000-8000-000000000032";

let currentUser = ADMIN;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => ({ id: currentUser }),
  requireAuthenticatedUser: async () => ({ id: currentUser, email: "a@example.test", platform_role: "platform_admin" }),
  isPlatformAdmin: async () => true,
}));

const NOW = () => Math.floor(Date.now() / 1000);
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => ({
        data: { claims: { sub: currentUser, exp: NOW() + 3000, aal: "aal2", amr: [{ method: "totp", timestamp: NOW() - 60 }] } },
        error: null,
      }),
    },
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: table === "studios" ? { id: S1 } : null, error: null });
      c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return c;
    },
  }),
}));

type LogRow = { studio_id: string; user_id: string; route: string; accessed_at: number };
let logs: LogRow[] = [];
let tick = 0;
let readFails = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const filters: ((r: LogRow) => boolean)[] = [];
      let limit = Infinity;
      let newestFirst = false;
      const q: Record<string, unknown> = {
        insert: async (row: Omit<LogRow, "accessed_at">) => {
          logs.push({ ...row, accessed_at: ++tick });
          return { error: null };
        },
        select: () => q,
        eq: (col: keyof LogRow, v: unknown) => (filters.push((r) => r[col] === v), q),
        like: (col: keyof LogRow, pat: string) => (filters.push((r) => String(r[col]).startsWith(pat.replace(/%$/, ""))), q),
        order: (_c: string, o: { ascending: boolean }) => ((newestFirst = !o.ascending), q),
        limit: (n: number) => ((limit = n), q),
      };
      const run = async () => {
        if (readFails) return { data: null, error: { code: "XX000" } };
        const rows = logs.filter((r) => filters.every((f) => f(r))).sort((a, b) => (newestFirst ? b.accessed_at - a.accessed_at : a.accessed_at - b.accessed_at));
        return { data: rows.slice(0, limit), error: null };
      };
      q.maybeSingle = async () => {
        const { data, error } = await run();
        return { data: data?.[0] ?? null, error };
      };
      q.then = (res: (v: unknown) => unknown) => run().then(res);
      return q;
    },
  }),
}));
vi.mock("@/lib/student-identity/lifecycle", () => ({ linkExistingClientAccount: vi.fn() }));
vi.mock("@/lib/auth/verifiedIdentity", () => ({ getVerifiedEmailForUser: vi.fn(), verifiedEmailMatches: vi.fn() }));

import { clearStudioContextAction, enterStudioContextAction } from "@/app/platform/actions";
import { signSupportCookie } from "../platform-support-cookie";
import { getCurrentStudioContext } from "../studio";

const COOKIE = "platform_selected_studio_id";
const form = (studioId: string) => {
  const f = new FormData();
  f.set("studioId", studioId);
  return f;
};
async function enter(studioId: string): Promise<string> {
  await expect(enterStudioContextAction(form(studioId))).rejects.toThrow("NEXT_REDIRECT:/app");
  return jar.get(COOKIE)!;
}
async function exit() {
  await expect(clearStudioContextAction()).rejects.toThrow("NEXT_REDIRECT:/platform");
}
const supportRows = () => logs.filter((r) => r.route.startsWith("platform_support:"));

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-for-hmac";
  jar.clear();
  logs = [];
  tick = 0;
  readFails = false;
  currentUser = ADMIN;
});

describe("support cookie replay after exit", () => {
  it("baseline: a freshly entered context resolves to the studio", async () => {
    await enter(S1);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S1, isPlatformAdmin: true, studioRole: "platform_admin" });
  });

  it("H1: a captured cookie re-introduced after exit does NOT restore authority, and writes no audit row", async () => {
    const captured = await enter(S1);
    await exit();
    expect(jar.has(COOKIE)).toBe(false);
    const rowsAfterExit = supportRows().length;

    jar.set(COOKIE, captured); // attacker/replay: same admin, AAL2 still active, token still authentic and unexpired
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
    expect(supportRows()).toHaveLength(rowsAfterExit);
  });

  it("H1: a new audited entry restores authority; the OLD cookie stays dead", async () => {
    const first = await enter(S1);
    await exit();
    const second = await enter(S1);
    expect(second).not.toBe(first);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S1 });

    jar.set(COOKIE, first);
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
    jar.set(COOKIE, second);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S1 });
  });
});

describe("support cookie replay after a studio switch", () => {
  it("H1: switching S1 -> S2 kills the S1 cookie; only the S2 cookie is current", async () => {
    const c1 = await enter(S1);
    const c2 = await enter(S2);
    expect(supportRows().map((r) => r.route.split(":jti=")[0])).toEqual(["platform_support:enter", `platform_support:switch:from=${S1}`]);

    jar.set(COOKIE, c1);
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
    jar.set(COOKIE, c2);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S2 });
  });

  it("H1: switching back to a previous studio cannot revive the old cookie for it", async () => {
    const old = await enter(S1);
    await enter(S2);
    const back = await enter(S1);
    jar.set(COOKIE, old);
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
    jar.set(COOKIE, back);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S1 });
  });
});

describe("support context currency is per admin and fails closed", () => {
  it("another admin's activity does not revoke this admin's context", async () => {
    const mine = await enter(S1);
    currentUser = OTHER_ADMIN;
    await enter(S2);
    await exit();
    currentUser = ADMIN;
    jar.set(COOKIE, mine);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S1 });
  });

  it("an authentic cookie whose nonce is not on the latest audit row is not a support context (self-minted token)", async () => {
    await enter(S1);
    jar.set(COOKIE, signSupportCookie(ADMIN, S1)!); // valid MAC, never audited
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("a pre-fix v1 cookie (no nonce) is not a support context", async () => {
    await enter(S1);
    jar.set(COOKIE, `v1.${S1}.${NOW()}.${"0".repeat(64)}`);
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("an unreadable audit trail is not a support context", async () => {
    await enter(S1);
    readFails = true;
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("an authentic cookie whose entry row does not exist is not a support context", async () => {
    await enter(S1);
    logs = [];
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });
});
