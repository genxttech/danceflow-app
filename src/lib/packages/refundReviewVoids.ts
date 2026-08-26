/**
 * Package Refund P0, Slice 2c-2: parses a submitted review form's per-item
 * void quantities into the RPC's `p_voids` shape. Fields are named
 * `void_<client_package_item_id>`; any field that isn't present, isn't a
 * positive integer, or belongs to a different form key is simply skipped --
 * ownership/quantity-bound validation is the RPC's job (resolve_partial_refund_credit_review
 * independently re-verifies every item against the reconciliation's actual
 * package), not this parser's.
 *
 * Lives in its own module, separate from src/app/app/clients/[id]/actions.ts
 * (a `"use server"` file), specifically so it can stay a plain synchronous
 * function -- every export from a `"use server"` file is treated by Next.js
 * as a Server Action, which must be async, so a synchronous pure helper
 * cannot be exported directly from that file. Mirrors this codebase's
 * established pure-decision-module pattern for the identical situation (see
 * buildPackageRefundReconciliationInput in
 * src/lib/payments/package-refund-reconciliation.ts, extracted from the
 * webhook route for the same reason: callable from a server-only file while
 * remaining directly unit-testable).
 */
export function buildVoidsFromFormData(
  formData: FormData,
): { client_package_item_id: string; quantity: number }[] {
  const voids: { client_package_item_id: string; quantity: number }[] = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("void_")) continue;
    const itemId = key.slice("void_".length);
    if (!itemId) continue;

    const quantity = Number.parseInt(String(value), 10);
    if (Number.isFinite(quantity) && quantity > 0) {
      voids.push({ client_package_item_id: itemId, quantity });
    }
  }

  return voids;
}
