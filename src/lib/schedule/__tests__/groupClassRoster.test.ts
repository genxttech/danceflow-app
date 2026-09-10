import { describe, expect, it } from "vitest";
import {
  getClassEnrollmentAppointmentsForClient,
  getClassRosterForInstructor,
  getClassRosterForStaff,
  getOwnClassEnrollmentForAppointment,
  resolveClassAttendeesForNotification,
} from "@/lib/schedule/groupClassRoster";

/**
 * GC-1.3A: covers the shared-class roster helper's two responsibilities --
 * (1) role-scoped field minimization (staff DTO vs instructor DTO, selected
 * at the query layer, never fetched-broad-then-hidden) and (2) the
 * temporary legacy dual-read fallback (real appointment_attendees rows
 * preferred; a legacy roster-of-one synthesized only when a group_class has
 * zero attendee rows and a non-null legacy appointments.client_id).
 *
 * Uses a hand-rolled fake Supabase client, matching the established pattern
 * in independentInstructorSchedule.test.ts -- fixtures embed their own
 * joined relations directly (e.g. `clients: {...}` on an
 * appointment_attendees row) rather than simulating real join resolution.
 */

type Row = Record<string, unknown>;

function makeFakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      let filtered = [...rows];
      let countMode = false;

      const builder = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count === "exact" && opts?.head) countMode = true;
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
          onFulfilled: (value: {
            data: Row[] | null;
            count?: number;
            error: null;
          }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          if (countMode) {
            return Promise.resolve({
              data: null,
              count: filtered.length,
              error: null,
            }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: filtered, error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };

      return builder;
    },
  };
}

const STUDIO_ID = "studio-1";
const APPOINTMENT_ID = "appt-1";

