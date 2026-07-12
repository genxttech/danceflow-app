"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
import {
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

  const cleanup = await cleanupGoogleCalendarConnectionEvents(connection);
  if (cleanup.failed > 0) redirect(withParam(returnTo, "error", "disconnect_cleanup_failed"));

  const { error } = await access.supabase
    .from("studio_google_calendar_connections")
    .update({
      status: "disconnected",
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      token_expires_at: null,
      last_sync_error: null,
    })
    .eq("id", connection.id);
  if (error) throw new Error(`Failed to disconnect Google Calendar: ${error.message}`);
  revalidatePath("/app/settings/integrations");
  revalidatePath(returnTo);
  redirect(withParam(returnTo, "disconnected", "1"));
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
