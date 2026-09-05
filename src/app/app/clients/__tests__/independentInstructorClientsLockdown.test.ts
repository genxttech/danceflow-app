import { describe, expect, it, vi } from "vitest";

/**
 * FC-1B1: independent_instructor is not host-studio staff. This page
 * previously exposed the full studio client roster (name, email, phone,
 * lifecycle detail) with no role check at all -- see
 * independentInstructorScheduleLockdown.test.ts for the fuller FC-1B1
 * context and the same throwing-fake-Supabase verification technique used
 * here.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const err = new UnexpectedQueryError(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.order = self;
      chain.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) => Promise.reject(err).then(onFulfilled, onRejected);
      return chain;
    },
  }),
}));

const { default: ClientsPage } = await import("../page");

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

describe("clients/page.tsx -- FC-1B1", () => {
  it("independent_instructor is rejected before the client roster is queried", async () => {
    mockStudioContext("independent_instructor");

    const error = await runPage(
      ClientsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(digestUrl(error)).toBe("/app");
  });

  it("studio_owner is not blocked by the new gate", async () => {
    mockStudioContext("studio_owner");

    const error = await runPage(
      ClientsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });

  it.each(["studio_admin", "front_desk", "platform_admin"])(
    "%s is not blocked by the new gate",
    async (role) => {
      mockStudioContext(role);

      const error = await runPage(
        ClientsPage({ searchParams: Promise.resolve({}) }),
      );

      expect(error).toBeInstanceOf(UnexpectedQueryError);
    },
  );
});

// FC-1B5D: instructor is no longer a general CRM role -- canViewClients now
// excludes it (superseded by the relationship-scoped teaching/booking-search
// RPCs), so this page rejects instructor the same way it already rejected
// independent_instructor.
describe("clients/page.tsx -- FC-1B5D", () => {
  it("instructor is rejected before the client roster is queried", async () => {
    mockStudioContext("instructor");

    const error = await runPage(
      ClientsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(digestUrl(error)).toBe("/app");
  });
});