describe("getClassRosterForStaff / getClassRosterForInstructor", () => {
  it("real roster: staff DTO includes billing/package/membership fields, instructor DTO does not", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-1",
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: "pkg-1",
          client_membership_id: null,
          clients: {
            id: "client-1",
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@example.test",
            phone: "555-1000",
          },
        },
      ],
    });

    const staffRoster = await getClassRosterForStaff({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(staffRoster).toEqual([
      {
        clientId: "client-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.test",
        phone: "555-1000",
        billingType: "package_credit",
        paymentStatus: "paid",
        clientPackageId: "pkg-1",
        clientMembershipId: null,
        source: "roster",
      },
    ]);

    const instructorRoster = await getClassRosterForInstructor({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(instructorRoster).toEqual([
      { clientId: "client-1", firstName: "Ada", lastName: "Lovelace", source: "roster" },
    ]);
    expect(instructorRoster[0]).not.toHaveProperty("billingType");
    expect(instructorRoster[0]).not.toHaveProperty("paymentStatus");
    expect(instructorRoster[0]).not.toHaveProperty("clientPackageId");
    expect(instructorRoster[0]).not.toHaveProperty("clientMembershipId");
    expect(instructorRoster[0]).not.toHaveProperty("email");
    expect(instructorRoster[0]).not.toHaveProperty("phone");
  });

  it("unassigned instructor (zero appointment_attendees rows scoped to a different appointment) returns zero rows", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: "some-other-appointment",
          studio_id: STUDIO_ID,
          client_id: "client-1",
          clients: { id: "client-1", first_name: "Ada", last_name: "Lovelace" },
        },
      ],
      appointments: [],
    });

    const staffRoster = await getClassRosterForStaff({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });
    const instructorRoster = await getClassRosterForInstructor({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(staffRoster).toEqual([]);
    expect(instructorRoster).toEqual([]);
  });

  it("real roster (any rows present) is preferred over the legacy fallback, even if appointments.client_id is also populated", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-real",
          billing_type: "membership",
          payment_status: "paid",
          client_package_id: null,
          client_membership_id: "membership-1",
          clients: {
            id: "client-real",
            first_name: "Real",
            last_name: "Attendee",
            email: "",
            phone: "",
          },
        },
      ],
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-legacy",
          appointment_type: "group_class",
          billing_type: "package_credit",
          payment_status: "unpaid",
          client_package_id: "legacy-pkg",
          clients: { id: "client-legacy", first_name: "Legacy", last_name: "Client" },
        },
      ],
    });

    const staffRoster = await getClassRosterForStaff({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(staffRoster).toHaveLength(1);
    expect(staffRoster[0].clientId).toBe("client-real");
    expect(staffRoster[0].source).toBe("roster");
  });

  it("legacy fallback fires only when zero appointment_attendees rows exist AND appointments.client_id is non-null", async () => {
    const supabaseWithLegacyClient = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-legacy",
          appointment_type: "group_class",
          billing_type: "package_credit",
          payment_status: "unpaid",
          client_package_id: "legacy-pkg",
          clients: { id: "client-legacy", first_name: "Legacy", last_name: "Client", email: "legacy@example.test", phone: "555-2000" },
        },
      ],
    });

    const staffRoster = await getClassRosterForStaff({
      supabase: supabaseWithLegacyClient as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(staffRoster).toEqual([
      {
        clientId: "client-legacy",
        firstName: "Legacy",
        lastName: "Client",
        email: "legacy@example.test",
        phone: "555-2000",
        billingType: "package_credit",
        paymentStatus: "unpaid",
        clientPackageId: "legacy-pkg",
        clientMembershipId: null,
        source: "legacy_fallback",
      },
    ]);

    // No legacy client_id at all on the appointments row -- zero rows, not a fabricated entry.
    const supabaseNoLegacyClient = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: null,
          appointment_type: "group_class",
          billing_type: "package_credit",
          payment_status: "unpaid",
          client_package_id: null,
          clients: null,
        },
      ],
    });

    const emptyRoster = await getClassRosterForStaff({
      supabase: supabaseNoLegacyClient as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(emptyRoster).toEqual([]);
  });

  it("legacy fallback for a membership-billed row returns clientMembershipId: null (no such column exists on appointments)", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-legacy",
          appointment_type: "group_class",
          billing_type: "membership",
          payment_status: "paid",
          client_package_id: null,
          clients: { id: "client-legacy", first_name: "Legacy", last_name: "Client", email: "", phone: "" },
        },
      ],
    });

    const staffRoster = await getClassRosterForStaff({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(staffRoster).toHaveLength(1);
    expect(staffRoster[0].billingType).toBe("membership");
    expect(staffRoster[0].paymentStatus).toBe("paid");
    expect(staffRoster[0].clientMembershipId).toBeNull();
    expect(staffRoster[0].source).toBe("legacy_fallback");

    const instructorRoster = await getClassRosterForInstructor({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });
    expect(instructorRoster).toEqual([
      { clientId: "client-legacy", firstName: "Legacy", lastName: "Client", source: "legacy_fallback" },
    ]);
  });
});

// GC-1.3B canonical lifecycle fixtures -- shared reference timestamps so
// every test in this file means the same thing by "future"/"past class",
// "pre-start cancel", and "post-start cancel".
const NOW_ISO = "2026-09-10T12:00:00.000Z";
const FUTURE_STARTS_AT = "2026-09-20T10:00:00.000Z";
const FUTURE_ENDS_AT = "2026-09-20T11:00:00.000Z";
const PAST_STARTS_AT = "2026-09-01T10:00:00.000Z";
const PAST_ENDS_AT = "2026-09-01T11:00:00.000Z";
const PRE_START_CANCELLED_AT = "2026-08-25T00:00:00.000Z"; // before either starts_at above
const POST_START_CANCELLED_AT = "2026-09-01T10:30:00.000Z"; // after PAST_STARTS_AT, before NOW_ISO

