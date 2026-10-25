import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { canEditCompetitionEventOperations, canManageCompetition, competitionAccessLevel, type CompetitionAccessLevel } from "@/lib/competition/access";
import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";

export type CompetitionWorkspaceEvent = {
  id: string;
  name: string;
  slug: string | null;
  studio_id: string;
  organizer_id: string | null;
  event_type: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  timezone: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
};

const EVENT_COLUMNS =
  "id, name, slug, studio_id, organizer_id, event_type, start_date, end_date, start_time, end_time, timezone, venue_name, city, state, registration_opens_at, registration_closes_at";

/**
 * Loads the event for the Competition workspace and decides, with the same rule as the action
 * guard (requireEventManager) and the database helper (can_manage_event_competition), whether the
 * viewer may manage it. Pages call this and 404 for non-managers; the database remains the real
 * boundary (row level security).
 */
export async function loadCompetitionWorkspace(eventId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  const { data: event, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("id", eventId)
    .eq("studio_id", context.studioId)
    .maybeSingle();
  if (error || !event) notFound();

  let organizerUserRole: string | null = null;
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", context.userId)
      .eq("active", true)
      .maybeSingle();
    organizerUserRole = organizerUser?.role ?? null;
  }

  const accessInput = {
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
    studioRole: context.studioRole ?? null,
    organizerUserRole,
  };
  const canManage = canManageCompetition(accessInput);
  const accessLevel: CompetitionAccessLevel = competitionAccessLevel(accessInput);

  // Venue, dates, times and time zone need an owner/admin role (the database enforces the same rule).
  const canEditOperations = canManage && canEditCompetitionEventOperations({ studioRole: context.studioRole ?? null, organizerUserRole });

  return { supabase, context, event: event as CompetitionWorkspaceEvent, canManage, canEditOperations, accessLevel };
}

/**
 * The gate for every Competition workspace page except check-in. Managers pass. A check-in-only user (front desk,
 * CB-2) is sent to the check-in desk, and anyone else gets a 404. Pages call this instead of re-deriving the rule.
 */
export async function requireCompetitionWorkspace(eventId: string) {
  const workspace = await loadCompetitionWorkspace(eventId);
  if (workspace.accessLevel === "check_in_only") redirect(`${competitionWorkspaceHref(eventId)}/checkin`);
  if (!workspace.canManage) notFound();
  return workspace;
}

/** The gate for the check-in desk (`competition/checkin/**`) and the layout: managers and the front desk. */
export async function requireCompetitionCheckinAccess(eventId: string) {
  const workspace = await loadCompetitionWorkspace(eventId);
  if (workspace.accessLevel === "none") notFound();
  return workspace;
}

/** For server actions: throws instead of rendering a 404. */
export async function requireCompetitionManager(eventId: string) {
  const workspace = await loadCompetitionWorkspace(eventId);
  if (!workspace.canManage) throw new Error("You do not have permission to manage this competition.");
  return workspace;
}
