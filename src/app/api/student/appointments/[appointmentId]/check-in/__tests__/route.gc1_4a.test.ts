import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GC-1.4A: student class self-check-in route coverage.
 *
 * Covers the two things this round's corrections were specifically about:
 * (1) the POST class branch must invoke the RPC through
 *     createStudentApiUserScopedClient, never createAdminClient -- this is
 *     what makes auth.uid() resolve correctly inside
 *     check_in_own_class_attendance; (2) the route's `eligible` field
 *     reflects a current booked enrollment, not GC-1.2's historical rule.
 * Lesson GET/POST paths are asserted unchanged (regression).
 */

const STUDIO_ID = "studio-1";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "user-1";
const CLASS_APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const LESSON_APPOINTMENT_ID = "22222222-2222-4222-8222-222222222222";

const getStudentApiUserMock = vi.fn();
const createStudentApiUserScopedClientMock = vi.fn();

vi.mock("@/lib/auth/studentApiAuth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/studentApiAuth")>(
    "@/lib/auth/studentApiAuth",
  );
  return {
    ...actual,
    getStudentApiUser: (...args: unknown[]) => getStudentApiUserMock(...args),
    createStudentApiUserScopedClient: (...args: unknown[]) =>
      createStudentApiUserScopedClientMock(...args),
  };
});

const sendMobilePushToUserMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: (...args: unknown[]) => sendMobilePushToUserMock(...args),
}));

const rateLimitMock = vi.fn().mockReturnValue({ allowed: true });
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...args: unknown[]) => args.join(":"),
  rateLimitedJson: () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
}));

type Fixture = {
  appointment: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  relationship: Record<string, unknown> | null;
  attendeeBooked: boolean;
  attendanceRecord: Record<string, unknown> | null;
};

function makeAdminClient(fixture: Fixture) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;

      if (table === "appointments") {
        chain.maybeSingle = () => Promise.resolve({ data: fixture.appointment, error: null });
      } else if (table === "clients") {
        chain.maybeSingle = () => Promise.resolve({ data: fixture.client, error: null });
      } else if (table === "client_account_links") {
        chain.limit = self;
        chain.maybeSingle = () => Promise.resolve({ data: fixture.relationship, error: null });
      } else if (table === "appointment_attendees") {
        chain.maybeSingle = () =>
          Promise.resolve({ data: fixture.attendeeBooked ? { id: "attendee-1" } : null, error: null });
      } else if (table === "attendance_records") {
        chain.maybeSingle = () => Promise.resolve({ data: fixture.attendanceRecord, error: null });
      } else if (table === "student_lesson_checkins") {
        chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      }

      return chain;
    },
  };
}

function jsonRequest(body: unknown) {
  return new Request("https://example.test/api/student/appointments/x/check-in", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(query = "") {
  return new Request(`https://example.test/api/student/appointments/x/check-in${query}`, {
    headers: { authorization: "Bearer test-token" },
  });
}

beforeEach(() => {
  getStudentApiUserMock.mockReset();
  createStudentApiUserScopedClientMock.mockReset();
  sendMobilePushToUserMock.mockClear();
  getStudentApiUserMock.mockResolvedValue({ id: USER_ID });
});

describe("GET -- class eligibility reflects current booked enrollment", () => {
  it("a booked, in-window attendee is eligible and not yet checked in", async () => {
    vi.resetModules();
    const fixture: Fixture = {
      appointment: {
        id: CLASS_APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: null,
        instructor_id: "instructor-1",
        title: "Beginner Salsa",
        appointment_type: "group_class",
        starts_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        ends_at: new Date(Date.now() + 70 * 60_000).toISOString(),
        status: "scheduled",
        clients: null,
        instructors: { id: "instructor-1", first_name: "I", last_name: "N", profile_user_id: null },
        studios: { name: "Studio", public_name: null },
      },
      client: { id: CLIENT_ID, first_name: "S", last_name: "T" },
      relationship: { id: "link-1" },
      attendeeBooked: true,
      attendanceRecord: null,
    };

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));
    const { GET } = await import("../route");

    const response = await GET(getRequest(`?clientId=${CLIENT_ID}`), {
      params: Promise.resolve({ appointmentId: CLASS_APPOINTMENT_ID }),
    });
    const body = await response!.json();

    expect(body.eligible).toBe(true);
    expect(body.checkedIn).toBe(false);
  });

  it("a cancelled (not currently booked) attendee is not eligible, regardless of GC-1.2's historical rule", async () => {
    vi.resetModules();
    const fixture: Fixture = {
      appointment: {
        id: CLASS_APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: null,
        instructor_id: "instructor-1",
        title: "Beginner Salsa",
        appointment_type: "group_class",
        starts_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        ends_at: new Date(Date.now() + 70 * 60_000).toISOString(),
        status: "scheduled",
        clients: null,
        instructors: null,
        studios: null,
      },
      client: { id: CLIENT_ID, first_name: "S", last_name: "T" },
      relationship: { id: "link-1" },
      attendeeBooked: false, // cancelled -- no booked row
      attendanceRecord: null,
    };

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));
    const { GET } = await import("../route");

    const response = await GET(getRequest(`?clientId=${CLIENT_ID}`), {
      params: Promise.resolve({ appointmentId: CLASS_APPOINTMENT_ID }),
    });
    const body = await response!.json();

    expect(body.eligible).toBe(false);
  });
});

