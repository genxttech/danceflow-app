import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeEmail } from "@/lib/notifications/outbound";

/**
 * PAY-DC-2C: email addresses of one studio's active owners/admins (at most
 * STAFF_RECIPIENT_LIMIT), falling back to the studio's own contact email when no
 * staff address is available. Requires a service-role client (auth.admin). Every
 * lookup is scoped to the single studio id, so recipients can never cross studios.
 */
export const STAFF_RECIPIENT_LIMIT = 5;

export async function getStudioStaffNotificationEmails(
  supabase: SupabaseClient,
  studioId: string,
): Promise<string[]> {
  const { data: roleRows, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", studioId)
    .eq("active", true)
    .in("role", ["studio_owner", "studio_admin"])
    .limit(STAFF_RECIPIENT_LIMIT);

  if (roleError) {
    throw new Error("studio_staff_recipient_lookup_failed");
  }

  const emails = new Set<string>();
  for (const row of (roleRows ?? []) as Array<{ user_id?: string | null }>) {
    if (!row.user_id) continue;
    const { data, error } = await supabase.auth.admin.getUserById(row.user_id);
    const email = error ? null : normalizeEmail(data?.user?.email);
    if (email) emails.add(email);
    if (emails.size >= STAFF_RECIPIENT_LIMIT) break;
  }

  if (emails.size > 0) return [...emails];

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("email")
    .eq("id", studioId)
    .maybeSingle();

  if (studioError) {
    throw new Error("studio_staff_recipient_lookup_failed");
  }

  const fallback = normalizeEmail((studio as { email?: string | null } | null)?.email);
  return fallback ? [fallback] : [];
}
