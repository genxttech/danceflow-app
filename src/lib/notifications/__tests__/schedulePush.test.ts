import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GC-1.3B: covers sendAppointmentSchedulePush's class fan-out branch --
 * resolves booked (never cancelled) class attendees, accumulates every
 * linked user id across ALL attendees into one Set before sending, so one
 * account (a guardian linked to more than one attendee in the same class,
 * or linked to a client through more than one account link) receives at
 * most one push for the class event. The existing private_lesson/partner
 * path must be unaffected.
 */

const sendMobilePushToUserMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: (...args: unknown[]) => sendMobilePushToUserMock(...args),
}));

const { sendAppointmentSchedulePush } = await import("@/lib/notifications/schedulePush");

type Row = Record<string, unknown>;

function makeFakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      let filtered = [...rows];

      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          filtered = filtered.filter((row) => row[col] === val);
          return builder;
        },
        async maybeSingle() {
          return { data: filtered[0] ?? null, error: null };
        },
        then(
          onFulfilled: (value: { data: Row[]; error: null }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve({ data: filtered, error: null }).then(onFulfilled, onRejected);
        },
      };

      return builder;
    },
  };
}

const STUDIO_ID = "studio-1";
const APPOINTMENT_ID = "class-1";
const FUTURE_STARTS_AT = "2026-09-20T10:00:00.000Z";

function classAppointmentRow() {
  return {
    id: APPOINTMENT_ID,
    studio_id: STUDIO_ID,
    client_id: null,
    partner_client_id: null,
    title: "Bronze Foxtrot",
    appointment_type: "group_class",
    starts_at: FUTURE_STARTS_AT,
    ends_at: "2026-09-20T11:00:00.000Z",
    status: "scheduled",
    clients: null,
    partner_client: null,
    studios: { name: "Test Studio", public_name: null },
  };
}

beforeEach(() => {
  sendMobilePushToUserMock.mockClear();
});

describe("sendAppointmentSchedulePush -- group_class fan-out", () => {
  it("sends exactly one push per unique linked user, excluding cancelled attendees", async () => {
    const supabase = makeFakeSupabase({
      appointments: [classAppointmentRow()],
      studio_settings: [{ studio_id: STUDIO_ID, timezone: "America/New_York" }],
      appointment_attendees: [
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-a", status: "booked" },
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-b", status: "booked" },
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-cancelled", status: "cancelled" },
      ],
      // Guardian scenario: the same user (user-x) is linked to BOTH
      // client-a and client-b -- must still receive exactly one push.
      client_account_links: [
        { studio_id: STUDIO_ID, client_id: "client-a", status: "linked", can_view_schedule: true, user_id: "user-x" },
        { studio_id: STUDIO_ID, client_id: "client-b", status: "linked", can_view_schedule: true, user_id: "user-x" },
        { studio_id: STUDIO_ID, client_id: "client-cancelled", status: "linked", can_view_schedule: true, user_id: "user-z" },
      ],
    });

    await sendAppointmentSchedulePush({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      appointmentId: APPOINTMENT_ID,
      reason: "confirmed",
    });

    expect(sendMobilePushToUserMock).toHaveBeenCalledTimes(1);
    expect(sendMobilePushToUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-x" }),
    );
  });

  it("tolerates an attendee with no linked account -- no crash, no push for them", async () => {
    const supabase = makeFakeSupabase({
      appointments: [classAppointmentRow()],
      studio_settings: [{ studio_id: STUDIO_ID, timezone: "America/New_York" }],
      appointment_attendees: [
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-unlinked", status: "booked" },
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-linked", status: "booked" },
      ],
      client_account_links: [
        { studio_id: STUDIO_ID, client_id: "client-linked", status: "linked", can_view_schedule: true, user_id: "user-y" },
      ],
    });

    await sendAppointmentSchedulePush({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      appointmentId: APPOINTMENT_ID,
      reason: "confirmed",
    });

    expect(sendMobilePushToUserMock).toHaveBeenCalledTimes(1);
    expect(sendMobilePushToUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-y" }),
    );
  });

  it("never includes roster content in the payload -- body is the standard single-class message", async () => {
    const supabase = makeFakeSupabase({
      appointments: [classAppointmentRow()],
      studio_settings: [{ studio_id: STUDIO_ID, timezone: "America/New_York" }],
      appointment_attendees: [
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-a", status: "booked" },
      ],
      client_account_links: [
        { studio_id: STUDIO_ID, client_id: "client-a", status: "linked", can_view_schedule: true, user_id: "user-x" },
      ],
    });

    await sendAppointmentSchedulePush({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      appointmentId: APPOINTMENT_ID,
      reason: "confirmed",
    });

    const call = sendMobilePushToUserMock.mock.calls[0][0] as { body: string; title: string };
    expect(call.title).toBe("New lesson scheduled");
    expect(call.body).not.toMatch(/client-|user-/);
  });

  it("a fully-cancelled class roster (nobody booked) sends nothing", async () => {
    const supabase = makeFakeSupabase({
      appointments: [classAppointmentRow()],
      studio_settings: [{ studio_id: STUDIO_ID, timezone: "America/New_York" }],
      appointment_attendees: [
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-a", status: "cancelled" },
      ],
      client_account_links: [
        { studio_id: STUDIO_ID, client_id: "client-a", status: "linked", can_view_schedule: true, user_id: "user-x" },
      ],
    });

    await sendAppointmentSchedulePush({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      appointmentId: APPOINTMENT_ID,
      reason: "confirmed",
    });

    expect(sendMobilePushToUserMock).not.toHaveBeenCalled();
  });
});

describe("sendAppointmentSchedulePush -- private_lesson path unchanged (regression)", () => {
  it("still notifies the primary client and a partner for a private lesson", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        {
          id: "lesson-1",
          studio_id: STUDIO_ID,
          client_id: "client-primary",
          partner_client_id: "client-partner",
          title: "Private Lesson",
          appointment_type: "private_lesson",
          starts_at: FUTURE_STARTS_AT,
          ends_at: "2026-09-20T11:00:00.000Z",
          status: "scheduled",
          clients: null,
          partner_client: null,
          studios: { name: "Test Studio", public_name: null },
        },
      ],
      studio_settings: [{ studio_id: STUDIO_ID, timezone: "America/New_York" }],
      client_account_links: [
        { studio_id: STUDIO_ID, client_id: "client-primary", status: "linked", can_view_schedule: true, user_id: "user-primary" },
        { studio_id: STUDIO_ID, client_id: "client-partner", status: "linked", can_view_schedule: true, user_id: "user-partner" },
      ],
    });

    await sendAppointmentSchedulePush({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      appointmentId: "lesson-1",
      reason: "confirmed",
    });

    expect(sendMobilePushToUserMock).toHaveBeenCalledTimes(2);
    expect(sendMobilePushToUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-primary", data: expect.objectContaining({ recipientRole: "primary" }) }),
    );
    expect(sendMobilePushToUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-partner", data: expect.objectContaining({ recipientRole: "partner" }) }),
    );
  });
});
