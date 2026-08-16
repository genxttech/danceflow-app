import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * `detectAppointmentConflicts` (unmodified, out of Slice 1's scope, already
 * covered by `src/lib/schedule/__tests__/conflicts.test.ts`) opens its own
 * Supabase client internally via `@/lib/supabase/server`'s `createClient`,
 * independent of the fake client this file passes into
 * `executeApprovedStudentBookingAction`. It's mocked here to always report
 * no conflict, so these tests isolate Slice 1's entitlement-enforcement
 * behavior instead of re-testing conflict detection.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          neq: () => chain,
          in: () => chain,
          lt: () => chain,
          gt: () => chain,
          then: (onFulfilled: (v: { count: number; error: null }) => unknown) =>
            Promise.resolve({ count: 0, error: null }).then(onFulfilled),
        };
        return chain;
      },
    }),
  }),
}));

const { executeApprovedStudentBookingAction } = await import("@/lib/booking/selfServiceExecution");
type StudentBookingActionRequestRow = Parameters<
  typeof executeApprovedStudentBookingAction
>[0]["actionRequest"];

const STUDIO_ID = "studio-1";
const OTHER_STUDIO_ID = "studio-9";
const CLIENT_ID = "client-1";
const STARTS_AT = "2026-09-15T10:00:00.000Z";
const ENDS_AT = "2026-09-15T11:00:00.000Z";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function privateLessonPackage(overrides: Row = {}): Row {
  return {
    id: "pkg-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    active: true,
    expiration_date: null,
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 3, is_unlimited: false },
    ],
    ...overrides,
  };
}

function baseRequest(overrides: Partial<StudentBookingActionRequestRow> = {}): StudentBookingActionRequestRow {
  return {
    id: "request-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    action_type: "book",
    mode: "instant",
    status: "pending",
    appointment_id: null,
    requested_starts_at: STARTS_AT,
    requested_ends_at: ENDS_AT,
    previous_starts_at: null,
    previous_ends_at: null,
    instructor_id: null,
    room_id: null,
    lesson_type: "private_lesson",
    reason: null,
    ...overrides,
  };
}

type Fixture = {
  client_packages?: Row[];
  studio_settings?: Row[];
  client_memberships?: Row[];
  client_membership_periods?: Row[];
  membership_plan_benefits?: Row[];
  client_membership_usage?: Row[];
  appointments?: Row[];
  student_booking_action_requests?: Row[];
};

