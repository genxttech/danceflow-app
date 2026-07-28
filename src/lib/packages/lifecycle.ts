import type { SupabaseClient } from "@supabase/supabase-js";

type PackageItemRow = {
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

type PackageLifecycleRow = {
  id: string;
  active: boolean | null;
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
      client_package_items (
        quantity_remaining,
        is_unlimited
      )
    `,
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("active", true);

  if (clientPackageId) {
    query = query.eq("id", clientPackageId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Could not reconcile package lifecycle: ${error.message}`);
  }

  const depletedPackageIds = ((data ?? []) as PackageLifecycleRow[])
    .filter((pkg) => pkg.active !== false)
    .filter((pkg) => !hasUsablePackageCredit(pkg))
    .map((pkg) => pkg.id);

  if (depletedPackageIds.length === 0) {
    return { completedPackageIds: [] as string[] };
  }

  const now = new Date().toISOString();

  const { error: packageUpdateError } = await supabase
    .from("client_packages")
    .update({
      active: false,
      updated_at: now,
    })
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("active", true)
    .in("id", depletedPackageIds);

  if (packageUpdateError) {
    throw new Error(
      `Could not complete depleted package: ${packageUpdateError.message}`,
    );
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
