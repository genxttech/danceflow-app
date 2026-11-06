import "server-only";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

/**
 * D24 M3-C: THE single server-side authorization function for client invoices.
 *
 * Callers (pages, server actions, the future creation call site) ask `authorizeClientInvoiceActor("draft" | "view")` and never test roles themselves.
 * The decision is made by the database helper public.studio_billing_permission(studio, permission), which reads auth.uid() from the user's own JWT.
 * Today that helper grants studio_owner and studio_admin only; granular billing permissions later change the helper, not this interface or its callers.
 * Platform admins get no implicit access (the helper has no platform-admin branch).
 *
 * The returned object has the exact shape of the M3-B orchestrator's AuthorizedBillingActor and is minted only here (studio and user come from
 * the verified session, never from a request).
 */
export type ClientInvoicePermission = "draft" | "view";

export type VerifiedClientInvoiceActor = {
  verified: true;
  studioId: string;
  userId: string;
  canManageBilling: true;
};

const PERMISSION_NAME: Record<ClientInvoicePermission, string> = {
  draft: "client_invoice.draft",
  view: "client_invoice.view",
};

export async function authorizeClientInvoiceActor(permission: ClientInvoicePermission): Promise<VerifiedClientInvoiceActor | null> {
  const context = await getCurrentStudioContext();
  if (!context.studioId || !context.userId) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("studio_billing_permission", {
    p_studio_id: context.studioId,
    p_permission: PERMISSION_NAME[permission],
  });
  if (error || data !== true) return null;
  return { verified: true, studioId: context.studioId, userId: context.userId, canManageBilling: true };
}
