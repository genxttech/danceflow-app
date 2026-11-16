import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./fakeSupabase";

/**
 * CI-B: concurrent and repeated event door check-in.
 *
 * Drives the real check-in server actions against an in-memory database whose
 * queries interleave like concurrent requests (see ./fakeSupabase.ts). The
 * control test at the bottom shows the old read-then-update pattern really does
 * double-admit under this harness, so the "exactly one admit" assertions are
 * meaningful.
 */

const state: {
  db: FakeDb;
  role: string | null;
  isPlatformAdmin: boolean;
} = { db: new FakeDb(), role: "front_desk", isPlatformAdmin: false };

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.db.client({ id: "user-1" }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "studio-1",
    studioRole: state.role,
    isPlatformAdmin: state.isPlatformAdmin,
    userId: "user-1",
  }),
}));

import { checkInEventRegistrationAction, checkInEventTicketCodeAction } from "../actions";

const ATTENDANCE_UNIQUE = [
  {
    // attendance_records_one_per_event_session_attendee (20260703)
    table: "attendance_records",
    columns: ["studio_id", "event_session_id", "event_registration_attendee_id"],
    where: (row: Row) => row.event_session_id != null && row.event_registration_attendee_id != null,
  },
];

function seed(extra: Partial<Record<string, Row[]>> = {}) {
  return new FakeDb(
    {
      events: [
        { id: "evt-1", studio_id: "studio-1", event_type: "social" },
        { id: "evt-g", studio_id: "studio-1", event_type: "group_class" },
      ],
      event_registrations: [
        { id: "reg-1", event_id: "evt-1", client_id: "client-1", status: "confirmed", payment_status: "paid", checked_in_at: null },
        { id: "reg-legacy", event_id: "evt-1", client_id: "client-2", status: "confirmed", payment_status: "paid", checked_in_at: null },
        { id: "reg-g", event_id: "evt-g", client_id: "client-3", status: "confirmed", payment_status: "paid", checked_in_at: null },
        { id: "reg-unpaid", event_id: "evt-1", client_id: "client-4", status: "confirmed", payment_status: "unpaid", checked_in_at: null },
      ],
      event_registration_attendees: [
        { id: "att-1", registration_id: "reg-1", event_id: "evt-1", ticket_code: "ABC123", checked_in_at: null, checked_in_by: null, sort_order: 1 },
        { id: "att-2", registration_id: "reg-1", event_id: "evt-1", ticket_code: "ABC124", checked_in_at: null, checked_in_by: null, sort_order: 2 },
        { id: "att-g", registration_id: "reg-g", event_id: "evt-g", ticket_code: "GRP001", checked_in_at: null, checked_in_by: null, sort_order: 1 },
        { id: "att-u", registration_id: "reg-unpaid", event_id: "evt-1", ticket_code: "UNP001", checked_in_at: null, checked_in_by: null, sort_order: 1 },
      ],
      event_sessions: [{ id: "sess-1", event_id: "evt-g", studio_id: "studio-1", status: "scheduled" }],
      attendance_records: [],
      ...extra,
    },
    ATTENDANCE_UNIQUE,
  );
}

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

async function redirectOf(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2];
    throw error;
  }
  throw new Error("expected the action to redirect");
}

function outcome(url: string) {
  const query = new URLSearchParams(url.split("?")[1] ?? "");
  return query.get("success") ? `success=${query.get("success")}` : query.get("warning") ? `warning=${query.get("warning")}` : `error=${query.get("error")}`;
}

const RETURN_TO = "/app/events/evt-1/check-in";

