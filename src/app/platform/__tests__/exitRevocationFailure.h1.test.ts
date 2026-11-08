import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H1: when the revoking exit row cannot be written, Exit must not be represented as a completed secure exit. A copied cookie stays valid server-side until
 * the exit row exists, so a failed revocation keeps the (still live) context and says so, instead of deleting the cookie and redirecting as if it were over.
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
let currentSession = "sess-1";
let claimsFail = false;
let currentAal: "aal1" | "aal2" = "aal2";
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => ({ id: currentUser }),
  requireAuthenticatedUser: async () => ({ id: currentUser, email: "a@example.test", platform_role: "platform_admin" }),
  isPlatformAdmin: async () => true,
}));

const NOW = () => Math.floor(Date.now() / 1000);
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => (claimsFail ? { data: null, error: { message: "transient" } } : {
        data: { claims: { sub: currentUser, session_id: currentSession, exp: NOW() + 3000, aal: currentAal, amr: [{ method: currentAal === "aal2" ? "totp" : "password", timestamp: NOW() - 60 }] } },
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
let failExitWrites = 0;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const filters: ((r: LogRow) => boolean)[] = [];
      let limit = Infinity;
      let newestFirst = false;
      const q: Record<string, unknown> = {
        insert: async (row: Omit<LogRow, "accessed_at">) => {
          if (row.route === "platform_support:exit" && failExitWrites > 0) {
            failExitWrites -= 1;
            return { error: { code: "XX000" } };
          }
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
import { getCurrentStudioContext } from "@/lib/auth/studio";

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
  failExitWrites = 0;
  currentUser = ADMIN;
  currentSession = "sess-1";
  currentAal = "aal2";
});

async function exitRaw() {
  return clearStudioContextAction().then(
    () => "returned",
    (e: Error) => e.message,
  );
}

describe("Exit when the revoking write fails", () => {
  it("H1: both exit writes failing is NOT reported as a completed exit, and the context is not silently abandoned", async () => {
    const captured = await enter(S1);
    failExitWrites = 2;
    const outcome = await exitRaw();
    // A completed exit redirects to /platform. A failed revocation must not.
    expect(outcome).not.toBe("NEXT_REDIRECT:/platform");
    expect(outcome).toBe("NEXT_REDIRECT:/platform/studios?exit=failed");
    // The context is still live server-side (no revoking row), and the browser still holds it, so state and message agree.
    expect(supportRows().filter((r) => r.route === "platform_support:exit")).toHaveLength(0);
    expect(jar.get(COOKIE)).toBe(captured);
    expect(await getCurrentStudioContext()).toMatchObject({ studioId: S1 });
  });

  it("H1: after a reported failure the admin can retry and a completed exit really revokes the copy", async () => {
    const captured = await enter(S1);
    failExitWrites = 2;
    await exitRaw();
    expect(await exitRaw()).toBe("NEXT_REDIRECT:/platform");
    expect(supportRows().filter((r) => r.route === "platform_support:exit")).toHaveLength(1);
    expect(jar.has(COOKIE)).toBe(false);
    jar.set(COOKIE, captured);
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("a single transient write failure is absorbed by the retry: normal completed exit, copy revoked", async () => {
    const captured = await enter(S1);
    failExitWrites = 1;
    expect(await exitRaw()).toBe("NEXT_REDIRECT:/platform");
    jar.set(COOKIE, captured);
    await expect(getCurrentStudioContext()).rejects.toThrow("NEXT_REDIRECT:/platform/studios");
  });

  it("an unauthenticated or garbage cookie whose exit write fails grants nothing, so Exit still clears it and completes", async () => {
    await enter(S1);
    jar.set(COOKIE, "not-a-real-cookie");
    failExitWrites = 2;
    expect(await exitRaw()).toBe("NEXT_REDIRECT:/platform");
    expect(jar.has(COOKIE)).toBe(false);
  });

  it("a claims failure plus both writes failing is reported as failed too (the hint path cannot prove revocation)", async () => {
    const captured = await enter(S1);
    claimsFail = true;
    failExitWrites = 2;
    expect(await exitRaw()).toBe("NEXT_REDIRECT:/platform/studios?exit=failed");
    expect(jar.get(COOKIE)).toBe(captured);
  });
});