describe("getClassEnrollmentAppointmentsForClient (upcoming/recent, staff + portal shared read)", () => {
  const CLIENT_ID = "client-1";

  function attendeeFixture(overrides: {
    appointmentId: string;
    status: string;
    cancelledAt?: string | null;
    startsAt: string;
    endsAt: string;
    title?: string;
  }) {
    return {
      appointment_attendees: [
        {
          appointment_id: overrides.appointmentId,
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: overrides.status,
          cancelled_at: overrides.cancelledAt ?? null,
          billing_type: "package_credit",
          payment_status: "paid",
          appointments: {
            id: overrides.appointmentId,
            title: overrides.title ?? "Bronze Foxtrot",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: overrides.startsAt,
            ends_at: overrides.endsAt,
            price_amount: null,
            instructors: { first_name: "Iris", last_name: "Instructor" },
            rooms: { name: "Studio A" },
          },
        },
      ],
      appointments: [],
    };
  }

  it("booked future enrollment appears in upcoming, not recent", async () => {
    const supabase = makeFakeSupabase(
      attendeeFixture({
        appointmentId: "class-1",
        status: "booked",
        startsAt: FUTURE_STARTS_AT,
        endsAt: FUTURE_ENDS_AT,
      }),
    );

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toHaveLength(1);
    expect(rows.upcoming[0].id).toBe("class-1");
    expect(rows.recent).toEqual([]);
  });

  it("pre-start cancelled enrollment for a future class appears in neither bucket", async () => {
    const supabase = makeFakeSupabase(
      attendeeFixture({
        appointmentId: "class-1",
        status: "cancelled",
        cancelledAt: PRE_START_CANCELLED_AT,
        startsAt: FUTURE_STARTS_AT,
        endsAt: FUTURE_ENDS_AT,
      }),
    );

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toEqual([]);
    expect(rows.recent).toEqual([]);
  });

  it("pre-start cancelled enrollment for a past class does not appear as participated history", async () => {
    const supabase = makeFakeSupabase(
      attendeeFixture({
        appointmentId: "class-1",
        status: "cancelled",
        cancelledAt: PRE_START_CANCELLED_AT,
        startsAt: PAST_STARTS_AT,
        endsAt: PAST_ENDS_AT,
      }),
    );

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toEqual([]);
    expect(rows.recent).toEqual([]);
  });

  it("post-start cancelled enrollment is absent from upcoming, present in recent (GC-1.2 historical eligibility preserved)", async () => {
    const supabase = makeFakeSupabase(
      attendeeFixture({
        appointmentId: "class-1",
        status: "cancelled",
        cancelledAt: POST_START_CANCELLED_AT,
        startsAt: PAST_STARTS_AT,
        endsAt: PAST_ENDS_AT,
      }),
    );

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toEqual([]);
    expect(rows.recent).toHaveLength(1);
    expect(rows.recent[0].id).toBe("class-1");
  });

  it("booked-but-already-past enrollment appears in recent, not upcoming", async () => {
    const supabase = makeFakeSupabase(
      attendeeFixture({
        appointmentId: "class-1",
        status: "booked",
        startsAt: PAST_STARTS_AT,
        endsAt: PAST_ENDS_AT,
      }),
    );

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toEqual([]);
    expect(rows.recent).toHaveLength(1);
  });

  it("rebook edge case: two of this client's own rows both eligible for the same class -- appears exactly once in recent", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: "class-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "cancelled",
          cancelled_at: POST_START_CANCELLED_AT,
          billing_type: "package_credit",
          payment_status: "paid",
          appointments: {
            id: "class-1",
            title: "Bronze Foxtrot",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: PAST_STARTS_AT,
            ends_at: PAST_ENDS_AT,
            price_amount: null,
            instructors: null,
            rooms: null,
          },
        },
        {
          appointment_id: "class-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "booked",
          cancelled_at: null,
          billing_type: "membership",
          payment_status: "paid",
          appointments: {
            id: "class-1",
            title: "Bronze Foxtrot",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: PAST_STARTS_AT,
            ends_at: PAST_ENDS_AT,
            price_amount: null,
            instructors: null,
            rooms: null,
          },
        },
      ],
      appointments: [],
    });

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.recent).toHaveLength(1);
    // The 'booked' row is preferred over the 'cancelled' row when both are
    // eligible for the same appointment_id.
    expect(rows.recent[0].billing_type).toBe("membership");
  });

  it("legacy-shaped future class appears exactly once, in upcoming", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: "class-legacy",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          appointment_type: "group_class",
          title: "Legacy Class",
          status: "scheduled",
          starts_at: FUTURE_STARTS_AT,
          ends_at: FUTURE_ENDS_AT,
          cancelled_at: null,
          billing_type: "pay_as_you_go",
          payment_status: "unpaid",
          price_amount: 20,
          instructors: null,
          rooms: null,
        },
      ],
    });

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toHaveLength(1);
    expect(rows.upcoming[0].source).toBe("legacy_fallback");
    expect(rows.recent).toEqual([]);
  });

  it("legacy-shaped past class, post-start-cancelled at the class level, appears exactly once in recent (legacy historical eligibility)", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: "class-legacy",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          appointment_type: "group_class",
          title: "Legacy Class",
          status: "cancelled",
          starts_at: PAST_STARTS_AT,
          ends_at: PAST_ENDS_AT,
          cancelled_at: POST_START_CANCELLED_AT,
          billing_type: "pay_as_you_go",
          payment_status: "unpaid",
          price_amount: 20,
          instructors: null,
          rooms: null,
        },
      ],
    });

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toEqual([]);
    expect(rows.recent).toHaveLength(1);
    expect(rows.recent[0].source).toBe("legacy_fallback");
  });

  it("legacy-shaped past class, pre-start-cancelled at the class level, does not appear (legacy has no separate per-attendee cancellation, so class-level pre-start cancellation excludes it)", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: "class-legacy",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          appointment_type: "group_class",
          title: "Legacy Class",
          status: "cancelled",
          starts_at: PAST_STARTS_AT,
          ends_at: PAST_ENDS_AT,
          cancelled_at: PRE_START_CANCELLED_AT,
          billing_type: "pay_as_you_go",
          payment_status: "unpaid",
          price_amount: 20,
          instructors: null,
          rooms: null,
        },
      ],
    });

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    expect(rows.upcoming).toEqual([]);
    expect(rows.recent).toEqual([]);
  });

  it("real-roster class is not double-counted against a legacy candidate for the same appointment_id (GC-1.3A client-history double-count regression)", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: "class-real",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "booked",
          cancelled_at: null,
          billing_type: "package_credit",
          payment_status: "paid",
          appointments: {
            id: "class-real",
            title: "Real Class",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: PAST_STARTS_AT,
            ends_at: PAST_ENDS_AT,
            price_amount: null,
            instructors: null,
            rooms: null,
          },
        },
      ],
      appointments: [
        {
          id: "class-real",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          appointment_type: "group_class",
          title: "Real Class",
          status: "scheduled",
          starts_at: PAST_STARTS_AT,
          ends_at: PAST_ENDS_AT,
          cancelled_at: null,
          billing_type: "package_credit",
          payment_status: "paid",
          price_amount: null,
          instructors: null,
          rooms: null,
        },
      ],
    });

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      nowIso: NOW_ISO,
    });

    // The base appointments row for "class-real" also has client_id
    // populated (as any legacy-shaped class row would), but since a real
    // appointment_attendees row already exists for it, the legacy branch's
    // own zero-attendee-count check excludes it -- exactly one entry, not two.
    expect(rows.recent).toHaveLength(1);
    expect(rows.recent[0].source).toBe("roster");
  });
});

