import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isPackageStillEligible,
  resolveEligiblePackage,
  validateClientPackageForBooking,
} from "@/lib/packages/entitlement";
import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

const STUDIO_ID = "studio-1";
const OTHER_STUDIO_ID = "studio-2";
const CLIENT_ID = "client-1";
const OTHER_CLIENT_ID = "client-2";
const APPOINTMENT_DATE_ISO = "2026-09-01T10:00:00.000Z";

function makePackagesTable(rows: Row[]) {
  const table = new FakeTable();
  table.rows = rows;
  return table;
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

function buildClient(packagesRows: Row[], settingsRows: Row[] = []) {
  const client_packages = makePackagesTable(packagesRows);
  const studio_settings = makePackagesTable(settingsRows);
  const fake = createFakeEntitlementClient({ client_packages, studio_settings });
  return { fake: fake as unknown as SupabaseClient, tables: { client_packages, studio_settings } };
}

describe("resolveEligiblePackage", () => {
  it("1. exhausted package (quantity_remaining=0) is not eligible", async () => {
    const { fake } = buildClient([
      privateLessonPackage({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
        ],
      }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("none_eligible");
  });

  it("2. expired package is not eligible", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ expiration_date: "2026-01-01" }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("none_eligible");
  });

  it("3. a single eligible package auto-resolves with its id and remaining balance", async () => {
    const { fake } = buildClient([privateLessonPackage()]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ outcome: "single_eligible", clientPackageId: "pkg-1", remaining: 3 });
  });

  it("13. two equally-eligible packages fail closed with multiple_eligible_packages, not a guess", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ id: "pkg-1" }),
      privateLessonPackage({ id: "pkg-2" }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("multiple_eligible_packages");
    if (result.outcome === "multiple_eligible_packages") {
      expect([...result.clientPackageIds].sort()).toEqual(["pkg-1", "pkg-2"]);
    }
  });

  it("15. a package at zero balance is ineligible even when active=true (not yet reconciled)", async () => {
    const { fake } = buildClient([
      privateLessonPackage({
        active: true,
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
        ],
      }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("none_eligible");
  });

  it("an unlimited item is eligible with remaining=null regardless of quantity_remaining", async () => {
    const { fake } = buildClient([
      privateLessonPackage({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true },
        ],
      }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ outcome: "single_eligible", clientPackageId: "pkg-1", remaining: null });
  });

  it("a package whose only remaining item is a different usage type is ineligible", async () => {
    const { fake } = buildClient([
      privateLessonPackage({
        client_package_items: [
          { usage_type: "group_class", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("none_eligible");
  });

  it("10. a package belonging to a different studio/client is never returned even if the id is spoofed", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ studio_id: OTHER_STUDIO_ID }),
      privateLessonPackage({ id: "pkg-2", client_id: OTHER_CLIENT_ID }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("none_eligible");
  });

  it("12. a database lookup failure fails closed with a sanitized error, not a false negative", async () => {
    const client_packages = makePackagesTable([]);
    client_packages.forceError = { message: "relation does not exist", code: "42P01" };
    const fake = createFakeEntitlementClient({ client_packages, studio_settings: makePackagesTable([]) });

    const result = await resolveEligiblePackage({
      supabase: fake as unknown as SupabaseClient,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("lookup_failed");
    if (result.outcome === "lookup_failed") {
      expect(result.error).not.toMatch(/relation does not exist|42P01/);
    }
  });
});

describe("isPackageStillEligible (reschedule preserve-linkage check)", () => {
  it("11a. an existing package still eligible for the new date is reported eligible", async () => {
    const { fake } = buildClient([privateLessonPackage()]);

    const result = await isPackageStillEligible({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ ok: true, eligible: true });
  });

  it("11b. an existing package that no longer covers the new date (expired) is reported ineligible", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ expiration_date: "2026-01-01" }),
    ]);

    const result = await isPackageStillEligible({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ ok: true, eligible: false });
  });

  it("reports ineligible (not an error) when the package id no longer exists", async () => {
    const { fake } = buildClient([]);

    const result = await isPackageStillEligible({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "missing-pkg",
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result).toEqual({ ok: true, eligible: false });
  });
});

describe("validateClientPackageForBooking (staff explicit-selection validator, unchanged behavior)", () => {
  it("passes through with no error when no clientPackageId is supplied", async () => {
    const { fake } = buildClient([], [{ studio_id: STUDIO_ID, block_depleted_package_booking: true }]);

    const result = await validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: null,
    });

    expect(result).toEqual({ ok: true });
  });

  it("blocks a depleted package when block_depleted_package_booking is on", async () => {
    const { fake } = buildClient(
      [
        privateLessonPackage({
          client_package_items: [
            { usage_type: "private_lesson", quantity_remaining: 0, quantity_total: 5, is_unlimited: false },
          ],
        }),
      ],
      [{ studio_id: STUDIO_ID, block_depleted_package_booking: true }],
    );

    const result = await validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    expect(result.ok).toBe(false);
  });

  it("does not block a depleted package when block_depleted_package_booking is off (existing soft-gate behavior)", async () => {
    const { fake } = buildClient(
      [
        privateLessonPackage({
          client_package_items: [
            { usage_type: "private_lesson", quantity_remaining: 0, quantity_total: 5, is_unlimited: false },
          ],
        }),
      ],
      [{ studio_id: STUDIO_ID, block_depleted_package_booking: false }],
    );

    const result = await validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    expect(result).toEqual({ ok: true });
  });

  it("blocks a package belonging to a different client", async () => {
    const { fake } = buildClient(
      [privateLessonPackage({ client_id: OTHER_CLIENT_ID })],
      [{ studio_id: STUDIO_ID, block_depleted_package_booking: true }],
    );

    const result = await validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    expect(result.ok).toBe(false);
  });
});
