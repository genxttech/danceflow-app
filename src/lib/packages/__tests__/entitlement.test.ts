import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluatePackageForAppointment,
  formatPackageBalance,
  getClientPackageStatus,
  getEligiblePackagesForAppointment,
  getItemWarningLevel,
  getUnsuppressedWarningUsageTypes,
  getWarningCausingUsageTypes,
  hasReplacementCoverage,
  hasUnsuppressedPackageWarning,
  isPackageEligibleForReactivation,
  isPackageStillEligible,
  packageIneligibleReasonLabel,
  packageUsageTypeForAppointment,
  pickDefaultPackageSelection,
  resolveEligiblePackage,
  validateClientPackageForBooking,
  type PackageWithItems,
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

describe("validateClientPackageForBooking (staff explicit selection: the canonical rule, no warn-only softening)", () => {
  const validate = (fake: SupabaseClient, clientPackageId: string | null, appointmentDate = "2026-09-01") =>
    validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId,
      appointmentType: "private_lesson",
      appointmentDate,
    });

  it("passes through with no error when no clientPackageId is supplied (booking without a package)", async () => {
    const { fake } = buildClient([]);
    expect(await validate(fake, null)).toEqual({ ok: true });
  });

  it("accepts an eligible finite package and an unlimited one", async () => {
    expect(await validate(buildClient([privateLessonPackage()]).fake, "pkg-1")).toEqual({ ok: true });
    const unlimited = privateLessonPackage({
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: true }],
    });
    expect(await validate(buildClient([unlimited]).fake, "pkg-1")).toEqual({ ok: true });
  });

  it.each([true, false])(
    "rejects a depleted package whatever block_depleted_package_booking says (setting=%s)",
    async (block) => {
      const { fake } = buildClient(
        [
          privateLessonPackage({
            client_package_items: [
              { usage_type: "private_lesson", quantity_remaining: 0, quantity_total: 5, is_unlimited: false },
            ],
          }),
        ],
        [{ studio_id: STUDIO_ID, block_depleted_package_booking: block }],
      );
      expect(await validate(fake, "pkg-1")).toEqual({ ok: false, error: expect.stringMatching(/no remaining balance/) });
    },
  );

  it("rejects an inactive package and an archived one", async () => {
    expect((await validate(buildClient([privateLessonPackage({ active: false })]).fake, "pkg-1")).ok).toBe(false);
    expect(
      (await validate(buildClient([privateLessonPackage({ archived_at: "2026-08-01T00:00:00Z" })]).fake, "pkg-1")).ok,
    ).toBe(false);
  });

  it("respects the appointment date for expiry (valid through the expiration date, rejected after)", async () => {
    const expiring = buildClient([privateLessonPackage({ expiration_date: "2026-09-01" })]).fake;
    expect(await validate(expiring, "pkg-1", "2026-09-01")).toEqual({ ok: true });
    expect(await validate(expiring, "pkg-1", "2026-09-02")).toEqual({
      ok: false,
      error: expect.stringMatching(/expired for this appointment date/),
    });
  });

  it("rejects a package with no item for this appointment's usage type", async () => {
    const groupOnly = privateLessonPackage({
      client_package_items: [{ usage_type: "group_class", quantity_remaining: 8, is_unlimited: false }],
    });
    expect(await validate(buildClient([groupOnly]).fake, "pkg-1")).toEqual({
      ok: false,
      error: expect.stringMatching(/does not cover this type of appointment/),
    });
  });

  it("blocks a package belonging to a different client, and one from another studio", async () => {
    expect((await validate(buildClient([privateLessonPackage({ client_id: OTHER_CLIENT_ID })]).fake, "pkg-1")).ok).toBe(false);
    expect((await validate(buildClient([privateLessonPackage({ studio_id: OTHER_STUDIO_ID })]).fake, "pkg-1")).ok).toBe(false);
  });

  it("does not depend on studio settings at all (no settings row needed)", async () => {
    const { fake } = buildClient([privateLessonPackage()], []);
    expect(await validate(fake, "pkg-1")).toEqual({ ok: true });
  });
});

