/**
 * Schedule Stabilization Slice 1b-a. Extracted so the WellnessLiving/
 * Mindbody legacy package importers' `active` computation is real,
 * directly-testable code rather than an inline expression duplicated in
 * two ~10,000-line server-action files (which, being `"use server"`
 * files, cannot themselves export a plain sync helper for testing --
 * Next.js requires every export from a `"use server"` file to be async).
 *
 * Confirmed defect this closes: both importers previously computed
 * `active` from `expiration_date` alone, so an already-exhausted-but-
 * unexpired imported package entered DanceFlow as `active=true` with zero
 * usable balance. `active` must require both.
 */

type ImportedPackageBalanceItem = {
  isUnlimited: boolean;
  quantityRemaining: number | null;
};

export function hasUsableImportedPackageBalance(
  items: readonly ImportedPackageBalanceItem[],
): boolean {
  return items.some(
    (item) =>
      item.isUnlimited || (item.quantityRemaining !== null && item.quantityRemaining > 0),
  );
}
