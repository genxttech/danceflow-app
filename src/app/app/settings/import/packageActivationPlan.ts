/**
 * Package Refund P0, Slice 2b: pure decision logic for the WellnessLiving/
 * Mindbody package-import re-sync's two-write update split, extracted so
 * it's directly unit-testable without faking the surrounding CSV/batch
 * pipeline (no existing test harness covers any of the ~40 import actions
 * in `actions.ts`, and building one is out of proportion to this slice).
 *
 * Both import sources compute an identical plan; this module is the
 * single source of truth both call sites in `actions.ts` delegate to.
 */

export type PackageImportSyncFields = {
  clientId: string;
  packageTemplateId: string;
  name: string;
  price: number;
  purchaseDate: string | null;
  expirationDate: string | null;
  importedAt: string;
};

export type PackageImportActivationPlan = {
  /**
   * Update A -- the unconditional ordinary-field sync. Never contains
   * `refund_status`/`refunded_at` (not read, not written). Proactively
   * includes `active: false` when the package should be inactive per
   * import data, or when the caller already knows (from a fresh read) the
   * package is fully refunded -- a defensive first layer, not the sole
   * protection.
   */
  syncPayload: Record<string, unknown>;
  /**
   * Update B -- present only when the package should become active.
   * `orFilter` is the exact NULL-safe PostgREST predicate that must be
   * applied to this update; it is the live, sole authority on whether
   * activation is actually allowed, independent of `knownFullyRefunded`
   * (which could be stale by the time this update executes).
   */
  activation: { payload: Record<string, unknown>; orFilter: string } | null;
};

export const PACKAGE_IMPORT_ACTIVATION_OR_FILTER =
  "refund_status.is.null,refund_status.neq.full";

export function computePackageImportActivationPlan(params: {
  fields: PackageImportSyncFields;
  desiredActive: boolean;
  existingRefundStatus: string | null;
}): PackageImportActivationPlan {
  const knownFullyRefunded = params.existingRefundStatus === "full";

  const syncPayload: Record<string, unknown> = {
    client_id: params.fields.clientId,
    package_template_id: params.fields.packageTemplateId,
    name_snapshot: params.fields.name,
    price_snapshot: params.fields.price,
    purchase_date: params.fields.purchaseDate,
    expiration_date: params.fields.expirationDate,
    imported_at: params.fields.importedAt,
  };
  if (!params.desiredActive || knownFullyRefunded) {
    syncPayload.active = false;
  }

  return {
    syncPayload,
    activation: params.desiredActive
      ? { payload: { active: true }, orFilter: PACKAGE_IMPORT_ACTIVATION_OR_FILTER }
      : null,
  };
}
