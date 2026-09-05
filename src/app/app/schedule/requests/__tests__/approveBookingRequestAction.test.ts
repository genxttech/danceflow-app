import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * Regression coverage for Schedule Stabilization Slice 1's
 * booking-request-approval enforcement: `approveBookingRequestAction`
 * previously converted a `booking_requests` row into an appointment with
 * only conflict detection guarding it -- no entitlement check at all, and
 * no billing linkage persisted (see the design doc for the confirmed P0).
 * These tests drive the real action, mocking only what's needed to keep it
 * a unit test: auth guard, `redirect`/`revalidatePath`, and conflict
 * detection (already covered by `src/lib/schedule/__tests__/conflicts.test.ts`,
 * out of scope here). The notification helpers (email/push) are left real
 * but never fire because the fixture has no client email/portal link, which
 * is the same "no recipient, bail early" branch they already have.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
}));

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const STAFF_USER_ID = "staff-1";
const REQUEST_ID = "req-1";
const REQUESTED_STARTS_AT = "2026-09-15T10:00:00.000Z";
const REQUESTED_ENDS_AT = "2026-09-15T11:00:00.000Z";

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

function bookingRequestRow(overrides: Row = {}): Row {
  return {
    id: REQUEST_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    instructor_id: null,
    room_id: null,
    appointment_type: "private_lesson",
    title: "Intro Lesson Request",
    requested_starts_at: REQUESTED_STARTS_AT,
    requested_ends_at: REQUESTED_ENDS_AT,
    notes: null,
    status: "pending",
    source: "portal_schedule",
    ...overrides,
  };
}

type Fixture = {
  booking_requests?: Row[];
  client_packages?: Row[];
  studio_settings?: Row[];
  client_memberships?: Row[];
  client_membership_periods?: Row[];
  membership_plan_benefits?: Row[];
  client_membership_usage?: Row[];
  appointments?: Row[];
};

let currentTables: ReturnType<typeof buildTables>;

function buildTables(fixture: Fixture) {
  return {
    booking_requests: table(fixture.booking_requests ?? [bookingRequestRow()]),
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
    clients: table([]),
    studios: table([]),
    client_account_links: table([]),
    notifications: table([]),
  };
}

function setFixture(fixture: Fixture) {
  currentTables = buildTables(fixture);
  return currentTables;
}

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireAppointmentCreateAccess: async () => ({
    supabase: createFakeEntitlementClient(currentTables),
    studioId: STUDIO_ID,
    user: { id: STAFF_USER_ID },
  }),
}));

// FC-1B5D: queueBookingDecisionEmail/sendBookingDecisionPush/
// queueApprovedInstructorEmail now look up the request's client via the
// admin client (not the RLS-scoped session client) so they keep working
// once instructor direct clients SELECT is narrowed in Phase B -- reuse
// the same fixture tables so `clients: table([])` still governs this path.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeEntitlementClient(currentTables),
}));

const { approveBookingRequestAction } = await import("@/app/app/schedule/requests/actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectRedirect(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected a redirect (NEXT_REDIRECT) but none occurred.");
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approveBookingRequestAction", () => {
  it("1. exhausted package blocks approval; no appointment is created and the request stays pending", async () => {
    const tables = setFixture({
      client_packages: [
        privateLessonPackage({
          client_package_items: [
            { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
          ],
        }),
      ],
    });

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digest).toMatch(/error=/);
    expect(tables.appointments.rows).toHaveLength(0);
    expect(tables.booking_requests.rows[0].status).toBe("pending");
  });

  it("3. a single eligible package auto-selects, persists billing linkage, and approves the request", async () => {
    const tables = setFixture({ client_packages: [privateLessonPackage()] });

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digest).toMatch(/success=approved/);
    expect(tables.appointments.rows).toHaveLength(1);
    expect(tables.appointments.rows[0]).toMatchObject({
      billing_type: "package_credit",
      client_package_id: "pkg-1",
      client_membership_id: null,
    });
    expect(tables.booking_requests.rows[0].status).toBe("approved");
  });

  it("7. a request approved after the client's package was exhausted between request-time and approval-time is blocked at approval (not trusted from request time)", async () => {
    const tables = setFixture({
      client_packages: [
        privateLessonPackage({
          client_package_items: [
            { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
          ],
        }),
      ],
    });

    await expectRedirect(approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })));

    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("13. multiple eligible packages block approval with a distinct, non-technical error", async () => {
    const tables = setFixture({
      client_packages: [privateLessonPackage({ id: "pkg-1" }), privateLessonPackage({ id: "pkg-2" })],
    });

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(decodeURIComponent(digest)).toMatch(/more than one package/i);
    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("14. package + membership both eligible block approval with a distinct, non-technical error", async () => {
    setFixture({
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

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(decodeURIComponent(digest)).toMatch(/both a package and a membership/i);
  });

  it("8. approval never produces a pay_as_you_go appointment (structural guard)", async () => {
    const tables = setFixture({ client_packages: [privateLessonPackage()] });

    await expectRedirect(approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })));

    expect(tables.appointments.rows.every((r) => r.billing_type !== "pay_as_you_go")).toBe(true);
  });

  it("12. a database failure during entitlement resolution fails closed with a sanitized error", async () => {
    const tables = setFixture({ client_packages: [] });
    tables.client_packages.forceError = { message: "relation does not exist", code: "42P01" };

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    const decoded = decodeURIComponent(digest);
    expect(decoded).not.toMatch(/relation does not exist|42P01/);
    expect(tables.appointments.rows).toHaveLength(0);
  });

  it("15. a public_intro request from a brand-new lead with zero packages/memberships is approved without entitlement resolution, preserving pre-Slice-1 behavior", async () => {
    const tables = setFixture({
      booking_requests: [bookingRequestRow({ source: "public_intro", appointment_type: "intro_lesson" })],
      client_packages: [],
      client_memberships: [],
    });

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digest).toMatch(/success=approved/);
    expect(tables.appointments.rows).toHaveLength(1);
    expect(tables.appointments.rows[0]).not.toHaveProperty("client_package_id");
    expect(tables.appointments.rows[0]).not.toHaveProperty("client_membership_id");
    expect(tables.booking_requests.rows[0].status).toBe("approved");
  });

  it("16. a portal_schedule request from an established client with no entitlement is still blocked (entitlement enforcement is not weakened for non-public_intro sources)", async () => {
    const tables = setFixture({
      booking_requests: [bookingRequestRow({ source: "portal_schedule" })],
      client_packages: [],
      client_memberships: [],
    });

    const digest = await expectRedirect(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(decodeURIComponent(digest)).toMatch(/no active package or membership/i);
    expect(tables.appointments.rows).toHaveLength(0);
    expect(tables.booking_requests.rows[0].status).toBe("pending");
  });
});