describe("resolveEligiblePackage -- archived packages (Slice 1b-a regression guard)", () => {
  it("2. an archived package (active=false) with real remaining balance is still excluded from booking entitlement", async () => {
    const { fake } = buildClient([
      privateLessonPackage({
        active: false,
        archived_at: "2026-09-01T00:00:00.000Z",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
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
});

describe("Package Refund P0, Slice 2b: refund_status='full' entitlement block", () => {
  it("resolveEligiblePackage excludes a refund_status='full' package even when active=true and balance>0", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ refund_status: "full" }),
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

  it("resolveEligiblePackage: a refund-blocked package alongside one genuinely eligible package resolves to single_eligible, not multiple_eligible_packages (ambiguity-ordering regression)", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ id: "pkg-1", refund_status: "full" }),
      privateLessonPackage({ id: "pkg-2", refund_status: null }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("single_eligible");
    expect(result).toMatchObject({ clientPackageId: "pkg-2" });
  });

  it("resolveEligiblePackage: a refund_status='partial' package is still eligible (no hard block)", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ refund_status: "partial" }),
    ]);

    const result = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });

    expect(result.outcome).toBe("single_eligible");
  });

  it("isPackageStillEligible reports ineligible once the linked package becomes refund_status='full'", async () => {
    const { fake } = buildClient([
      privateLessonPackage({ refund_status: "full" }),
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

  it("validateClientPackageForBooking blocks a refund_status='full' package even though active=true and balance>0", async () => {
    const { fake } = buildClient([privateLessonPackage({ refund_status: "full" })]);

    const result = await validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
      appointmentType: "private_lesson",
      appointmentDate: "2026-09-01",
    });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/refunded/) });
  });

  it("validateClientPackageForBooking blocks a refund_status='full' package even when block_depleted_package_booking=false (the critical bug regression)", async () => {
    const { fake } = buildClient(
      [privateLessonPackage({ refund_status: "full" })],
      [{ studio_id: STUDIO_ID, block_depleted_package_booking: false }],
    );

    const result = await validateClientPackageForBooking({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
      appointmentType: "private_lesson",
      appointmentDate: "2026-09-01",
    });

    expect(result.ok).toBe(false);
  });

  it("validateClientPackageForBooking: a refund_status='partial' package follows the ordinary rules (no hard block of its own)", async () => {
    const partialWithBalance = buildClient([privateLessonPackage({ refund_status: "partial" })]).fake;
    const partialDepleted = buildClient([
      privateLessonPackage({
        refund_status: "partial",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 0, quantity_total: 5, is_unlimited: false },
        ],
      }),
    ]).fake;
    const call = (fake: SupabaseClient) =>
      validateClientPackageForBooking({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
        appointmentType: "private_lesson",
        appointmentDate: "2026-09-01",
      });

    expect(await call(partialWithBalance)).toEqual({ ok: true });
    // Blocked for the ordinary depletion reason, not the refund reason.
    expect(await call(partialDepleted)).toEqual({ ok: false, error: expect.stringMatching(/no remaining balance/) });
  });
});

