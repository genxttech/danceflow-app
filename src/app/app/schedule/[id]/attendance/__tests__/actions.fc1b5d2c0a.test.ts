import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D2c-0A: action-level authorization tests for the four attendance
 * mutation Server Actions (check-in / attended / no-show / reset). Before
 * this change these relied only on "does the caller have any active
 * user_studio_roles row at this studio" -- no relationship to the specific
 * appointment at all. Each action now calls requireAttendanceAccess (this
 * file's helper, not exported), which reuses the same
 * requireAppointmentRelationshipAccess primitive D2A/D2C already established
 * for `appointments` itself. That primitive is unit-tested in isolation at
 * src/lib/auth/__tests__/appointmentAccess.fc1b5d2.test.ts; here it is
 * mocked so each action's own behavior (call the check, react correctly to
 * allow/deny, never reach the attendance_records mutation on deny) can be
 * proven with call-tracking, matching this codebase's established pattern
 * (see appointmentRelationshipScoping.fc1b5d2.test.ts).
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

const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) =>
    requireAppointmentRelationshipAccessMock(...args),
}));

const fromCalls: string[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.insert = () => Promise.resolve({ data: null, error: null });
  chain.update = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return chain;
}

function createFakeSupabase() {
  return {
    from(table: string) {
      fromCalls.push(table);
      return benignChain();
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(),
}));

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-1";
const CLIENT_ID = "client-1";

function studioContext(studioRole: string, isPlatformAdmin = false) {
  return { studioId: STUDIO_ID, studioRole, isPlatformAdmin, userId: USER_ID, email: "x@y.com" };
}

function allow(scope: "broad" | "own-instructor" | "own-floor-rental") {
  return {
    ok: true,
    scope,
    appointment: {
      id: APPOINTMENT_ID,
      studio_id: STUDIO_ID,
      appointment_type: "group_class",
      title: "Beginner Salsa",
    },
  };
}

const deny = { ok: false, reason: "You can only manage your own assigned appointments or your own floor space rental bookings." };

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

function redirectUrl(error: unknown): string {
  const digest = (error as { digest?: string }).digest ?? "";
  return digest.split(";")[2] ?? "";
}

const actions = await import("../actions");

beforeEach(() => {
  fromCalls.length = 0;
  getCurrentStudioContextMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
});

const CASES: Array<{
  name: string;
  action: (formData: FormData) => Promise<void>;
  successParam: string;
  errorParam: string;
}> = [
  {
    name: "checkInClassAttendeeAction",
    action: actions.checkInClassAttendeeAction,
    successParam: "checked_in",
    errorParam: "checkin_failed",
  },
  {
    name: "markClassAttendedAction",
    action: actions.markClassAttendedAction,
    successParam: "attended",
    errorParam: "attended_failed",
  },
  {
    name: "markClassNoShowAction",
    action: actions.markClassNoShowAction,
    successParam: "no_show",
    errorParam: "no_show_failed",
  },
  {
    name: "resetClassAttendanceAction",
    action: actions.resetClassAttendanceAction,
    successParam: "reset",
    errorParam: "reset_failed",
  },
];

describe.each(CASES)("$name -- FC-1B5D2c-0A", ({ action, successParam, errorParam }) => {
  it("broad role (studio_owner) is allowed and writes attendance_records", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("studio_owner"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(allow("broad"));

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
    expect(fromCalls).toContain("attendance_records");
  });

  it("front_desk (broad role) is allowed -- retains operational attendance authority for any class", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("front_desk"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(allow("broad"));

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
    expect(fromCalls).toContain("attendance_records");
  });

  it("platform_admin is allowed", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("platform_admin", true));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(allow("broad"));

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
  });

  it("assigned instructor (own-instructor scope) is allowed", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(allow("own-instructor"));

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
    expect(fromCalls).toContain("attendance_records");
  });

  it("unassigned instructor (colleague's class) is denied and never reaches attendance_records", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(deny);

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("attendance_records");
  });

  it("cross-studio appointment (relationship primitive returns not-found) is denied", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "Appointment not found.",
    });

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("attendance_records");
  });

  it("own-floor-rental scope alone is denied -- a floor-rental relationship never grants attendance authority, even for the caller's own booking", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("independent_instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(allow("own-floor-rental"));

    const error = await run(
      action(formDataFor({ appointmentId: APPOINTMENT_ID, clientId: CLIENT_ID })),
    );

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("attendance_records");
  });
});
