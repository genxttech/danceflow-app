import { createAdminClient } from "@/lib/supabase/admin";

/**
 * H1: audit trail for platform-admin support access to a studio (entry, switch, exit). It reuses `workspace_access_logs` (studio_id, user_id, accessed_at,
 * route) so no schema change is needed; the `platform_support:` route prefix separates these rows from ordinary workspace access rows.
 *
 * Entry and switch are PRIVILEGE-GRANTING, so the caller must treat a failed write as a refusal (fail closed): no audit row, no support context. Exit only
 * reduces privilege, so it is best-effort and never blocks leaving a studio.
 */
export type PlatformSupportEvent = "enter" | "switch" | "exit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function platformSupportRoute(event: PlatformSupportEvent, previousStudioId?: string | null): string {
  if (event === "switch" && previousStudioId && UUID.test(previousStudioId)) return `platform_support:switch:from=${previousStudioId.toLowerCase()}`;
  return `platform_support:${event}`;
}

export async function recordPlatformSupportEvent(params: {
  event: PlatformSupportEvent;
  studioId: string;
  userId: string;
  previousStudioId?: string | null;
}): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("workspace_access_logs").insert({
      studio_id: params.studioId,
      user_id: params.userId,
      route: platformSupportRoute(params.event, params.previousStudioId),
    });
    if (error) {
      console.warn("Failed to record platform support access event", { event: params.event, code: error.code });
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Failed to record platform support access event", { event: params.event, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
