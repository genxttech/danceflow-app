import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeEmail } from "@/lib/notifications/outbound";

/**
 * PAY-DC-2C: email addresses of one studio's active owners/admins (at most
 * STAFF_RECIPIENT_LIMIT), falling back to the studio's own contact email when no
 * staff address is available. Requires a service-role client (auth.admin). Every
 * lookup is scoped to the single studio id, so recipients can never cross studios.
 */
export const STAFF_RECIPIENT_LIMIT = 5;

type StaffRole = "studio_owner" | "studio_admin" | "front_desk";

/** Active users holding any of `roles` in this one studio, as normalized addresses (no fallback). */
async function collectStaffEmails(
  supabase: SupabaseClient,
  studioId: string,
  roles: StaffRole[],
  limit: number,
): Promise<string[]> {
  const { data: roleRows, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", studioId)
    .eq("active", true)
    .in("role", roles)
    .limit(limit);

  if (roleError) {
    throw new Error("studio_staff_recipient_lookup_failed");
  }

  const emails = new Set<string>();
  for (const row of (roleRows ?? []) as Array<{ user_id?: string | null }>) {
    if (!row.user_id) continue;
    const { data, error } = await supabase.auth.admin.getUserById(row.user_id);
    const email = error ? null : normalizeEmail(data?.user?.email);
    if (email) emails.add(email);
    if (emails.size >= limit) break;
  }
  return [...emails];
}

async function studioContactEmail(supabase: SupabaseClient, studioId: string): Promise<string[]> {
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

export async function getStudioStaffNotificationEmails(
  supabase: SupabaseClient,
  studioId: string,
): Promise<string[]> {
  const emails = await collectStaffEmails(supabase, studioId, ["studio_owner", "studio_admin"], STAFF_RECIPIENT_LIMIT);
  if (emails.length > 0) return emails;
  return studioContactEmail(supabase, studioId);
}

/**
 * GC-S1F: recipients of the operational notice for an externally initiated registration/enrollment (nobody on staff started
 * it): the owner/admin set above plus the studio's active front-desk users, one address each (a person who qualifies twice is
 * emailed once), at most STAFF_RECIPIENT_LIMIT owners/admins plus STAFF_RECIPIENT_LIMIT front-desk users, falling back to the
 * studio contact email when nobody applicable has an address. Does not change getStudioStaffNotificationEmails.
 */
export async function getStudioRegistrationNotificationEmails(
  supabase: SupabaseClient,
  studioId: string,
): Promise<string[]> {
  const [ownersAndAdmins, frontDesk] = await Promise.all([
    collectStaffEmails(supabase, studioId, ["studio_owner", "studio_admin"], STAFF_RECIPIENT_LIMIT),
    collectStaffEmails(supabase, studioId, ["front_desk"], STAFF_RECIPIENT_LIMIT),
  ]);
  const emails = [...new Set([...ownersAndAdmins, ...frontDesk])];
  if (emails.length > 0) return emails;
  return studioContactEmail(supabase, studioId);
}
