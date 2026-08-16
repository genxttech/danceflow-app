/**
 * Schedule Stabilization Slice 1b-b: ARIA's package-balance warning
 * helpers, extracted from `automations/actions.ts` (a "use server" file,
 * whose exports must all be async functions) purely so these pure,
 * synchronous functions can be unit-tested directly.
 *
 * `ariaPackageHasReplacementCoverage` is rebuilt on the canonical
 * `hasReplacementCoverage` helper shared by every other warning surface
 * (portal, staff pages, notifications, Marketing) -- see
 * `src/lib/packages/entitlement.ts`. Two corrections from the original
 * ARIA-only implementation: (1) coverage now requires only
 * `remaining > 0` (not depleted), not `remaining > threshold` -- a
 * replacement package that's itself low but not depleted still counts;
 * (2) archived/expired/inactive gating is delegated to the shared helper
 * instead of a local ad hoc check.
 *
 * `ariaLowItemsIncludeCanonicalWarning` exists because ARIA's proactive
 * balance thresholds (a hardcoded <=2 in the cron path, a studio-
 * configurable default-2 in the manual run-now path) are intentionally
 * more sensitive than canonical Low (exact `remaining===1`). A candidate
 * can be threshold-triggered while `getClientPackageStatus` would still
 * show the same package as "Active" everywhere else -- a contradiction a
 * staff member could see side-by-side. Both ARIA action-generating call
 * sites use this to decide whether their copy can say "low"/"depleted"
 * outright, or must instead describe the proactive trigger on its own
 * terms without claiming a canonical status the package's own detail
 * page wouldn't show.
 */

import {
  getItemWarningLevel,
  hasReplacementCoverage,
  type PackageWithItems,
} from "@/lib/packages/entitlement";

export type AriaPackageWarningItem = {
  usage_type?: string | null;
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

export type AriaPackageWarningRow = {
  id: string;
  client_id: string | null;
  expiration_date: string | null;
  client_package_items: AriaPackageWarningItem[];
};

export function normalizedAriaUsageType(value: string | null | undefined) {
  return `${value ?? ""}`.trim().toLowerCase() || "__general__";
}

/**
 * Adapts an ARIA package-balance row into the canonical `PackageWithItems`
 * shape shared by every other warning surface. Both ARIA call sites'
 * queries already scope to `active=true`, and an active row can never
 * also be archived under the Slice 1b-a lifecycle model, so
 * `archived_at: null` is safe here without an extra column on either
 * query.
 */
export function toAriaPackageWithItems(pkg: AriaPackageWarningRow): PackageWithItems {
  return {
    id: pkg.id,
    active: true,
    archived_at: null,
    expiration_date: pkg.expiration_date,
    client_package_items: (pkg.client_package_items ?? []).map((item) => ({
      usage_type: item.usage_type ?? "",
      quantity_remaining:
        item.quantity_remaining === null || item.quantity_remaining === undefined
          ? null
          : Number(item.quantity_remaining),
      is_unlimited: Boolean(item.is_unlimited),
    })),
  };
}

export function ariaPackageHasReplacementCoverage(params: {
  targetPackage: AriaPackageWarningRow;
  allPackages: AriaPackageWarningRow[];
  lowItems: AriaPackageWarningItem[];
}) {
  const { targetPackage, allPackages, lowItems } = params;
  if (!targetPackage.client_id || lowItems.length === 0) return false;

  const otherPackages = allPackages
    .filter(
      (candidate) =>
        candidate.id !== targetPackage.id && candidate.client_id === targetPackage.client_id,
    )
    .map(toAriaPackageWithItems);

  return lowItems.every((lowItem) => {
    const usageType = normalizedAriaUsageType(lowItem.usage_type);
    return hasReplacementCoverage({ candidatePackages: otherPackages, usageType });
  });
}

/**
 * Does at least one of these threshold-flagged items also meet the
 * canonical getItemWarningLevel definition (finite <=0 depleted, finite
 * ===1 low)?
 */
export function ariaLowItemsIncludeCanonicalWarning(items: AriaPackageWarningItem[]) {
  return items.some((item) => {
    if (item.is_unlimited) return false;
    return (
      getItemWarningLevel({
        usage_type: item.usage_type ?? "",
        quantity_remaining:
          item.quantity_remaining === null || item.quantity_remaining === undefined
            ? null
            : Number(item.quantity_remaining),
        is_unlimited: false,
      }) !== null
    );
  });
}
