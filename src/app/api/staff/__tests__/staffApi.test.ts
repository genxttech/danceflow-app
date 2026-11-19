import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staffCapabilitiesForRole } from "@/lib/auth/staffCapabilities";
import { localDayUtcRange, resolveStudioTimeZone } from "@/lib/staff/instructorToday";
import {
  APPT_COLLEAGUE_CLASS,
  APPT_COLLEAGUE_LESSON,
  APPT_NEXT_DAY,
  APPT_OTHER_STUDIO,
  APPT_OWN_CANCELLED,
  APPT_OWN_CLASS,
  APPT_OWN_LESSON,
  APPT_RENTAL,
  STUDIO_A,
  STUDIO_B,
  STUDIO_ORGANIZER,
  STUDIO_PAUSED,
  TOKENS,
  appointment_attendees,
  createAdminWorldClient,
  createWorldClient,
  type AuthOutcome,
} from "./staffApiWorld";

const harness = vi.hoisted(() => ({
  failures: {} as { table?: string; rpc?: string },
  authFailure: null as unknown,
  cookieClientCalls: 0,
  redirects: [] as string[],
  createdWith: [] as { key: string; authorization?: string }[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, key: string, options: { global: { headers: { Authorization: string } } }) => {
    const authorization = options.global.headers.Authorization;
    harness.createdWith.push({ key, authorization });
    return createWorldClient(authorization.replace(/^Bearer /, ""), {
      failures: harness.failures,
      authFailure: harness.authFailure as AuthOutcome,
    });
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminWorldClient(),
}));

// Any use of the cookie client on this surface is a defect, so it fails loudly and is counted.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    harness.cookieClientCalls += 1;
    throw new Error("The staff API must never build a cookie client");
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("The staff API must never read cookies");
  },
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    harness.redirects.push(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const { GET: getMe } = await import("../me/route");
const { GET: getToday } = await import("../workspaces/[studioId]/today/route");
const { GET: getAppointment } = await import("../workspaces/[studioId]/appointments/[appointmentId]/route");

const DAY = "2026-11-09";

function request(path: string, token?: string, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

function today(token: string | undefined, studioId: string, query = `?date=${DAY}`) {
  return getToday(request(`/api/staff/workspaces/${studioId}/today${query}`, token), {
    params: Promise.resolve({ studioId }),
  });
}

function appointment(token: string | undefined, studioId: string, appointmentId: string) {
  return getAppointment(request(`/api/staff/workspaces/${studioId}/appointments/${appointmentId}`, token), {
    params: Promise.resolve({ studioId, appointmentId }),
  });
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json();
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.failures = {};
  harness.authFailure = null;
  harness.cookieClientCalls = 0;
  harness.redirects = [];
  harness.createdWith = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Holds for every test in this file: no redirect and no cookie path, on success or failure.
  expect(harness.redirects).toEqual([]);
  expect(harness.cookieClientCalls).toBe(0);
  vi.restoreAllMocks();
});

describe("authentication", () => {
  it("refuses a request with no token on every route, as JSON", async () => {
    await expectRefusal(await getMe(request("/api/staff/me")), 401, "unauthenticated");
    await expectRefusal(await today(undefined, STUDIO_A), 401, "unauthenticated");
    await expectRefusal(await appointment(undefined, STUDIO_A, APPT_OWN_LESSON), 401, "unauthenticated");
  });

  it("has no cookie fallback: a browser session alone is not enough", async () => {
    const response = await getMe(request("/api/staff/me", undefined, { cookie: "sb-access-token=valid-session" }));
    await expectRefusal(response, 401, "unauthenticated");
  });

  it("does not accept the student API's custom token header", async () => {
    const response = await getMe(request("/api/staff/me", undefined, { "x-danceflow-access-token": TOKENS.instructorA }));
    await expectRefusal(response, 401, "unauthenticated");
  });

  it("refuses an invalid token", async () => {
    await expectRefusal(await today("not-a-real-token", STUDIO_A), 401, "unauthenticated");
  });

  it("reports an auth outage as 503, not 401, so the app does not sign the user out", async () => {
    harness.authFailure = { status: 500 };
    await expectRefusal(await getMe(request("/api/staff/me", TOKENS.instructorA)), 503, "service_unavailable");
    harness.authFailure = { status: 0, name: "AuthRetryableFetchError" };
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
  });

  it("builds its client from the anon key and the caller's token, never the service role", async () => {
    await getMe(request("/api/staff/me", TOKENS.instructorA));
    expect(harness.createdWith).toEqual([{ key: "anon-key", authorization: `Bearer ${TOKENS.instructorA}` }]);
  });
});

describe("account standing", () => {
  it.each([
    ["deactivated", TOKENS.deactivated],
    ["pending deletion", TOKENS.pendingDeletion],
    ["banned", TOKENS.banned],
    ["without a profile", TOKENS.noProfile],
  ])("refuses an account that is %s", async (_label, token) => {
    await expectRefusal(await getMe(request("/api/staff/me", token)), 403, "account_inactive");
    await expectRefusal(await today(token, STUDIO_A), 403, "account_inactive");
  });

  it("refuses a platform admin even with a real studio membership", async () => {
    await expectRefusal(await getMe(request("/api/staff/me", TOKENS.platformAdmin)), 403, "platform_admin_unsupported");
    await expectRefusal(await today(TOKENS.platformAdmin, STUDIO_A), 403, "platform_admin_unsupported");
    await expectRefusal(
      await appointment(TOKENS.platformAdmin, STUDIO_A, APPT_OWN_LESSON),
      403,
      "platform_admin_unsupported",
    );
  });

  it("does not let a platform_admin role row act as a membership", async () => {
    await expectRefusal(await today(TOKENS.roleRowAdmin, STUDIO_A), 403, "not_a_member");
    const body = await (await getMe(request("/api/staff/me", TOKENS.roleRowAdmin))).json();
    expect(body.workspaces).toEqual([]);
  });
});

describe("workspace boundary", () => {
  it("refuses a studio the caller does not belong to", async () => {
    await expectRefusal(await today(TOKENS.instructorB, STUDIO_A), 403, "not_a_member");
    await expectRefusal(await appointment(TOKENS.instructorB, STUDIO_A, APPT_OWN_LESSON), 403, "not_a_member");
  });

  it("answers the same for a studio that does not exist", async () => {
    await expectRefusal(await today(TOKENS.instructorB, "eeeeeeee-0000-4000-8000-000000000009"), 403, "not_a_member");
  });

  it("refuses a deactivated membership", async () => {
    await expectRefusal(await today(TOKENS.removedFromA, STUDIO_A), 403, "not_a_member");
  });

  it("does not reveal a paused studio's state to a non-member", async () => {
    await expectRefusal(await today(TOKENS.instructorB, STUDIO_PAUSED), 403, "not_a_member");
  });

  it("refuses a member of a paused studio, the check web staff get from the app layout", async () => {
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_PAUSED), 403, "workspace_paused");
  });

  it("rejects a malformed workspace id after authenticating", async () => {
    await expectRefusal(await today(TOKENS.instructorA, "not-a-uuid"), 400, "invalid_request");
    await expectRefusal(await today(undefined, "not-a-uuid"), 401, "unauthenticated");
  });

  it("accepts an uppercase workspace id as the same workspace", async () => {
    const response = await today(TOKENS.instructorA, STUDIO_A.toUpperCase());
    expect(response.status).toBe(200);
    expect((await response.json()).studioId).toBe(STUDIO_A);
  });

  it("fails closed when the membership or status read fails", async () => {
    harness.failures = { table: "user_studio_roles" };
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
    harness.failures = { table: "studios" };
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
    harness.failures = { table: "profiles" };
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
  });

  it("marks every response uncacheable", async () => {
    expect((await getMe(request("/api/staff/me", TOKENS.instructorA))).headers.get("cache-control")).toBe("private, no-store");
    expect((await today(undefined, STUDIO_A)).headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("GET /api/staff/me", () => {
  it("lists the caller's workspaces with role, access and capabilities", async () => {
    const response = await getMe(request("/api/staff/me", TOKENS.instructorA));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.user).toEqual({
      id: TOKENS.instructorA,
      email: `${TOKENS.instructorA}@example.test`,
      fullName: `Name of ${TOKENS.instructorA}`,
    });
    expect(body.workspaces.map((row: { studioId: string }) => row.studioId)).toEqual([STUDIO_A, STUDIO_PAUSED]);

    const [active, paused] = body.workspaces;
    expect(active).toMatchObject({ name: "Studio A", publicName: "Studio A Public", slug: "studio-a", role: "instructor", accessAllowed: true, subscriptionStatus: "active" });
    expect(active.capabilities).toEqual(staffCapabilitiesForRole("instructor"));
    expect(paused).toMatchObject({ role: "instructor", accessAllowed: false, subscriptionStatus: "past_due" });
  });

  it("never lists another person's studio", async () => {
    const body = await (await getMe(request("/api/staff/me", TOKENS.instructorB))).json();
    expect(body.workspaces.map((row: { studioId: string }) => row.studioId)).toEqual([STUDIO_B]);
  });

  it("returns an empty list for a signed-in person with no staff role", async () => {
    const response = await getMe(request("/api/staff/me", TOKENS.student));
    expect(response.status).toBe(200);
    expect((await response.json()).workspaces).toEqual([]);
  });

  it("includes organizer workspaces and normalizes an organizer-named studio's owner role, as the web does", async () => {
    const staff = await (await getMe(request("/api/staff/me", TOKENS.organizerStaff))).json();
    expect(staff.workspaces).toHaveLength(1);
    expect(staff.workspaces[0]).toMatchObject({ studioId: STUDIO_ORGANIZER, role: "organizer_staff" });
    expect(staff.workspaces[0].capabilities.checkInEventAttendees).toBe(true);
    expect(staff.workspaces[0].capabilities.viewStudioSchedule).toBe(false);

    const owner = await (await getMe(request("/api/staff/me", TOKENS.organizerOwner))).json();
    expect(owner.workspaces[0].role).toBe("organizer_owner");
  });

  it("reports one workspace per studio, using the role the web would resolve", async () => {
    const body = await (await getMe(request("/api/staff/me", TOKENS.dualRole))).json();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].role).toBe("instructor");
  });

  it("fails closed when subscription status cannot be read", async () => {
    harness.failures = { table: "studios" };
    await expectRefusal(await getMe(request("/api/staff/me", TOKENS.instructorA)), 503, "service_unavailable");
  });
});

describe("capabilities", () => {
  it("follows permissions.ts for each role", () => {
    const instructor = staffCapabilitiesForRole("instructor");
    expect(instructor).toMatchObject({ viewStudioSchedule: true, markAttendance: true, editAppointments: true, viewClients: false, deleteAppointments: false, manageAppointmentPayments: false, viewPayments: false, manageBilling: false });

    const independent = staffCapabilitiesForRole("independent_instructor");
    expect(independent).toMatchObject({ viewStudioSchedule: false, markAttendance: false, manageOwnFloorRentalAppointment: true, viewClients: false });

    const frontDesk = staffCapabilitiesForRole("front_desk");
    expect(frontDesk).toMatchObject({ viewClients: true, takePayments: true, manageBilling: false, manageSettings: false });

    const owner = staffCapabilitiesForRole("studio_owner");
    expect(owner).toMatchObject({ manageBilling: true, assignRoles: true, viewStudioSchedule: true, viewOrganizerWorkspace: false });

    const organizer = staffCapabilitiesForRole("organizer_staff");
    expect(organizer).toMatchObject({ viewOrganizerWorkspace: true, checkInEventAttendees: true, manageEvents: false, viewStudioSchedule: false });
  });

  it.each([null, undefined, "", "some_future_role"])("denies everything for the unrecognized role %s", (role) => {
    expect(Object.values(staffCapabilitiesForRole(role)).every((value) => value === false)).toBe(true);
  });
});

describe("GET today", () => {
  it("returns only the caller's own appointments for that local day, in this studio", async () => {
    const response = await today(TOKENS.instructorA, STUDIO_A);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({ studioId: STUDIO_A, date: DAY, timeZone: "America/New_York", instructorId: "ins-a1" });
    const ids = body.appointments.map((row: { id: string }) => row.id).sort();
    expect(ids).toEqual([APPT_OWN_LESSON, APPT_OWN_CLASS, APPT_OWN_CANCELLED].sort());

    expect(ids).not.toContain(APPT_COLLEAGUE_CLASS);
    expect(ids).not.toContain(APPT_COLLEAGUE_LESSON);
    expect(ids).not.toContain(APPT_NEXT_DAY);
    expect(ids).not.toContain(APPT_OTHER_STUDIO);
  });

  it("uses the identity of the requested studio when a person teaches at two", async () => {
    const body = await (await today(TOKENS.instructorA, STUDIO_A)).json();
    expect(body.instructorId).toBe("ins-a1");
    expect(JSON.stringify(body)).not.toContain("cli-b1");
  });

  it("isolates two instructors in two studios from each other", async () => {
    const body = await (await today(TOKENS.instructorB, STUDIO_B)).json();
    expect(body.timeZone).toBe("America/Chicago");
    expect(body.appointments.map((row: { id: string }) => row.id)).toEqual([APPT_OTHER_STUDIO]);
  });

  it("shows no one's schedule to an instructor with no linked instructor row", async () => {
    const body = await (await today(TOKENS.unlinkedInstructorA, STUDIO_A)).json();
    expect(body.instructorId).toBeNull();
    expect(body.appointments).toEqual([]);
  });

  it("shows an owner their own teaching day, not the studio's", async () => {
    const body = await (await today(TOKENS.ownerA, STUDIO_A)).json();
    expect(body.instructorId).toBeNull();
    expect(body.appointments).toEqual([]);
  });

  it("returns only teaching-safe fields", async () => {
    const body = await (await today(TOKENS.instructorA, STUDIO_A)).json();
    const lesson = body.appointments.find((row: { id: string }) => row.id === APPT_OWN_LESSON);

    expect(lesson).toEqual({
      id: APPT_OWN_LESSON,
      title: null,
      appointmentType: "private_lesson",
      status: "scheduled",
      startsAt: "2026-11-09T15:00:00.000Z",
      endsAt: "2026-11-09T15:45:00.000Z",
      room: { id: "room-1", name: "Main Floor" },
      locationName: null,
      client: { id: "cli-a1", firstName: "Ana", lastName: "Own" },
      // The teaching RPC only covers primary clients, so an instructor does not get this partner's name.
      partner: null,
    });

    const serialized = JSON.stringify(body);
    for (const leak of ["price", "payment", "billing", "referral", "555-01", "notes"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("leaves a client's name null outside the teaching relationship instead of failing", async () => {
    const body = await (await today(TOKENS.instructorA, STUDIO_A)).json();
    const cancelled = body.appointments.find((row: { id: string }) => row.id === APPT_OWN_CANCELLED);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.client).toBeNull();
  });

  it.each([
    ["independent_instructor", TOKENS.independentA, STUDIO_A],
    ["organizer_staff", TOKENS.organizerStaff, STUDIO_ORGANIZER],
    ["organizer_owner", TOKENS.organizerOwner, STUDIO_ORGANIZER],
  ])("refuses the role %s", async (_role, token, studioId) => {
    await expectRefusal(await today(token, studioId), 403, "role_not_permitted");
  });

  it.each(["2026-02-30", "2026-11-9", "tomorrow", "2026-11-09garbage", "2026-11-09T00:00:00Z", ""])(
    "rejects the date %j as a 400",
    async (date) => {
      await expectRefusal(await today(TOKENS.instructorA, STUDIO_A, `?date=${encodeURIComponent(date)}`), 400, "invalid_request");
    },
  );

  it("defaults to today in the studio's time zone", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T03:00:00.000Z"), toFake: ["Date"] });
    try {
      const body = await (await today(TOKENS.instructorA, STUDIO_A, "")).json();
      expect(body.date).toBe(DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the schedule read or the name lookup fails", async () => {
    harness.failures = { table: "appointments" };
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
    harness.failures = { rpc: "get_teaching_clients_for_instructor" };
    await expectRefusal(await today(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
  });
});

describe("GET appointment detail", () => {
  it("returns the caller's own lesson with its recap and without financial fields", async () => {
    const response = await appointment(TOKENS.instructorA, STUDIO_A, APPT_OWN_LESSON);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({
      id: APPT_OWN_LESSON,
      studioId: STUDIO_A,
      accessScope: "own-instructor",
      notes: "teaching note",
      client: { id: "cli-a1", firstName: "Ana", lastName: "Own" },
      instructor: { id: "ins-a1", firstName: "Ida", lastName: "Instructor" },
      roster: null,
      recap: { summary: "Worked on frame", homework: "Practice box step", nextFocus: "Timing", visibleToClient: true },
    });

    const serialized = JSON.stringify(body);
    for (const leak of ["price", "payment", "billing", "referral", "555-01", "secret"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("returns a group class's enrolled roster with attendance and no funding detail", async () => {
    const body = await (await appointment(TOKENS.instructorA, STUDIO_A, APPT_OWN_CLASS)).json();
    expect(body.roster.bookedCount).toBe(2);
    expect(body.roster.capacity).toBe(10);
    expect(body.roster.attendees).toEqual(
      expect.arrayContaining([
        { clientId: "cli-a1", name: "Ana Own", attendanceStatus: "attended" },
        // Not in the instructor's private-lesson relationship and hidden by clients RLS: the name comes from the roster RPC.
        { clientId: "cli-rental", name: "Rene Renter", attendanceStatus: null },
      ]),
    );
    expect(body.recap).toBeNull();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("package_credit");
    expect(serialized).not.toContain("cli-a3");
    expect(serialized).not.toContain("Unnamed");
  });

  it("returns null, never the placeholder, when no name source is readable", async () => {
    harness.failures = {};
    const embedded = appointment_attendees.find((row) => row.id === "att-1")!;
    const saved = embedded.clients;
    embedded.clients = null;
    try {
      // The broad view has no RPC fallback, so a hidden embed must surface as null.
      const body = await (await appointment(TOKENS.ownerA, STUDIO_A, APPT_OWN_CLASS)).json();
      const entry = body.roster.attendees.find((row: { clientId: string }) => row.clientId === "cli-a1");
      expect(entry.name).toBeNull();
      expect(JSON.stringify(body)).not.toContain("Unnamed");
    } finally {
      embedded.clients = saved;
    }
  });

  it("fails closed when the roster names lookup fails for the assigned instructor", async () => {
    harness.failures = { rpc: "get_class_roster_names_for_instructor" };
    await expectRefusal(await appointment(TOKENS.instructorA, STUDIO_A, APPT_OWN_CLASS), 503, "service_unavailable");
  });

  it("gives a colleague's appointment, including a class, the same 404 as a missing one", async () => {
    const missing = await appointment(TOKENS.instructorA, STUDIO_A, "a0000000-0000-4000-8000-00000000ffff");
    const lesson = await appointment(TOKENS.instructorA, STUDIO_A, APPT_COLLEAGUE_LESSON);
    const groupClass = await appointment(TOKENS.instructorA, STUDIO_A, APPT_COLLEAGUE_CLASS);

    const missingBody = await missing.clone().json();
    await expectRefusal(missing, 404, "not_found");
    await expectRefusal(lesson.clone(), 404, "not_found");
    await expectRefusal(groupClass.clone(), 404, "not_found");
    expect(await lesson.json()).toEqual(missingBody);
    expect(await groupClass.json()).toEqual(missingBody);
  });

  it("does not return another studio's appointment through a studio the caller belongs to", async () => {
    await expectRefusal(await appointment(TOKENS.instructorA, STUDIO_A, APPT_OTHER_STUDIO), 404, "not_found");
    await expectRefusal(await appointment(TOKENS.ownerA, STUDIO_A, APPT_OTHER_STUDIO), 404, "not_found");
  });

  it("refuses an instructor with no instructor row", async () => {
    await expectRefusal(await appointment(TOKENS.unlinkedInstructorA, STUDIO_A, APPT_OWN_LESSON), 404, "not_found");
  });

  it("does not serve an own floor rental to an instructor, matching the web detail page", async () => {
    await expectRefusal(await appointment(TOKENS.renterInstructorA, STUDIO_A, APPT_RENTAL), 404, "not_found");
  });

  it.each([
    ["owner", TOKENS.ownerA],
    ["front desk", TOKENS.frontDeskA],
  ])("lets a %s read any appointment in their studio, with names but no CRM or financial fields", async (_label, token) => {
    const response = await appointment(token, STUDIO_A, APPT_COLLEAGUE_LESSON);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accessScope).toBe("broad");
    expect(body.client).toEqual({ id: "cli-a2", firstName: "Colin", lastName: "Colleague" });
    const serialized = JSON.stringify(body);
    for (const leak of ["price", "payment", "billing", "referral", "555-01"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("resolves a partner's name for broad staff", async () => {
    const body = await (await appointment(TOKENS.ownerA, STUDIO_A, APPT_OWN_LESSON)).json();
    expect(body.partner).toEqual({ id: "cli-a3", firstName: "Pat", lastName: "Partner" });
  });

  it("refuses an independent instructor and organizer roles before reading the appointment", async () => {
    await expectRefusal(await appointment(TOKENS.independentA, STUDIO_A, APPT_OWN_LESSON), 403, "role_not_permitted");
    await expectRefusal(await appointment(TOKENS.organizerStaff, STUDIO_ORGANIZER, APPT_OWN_LESSON), 403, "role_not_permitted");
  });

  it("refuses a member of a paused studio", async () => {
    await expectRefusal(await appointment(TOKENS.instructorA, STUDIO_PAUSED, APPT_OWN_LESSON), 403, "workspace_paused");
  });

  it("rejects a malformed appointment id", async () => {
    await expectRefusal(await appointment(TOKENS.instructorA, STUDIO_A, "nope"), 400, "invalid_request");
  });

  it("fails closed when a detail read fails", async () => {
    harness.failures = { table: "lesson_recaps" };
    await expectRefusal(await appointment(TOKENS.instructorA, STUDIO_A, APPT_OWN_LESSON), 503, "service_unavailable");
    harness.failures = { table: "appointment_attendees" };
    await expectRefusal(await appointment(TOKENS.instructorA, STUDIO_A, APPT_OWN_CLASS), 503, "service_unavailable");
  });
});

describe("local day range", () => {
  it("covers a 24-hour day", () => {
    expect(localDayUtcRange("2026-11-09", "America/New_York")).toEqual({
      startIso: "2026-11-09T05:00:00.000Z",
      endIso: "2026-11-10T05:00:00.000Z",
    });
  });

  it("covers the 23-hour spring-forward day", () => {
    expect(localDayUtcRange("2026-03-08", "America/New_York")).toEqual({
      startIso: "2026-03-08T05:00:00.000Z",
      endIso: "2026-03-09T04:00:00.000Z",
    });
  });

  it("covers the 25-hour fall-back day", () => {
    expect(localDayUtcRange("2026-11-01", "America/New_York")).toEqual({
      startIso: "2026-11-01T04:00:00.000Z",
      endIso: "2026-11-02T05:00:00.000Z",
    });
  });

  it("handles a zone ahead of UTC and a month boundary", () => {
    expect(localDayUtcRange("2026-12-31", "Asia/Tokyo")).toEqual({
      startIso: "2026-12-30T15:00:00.000Z",
      endIso: "2026-12-31T15:00:00.000Z",
    });
  });

  it("falls back for a missing or unusable studio time zone", () => {
    expect(resolveStudioTimeZone(null)).toBe("America/New_York");
    expect(resolveStudioTimeZone("  ")).toBe("America/New_York");
    expect(resolveStudioTimeZone("Not/AZone")).toBe("America/New_York");
    expect(resolveStudioTimeZone("Europe/Paris")).toBe("Europe/Paris");
  });
});
