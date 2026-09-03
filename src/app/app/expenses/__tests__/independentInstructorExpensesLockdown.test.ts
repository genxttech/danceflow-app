import { describe, expect, it, vi } from "vitest";

/**
 * FC-1B1: independent_instructor is not host-studio staff. This surface
 * previously listed independent_instructor alongside studio_owner/
 * studio_admin for BOTH reading and managing (create/void) the host
 * studio's general expense ledger -- unrelated to their own floor-rental
 * fees, which are already correctly handled by the portal
 * floor-space/my-rentals surface (unchanged by this fix).
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getCurrentStudioContextMock = vi.fn();

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) =>
    getCurrentStudioContextMock(...args),
}));

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

function throwingSupabase() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
    from(table: string) {
      const err = new UnexpectedQueryError(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.neq = self;
      chain.in = self;
      chain.gte = self;
      chain.lte = self;
      chain.order = self;
      chain.limit = self;
      chain.insert = self;
      chain.single = () => Promise.reject(err);
      chain.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) => Promise.reject(err).then(onFulfilled, onRejected);
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => throwingSupabase(),
}));

const { default: ExpensesPage } = await import("../page");
const { createExpenseAction, voidExpenseAction } = await import("../actions");

function mockStudioContext(studioRole: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin: false,
    userId: "user-1",
    email: "user@example.test",
  });
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

async function runPage(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

function formDataFor(fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("expenses/page.tsx -- FC-1B1", () => {
  it("independent_instructor cannot read the general studio expense ledger", async () => {
    mockStudioContext("independent_instructor");

    const error = await runPage(ExpensesPage());

    expect(digestUrl(error)).toBe("/app");
  });

  it.each(["studio_owner", "studio_admin"])(
    "%s is not blocked by the new gate",
    async (role) => {
      mockStudioContext(role);

      const error = await runPage(ExpensesPage());

      expect(error).toBeInstanceOf(UnexpectedQueryError);
    },
  );
});

describe("createExpenseAction -- FC-1B1", () => {
  it("independent_instructor cannot create a general studio expense", async () => {
    mockStudioContext("independent_instructor");

    await expect(createExpenseAction(formDataFor())).rejects.toThrow(
      "You do not have permission to manage expenses.",
    );
  });

  it("studio_owner is not blocked by the new gate", async () => {
    mockStudioContext("studio_owner");

    // Reaching real business logic (which then hits the throwing fake) --
    // not the permission error -- proves staff passed the guard.
    await expect(createExpenseAction(formDataFor())).rejects.not.toThrow(
      "You do not have permission to manage expenses.",
    );
  });
});

describe("voidExpenseAction -- FC-1B1", () => {
  it("independent_instructor cannot void a general studio expense", async () => {
    mockStudioContext("independent_instructor");

    await expect(voidExpenseAction(formDataFor())).rejects.toThrow(
      "You do not have permission to void expenses.",
    );
  });

  it("studio_owner is not blocked by the new gate", async () => {
    mockStudioContext("studio_owner");

    await expect(voidExpenseAction(formDataFor())).rejects.not.toThrow(
      "You do not have permission to void expenses.",
    );
  });
});
