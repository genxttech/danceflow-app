import { createAdminClient } from "@/lib/supabase/admin";
import { parseSupportCookie } from "@/lib/auth/platform-support-cookie";

/**
 * H1: audit trail for platform-admin support access to a studio (entry, switch, exit). It reuses `workspace_access_logs` (studio_id, user_id, accessed_at,
 * route) so no schema change is needed; the `platform_support:` route prefix separates these rows from ordinary workspace access rows.
 *
 * Entry and switch are PRIVILEGE-GRANTING, so the caller must treat a failed write as a refusal (fail closed): no audit row, no support context. Exit only
 * reduces privilege, so it never blocks leaving a studio.
 *
 * The trail is also the REVOCATION record for support cookies: enter/switch rows carry the cookie's nonce (`:jti=<nonce>`), and a cookie is honoured only
 * while its row is the admin's most recent `platform_support:` row. An exit or a later switch therefore invalidates every earlier cookie, authentic and
 * unexpired or not, and a cookie with no entry row is never a context.
 */
export type PlatformSupportEvent = "enter" | "switch" | "exit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{32}$/;

export function platformSupportRoute(event: PlatformSupportEvent, previousStudioId?: string | null, nonce?: string | null): string {
  const jti = event !== "exit" && nonce && NONCE.test(nonce) ? `:jti=${nonce}` : "";
  if (event === "switch" && previousStudioId && UUID.test(previousStudioId)) return `platform_support:switch:from=${previousStudioId.toLowerCase()}${jti}`;
  return `platform_support:${event}${jti}`;
}

export async function recordPlatformSupportEvent(params: {
  event: PlatformSupportEvent;
  studioId: string;
  userId: string;
  previousStudioId?: string | null;
  nonce?: string | null;
}): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("workspace_access_logs").insert({
      studio_id: params.studioId,
      user_id: params.userId,
      route: platformSupportRoute(params.event, params.previousStudioId, params.nonce),
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

/**
 * The studio of the admin's CURRENT support context, or null. `cookieValue` must be authentic and bound to `userId`, AND its nonce must be carried by the
 * admin's most recent `platform_support:` audit row for that studio. Fails closed on any read error.
 */
export async function resolveCurrentSupportStudio(cookieValue: string | null | undefined, userId: string): Promise<string | null> {
  const claims = parseSupportCookie(cookieValue, userId);
  if (!claims) return null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("workspace_access_logs")
      .select("studio_id, route")
      .eq("user_id", userId)
      .like("route", "platform_support:%")
      .order("accessed_at", { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || data.length !== 1) return null;
    const latest = data[0] as { studio_id: string; route: string };
    if (latest.studio_id?.toLowerCase() !== claims.studioId) return null;
    return latest.route.endsWith(`:jti=${claims.nonce}`) ? claims.studioId : null;
  } catch {
    return null;
  }
}
