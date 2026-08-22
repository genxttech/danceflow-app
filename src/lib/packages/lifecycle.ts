import type { SupabaseClient } from "@supabase/supabase-js";

import { isPackageRefundBlocked } from "./entitlement";

type PackageItemRow = {
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

type PackageLifecycleRow = {
  id: string;
  active: boolean | null;
  refund_status: string | null;
  client_package_items:
    | PackageItemRow[]
    | PackageItemRow
    | null;
};

function relationRows<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hasUsablePackageCredit(pkg: PackageLifecycleRow) {
  const items = relationRows(pkg.client_package_items);

  if (items.some((item) => item.is_unlimited === true)) {
    return true;
  }

  return items.some((item) => {
    const remaining = Number(item.quantity_remaining ?? 0);
    return Number.isFinite(remaining) && remaining > 0;
  });
}

/**
 * Reconciles `active` against real balance for every non-archived package
 * a client has (or one specific package, if `clientPackageId` is given).
 * Bidirectional: a currently-active package with no usable balance is
 * deactivated (existing behavior), and -- Schedule Stabilization Slice
 * 1b-a correction -- a currently-inactive, non-archived package that has
 * regained usable balance (e.g. via a manual credit restoration) is
 * reactivated. Archived packages (`archived_at IS NOT NULL`) are excluded
 * from the query entirely, so ordinary reconciliation can never reactivate
 * one or touch its archive metadata, in either direction.
 *
 * Package Refund P0, Slice 2b: a `refund_status='full'` package is (a)
 * excluded from the reactivate branch entirely -- regained balance never
 * reactivates a refunded package -- and (b) subject to a third,
 * balance-independent normalization block below: any such package still
 * `active=true` (legacy data, a race, or a future writer defect) is
 * deterministically corrected to `active=false`, regardless of remaining
 * balance. A `'partial'` or `null` refund status is untouched by either
 * change and flows through the pre-existing depletion/reactivate logic
 * exactly as before.
 */
export async function reconcileClientPackageLifecycle(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  clientPackageId?: string | null;
}) {
  const { supabase, studioId, clientId, clientPackageId = null } = params;

  let query = supabase
    .from("client_packages")
    .select(
      `
      id,
      active,
      refund_status,
      client_package_items (
        quantity_remaining,
        is_unlimited
      )
    `,
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("archived_at", null);

  if (clientPackageId) {
    query = query.eq("id", clientPackageId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Could not reconcile package lifecycle: ${error.message}`);
  }

  const rows = (data ?? []) as PackageLifecycleRow[];

  // Depletion-driven deactivation, unchanged in shape, now excludes
  // refund-blocked rows so the two deactivation reasons stay mutually
  // exclusive (both blocks would set the same value either way -- this is
  // for clarity, not correctness).
  const toDeactivate = rows
    .filter((pkg) => pkg.active !== false)
    .filter((pkg) => !isPackageRefundBlocked(pkg))
    .filter((pkg) => !hasUsablePackageCredit(pkg))
    .map((pkg) => pkg.id);

  // Refund-blocked packages never regain balance-driven reactivation.
  const toReactivate = rows
    .filter((pkg) => pkg.active === false)
    .filter((pkg) => !isPackageRefundBlocked(pkg))
    .filter((pkg) => hasUsablePackageCredit(pkg))
    .map((pkg) => pkg.id);

  // Balance-independent normalization: a full-refund package must be
  // active=false regardless of remaining balance. This is the only block
  // whose condition does not depend on hasUsablePackageCredit at all. A
  // row here can never also appear in toReactivate (mutually exclusive by
  // `active` value), so this can never reactivate anything in the same
  // pass.
  const toDeactivateForRefund = rows
    .filter((pkg) => pkg.active !== false)
    .filter((pkg) => isPackageRefundBlocked(pkg))
    .map((pkg) => pkg.id);

  const now = new Date().toISOString();

  if (toDeactivate.length > 0) {
    const { error: deactivateError } = await supabase
      .from("client_packages")
      .update({
        active: false,
        updated_at: now,
      })
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("active", true)
      .is("archived_at", null)
      .in("id", toDeactivate);

    if (deactivateError) {
      throw new Error(
        `Could not complete depleted package: ${deactivateError.message}`,
      );
    }
  }

  if (toReactivate.length > 0) {
    const { error: reactivateError } = await supabase
      .from("client_packages")
      .update({
        active: true,
        updated_at: now,
      })
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("active", false)
      .is("archived_at", null)
      // NULL-safe re-guard: a concurrent refund landing between the select
      // and this update means the row no longer matches and is correctly
      // left untouched, rather than reactivated on stale information.
      .or("refund_status.is.null,refund_status.neq.full")
      .in("id", toReactivate);

    if (reactivateError) {
      throw new Error(
        `Could not restore package to active: ${reactivateError.message}`,
      );
    }
  }

  if (toDeactivateForRefund.length > 0) {
    const { error: refundNormalizeError } = await supabase
      .from("client_packages")
      .update({
        active: false,
        updated_at: now,
      })
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("active", true)
      .is("archived_at", null)
      // Re-guard on refund_status itself: a concurrent reversal between
      // the select above and this update means the row no longer matches
      // and is correctly left untouched, rather than incorrectly
      // deactivated on stale information.
      .eq("refund_status", "full")
      .in("id", toDeactivateForRefund);

    if (refundNormalizeError) {
      throw new Error(
        `Could not normalize refunded package to inactive: ${refundNormalizeError.message}`,
      );
    }
  }

  // Deliberately scoped to genuine depletion only -- the ARIA cleanup
  // copy below says "fully depleted," which would be inaccurate for a
  // refund-driven normalization. A refund-specific message belongs to a
  // later refund-application slice, not this one.
  const depletedPackageIds = toDeactivate;

  if (depletedPackageIds.length === 0) {
    return { completedPackageIds: [] as string[] };
  }

  const { data: staleActions, error: staleActionsError } = await supabase
    .from("automation_actions")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("rule_key", "aria_low_package_balance")
    .eq("related_table", "client_packages")
    .in("related_id", depletedPackageIds)
    .in("status", ["suggested", "drafted", "approved", "queued", "snoozed"]);

  if (!staleActionsError && (staleActions ?? []).length > 0) {
    const actionIds = (staleActions ?? []).map((action) => String(action.id));

    const { error: actionUpdateError } = await supabase
      .from("automation_actions")
      .update({
        status: "completed",
        completed_at: now,
        completed_by: null,
        reviewed_at: now,
        reviewed_by: null,
        review_note:
          "Completed automatically because the related package was fully depleted and moved to package history.",
        updated_at: now,
      })
      .eq("studio_id", studioId)
      .in("id", actionIds);

    if (!actionUpdateError) {
      const events = (staleActions ?? []).map((action) => ({
        studio_id: studioId,
        automation_action_id: action.id,
        event_type: "completed",
        previous_status: action.status,
        new_status: "completed",
        note:
          "Package lifecycle reconciliation completed this stale low-balance action.",
        metadata: {
          reason: "package_fully_depleted",
          source: "package_lifecycle_reconciliation",
        },
        created_by: null,
      }));

      const { error: eventError } = await supabase
        .from("automation_action_events")
        .insert(events);

      if (eventError) {
        console.warn(
          "Package lifecycle reconciliation could not record ARIA events:",
          eventError.message,
        );
      }
    } else {
      console.warn(
        "Package lifecycle reconciliation could not complete stale ARIA actions:",
        actionUpdateError.message,
      );
    }
  }

  return { completedPackageIds: depletedPackageIds };
}