describe("getOwnClassEnrollmentForAppointment (portal/mobile detail access + own state)", () => {
  const CLIENT_ID = "client-1";
  const OTHER_CLIENT_ID = "client-2";

  it("eligible: true for this client's own booked row", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class", starts_at: PAST_STARTS_AT },
      ],
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "booked",
          cancelled_at: null,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: "pkg-1",
          client_membership_id: null,
        },
      ],
    });

    const result = await getOwnClassEnrollmentForAppointment({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(result?.eligible).toBe(true);
    expect(result?.source).toBe("roster");
  });

  it("eligible: true for a post-start-cancelled row on this client's own past class (historical rule)", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class", starts_at: PAST_STARTS_AT },
      ],
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "cancelled",
          cancelled_at: POST_START_CANCELLED_AT,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: "pkg-1",
          client_membership_id: null,
        },
      ],
    });

    const result = await getOwnClassEnrollmentForAppointment({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(result?.eligible).toBe(true);
  });

  it("eligible: false for a pre-start-cancelled row (never-eligible participation)", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class", starts_at: PAST_STARTS_AT },
      ],
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "cancelled",
          cancelled_at: PRE_START_CANCELLED_AT,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: "pkg-1",
          client_membership_id: null,
        },
      ],
    });

    const result = await getOwnClassEnrollmentForAppointment({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(result?.eligible).toBe(false);
  });

  it("never returns another client's row: a real attendee row exists for a different client, this client has none, and no legacy fallback fires", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        { id: APPOINTMENT_ID, studio_id: STUDIO_ID, appointment_type: "group_class", starts_at: PAST_STARTS_AT },
      ],
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: OTHER_CLIENT_ID,
          status: "booked",
          cancelled_at: null,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: null,
          client_membership_id: null,
        },
      ],
    });

    const result = await getOwnClassEnrollmentForAppointment({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(result).toBeNull();
  });

  it("never returns another client's legacy row: the legacy-designated client differs from the requesting client", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          appointment_type: "group_class",
          starts_at: PAST_STARTS_AT,
          client_id: OTHER_CLIENT_ID,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: null,
          status: "scheduled",
          cancelled_at: null,
          clients: { id: OTHER_CLIENT_ID, first_name: "Other", last_name: "Client", email: "", phone: "" },
        },
      ],
      appointment_attendees: [],
    });

    const result = await getOwnClassEnrollmentForAppointment({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(result).toBeNull();
  });

  it("legacy fallback: eligible for the correctly-matching designated client, with clientMembershipId always null", async () => {
    const supabase = makeFakeSupabase({
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          appointment_type: "group_class",
          starts_at: PAST_STARTS_AT,
          client_id: CLIENT_ID,
          billing_type: "membership",
          payment_status: "paid",
          client_package_id: null,
          status: "scheduled",
          cancelled_at: null,
          clients: { id: CLIENT_ID, first_name: "Legacy", last_name: "Client", email: "", phone: "" },
        },
      ],
      appointment_attendees: [],
    });

    const result = await getOwnClassEnrollmentForAppointment({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(result?.eligible).toBe(true);
    expect(result?.source).toBe("legacy_fallback");
    expect(result?.clientMembershipId).toBeNull();
  });
});

