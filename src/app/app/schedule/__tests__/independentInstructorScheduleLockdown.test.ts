import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B1: Independent Instructor Staff-Side Visibility Lockdown.
 *
 * FC-1B found that independent_instructor -- a role representing a facility
 * rental relationship, not host-studio employment -- could reach several
 * staff-side schedule pages by direct URL with no server-side role check at
 * all (schedule/new, schedule/[id], schedule/[id]/edit,
 * schedule/[id]/attendance, schedule/calendar), exposing the full studio's
 * client roster, appointment notes, lesson-recap coaching content, attendee
 * PII, and payment detail. The role check that DID exist on some of these
 * pages only hid buttons, never gated the underlying data read.
 *
 * This suite drives each real page component (not a stand-in) far enough to
 * prove two things per page:
 *  1. independent_instructor is rejected server-side BEFORE any studio data
 *     is queried -- proven by a fake Supabase client whose every table
 *     (other than the raw user_studio_roles lookup two of these pages use
 *     for auth) throws a distinguishing "was this table ever queried"
 *     error; if the gate is missing or placed too late, that error surfaces
 *     instead of the expected redirect, failing the test for the right
 *     reason.
 *  2. a legitimate staff role is NOT rejected by the new gate -- proven by
 *     asserting execution proceeds PAST the gate (reaching real business
 *     logic, which then hits the same throwing fake) rather than being
 *     redirected to the gate's own destination.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  notFound: () => {
    const error = new Error("NEXT_NOT_FOUND");
    (error as unknown as { digest: string }).digest = "NEXT_NOT_FOUND";
    throw error;
  },
}));

const getCurrentStudioContextMock = vi.fn();

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) =>
    getCurrentStudioContextMock(...args),
}));

let fakeSupabase: unknown;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeSupabase,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeSupabase,
}));

const { default: NewAppointmentPage } = await import("../new/page");
const { default: AppointmentDetailPage } = await import("../[id]/page");
const { default: AppointmentEditPage } = await import("../[id]/edit/page");
const { default: AppointmentAttendancePage } = await import(
  "../[id]/attendance/page"
);
const { default: SchedulePage } = await import("../calendar/page");

type Row = Record<string, unknown>;

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

function makeThrowingChain(table: string) {
  const err = new UnexpectedQueryError(table);
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.order = self;
  chain.limit = self;
  chain.in = self;
  chain.gte = self;
  chain.lte = self;
  chain.single = () => Promise.reject(err);
  chain.maybeSingle = () => Promise.reject(err);
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.reject(err).then(onFulfilled, onRejected);
  return chain;
}

function makeResolvingChain(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.order = self;
  chain.limit = self;
  chain.in = self;
  chain.single = async () =>
    rows.length
      ? { data: rows[0], error: null }
      : { data: null, error: { message: "Row not found" } };
  chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
  return chain;
}

/**
 * Used by schedule/[id]/page.tsx and schedule/[id]/attendance/page.tsx,
 * which resolve role/studio via a raw user_studio_roles query rather than
 * getCurrentStudioContext(). Every OTHER table throws, so any code that
 * reaches past the gate immediately surfaces UNEXPECTED_QUERY.
 */
function createFakeSupabaseWithRawRole(roleRow: Row | null) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
    from(table: string) {
      if (table === "user_studio_roles") {
        return makeResolvingChain(roleRow ? [roleRow] : []);
      }
      return makeThrowingChain(table);
    },
  };
}

/**
 * Used by pages that resolve role/studio via getCurrentStudioContext()
 * (mocked separately below, module-wide) -- here every table throws, so any
 * code reaching a real query past the gate surfaces UNEXPECTED_QUERY.
 */
function createFakeSupabaseAllThrowing() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
    from(table: string) {
      return makeThrowingChain(table);
    },
  };
}

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

beforeEach(() => {
  getCurrentStudioContextMock.mockReset();
});