function buildClient(fixture: Fixture) {
  const tables = {
    client_packages: table(fixture.client_packages ?? []),
    studio_settings: table(
      fixture.studio_settings ?? [
        {
          studio_id: STUDIO_ID,
          block_depleted_membership_booking: true,
          block_unpaid_membership_booking: false,
        },
      ],
    ),
    client_memberships: table(fixture.client_memberships ?? []),
    client_membership_periods: table(fixture.client_membership_periods ?? []),
    membership_plan_benefits: table(fixture.membership_plan_benefits ?? []),
    client_membership_usage: table(fixture.client_membership_usage ?? []),
    appointments: table(fixture.appointments ?? []),
    student_booking_action_requests: table(
      fixture.student_booking_action_requests ?? [
        { id: "request-1", studio_id: STUDIO_ID },
      ],
    ),
    student_booking_action_audit_events: table([]),
  };
  const fake = createFakeEntitlementClient(tables);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fake: fake as any, tables };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeApprovedStudentBookingAction -- book", () => {
  it("1. exhausted package blocks the booking with a safe message, no appointment is created", async () => {
    const { fake, tables } = buildClient({
      client_packages: [
        privateLessonPackage({
          client_package_items: [
            { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
          ],
        }),
      ],
    });

    await expect(
      executeApprovedStudentBookingAction({
        supabase: fake,
        actionRequest: baseRequest(),
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/active package or membership/i);

    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("3. a single eligible package auto-selects, persists billing linkage, and creates the appointment", async () => {
    const { fake, tables } = buildClient({ client_packages: [privateLessonPackage()] });

    const appointment = await executeApprovedStudentBookingAction({
      supabase: fake,
      actionRequest: baseRequest(),
      actorUserId: "user-1",
    });

    expect(appointment.id).toBeTruthy();
    const created = tables.appointments.rows.find((r) => r.id === appointment.id);
    expect(created).toMatchObject({
      billing_type: "package_credit",
      client_package_id: "pkg-1",
      client_membership_id: null,
    });
  });

  it("5. a valid membership resolves, persists billing linkage, and creates the appointment", async () => {
    const { fake, tables } = buildClient({
      client_memberships: [
        {
          id: "membership-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          membership_plan_id: "plan-1",
          status: "active",
          current_period_start: "2026-09-01",
          current_period_end: "2026-09-30",
        },
      ],
      membership_plan_benefits: [
        {
          id: "benefit-1",
          membership_plan_id: "plan-1",
          benefit_type: "included_private_lessons",
          applies_to: "all",
          quantity: 4,
          sort_order: 1,
        },
      ],
    });

    const appointment = await executeApprovedStudentBookingAction({
      supabase: fake,
      actionRequest: baseRequest(),
      actorUserId: "user-1",
    });

    const created = tables.appointments.rows.find((r) => r.id === appointment.id);
    expect(created).toMatchObject({
      billing_type: "membership",
      client_package_id: null,
      client_membership_id: "membership-1",
    });
  });

  it("13. multiple eligible packages block with a safe, non-technical message", async () => {
    const { fake, tables } = buildClient({
      client_packages: [privateLessonPackage({ id: "pkg-1" }), privateLessonPackage({ id: "pkg-2" })],
    });

    await expect(
      executeApprovedStudentBookingAction({
        supabase: fake,
        actionRequest: baseRequest(),
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/more than one package/i);

    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("14. package + membership both eligible block with a safe, non-technical message", async () => {
    const { fake, tables } = buildClient({
      client_packages: [privateLessonPackage()],
      client_memberships: [
        {
          id: "membership-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          membership_plan_id: "plan-1",
          status: "active",
          current_period_start: "2026-09-01",
          current_period_end: "2026-09-30",
        },
      ],
      membership_plan_benefits: [
        {
          id: "benefit-1",
          membership_plan_id: "plan-1",
          benefit_type: "included_private_lessons",
          applies_to: "all",
          quantity: 4,
          sort_order: 1,
        },
      ],
    });

    await expect(
      executeApprovedStudentBookingAction({
        supabase: fake,
        actionRequest: baseRequest(),
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/both a package and a membership/i);

    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("8. self-service booking never produces a pay_as_you_go appointment (structural guard)", async () => {
    const { fake, tables } = buildClient({ client_packages: [privateLessonPackage()] });

    await executeApprovedStudentBookingAction({
      supabase: fake,
      actionRequest: baseRequest(),
      actorUserId: "user-1",
    });

    expect(tables.appointments.rows.every((r) => r.billing_type !== "pay_as_you_go")).toBe(true);
  });

  it("9. the persisted linkage matches what attendance-time deduction requires (non-null client_package_id, non-pay_as_you_go billing_type)", async () => {
    // `syncPackageUsageForAttendedAppointment` and
    // `packageHasAvailableCreditForAttendance` (schedule/actions.ts, out of
    // Slice 1's scope, already covered by their own test suites) both gate
    // strictly on `client_package_id` being non-null for a package-billed
    // appointment. This asserts the self-service write actually produces
    // that shape, so the existing attendance pipeline picks it up
    // unmodified rather than silently no-op'ing the way it did pre-Slice-1.
    const { fake, tables } = buildClient({ client_packages: [privateLessonPackage()] });

    const appointment = await executeApprovedStudentBookingAction({
      supabase: fake,
      actionRequest: baseRequest(),
      actorUserId: "user-1",
    });

    const created = tables.appointments.rows.find((r) => r.id === appointment.id);
    expect(created?.client_package_id).toBe("pkg-1");
    expect(created?.billing_type).toBe("package_credit");
  });

  it("10. a package belonging to a different studio can never be linked, even with a spoofed id present in the table", async () => {
    const { fake, tables } = buildClient({
      client_packages: [privateLessonPackage({ studio_id: OTHER_STUDIO_ID })],
    });

    await expect(
      executeApprovedStudentBookingAction({
        supabase: fake,
        actionRequest: baseRequest(),
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/active package or membership/i);

    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("12. a database failure during entitlement resolution fails closed with a sanitized error", async () => {
    const { fake, tables } = buildClient({ client_packages: [] });
    tables.client_packages.forceError = { message: "relation does not exist", code: "42P01" };

    await expect(
      executeApprovedStudentBookingAction({
        supabase: fake,
        actionRequest: baseRequest(),
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/couldn't verify your booking eligibility/i);

    expect(tables.appointments.rows).toHaveLength(0);
  });
});

describe("executeApprovedStudentBookingAction -- reschedule", () => {
  it("11a. preserves the existing valid package linkage unchanged, even though another package is also eligible", async () => {
    const { fake, tables } = buildClient({
      client_packages: [
        privateLessonPackage({ id: "pkg-existing" }),
        privateLessonPackage({ id: "pkg-other-also-eligible" }),
      ],
      appointments: [
        {
          id: "appt-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          billing_type: "package_credit",
          client_package_id: "pkg-existing",
          client_membership_id: null,
        },
      ],
    });

    await executeApprovedStudentBookingAction({
      supabase: fake,
      actionRequest: baseRequest({
        action_type: "reschedule",
        appointment_id: "appt-1",
      }),
      actorUserId: "user-1",
    });

    const updated = tables.appointments.rows.find((r) => r.id === "appt-1");
    expect(updated).toMatchObject({
      billing_type: "package_credit",
      client_package_id: "pkg-existing",
      client_membership_id: null,
    });
  });

  it("11b. re-resolves fresh when the existing linkage no longer covers the new date", async () => {
    const { fake, tables } = buildClient({
      client_packages: [privateLessonPackage({ id: "pkg-fresh" })],
      appointments: [
        {
          id: "appt-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          billing_type: "package_credit",
          client_package_id: "pkg-stale-expired",
          client_membership_id: null,
        },
      ],
    });

    await executeApprovedStudentBookingAction({
      supabase: fake,
      actionRequest: baseRequest({
        action_type: "reschedule",
        appointment_id: "appt-1",
      }),
      actorUserId: "user-1",
    });

    const updated = tables.appointments.rows.find((r) => r.id === "appt-1");
    expect(updated).toMatchObject({
      billing_type: "package_credit",
      client_package_id: "pkg-fresh",
    });
  });

  it("reschedule fails closed when fresh resolution is required and finds nothing eligible", async () => {
    const { fake, tables } = buildClient({
      client_packages: [],
      appointments: [
        {
          id: "appt-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          billing_type: null,
          client_package_id: null,
          client_membership_id: null,
        },
      ],
    });

    await expect(
      executeApprovedStudentBookingAction({
        supabase: fake,
        actionRequest: baseRequest({
          action_type: "reschedule",
          appointment_id: "appt-1",
        }),
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/active package or membership/i);

    const updated = tables.appointments.rows.find((r) => r.id === "appt-1");
    expect(updated?.starts_at).toBeUndefined();
  });
});