describe("resolveClassAttendeesForNotification (booked-only, distinct from the historical read rule)", () => {
  it("returns only booked attendee client ids", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-booked-1", status: "booked" },
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-booked-2", status: "booked" },
        { appointment_id: APPOINTMENT_ID, studio_id: STUDIO_ID, client_id: "client-cancelled", status: "cancelled" },
      ],
    });

    const clientIds = await resolveClassAttendeesForNotification({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(clientIds.sort()).toEqual(["client-booked-1", "client-booked-2"]);
  });

  it("excludes both pre-start and post-start cancelled attendees -- booked-only, not the historical read rule", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-pre-start-cancelled",
          status: "cancelled",
          cancelled_at: PRE_START_CANCELLED_AT,
        },
        {
          appointment_id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: "client-post-start-cancelled",
          status: "cancelled",
          cancelled_at: POST_START_CANCELLED_AT,
        },
      ],
    });

    const clientIds = await resolveClassAttendeesForNotification({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(clientIds).toEqual([]);
  });

  it("legacy fallback: a non-cancelled legacy class notifies its one designated client", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          appointment_type: "group_class",
          client_id: "client-legacy",
          status: "scheduled",
          starts_at: PAST_STARTS_AT,
          cancelled_at: null,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: null,
          clients: { id: "client-legacy", first_name: "Legacy", last_name: "Client", email: "", phone: "" },
        },
      ],
    });

    const clientIds = await resolveClassAttendeesForNotification({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(clientIds).toEqual(["client-legacy"]);
  });

  it("legacy fallback: a cancelled legacy class notifies nobody", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [],
      appointments: [
        {
          id: APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          appointment_type: "group_class",
          client_id: "client-legacy",
          status: "cancelled",
          starts_at: PAST_STARTS_AT,
          cancelled_at: POST_START_CANCELLED_AT,
          billing_type: "package_credit",
          payment_status: "paid",
          client_package_id: null,
          clients: { id: "client-legacy", first_name: "Legacy", last_name: "Client", email: "", phone: "" },
        },
      ],
    });

    const clientIds = await resolveClassAttendeesForNotification({
      supabase: supabase as never,
      appointmentId: APPOINTMENT_ID,
      studioId: STUDIO_ID,
    });

    expect(clientIds).toEqual([]);
  });
});
