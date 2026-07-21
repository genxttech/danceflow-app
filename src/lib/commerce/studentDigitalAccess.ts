import { SupabaseClient } from "@supabase/supabase-js";

export type ActiveStudentEntitlement = {
  id: string;
  user_id: string;
  studio_id: string;
  catalog_item_id: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
};

export function entitlementIsActive(entitlement: ActiveStudentEntitlement) {
  const now = Date.now();
  const startsAt = new Date(entitlement.starts_at).getTime();
  const expiresAt = entitlement.expires_at
    ? new Date(entitlement.expires_at).getTime()
    : null;

  return (
    ["active", "refunded_access_retained"].includes(entitlement.status) &&
    Number.isFinite(startsAt) &&
    startsAt <= now &&
    (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now))
  );
}

export async function loadActiveStudentEntitlement(input: {
  admin: SupabaseClient;
  entitlementId: string;
  userId: string;
}) {
  const { data, error } = await input.admin
    .from("commerce_entitlements")
    .select(
      "id, user_id, studio_id, catalog_item_id, status, starts_at, expires_at",
    )
    .eq("id", input.entitlementId)
    .eq("user_id", input.userId)
    .maybeSingle();

  const entitlement = data as ActiveStudentEntitlement | null;

  if (error || !entitlement) {
    return { entitlement: null, reason: "not_found" as const };
  }

  if (!entitlementIsActive(entitlement)) {
    return { entitlement: null, reason: "inactive" as const };
  }

  return { entitlement, reason: null };
}

export async function loadEntitledCatalogIds(input: {
  admin: SupabaseClient;
  entitlement: ActiveStudentEntitlement;
}) {
  const { data: parent, error } = await input.admin
    .from("commerce_catalog_items")
    .select("id, item_type, active, published")
    .eq("id", input.entitlement.catalog_item_id)
    .maybeSingle();

  if (error || !parent || !parent.active || !parent.published) {
    return null;
  }

  if (parent.item_type !== "video_series") {
    return [parent.id as string];
  }

  const { data: rows, error: seriesError } = await input.admin
    .from("commerce_series_items")
    .select("child_catalog_item_id, position")
    .eq("series_catalog_item_id", parent.id)
    .eq("active", true)
    .order("position", { ascending: true });

  if (seriesError) {
    throw new Error(seriesError.message);
  }

  return (rows ?? []).map((row) => row.child_catalog_item_id as string);
}
