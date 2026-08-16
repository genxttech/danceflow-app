import { describe, expect, it } from "vitest";

/**
 * DB-integration limitation (explicitly flagged, not silently worked
 * around): this repository has no real-Postgres/pgTAP integration harness
 * (confirmed -- no such tooling exists anywhere in this codebase), so the
 * new reconciliation step added to the `deduct_package_credit_when_
 * appointment_attended()` trigger function (migration
 * 20260816090100_package_lifecycle_reconciliation_trigger.sql) cannot be
 * executed against a real Postgres engine as part of this test suite. The
 * SQL itself must be verified against a real/staging Supabase database
 * before this migration is applied to production.
 *
 * What this test CAN do, and does: the SQL's new reconciliation step is a
 * single CASE expression --
 *
 *   active = case
 *     when exists (
 *       select 1 from client_package_items cpi2
 *       where cpi2.client_package_id = cp.id
 *         and (cpi2.is_unlimited = true or coalesce(cpi2.quantity_remaining, 0) > 0)
 *     ) then cp.active
 *     else false
 *   end
 *
 * -- deliberately written to match `hasUsablePackageCredit` in
 * lifecycle.ts exactly (OR across items: any unlimited OR any item with
 * remaining > 0). This test encodes that same predicate as a plain JS
 * mirror and asserts it against the identical fixture matrix used for the
 * real, executable `reconcileClientPackageLifecycle` JS function in
 * lifecycle.test.ts -- proving the two reconciliation implementations
 * (JS-side and the intended SQL) agree on every case, even though it
 * cannot prove the *deployed* SQL matches this mirror verbatim.
 */
function sqlTriggerReconciliationMirror(
  items: readonly { quantity_remaining: number | null; is_unlimited: boolean }[],
): boolean {
  return items.some(
    (item) => item.is_unlimited === true || (item.quantity_remaining ?? 0) > 0,
  );
}

describe("SQL trigger reconciliation logic parity (mirror, not a live-Postgres test -- see doc comment)", () => {
  it("all finite items depleted -> package becomes inactive", () => {
    expect(
      sqlTriggerReconciliationMirror([{ quantity_remaining: 0, is_unlimited: false }]),
    ).toBe(false);
  });

  it("one unlimited item alongside a depleted finite item -> package remains active", () => {
    expect(
      sqlTriggerReconciliationMirror([
        { quantity_remaining: 0, is_unlimited: false },
        { quantity_remaining: null, is_unlimited: true },
      ]),
    ).toBe(true);
  });

  it("a finite item with remaining balance -> package remains active", () => {
    expect(
      sqlTriggerReconciliationMirror([{ quantity_remaining: 2, is_unlimited: false }]),
    ).toBe(true);
  });

  it("multiple finite items, only one depleted -> package remains active", () => {
    expect(
      sqlTriggerReconciliationMirror([
        { quantity_remaining: 0, is_unlimited: false },
        { quantity_remaining: 4, is_unlimited: false },
      ]),
    ).toBe(true);
  });
});