beforeEach(() => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  state.db = seed();
  state.role = "front_desk";
  state.isPlatformAdmin = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("CI-B ticket-code check-in", () => {
  it("admits exactly once when the same ticket is scanned concurrently", async () => {
    const scan = () =>
      redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "abc 123", returnTo: RETURN_TO })));

    const results = await Promise.all([scan(), scan(), scan()]);
    const outcomes = results.map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in", "warning=already_checked_in"]);
    expect(results.every((url) => url.includes("ticket=ABC123"))).toBe(true);

    const attendee = state.db.rows("event_registration_attendees").find((row) => row.id === "att-1")!;
    expect(attendee.checked_in_at).toBeTruthy();
    expect(attendee.checked_in_by).toBe("user-1");
    // Only the winner writes attendance.
    expect(state.db.rows("attendance_records")).toHaveLength(1);
    // Only one of two tickets used: the registration is not fully checked in.
    expect(state.db.rows("event_registrations").find((row) => row.id === "reg-1")!.checked_in_at).toBeNull();
  });

  it("returns an explicit already-checked-in outcome on a repeat scan and keeps the first admission time", async () => {
    const first = await redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "ABC123", returnTo: RETURN_TO })));
    const firstTime = state.db.rows("event_registration_attendees").find((row) => row.id === "att-1")!.checked_in_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "ABC123", returnTo: RETURN_TO })));

    expect(outcome(first)).toBe("success=checked_in");
    expect(second).toBe(`${RETURN_TO}?warning=already_checked_in&ticket=ABC123`);
    expect(state.db.rows("event_registration_attendees").find((row) => row.id === "att-1")!.checked_in_at).toBe(firstTime);
  });

  it("rolls the registration up when its two tickets are scanned at the same time", async () => {
    const results = await Promise.all([
      redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "ABC123", returnTo: RETURN_TO }))),
      redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "ABC124", returnTo: RETURN_TO }))),
    ]);

    expect(results.map(outcome)).toEqual(["success=checked_in", "success=checked_in"]);
    expect(state.db.rows("event_registrations").find((row) => row.id === "reg-1")!.checked_in_at).toBeTruthy();
  });

  it("admits a group-class ticket once per session under concurrent scans", async () => {
    const scan = () =>
      redirectOf(
        checkInEventTicketCodeAction(
          form({ eventId: "evt-g", ticketCode: "GRP001", eventSessionId: "sess-1", returnTo: "/app/events/evt-g/check-in" }),
        ),
      );

    const outcomes = (await Promise.all([scan(), scan()])).map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in"]);
    const attendance = state.db.rows("attendance_records");
    expect(attendance).toHaveLength(1);
    expect(attendance[0]).toMatchObject({ event_session_id: "sess-1", event_registration_attendee_id: "att-g", status: "checked_in" });
  });

  it("admits once when a pre-created group-class attendance row is claimed concurrently", async () => {
    state.db = seed({
      attendance_records: [
        { id: "ar-1", studio_id: "studio-1", event_registration_id: "reg-g", event_session_id: "sess-1", event_registration_attendee_id: "att-g", status: "registered", checked_in_at: null },
      ],
    });
    const scan = () =>
      redirectOf(
        checkInEventTicketCodeAction(
          form({ eventId: "evt-g", ticketCode: "GRP001", eventSessionId: "sess-1", returnTo: "/app/events/evt-g/check-in" }),
        ),
      );

    const outcomes = (await Promise.all([scan(), scan()])).map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in"]);
    expect(state.db.rows("attendance_records")).toHaveLength(1);
  });

  it("still blocks unpaid tickets before any check-in write", async () => {
    const url = await redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "UNP001", returnTo: RETURN_TO })));

    expect(outcome(url)).toBe("error=cannot_check_in_unpaid");
    expect(state.db.log.filter((entry) => entry.op !== "select")).toEqual([]);
  });
});