describe("schedule/new/page.tsx -- FC-1B1", () => {
  it("independent_instructor is rejected before any studio data is queried", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabaseAllThrowing();

    const error = await runPage(
      NewAppointmentPage({ searchParams: Promise.resolve({}) }),
    );

    expect(digestUrl(error)).toBe("/app");
  });

  it("studio_owner is not blocked by the new gate", async () => {
    mockStudioContext("studio_owner");
    fakeSupabase = createFakeSupabaseAllThrowing();

    const error = await runPage(
      NewAppointmentPage({ searchParams: Promise.resolve({}) }),
    );

    // Reaching real business logic (which then hits the throwing fake) --
    // NOT the gate's own "/app" redirect -- proves staff passed the gate.
    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });
});

describe("schedule/[id]/page.tsx -- FC-1B1", () => {
  it("independent_instructor is rejected before any appointment data is queried", async () => {
    fakeSupabase = createFakeSupabaseWithRawRole({
      studio_id: "studio-1",
      role: "independent_instructor",
    });

    const error = await runPage(
      AppointmentDetailPage({
        params: Promise.resolve({ id: "appt-1" }),
        searchParams: Promise.resolve({}),
      } as never),
    );

    expect(digestUrl(error)).toBe("/app");
  });

  it("studio_owner is not blocked by the new gate", async () => {
    fakeSupabase = createFakeSupabaseWithRawRole({
      studio_id: "studio-1",
      role: "studio_owner",
    });

    const error = await runPage(
      AppointmentDetailPage({
        params: Promise.resolve({ id: "appt-1" }),
        searchParams: Promise.resolve({}),
      } as never),
    );

    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });
});

describe("schedule/[id]/edit/page.tsx -- FC-1B1", () => {
  it("independent_instructor is rejected before any appointment data is queried", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabaseAllThrowing();

    const error = await runPage(
      AppointmentEditPage({ params: Promise.resolve({ id: "appt-1" }) }),
    );

    expect(digestUrl(error)).toBe("/app");
  });

  it("studio_owner is not blocked by the new gate", async () => {
    mockStudioContext("studio_owner");
    fakeSupabase = createFakeSupabaseAllThrowing();

    const error = await runPage(
      AppointmentEditPage({ params: Promise.resolve({ id: "appt-1" }) }),
    );

    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });
});

describe("schedule/[id]/attendance/page.tsx -- FC-1B1", () => {
  it("independent_instructor is rejected before any attendee/recap data is queried", async () => {
    fakeSupabase = createFakeSupabaseWithRawRole({
      studio_id: "studio-1",
      role: "independent_instructor",
    });

    const error = await runPage(
      AppointmentAttendancePage({
        params: Promise.resolve({ id: "appt-1" }),
        searchParams: Promise.resolve({}),
      } as never),
    );

    expect(digestUrl(error)).toBe("/app");
  });

  it("studio_owner is not blocked by the new gate", async () => {
    fakeSupabase = createFakeSupabaseWithRawRole({
      studio_id: "studio-1",
      role: "studio_owner",
    });

    const error = await runPage(
      AppointmentAttendancePage({
        params: Promise.resolve({ id: "appt-1" }),
        searchParams: Promise.resolve({}),
      } as never),
    );

    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });
});

describe("schedule/calendar/page.tsx -- FC-1B1", () => {
  it("independent_instructor is rejected before any calendar data is queried", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabaseAllThrowing();

    const error = await runPage(
      SchedulePage({ searchParams: Promise.resolve({}) } as never),
    );

    expect(digestUrl(error)).toBe("/app");
  });

  it("studio_owner is not blocked by the new gate", async () => {
    mockStudioContext("studio_owner");
    fakeSupabase = createFakeSupabaseAllThrowing();

    const error = await runPage(
      SchedulePage({ searchParams: Promise.resolve({}) } as never),
    );

    expect(error).toBeInstanceOf(UnexpectedQueryError);
  });
});
