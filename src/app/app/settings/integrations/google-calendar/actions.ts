"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import {
  getGoogleCalendarAccess,
  googleCalendarReturnPath,
  parseGoogleCalendarScope,
  type GoogleCalendarScope,
} from "@/lib/integrations/google-calendar/access";
import {
  cleanupGoogleCalendarConnectionEvents,
  syncGoogleCalendarConnection,
  type GoogleCalendarConnectionRow,
} from "@/lib/integrations/google-calendar/sync";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordIntegrationEvent } from "@/lib/integrations/audit";
import { deleteGoogleCredentials } from "@/lib/integrations/google-calendar/credentials";
import {
  revokeGoogleCalendarGrant,
  getValidGoogleCalendarAccessToken,
  listGoogleCalendars,
} from "@/lib/integrations/google-calendar/client";

function safeReturnPath(value: FormDataEntryValue | null, scope: GoogleCalendarScope) {
  const fallback = googleCalendarReturnPath(scope);
  const raw = String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  return raw;
}
function withParam(path: string, key: string, value: string) {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}
async function loadConnection(scope: GoogleCalendarScope) {
  const access = await getGoogleCalendarAccess(scope);
  let query = access.supabase
    .from("studio_google_calendar_connections")
    .select("id, studio_id, connection_scope, instructor_id, calendar_id, sync_lessons, sync_classes, sync_events")
    .eq("studio_id", access.context.studioId)
    .eq("connection_scope", scope);
  query = scope === "instructor"
    ? query.eq("instructor_id", access.instructorId)
    : query.is("instructor_id", null);
  const { data, error } = await query.maybeSingle<GoogleCalendarConnectionRow>();
  if (error) throw new Error(`Failed to load Google Calendar connection: ${error.message}`);
  return { access, connection: data };
}

export async function updateGoogleCalendarSettingsAction(formData: FormData) {
  const scope = parseGoogleCalendarScope(String(formData.get("connectionScope") ?? "studio"));
  const returnTo = safeReturnPath(formData.get("returnTo"), scope);
  const { access, connection } = await loadConnection(scope);
  if (!connection || !connection.calendar_id) redirect(withParam(returnTo, "error", "not_connected"));

  const accessToken = await getValidGoogleCalendarAccessToken(connection.id);
  const calendars = await listGoogleCalendars(accessToken);
  const requestedCalendarId = String(formData.get("calendarId") ?? "").trim();
  const selectedCalendar = calendars.find((calendar) => calendar.id === requestedCalendarId);
  if (!selectedCalendar) redirect(withParam(returnTo, "error", "invalid_calendar"));

  if (connection.calendar_id !== selectedCalendar.id) {
    const cleanup = await cleanupGoogleCalendarConnectionEvents(connection);
    if (cleanup.failed > 0) redirect(withParam(returnTo, "error", "calendar_cleanup_failed"));
  }

  const update = {
    calendar_id: selectedCalendar.id,
    calendar_summary: selectedCalendar.summary,
    sync_lessons: formData.get("syncLessons") === "on",
    sync_classes: formData.get("syncClasses") === "on",
    sync_events: scope === "studio" && formData.get("syncEvents") === "on",
  };
  const { error } = await access.supabase
    .from("studio_google_calendar_connections")
    .update(update)
    .eq("id", connection.id);
  if (error) throw new Error(`Failed to update Google Calendar settings: ${error.message}`);
  revalidatePath("/app/settings/integrations");
  revalidatePath(returnTo);
  redirect(withParam(returnTo, "saved", "1"));
}

export async function disconnectGoogleCalendarAction(formData: FormData) {
  const scope = parseGoogleCalendarScope(String(formData.get("connectionScope") ?? "studio"));
  const returnTo = safeReturnPath(formData.get("returnTo"), scope);
  const { access, connection } = await loadConnection(scope);
  if (!connection) redirect(withParam(returnTo, "disconnected", "1"));

  // A connection whose authorization is gone (needs_reauth, revoked grant) cannot reach Google to remove events: that must not trap it.
  // Cleanup that throws means the credentials are unusable, so disconnect proceeds without it; partial deletes that report failures still block.
  let cleanupSkipped = false;
  try {
    const cleanup = await cleanupGoogleCalendarConnectionEvents(connection);
    if (cleanup.failed > 0) redirect(withParam(returnTo, "error", "disconnect_cleanup_failed"));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    cleanupSkipped = true;
  }

  // Tokens go first: a failure here leaves the connection visibly connected so the user can retry, never "disconnected" with live tokens.
  // Revoke at Google first (best effort, never blocks the local disconnect); the app should also disappear from the user's Google account permissions.
  const revokeOutcome = await revokeGoogleCalendarGrant(connection.id);
  await deleteGoogleCredentials(createAdminClient(), connection.id);
  const { error } = await access.supabase
    .from("studio_google_calendar_connections")
    .update({
      status: "disconnected",
      last_sync_error: null,
    })
    .eq("id", connection.id);
  if (error) throw new Error(`Failed to disconnect Google Calendar: ${error.message}`);
  await recordIntegrationEvent({ studioId: access.context.studioId, provider: "google_calendar", eventType: "disconnected", connectionId: connection.id, actorUserId: access.context.userId, details: { scope, revoke: revokeOutcome, cleanup_skipped: cleanupSkipped } });
  revalidatePath("/app/settings/integrations");
  revalidatePath(returnTo);
  redirect(withParam(withParam(returnTo, "disconnected", "1"), "cleanup_skipped", cleanupSkipped ? "1" : "0"));
}

export async function refreshGoogleCalendarsAction(formData: FormData) {
  const scope = parseGoogleCalendarScope(String(formData.get("connectionScope") ?? "studio"));
  const returnTo = safeReturnPath(formData.get("returnTo"), scope);
  const { connection } = await loadConnection(scope);
  if (!connection) redirect(withParam(returnTo, "error", "not_connected"));
  await getValidGoogleCalendarAccessToken(connection.id);
  revalidatePath(returnTo);
  redirect(withParam(returnTo, "refreshed", "1"));
}

export async function syncGoogleCalendarNowAction(formData: FormData) {
  const scope = parseGoogleCalendarScope(String(formData.get("connectionScope") ?? "studio"));
  const returnTo = safeReturnPath(formData.get("returnTo"), scope);
  const { connection } = await loadConnection(scope);
  if (!connection?.calendar_id) redirect(withParam(returnTo, "error", "calendar_required"));
  const result = await syncGoogleCalendarConnection(connection);
  if (result.status === "failed") redirect(withParam(returnTo, "error", "sync_failed"));
  redirect(withParam(withParam(withParam(returnTo, "synced", String(result.synced)), "deleted", String(result.deleted)), "failed", String(result.failed)));
}