describe("POST -- class check-in invokes the RPC through the user-scoped client, never the admin client", () => {
  it("calls check_in_own_class_attendance via createStudentApiUserScopedClient", async () => {
    vi.resetModules();
    const fixture: Fixture = {
      appointment: {
        id: CLASS_APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: null,
        instructor_id: "instructor-1",
        title: "Beginner Salsa",
        appointment_type: "group_class",
        starts_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        ends_at: new Date(Date.now() + 65 * 60_000).toISOString(),
        status: "scheduled",
        clients: null,
        instructors: { id: "instructor-1", first_name: "I", last_name: "N", profile_user_id: "instructor-user-1" },
        studios: { name: "Studio", public_name: null },
      },
      client: { id: CLIENT_ID, first_name: "S", last_name: "T" },
      relationship: { id: "link-1" },
      attendeeBooked: true,
      attendanceRecord: { checked_in_at: new Date().toISOString() },
    };

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const rpcMock = vi.fn().mockResolvedValue({ error: null });
    const adminRpcMock = vi.fn();
    createStudentApiUserScopedClientMock.mockResolvedValue({ rpc: rpcMock });

    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ clientId: CLIENT_ID }), {
      params: Promise.resolve({ appointmentId: CLASS_APPOINTMENT_ID }),
    });
    const body = await response!.json();

    expect(rpcMock).toHaveBeenCalledWith("check_in_own_class_attendance", {
      p_appointment_id: CLASS_APPOINTMENT_ID,
      p_client_id: CLIENT_ID,
    });
    // The admin client (makeAdminClient) has no .rpc method at all -- if the
    // route ever called .rpc on it instead of the scoped client, this would
    // throw rather than silently succeed, which is exactly the regression
    // this test guards against.
    expect(adminRpcMock).not.toHaveBeenCalled();
    expect(body.checkedIn).toBe(true);
    expect(body.eligible).toBe(true);
  });

  it("propagates an RPC rejection (e.g. not currently booked) as a 409, not a silent success", async () => {
    vi.resetModules();
    const fixture: Fixture = {
      appointment: {
        id: CLASS_APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: null,
        instructor_id: null,
        title: "Beginner Salsa",
        appointment_type: "group_class",
        starts_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        ends_at: new Date(Date.now() + 65 * 60_000).toISOString(),
        status: "scheduled",
        clients: null,
        instructors: null,
        studios: null,
      },
      client: { id: CLIENT_ID, first_name: "S", last_name: "T" },
      relationship: { id: "link-1" },
      attendeeBooked: true,
      attendanceRecord: null,
    };

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));
    createStudentApiUserScopedClientMock.mockResolvedValue({
      rpc: vi.fn().mockResolvedValue({ error: { message: "Not currently enrolled in this class." } }),
    });

    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ clientId: CLIENT_ID }), {
      params: Promise.resolve({ appointmentId: CLASS_APPOINTMENT_ID }),
    });

    expect(response!.status).toBe(409);
  });
});

describe("lesson check-in -- regression, unchanged", () => {
  it("GET a lesson still reads student_lesson_checkins, eligible always true", async () => {
    vi.resetModules();
    const fixture: Fixture = {
      appointment: {
        id: LESSON_APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: "instructor-1",
        title: "Private Lesson",
        appointment_type: "private_lesson",
        starts_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        ends_at: new Date(Date.now() + 70 * 60_000).toISOString(),
        status: "scheduled",
        clients: { id: CLIENT_ID, first_name: "S", last_name: "T" },
        instructors: null,
        studios: null,
      },
      client: null,
      relationship: { id: "link-1" },
      attendeeBooked: false,
      attendanceRecord: null,
    };

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));
    const { GET } = await import("../route");

    const response = await GET(getRequest(), { params: Promise.resolve({ appointmentId: LESSON_APPOINTMENT_ID }) });
    const body = await response!.json();

    expect(body.eligible).toBe(true);
    expect(body.checkedIn).toBe(false);
  });
});
