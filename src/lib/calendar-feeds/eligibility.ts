/* eslint-disable @typescript-eslint/no-explicit-any -- loose Supabase client shape */
import type { FeedSubject, SupabaseLike } from "./events";

/**
 * Account and workspace gates that a bearer feed link must not outlive: the feed may never show a person more than the app
 * itself would show them today. Checked on every request, after the token resolves and before anything is read.
 *  - the sign-in account must still exist and not be banned;
 *  - the DanceFlow account must be active (not deactivated or pending deletion);
 *  - staff feeds additionally follow the Staff API: the studio's subscription must allow workspace access.
 * Returns false for a denial. THROWS when a check cannot be performed (callers treat that as a server fault, never as "allowed").
 */

/** Mirrors isWorkspaceAccessAllowedStatus in src/lib/auth/studio.ts (pinned by a parity test). */
export const WORKSPACE_ALLOWED_STATUSES = ["active", "trialing"];

export async function isSubjectEligible(admin: SupabaseLike, subject: FeedSubject, now: Date): Promise<boolean> {
  const { data: auth, error: authError } = await (admin as any).auth.admin.getUserById(subject.subjectUserId);
  if (authError) {
    if (authError.status === 404) return false;
    throw new Error("account lookup failed");
  }
  const user = auth?.user;
  if (!user) return false;
  const bannedUntil = user.banned_until ? Date.parse(user.banned_until) : 0;
  if (bannedUntil > now.getTime()) return false;

  const account = await admin.from("user_account_status").select("status").eq("user_id", subject.subjectUserId).maybeSingle();
  if (account.error) throw new Error("account status lookup failed");
  if (account.data && account.data.status !== "active") return false;

  if (subject.subjectKind === "staff") {
    const studio = await admin.from("studios").select("subscription_status").eq("id", subject.studioId).maybeSingle();
    if (studio.error) throw new Error("workspace lookup failed");
    if (!WORKSPACE_ALLOWED_STATUSES.includes(studio.data?.subscription_status)) return false;
  }
  return true;
}
