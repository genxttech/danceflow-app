import { createAdminClient } from "@/lib/supabase/admin";

export type PortalRelationshipPermission =
  | "can_view_schedule"
  | "can_view_billing"
  | "can_manage_bookings"
  | "can_sign_documents";

export type PortalRelationshipAccess = {
  linkId: string;
  clientId: string;
  studioId: string;
  relationshipType: string;
  isPrimary: boolean;
  canViewSchedule: boolean;
  canViewBilling: boolean;
  canManageBookings: boolean;
  canSignDocuments: boolean;
};

type PortalLinkRow = {
  id: string;
  client_id: string;
  studio_id: string;
  relationship_type: string;
  is_primary: boolean | null;
  can_view_schedule: boolean | null;
  can_view_billing: boolean | null;
  can_manage_bookings: boolean | null;
  can_sign_documents: boolean | null;
};

export async function resolvePortalRelationship(params: {
  userId: string;
  studioId: string;
  requestedClientId?: string | null;
  permission?: PortalRelationshipPermission;
}) {
  const admin = createAdminClient();

  let query = admin
    .from("client_account_links")
    .select(`
      id,
      client_id,
      studio_id,
      relationship_type,
      is_primary,
      can_view_schedule,
      can_view_billing,
      can_manage_bookings,
      can_sign_documents
    `)
    .eq("user_id", params.userId)
    .eq("studio_id", params.studioId)
    .eq("status", "linked");

  if (params.requestedClientId) {
    query = query.eq("client_id", params.requestedClientId);
  }

  const { data, error } = await query
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Portal relationship lookup failed: ${error.message}`);
  }

  if (!data) return null;

  const row = data as PortalLinkRow;
  if (params.permission && row[params.permission] !== true) {
    return null;
  }

  return {
    linkId: row.id,
    clientId: row.client_id,
    studioId: row.studio_id,
    relationshipType: row.relationship_type,
    isPrimary: row.is_primary === true,
    canViewSchedule: row.can_view_schedule === true,
    canViewBilling: row.can_view_billing === true,
    canManageBookings: row.can_manage_bookings === true,
    canSignDocuments: row.can_sign_documents === true,
  } satisfies PortalRelationshipAccess;
}

export function portalClientPath(
  studioSlug: string,
  clientId: string,
  suffix = "",
) {
  const base = `/portal/${encodeURIComponent(studioSlug)}${suffix}`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}client=${encodeURIComponent(clientId)}`;
}
