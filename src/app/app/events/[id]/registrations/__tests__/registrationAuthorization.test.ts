import { describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D Phase A correction: requireEventWorkspaceFeature's
 * studio-workspace branch only checks a billing feature flag, not a role
 * -- any active studio role, including instructor, could reach the full
 * unscoped clients roster. The page now additionally requires
 * canManageEventRegistrations (reused as-is, no new role array) for
 * whichever identity (studio or organizer) resolved workspace access.
 * Uses the same throwing-fake-Supabase technique already established in
 * this codebase to prove the gate fires before any query.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const err = new UnexpectedQueryError(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.in = self;
      chain.order = self;
      chain.limit = self;
      chain.single = () => Promise.reject(err);
      chain.maybeSingle = () => Promise.reject(err);
      chain.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) => Promise.reject(err).then(onFulfilled, onRejected);
      return chain;
    },
  }),
}));

const requireEventWorkspaceFeatureMock = vi.fn();
vi.mock("@/lib/billing/access", () => ({
  requireEventWorkspaceFeature: (...args: unknown[]) =>
    requireEventWorkspaceFeatureMock(...args),
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

const { default: EventRegistrationsPage } = await import("../page");

function mockWorkspaceAccess(overrides: Record<string, unknown>) {
  requireEventWorkspaceFeatureMock.mockResolvedValue({
    eventId: "event-1",
    studioId: "studio-1",
    organizerId: null,
    studioRole: null,
    organizerRole: null,
    isPlatformAdmin: false,
    accountType: "studio",
    ...overrides,
  });
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole: overrides.studioRole ?? null,
    isPlatformAdmin: overrides.isPlatformAdmin ?? false,
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

async function runPage() {
  return run(
    EventRegistrationsPage({
      params: Promise.resolve({ id: "event-1" }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe("event registrations page authorization -- FC-1B5D correction", () => {
  it("instructor (studio tier) is rejected before the clients roster query", async () => {
    mockWorkspaceAccess({ accountType: "studio", studioRole: "instructor" });
    const error = await runPage();
    expect(error).not.toBeInstanceOf(UnexpectedQueryError);
    expect(digestUrl(error)).toBe("/app/events");
  });

  it.each(["studio_owner", "studio_admin"])(
    "%s (studio tier) reaches the real query",
    async (role) => {
      mockWorkspaceAccess({ accountType: "studio", studioRole: role });
      const error = await runPage();
      expect(error).toBeInstanceOf(UnexpectedQueryError);
    },
  );

  it("front_desk (studio tier) is rejected -- canManageEventRegistrations does not include it today", async () => {
    mockWorkspaceAccess({ accountType: "studio", studioRole: "front_desk" });
    const error = await runPage();
    expect(error).not.toBeInstanceOf(UnexpectedQueryError);
    expect(digestUrl(error)).toBe("/app/events");
  });

  it.each(["organizer_owner", "organizer_admin", "organizer_staff"])(
    "%s (organizer tier) reaches the real query -- organizer behavior preserved",
    async (role) => {
      mockWorkspaceAccess({ accountType: "organizer", organizerRole: role });
      const error = await runPage();
      expect(error).toBeInstanceOf(UnexpectedQueryError);
    },
  );

  it("platform_admin bypasses the check entirely", async () => {
    mockWorkspaceAccess({ accountType: "studio", studioRole: null, isPlatformAdmin: true });
    const error = await runPage();
    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });
});
