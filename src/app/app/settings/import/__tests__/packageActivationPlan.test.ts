import { describe, expect, it } from "vitest";

import {
  computePackageImportActivationPlan,
  PACKAGE_IMPORT_ACTIVATION_OR_FILTER,
  type PackageImportSyncFields,
} from "@/app/app/settings/import/packageActivationPlan";

const FIELDS: PackageImportSyncFields = {
  clientId: "client-1",
  packageTemplateId: "template-1",
  name: "10-pack",
  price: 200,
  purchaseDate: "2026-01-01",
  expirationDate: "2026-12-31",
  importedAt: "2026-08-17T00:00:00.000Z",
};

describe("Package Refund P0, Slice 2b: computePackageImportActivationPlan", () => {
  it("full-refund package: ordinary fields still sync with active:false (Update A), and Update B is still issued but carries the live NULL-safe predicate that is the actual authority preventing activation", () => {
    const plan = computePackageImportActivationPlan({
      fields: FIELDS,
      desiredActive: true,
      existingRefundStatus: "full",
    });

    expect(plan.syncPayload).toMatchObject({
      client_id: "client-1",
      package_template_id: "template-1",
      name_snapshot: "10-pack",
      price_snapshot: 200,
      purchase_date: "2026-01-01",
      expiration_date: "2026-12-31",
      imported_at: "2026-08-17T00:00:00.000Z",
    });
    // Defensive normalization: Update A proactively sets active:false for a
    // known-fully-refunded package, even though the import data alone would
    // otherwise call for activation. This is a first defensive layer, not
    // the sole protection.
    expect(plan.syncPayload.active).toBe(false);
    // Update B is unconditional on desiredActive alone -- per the approved
    // plan, it must NOT be skipped just because this JS-side read believed
    // the package was refunded (that belief could be stale by write time).
    // Its own live NULL-safe predicate, re-checked at write time, is the
    // actual authority that prevents activation -- not this plan object.
    expect(plan.activation).toEqual({
      payload: { active: true },
      orFilter: PACKAGE_IMPORT_ACTIVATION_OR_FILTER,
    });
  });

  it("null-refund package: ordinary fields sync and activation write is issued with the NULL-safe predicate", () => {
    const plan = computePackageImportActivationPlan({
      fields: FIELDS,
      desiredActive: true,
      existingRefundStatus: null,
    });

    expect(plan.syncPayload.active).toBeUndefined();
    expect(plan.activation).toEqual({
      payload: { active: true },
      orFilter: PACKAGE_IMPORT_ACTIVATION_OR_FILTER,
    });
  });

  it("partial-refund package: activation write is still issued (no hard block for partial)", () => {
    const plan = computePackageImportActivationPlan({
      fields: FIELDS,
      desiredActive: true,
      existingRefundStatus: "partial",
    });

    expect(plan.syncPayload.active).toBeUndefined();
    expect(plan.activation).toEqual({
      payload: { active: true },
      orFilter: PACKAGE_IMPORT_ACTIVATION_OR_FILTER,
    });
  });

  it("should-be-inactive package (depleted/expired per import data): Update A alone sets active:false, Update B is never issued, regardless of refund state", () => {
    const plan = computePackageImportActivationPlan({
      fields: FIELDS,
      desiredActive: false,
      existingRefundStatus: null,
    });

    expect(plan.syncPayload.active).toBe(false);
    expect(plan.activation).toBeNull();
  });

  it("refund_status/refunded_at are never referenced by either write's payload", () => {
    const plan = computePackageImportActivationPlan({
      fields: FIELDS,
      desiredActive: true,
      existingRefundStatus: "full",
    });

    expect(plan.syncPayload).not.toHaveProperty("refund_status");
    expect(plan.syncPayload).not.toHaveProperty("refunded_at");
    // No activation payload in this case, but assert the shape contract on
    // the sibling non-blocked case too, for completeness.
    const nonBlocked = computePackageImportActivationPlan({
      fields: FIELDS,
      desiredActive: true,
      existingRefundStatus: null,
    });
    expect(nonBlocked.activation?.payload).not.toHaveProperty("refund_status");
    expect(nonBlocked.activation?.payload).not.toHaveProperty("refunded_at");
  });
});
