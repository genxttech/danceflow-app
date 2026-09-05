import { describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D Phase A correction (independent-review blocking finding #2):
 * this page computed `canManage = canManageSettings(...)` but never used
 * it to gate the raw clients read (`outbound_deliveries` ->
 * `automation_actions` -> `clients` name/email join) -- only downstream UI
 * affordances (`disabled={!canManage}`) depended on it. Any active studio
 * role, including instructor, could reach the read. This suite proves
 * authorization now runs before any query, using the same
 * throwing-fake-Supabase technique already established in this codebase
 * (independentInstructorClientsLockdown.test.ts).
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const err = new UnexpectedQueryError(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.in = self;
      chain.order = self;
      chain.limit = self;
      chain.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) => Promise.reject(err).then(onFulfilled, onRejected);
      return chain;
    },
  }),
}));

const { default: AutomationDraftsPage } = await import("../page");

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

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

describe("automations/drafts/page.tsx authorization -- FC-1B5D correction", () => {
  it.each(["instructor", "independent_instructor", "front_desk"])(
    "%s is rejected before the raw clients read (canManageSettings excludes this role)",
    async (role) => {
      mockStudioContext(role);
      const error = await run(
        AutomationDraftsPage({ searchParams: Promise.resolve({}) }),
      );
      expect(error).not.toBeInstanceOf(UnexpectedQueryError);
      expect(digestUrl(error)).toBe("/app");
    },
  );

  it.each(["studio_owner", "studio_admin", "platform_admin"])(
    "%s (canManageSettings) reaches the real query, unaffected by the correction",
    async (role) => {
      mockStudioContext(role);
      const error = await run(
        AutomationDraftsPage({ searchParams: Promise.resolve({}) }),
      );
      expect(error).toBeInstanceOf(UnexpectedQueryError);
    },
  );
});