describe("getClientPackageStatus", () => {
  it("archived_at set takes precedence over every other state", () => {
    const status = getClientPackageStatus({
      archived_at: "2026-09-01T00:00:00.000Z",
      expiration_date: "2020-01-01",
      client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
    });
    expect(status).toBe("archived");
  });

  it("6. a manually archived package that was already depleted shows Archived, not Depleted", () => {
    const status = getClientPackageStatus({
      archived_at: "2026-09-01T00:00:00.000Z",
      expiration_date: null,
      client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
    });
    expect(status).toBe("archived");
  });

  it("6b. a manually archived package that was already expired shows Archived, not Expired", () => {
    const status = getClientPackageStatus({
      archived_at: "2026-09-01T00:00:00.000Z",
      expiration_date: "2020-01-01",
      client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
    });
    expect(status).toBe("archived");
  });

  it("4. a naturally depleted package (never archived) shows Depleted, not Archived", () => {
    const status = getClientPackageStatus({
      archived_at: null,
      expiration_date: null,
      client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
    });
    expect(status).toBe("depleted");
  });

  it("depleted is computed from real balance across items (OR), not a single item", () => {
    const status = getClientPackageStatus({
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { quantity_remaining: 0, is_unlimited: false },
        { quantity_remaining: null, is_unlimited: true },
      ],
    });
    expect(status).toBe("active");
  });

  it("5. an expired, non-archived, non-depleted package shows Expired", () => {
    const status = getClientPackageStatus({
      archived_at: null,
      expiration_date: "2020-01-01",
      client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
    });
    expect(status).toBe("expired");
  });

  it("a package with exactly 1 remaining on its lowest finite item shows Low", () => {
    const status = getClientPackageStatus({
      archived_at: null,
      expiration_date: null,
      client_package_items: [{ quantity_remaining: 1, is_unlimited: false }],
    });
    expect(status).toBe("low");
  });

  it("a healthy package with balance above the low threshold shows Active", () => {
    const status = getClientPackageStatus({
      archived_at: null,
      expiration_date: null,
      client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
    });
    expect(status).toBe("active");
  });
});

describe("isPackageEligibleForReactivation", () => {
  it("7. a package with usable balance and no expiration is eligible when payment is settled", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: null,
        refund_status: null,
        client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
      }, true),
    ).toBe(true);
  });

  it("8. a zero-balance package is not eligible for reactivation", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: null,
        refund_status: null,
        client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
      }, true),
    ).toBe(false);
  });

  it("9. an expired package is not eligible for reactivation even with remaining balance", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: "2020-01-01",
        refund_status: null,
        client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
      }, true),
    ).toBe(false);
  });

  it("an unlimited package is eligible regardless of quantity_remaining", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: null,
        refund_status: null,
        client_package_items: [{ quantity_remaining: null, is_unlimited: true }],
      }, true),
    ).toBe(true);
  });

  it("Package Refund P0, Slice 2b: a refund_status='full' package is never eligible for reactivation, even with usable balance and no expiration", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: null,
        refund_status: "full",
        client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
      }, true),
    ).toBe(false);
  });

  it("Package Refund P0, Slice 2b: a refund_status='partial' package follows ordinary eligibility rules (no hard block)", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: null,
        refund_status: "partial",
        client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
      }, true),
    ).toBe(true);
  });

  it("PKG-P1: an otherwise-eligible package is blocked when its payment is not settled", () => {
    expect(
      isPackageEligibleForReactivation({
        expiration_date: null,
        refund_status: null,
        client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
      }, false),
    ).toBe(false);
  });
});

describe("getItemWarningLevel", () => {
  it("a finite item at 0 is depleted", () => {
    expect(getItemWarningLevel({ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false })).toBe(
      "depleted",
    );
  });

  it("a finite item at exactly 1 is low", () => {
    expect(getItemWarningLevel({ usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false })).toBe(
      "low",
    );
  });

  it("a finite item above 1 is neither low nor depleted", () => {
    expect(getItemWarningLevel({ usage_type: "private_lesson", quantity_remaining: 2, is_unlimited: false })).toBe(
      null,
    );
  });

  it("an unlimited item is never low or depleted, regardless of quantity_remaining", () => {
    expect(
      getItemWarningLevel({ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: true }),
    ).toBe(null);
  });
});

describe("getWarningCausingUsageTypes", () => {
  it("a package with two warning-causing usage types returns both", () => {
    const pkg: PackageWithItems = {
      id: "pkg-1",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
        { usage_type: "group_class", quantity_remaining: 0, is_unlimited: false },
      ],
    };
    expect(getWarningCausingUsageTypes(pkg).sort()).toEqual(["group_class", "private_lesson"]);
  });

  it("a healthy item's usage type is excluded even alongside a warning-causing one", () => {
    const pkg: PackageWithItems = {
      id: "pkg-1",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
        { usage_type: "group_class", quantity_remaining: 5, is_unlimited: false },
      ],
    };
    expect(getWarningCausingUsageTypes(pkg)).toEqual(["private_lesson"]);
  });
});

