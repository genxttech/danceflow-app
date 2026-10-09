import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { canManageCompetition } from "@/lib/competition/access";

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

  const canManage = canManageCompetition({
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
    studioRole: context.studioRole ?? null,
    organizerUserRole,
  });

  return { supabase, context, event: event as CompetitionWorkspaceEvent, canManage };
}

/** Same as loadCompetitionWorkspace but 404s for anyone who cannot manage the competition. */
export async function requireCompetitionWorkspace(eventId: string) {
  const workspace = await loadCompetitionWorkspace(eventId);
  if (!workspace.canManage) notFound();
  return workspace;
}

/** For server actions: throws instead of rendering a 404. */
export async function requireCompetitionManager(eventId: string) {
  const workspace = await loadCompetitionWorkspace(eventId);
  if (!workspace.canManage) throw new Error("You do not have permission to manage this competition.");
  return workspace;
}