describe("CI-B manual check-in", () => {
  it("admits a whole registration once when two staff press Check in together", async () => {
    const press = () =>
      redirectOf(checkInEventRegistrationAction(form({ eventId: "evt-1", registrationId: "reg-1", returnTo: RETURN_TO })));

    const outcomes = (await Promise.all([press(), press()])).map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in"]);
    // One attendance row per attendee ticket, not one per press.
    expect(state.db.rows("attendance_records")).toHaveLength(2);
    expect(state.db.rows("event_registrations").find((row) => row.id === "reg-1")!.checked_in_at).toBeTruthy();
  });

  it("admits a single attendee once and reports the repeat", async () => {
    const press = () =>
      redirectOf(
        checkInEventRegistrationAction(
          form({ eventId: "evt-1", registrationId: "reg-1", eventRegistrationAttendeeId: "att-2", returnTo: RETURN_TO }),
        ),
      );

    const outcomes = (await Promise.all([press(), press()])).map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in"]);
    expect(state.db.rows("event_registration_attendees").find((row) => row.id === "att-1")!.checked_in_at).toBeNull();
  });

  it("admits a legacy registration without ticket rows once", async () => {
    const press = () =>
      redirectOf(checkInEventRegistrationAction(form({ eventId: "evt-1", registrationId: "reg-legacy", returnTo: RETURN_TO })));

    const outcomes = (await Promise.all([press(), press()])).map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in"]);
    expect(state.db.rows("attendance_records").filter((row) => row.event_registration_id === "reg-legacy")).toHaveLength(1);
  });

  it("admits a group-class attendee once per session", async () => {
    const press = () =>
      redirectOf(
        checkInEventRegistrationAction(
          form({ eventId: "evt-g", registrationId: "reg-g", eventRegistrationAttendeeId: "att-g", eventSessionId: "sess-1", returnTo: "/app/events/evt-g/check-in" }),
        ),
      );

    const outcomes = (await Promise.all([press(), press()])).map(outcome).sort();

    expect(outcomes).toEqual(["success=checked_in", "warning=already_checked_in"]);
    expect(state.db.rows("attendance_records")).toHaveLength(1);
  });
});

describe("CI-B check-in role gate (canCheckInEventAttendees)", () => {
  const allowed = ["studio_owner", "studio_admin", "front_desk", "organizer_owner", "organizer_admin", "organizer_staff"];
  const denied = ["instructor", "independent_instructor", null];

  it.each(allowed)("%s may check in", async (role) => {
    state.role = role;
    const url = await redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "ABC123", returnTo: RETURN_TO })));
    expect(outcome(url)).toBe("success=checked_in");
  });

  it("platform admins may check in", async () => {
    state.role = null;
    state.isPlatformAdmin = true;
    const url = await redirectOf(checkInEventRegistrationAction(form({ eventId: "evt-1", registrationId: "reg-1", returnTo: RETURN_TO })));
    expect(outcome(url)).toBe("success=checked_in");
  });

  it.each(denied)("%s is refused before any database read or write", async (role) => {
    state.role = role;
    const ticket = await redirectOf(checkInEventTicketCodeAction(form({ eventId: "evt-1", ticketCode: "ABC123", returnTo: RETURN_TO })));
    const manual = await redirectOf(checkInEventRegistrationAction(form({ eventId: "evt-1", registrationId: "reg-1", returnTo: RETURN_TO })));

    expect(outcome(ticket)).toBe("error=checkin_unauthorized");
    expect(outcome(manual)).toBe("error=checkin_unauthorized");
    expect(state.db.log).toEqual([]);
  });
});

describe("harness control", () => {
  it("the old read-then-update pattern double-admits under this harness", async () => {
    const client = state.db.client();
    let admits = 0;

    const naiveScan = async () => {
      const { data } = await client
        .from("event_registration_attendees")
        .select("id, checked_in_at")
        .eq("id", "att-1")
        .maybeSingle();
      if ((data as Row).checked_in_at) return;
      await client.from("event_registration_attendees").update({ checked_in_at: new Date().toISOString() }).eq("id", "att-1");
      admits += 1;
    };

    await Promise.all([naiveScan(), naiveScan()]);

    expect(admits).toBe(2);
  });
});