describe("packageProvidesCoverageForUsageType / hasReplacementCoverage (Slice 1b-b canonical replacement-coverage helper)", () => {
  function coveragePackage(overrides: Partial<PackageWithItems> = {}): PackageWithItems {
    return {
      id: "replacement-1",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
      ...overrides,
    };
  }

  it("low package, no replacement -> not suppressed", () => {
    expect(hasReplacementCoverage({ candidatePackages: [], usageType: "private_lesson" })).toBe(false);
  });

  it("depleted package, no replacement -> not suppressed", () => {
    expect(hasReplacementCoverage({ candidatePackages: [], usageType: "private_lesson" })).toBe(false);
  });

  it("healthy same-usage replacement -> suppressed", () => {
    expect(
      hasReplacementCoverage({ candidatePackages: [coveragePackage()], usageType: "private_lesson" }),
    ).toBe(true);
  });

  it("healthy but unrelated-usage-type replacement -> not suppressed", () => {
    const replacement = coveragePackage({
      client_package_items: [{ usage_type: "group_class", quantity_remaining: 5, is_unlimited: false }],
    });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      false,
    );
  });

  it("archived replacement -> not suppressed", () => {
    const replacement = coveragePackage({ archived_at: "2026-09-01T00:00:00.000Z" });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      false,
    );
  });

  it("expired replacement -> not suppressed", () => {
    const replacement = coveragePackage({ expiration_date: "2020-01-01" });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      false,
    );
  });

  it("inactive (not archived) replacement -> not suppressed", () => {
    const replacement = coveragePackage({ active: false });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      false,
    );
  });

  it("replacement itself depleted -> not suppressed", () => {
    const replacement = coveragePackage({
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false }],
    });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      false,
    );
  });

  it("replacement that is itself low (remaining=1, not depleted) still counts as coverage", () => {
    const replacement = coveragePackage({
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false }],
    });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      true,
    );
  });

  it("unlimited same-usage replacement -> suppressed", () => {
    const replacement = coveragePackage({
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true }],
    });
    expect(hasReplacementCoverage({ candidatePackages: [replacement], usageType: "private_lesson" })).toBe(
      true,
    );
  });

  it("multiple healthy replacements -> suppressed, and the function returns a bare boolean, never a package reference", () => {
    const result = hasReplacementCoverage({
      candidatePackages: [coveragePackage({ id: "r1" }), coveragePackage({ id: "r2" })],
      usageType: "private_lesson",
    });
    expect(result).toBe(true);
    expect(typeof result).toBe("boolean");
  });
});

