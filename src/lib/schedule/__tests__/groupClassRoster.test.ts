import { describe, expect, it } from "vitest";
import {
  getClassEnrollmentAppointmentsForClient,
  getClassRosterForInstructor,
  getClassRosterForStaff,
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

describe("getClassEnrollmentAppointmentsForClient (staff client-profile class history)", () => {
  const CLIENT_ID = "client-1";

  it("returns a real-roster class enrollment with this client's own attendee billing state", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: "class-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "booked",
          billing_type: "package_credit",
          payment_status: "paid",
          appointments: {
            id: "class-1",
            title: "Bronze Foxtrot",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: "2026-09-10T10:00:00.000Z",
            ends_at: "2026-09-10T11:00:00.000Z",
            price_amount: null,
            instructors: { first_name: "Iris", last_name: "Instructor" },
            rooms: { name: "Studio A" },
          },
        },
      ],
      appointments: [],
    });

    const rows = await getClassEnrollmentAppointmentsForClient({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
    });

    expect(rows).toEqual([
      {
        id: "class-1",
        title: "Bronze Foxtrot",
        appointment_type: "group_class",
        status: "scheduled",
        starts_at: "2026-09-10T10:00:00.000Z",
        ends_at: "2026-09-10T11:00:00.000Z",
        billing_type: "package_credit",
        payment_status: "paid",
        price_amount: null,
        instructors: { first_name: "Iris", last_name: "Instructor" },
        rooms: { name: "Studio A" },
        source: "roster",
      },
    ]);
  });

  it("a cancelled (not booked) enrollment does not appear", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: "class-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "cancelled",
          billing_type: "package_credit",
          payment_status: "paid",
          appointments: {
            id: "class-1",
            title: "Bronze Foxtrot",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: "2026-09-10T10:00:00.000Z",
            ends_at: "2026-09-10T11:00:00.000Z",
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
    });

    expect(rows).toEqual([]);
  });

  it("includes a legacy-shaped class only when it has zero appointment_attendees rows, and does not duplicate a class already covered by the real roster", async () => {
    const supabase = makeFakeSupabase({
      appointment_attendees: [
        {
          appointment_id: "class-real",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          status: "booked",
          billing_type: "package_credit",
          payment_status: "paid",
          appointments: {
            id: "class-real",
            title: "Real Class",
            appointment_type: "group_class",
            status: "scheduled",
            starts_at: "2026-09-10T10:00:00.000Z",
            ends_at: "2026-09-10T11:00:00.000Z",
            price_amount: null,
            instructors: null,
            rooms: null,
          },
        },
      ],
      appointments: [
        {
          id: "class-legacy",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          appointment_type: "group_class",
          title: "Legacy Class",
          status: "scheduled",
          starts_at: "2026-09-01T10:00:00.000Z",
          ends_at: "2026-09-01T11:00:00.000Z",
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
    });

    expect(rows).toHaveLength(2);
    const legacyRow = rows.find((row) => row.id === "class-legacy");
    expect(legacyRow?.source).toBe("legacy_fallback");
    expect(legacyRow?.billing_type).toBe("pay_as_you_go");
    const realRow = rows.find((row) => row.id === "class-real");
    expect(realRow?.source).toBe("roster");
  });
});
