import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveEntitlementForBooking,
  resolveEntitlementForReschedule,
} from "@/lib/booking/entitlementResolution";
import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const APPOINTMENT_DATE_ISO = "2026-09-15T10:00:00.000Z";

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

function activeMembership(overrides: Row = {}): Row {
  return {
    id: "membership-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    membership_plan_id: "plan-1",
    status: "active",
    current_period_start: "2026-09-01",
    current_period_end: "2026-09-30",
    ...overrides,
  };
}

function benefit(overrides: Row = {}): Row {
  return {
    id: "benefit-1",
    membership_plan_id: "plan-1",
    benefit_type: "included_private_lessons",
    applies_to: "all",
    quantity: 4,
    sort_order: 1,
    ...overrides,
  };
}

type Fixture = {
  client_packages: Row[];
  studio_settings?: Row[];
  client_memberships?: Row[];
  client_membership_periods?: Row[];
  membership_plan_benefits?: Row[];
  client_membership_usage?: Row[];
  appointments?: Row[];
};

function buildClient(fixture: Fixture) {
  const tables = {
    client_packages: table(fixture.client_packages),
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
  };
  const fake = createFakeEntitlementClient(tables);
  return { fake: fake as unknown as SupabaseClient, tables };
}

describe("resolveEntitlementForBooking", () => {
  it("1. no eligible package and no eligible membership -> no_eligible_entitlement", async () => {
    const { fake } = buildClient({ client_packages: [] });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ outcome: "no_eligible_entitlement" });
  });

  it("3. a single eligible package with no membership resolves to package_credit and persists the id", async () => {
    const { fake } = buildClient({ client_packages: [privateLessonPackage()] });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({
      outcome: "resolved",
      billingType: "package_credit",
      clientPackageId: "pkg-1",
      clientMembershipId: null,
    });
  });

  it("5. a valid membership with no eligible package resolves to membership and persists the id", async () => {
    const { fake } = buildClient({
      client_packages: [],
      client_memberships: [activeMembership()],
      membership_plan_benefits: [benefit()],
    });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({
      outcome: "resolved",
      billingType: "membership",
      clientPackageId: null,
      clientMembershipId: "membership-1",
    });
  });

  it("4. a membership with an invalid status (cancelled) blocks even though its period covers the date", async () => {
    const { fake } = buildClient({
      client_packages: [],
      client_memberships: [activeMembership({ status: "canceled" })],
      membership_plan_benefits: [benefit()],
    });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ outcome: "no_eligible_entitlement" });
  });

  it("6. appointment date outside the membership period blocks (no fallback package)", async () => {
    const { fake } = buildClient({
      client_packages: [],
      client_memberships: [
        activeMembership({ current_period_start: "2026-01-01", current_period_end: "2026-01-31" }),
      ],
      membership_plan_benefits: [benefit()],
    });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ outcome: "no_eligible_entitlement" });
  });

  it("13. multiple eligible packages fail closed with multiple_eligible_packages, independent of membership state", async () => {
    const { fake } = buildClient({
      client_packages: [privateLessonPackage({ id: "pkg-1" }), privateLessonPackage({ id: "pkg-2" })],
    });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("multiple_eligible_packages");
  });

  it("14. an eligible package AND an eligible membership fail closed with ambiguous_entitlement_type, observable with both ids", async () => {
    const { fake } = buildClient({
      client_packages: [privateLessonPackage()],
      client_memberships: [activeMembership()],
      membership_plan_benefits: [benefit()],
    });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({
      outcome: "ambiguous_entitlement_type",
      clientPackageId: "pkg-1",
      clientMembershipId: "membership-1",
    });
  });

  it("12. a package lookup failure fails closed with lookup_failed and a sanitized error", async () => {
    const { fake, tables } = buildClient({ client_packages: [] });
    tables.client_packages.forceError = { message: "connection reset", code: "08006" };

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("lookup_failed");
    if (result.outcome === "lookup_failed") {
      expect(result.error).not.toMatch(/connection reset|08006/);
    }
  });

  it("8. self-service resolution never produces pay_as_you_go (structural guard)", async () => {
    const { fake } = buildClient({ client_packages: [privateLessonPackage()] });

    const result = await resolveEntitlementForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    if (result.outcome === "resolved") {
      expect(result.billingType).not.toBe("pay_as_you_go");
    }
  });
});

describe("resolveEntitlementForReschedule", () => {
  it("11a. preserves an existing valid package linkage unchanged; does not re-run auto-selection", async () => {
    const { fake } = buildClient({
      client_packages: [
        privateLessonPackage({ id: "pkg-existing" }),
        privateLessonPackage({ id: "pkg-other-also-eligible" }),
      ],
    });

    const result = await resolveEntitlementForReschedule({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      newAppointmentDateIso: APPOINTMENT_DATE_ISO,
      existingBillingType: "package_credit",
      existingClientPackageId: "pkg-existing",
      existingClientMembershipId: null,
    });

    expect(result).toEqual({
      outcome: "resolved",
      billingType: "package_credit",
      clientPackageId: "pkg-existing",
      clientMembershipId: null,
    });
  });

  it("11b. existing package no longer valid (expired for new date) triggers fresh resolution", async () => {
    const { fake } = buildClient({
      client_packages: [
        privateLessonPackage({ id: "pkg-existing", expiration_date: "2026-01-01" }),
      ],
    });

    const result = await resolveEntitlementForReschedule({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      newAppointmentDateIso: APPOINTMENT_DATE_ISO,
      existingBillingType: "package_credit",
      existingClientPackageId: "pkg-existing",
      existingClientMembershipId: null,
    });

    expect(result).toEqual({ outcome: "no_eligible_entitlement" });
  });

  it("preserves an existing valid membership linkage unchanged", async () => {
    const { fake } = buildClient({
      client_packages: [],
      client_memberships: [activeMembership()],
      membership_plan_benefits: [benefit()],
    });

    const result = await resolveEntitlementForReschedule({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      newAppointmentDateIso: APPOINTMENT_DATE_ISO,
      existingBillingType: "membership",
      existingClientPackageId: null,
      existingClientMembershipId: "membership-1",
    });

    expect(result).toEqual({
      outcome: "resolved",
      billingType: "membership",
      clientPackageId: null,
      clientMembershipId: "membership-1",
    });
  });

  it("no existing linkage (legacy pre-Slice-1 appointment) performs fresh resolution", async () => {
    const { fake } = buildClient({ client_packages: [privateLessonPackage()] });

    const result = await resolveEntitlementForReschedule({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      newAppointmentDateIso: APPOINTMENT_DATE_ISO,
      existingBillingType: null,
      existingClientPackageId: null,
      existingClientMembershipId: null,
    });

    expect(result).toEqual({
      outcome: "resolved",
      billingType: "package_credit",
      clientPackageId: "pkg-1",
      clientMembershipId: null,
    });
  });

  it("fresh resolution after an invalidated linkage still fails closed if the new state is ambiguous/empty", async () => {
    const { fake } = buildClient({
      client_packages: [
        privateLessonPackage({ id: "pkg-existing", expiration_date: "2026-01-01" }),
      ],
    });

    const result = await resolveEntitlementForReschedule({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      newAppointmentDateIso: APPOINTMENT_DATE_ISO,
      existingBillingType: "package_credit",
      existingClientPackageId: "pkg-existing",
      existingClientMembershipId: null,
    });

    expect(result.outcome).toBe("no_eligible_entitlement");
  });
});