describe("getUnsuppressedWarningUsageTypes / hasUnsuppressedPackageWarning (Slice 1b-b usage-type completeness)", () => {
  function multiUsageTypePackage(overrides: Partial<PackageWithItems> = {}): PackageWithItems {
    return {
      id: "target-1",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
        { usage_type: "group_class", quantity_remaining: 0, is_unlimited: false },
      ],
      ...overrides,
    };
  }

  it("two warning-causing usage types, replacement covers only one -> the uncovered one remains", () => {
    const target = multiUsageTypePackage();
    const replacement: PackageWithItems = {
      id: "replacement-private",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    };

    const unsuppressed = getUnsuppressedWarningUsageTypes({
      targetPackage: target,
      otherClientPackages: [replacement],
    });
    expect(unsuppressed).toEqual(["group_class"]);
    expect(hasUnsuppressedPackageWarning({ targetPackage: target, otherClientPackages: [replacement] })).toBe(
      true,
    );
  });

  it("two warning-causing usage types, separate replacements collectively cover both -> fully suppressed, no package selected", () => {
    const target = multiUsageTypePackage();
    const replacementPrivate: PackageWithItems = {
      id: "replacement-private",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    };
    const replacementGroup: PackageWithItems = {
      id: "replacement-group",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [{ usage_type: "group_class", quantity_remaining: 3, is_unlimited: false }],
    };

    const unsuppressed = getUnsuppressedWarningUsageTypes({
      targetPackage: target,
      otherClientPackages: [replacementPrivate, replacementGroup],
    });
    expect(unsuppressed).toEqual([]);
    expect(
      hasUnsuppressedPackageWarning({
        targetPackage: target,
        otherClientPackages: [replacementPrivate, replacementGroup],
      }),
    ).toBe(false);
    // Neither helper returns anything other than usage types / a boolean -- no package
    // reference is ever produced, so nothing here could be mistaken for a booking selection.
    expect(unsuppressed.every((usageType) => typeof usageType === "string")).toBe(true);
  });

  it("unlimited replacement covering only one usage type suppresses just that one", () => {
    const target = multiUsageTypePackage();
    const unlimitedPrivateOnly: PackageWithItems = {
      id: "replacement-unlimited",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true },
      ],
    };

    const unsuppressed = getUnsuppressedWarningUsageTypes({
      targetPackage: target,
      otherClientPackages: [unlimitedPrivateOnly],
    });
    expect(unsuppressed).toEqual(["group_class"]);
  });

  it("a single-usage-type low package with a healthy same-usage replacement is fully suppressed", () => {
    const target: PackageWithItems = {
      id: "target-2",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
      ],
    };
    const replacement: PackageWithItems = {
      id: "replacement-1",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    };

    expect(hasUnsuppressedPackageWarning({ targetPackage: target, otherClientPackages: [replacement] })).toBe(
      false,
    );
  });

  it("a healthy package (no warning-causing usage types) has no unsuppressed warning regardless of replacements", () => {
    const target: PackageWithItems = {
      id: "target-3",
      active: true,
      archived_at: null,
      expiration_date: null,
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    };

    expect(hasUnsuppressedPackageWarning({ targetPackage: target, otherClientPackages: [] })).toBe(false);
  });

  it("a caller accidentally including the target package itself in otherClientPackages does not self-suppress", () => {
    const target = multiUsageTypePackage({
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false }],
    });

    // Without the defensive self-id exclusion, the target's own item (remaining=1, >0)
    // would satisfy packageProvidesCoverageForUsageType and incorrectly "cover itself,"
    // suppressing its own warning. This proves getUnsuppressedWarningUsageTypes filters
    // targetPackage.id out of the candidate set even when a caller passes it in by mistake.
    const unsuppressed = getUnsuppressedWarningUsageTypes({
      targetPackage: target,
      otherClientPackages: [target],
    });
    expect(unsuppressed).toEqual(["private_lesson"]);
  });
});

describe("canonical scheduling eligibility (picker helpers shared by the forms and the server)", () => {
  const DATE = "2026-09-01";
  const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name_snapshot: `Package ${id}`,
    active: true,
    archived_at: null,
    expiration_date: null,
    refund_status: null,
    client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 6, is_unlimited: false }],
    ...overrides,
  });
  const eligibleIds = (packages: ReturnType<typeof candidate>[], date = DATE, appointmentType = "private_lesson") =>
    getEligiblePackagesForAppointment(packages, { appointmentType, appointmentDate: date }).map((o) => o.id);

  it("maps every appointment type to its single package usage type (one canonical mapping)", () => {
    expect(packageUsageTypeForAppointment("private_lesson")).toBe("private_lesson");
    expect(packageUsageTypeForAppointment("intro_lesson")).toBe("private_lesson");
    expect(packageUsageTypeForAppointment("coaching")).toBe("private_lesson");
    expect(packageUsageTypeForAppointment("group_class")).toBe("group_class");
    expect(packageUsageTypeForAppointment("practice_party")).toBe("practice_party");
    expect(packageUsageTypeForAppointment("event")).toBe("practice_party");
    expect(packageUsageTypeForAppointment("floor_space_rental")).toBeNull();
    expect(packageUsageTypeForAppointment("room_unavailable")).toBeNull();
  });

  it("includes an active finite package with its remaining count for the matching usage type only", () => {
    const pkg = candidate("a", {
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: "6", is_unlimited: false },
        { usage_type: "group_class", quantity_remaining: 20, is_unlimited: false },
      ],
    });
    const [option] = getEligiblePackagesForAppointment([pkg], { appointmentType: "private_lesson", appointmentDate: DATE });
    expect(option).toEqual({ id: "a", name: "Package a", isUnlimited: false, remaining: 6 });
    expect(formatPackageBalance(option)).toBe("6 remaining");
  });

  it("includes an unlimited package as Unlimited", () => {
    const pkg = candidate("u", {
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: true }],
    });
    const [option] = getEligiblePackagesForAppointment([pkg], { appointmentType: "coaching", appointmentDate: DATE });
    expect(option).toMatchObject({ id: "u", isUnlimited: true, remaining: null });
    expect(formatPackageBalance(option)).toBe("Unlimited");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["depleted", { client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false }] }, "depleted"],
    ["expired", { expiration_date: "2026-08-31" }, "expired"],
    ["inactive", { active: false }, "inactive"],
    ["archived", { archived_at: "2026-08-01T00:00:00Z" }, "archived"],
    ["fully refunded", { refund_status: "full" }, "refunded"],
    ["wrong usage type", { client_package_items: [{ usage_type: "practice_party", quantity_remaining: 3, is_unlimited: false }] }, "no_matching_usage"],
  ])("excludes a %s package (reason recorded)", (_label, overrides, reason) => {
    const pkg = candidate("x", overrides);
    expect(eligibleIds([pkg])).toEqual([]);
    expect(evaluatePackageForAppointment(pkg, "private_lesson", DATE)).toEqual({ eligible: false, reason });
  });

  it("respects the appointment date: eligible through the expiration date, not after", () => {
    const pkg = candidate("e", { expiration_date: "2026-09-01" });
    expect(eligibleIds([pkg], "2026-09-01")).toEqual(["e"]);
    expect(eligibleIds([pkg], "2026-09-02")).toEqual([]);
  });

  it("selection: one eligible auto-selects, several are never guessed, none is an empty state", () => {
    expect(pickDefaultPackageSelection([])).toEqual({ kind: "none" });
    const one = getEligiblePackagesForAppointment([candidate("a"), candidate("d", { active: false })], {
      appointmentType: "private_lesson",
      appointmentDate: DATE,
    });
    expect(pickDefaultPackageSelection(one)).toEqual({ kind: "single", packageId: "a" });
    const many = getEligiblePackagesForAppointment([candidate("a"), candidate("b")], {
      appointmentType: "private_lesson",
      appointmentDate: DATE,
    });
    expect(pickDefaultPackageSelection(many)).toEqual({ kind: "multiple" });
  });

  it("labels a preserved historical link's state for the edit form", () => {
    expect(packageIneligibleReasonLabel("depleted")).toBe("no remaining balance");
    expect(packageIneligibleReasonLabel("expired")).toBe("expired");
  });

  it("self-service auto-selection (resolveEligiblePackage) agrees with the picker rule", async () => {
    const rows = [
      privateLessonPackage({ id: "ok", client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 2, is_unlimited: false }] }),
      privateLessonPackage({ id: "gone", client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false }] }),
      privateLessonPackage({ id: "old", expiration_date: "2026-08-01" }),
      privateLessonPackage({ id: "arch", archived_at: "2026-08-01T00:00:00Z" }),
    ];
    const { fake } = buildClient(rows);
    const resolved = await resolveEligiblePackage({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentType: "private_lesson",
      appointmentDateIso: APPOINTMENT_DATE_ISO,
    });
    expect(resolved).toEqual({ outcome: "single_eligible", clientPackageId: "ok", remaining: 2 });
    expect(eligibleIds(rows as ReturnType<typeof candidate>[], APPOINTMENT_DATE_ISO.slice(0, 10))).toEqual(["ok"]);
  });
});
