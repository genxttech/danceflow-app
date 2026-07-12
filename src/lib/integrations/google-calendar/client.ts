import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/wave/secrets";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export type GoogleCalendarTokens = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
export type GoogleCalendarListItem = { id: string; summary: string; primary?: boolean; accessRole?: string };
export type GoogleCalendarEventPayload = {
  summary: string;
  description?: string;
  location?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};
export type GoogleCalendarEventResponse = { id: string; htmlLink?: string };

class GoogleCalendarRequestError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GoogleCalendarRequestError"; }
}
function googleClientId() { const value = process.env.GOOGLE_CALENDAR_CLIENT_ID; if (!value) throw new Error("Missing GOOGLE_CALENDAR_CLIENT_ID."); return value; }
function googleClientSecret() { const value = process.env.GOOGLE_CALENDAR_CLIENT_SECRET; if (!value) throw new Error("Missing GOOGLE_CALENDAR_CLIENT_SECRET."); return value; }
export function googleCalendarScopes() { return ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/userinfo.email"]; }

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const payload = await response.json() as GoogleCalendarTokens & { error?: string; error_description?: string };
  if (!response.ok || payload.error) throw new Error(payload.error_description ?? payload.error ?? "Google Calendar authorization failed.");
  return payload;
}
export function exchangeGoogleCalendarCode(args: { code: string; redirectUri: string }) {
  return tokenRequest(new URLSearchParams({ client_id: googleClientId(), client_secret: googleClientSecret(), code: args.code, grant_type: "authorization_code", redirect_uri: args.redirectUri }));
}
export function refreshGoogleCalendarAccessToken(refreshToken: string) {
  return tokenRequest(new URLSearchParams({ client_id: googleClientId(), client_secret: googleClientSecret(), grant_type: "refresh_token", refresh_token: refreshToken }));
}
export async function getValidGoogleCalendarAccessToken(connectionId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("studio_google_calendar_connections").select("encrypted_access_token, encrypted_refresh_token, token_expires_at").eq("id", connectionId).single();
  if (error || !data?.encrypted_access_token) throw new Error("Google Calendar credentials are unavailable. Reconnect Google Calendar.");
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) return decryptIntegrationSecret(data.encrypted_access_token);
  if (!data.encrypted_refresh_token) {
    await admin.from("studio_google_calendar_connections").update({ status: "needs_reauth", last_sync_error: "Refresh token missing." }).eq("id", connectionId);
    throw new Error("Google Calendar authorization expired. Reconnect Google Calendar.");
  }
  try {
    const tokens = await refreshGoogleCalendarAccessToken(decryptIntegrationSecret(data.encrypted_refresh_token));
    const { error: saveError } = await admin.from("studio_google_calendar_connections").update({
      encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
      token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      status: "connected", last_sync_error: null,
    }).eq("id", connectionId);
    if (saveError) throw new Error("Refreshed Google Calendar credentials could not be saved.");
    return tokens.access_token;
  } catch {
    await admin.from("studio_google_calendar_connections").update({ status: "needs_reauth", last_sync_error: "Google Calendar authorization expired. Reconnect Google Calendar." }).eq("id", connectionId);
    throw new Error("Google Calendar authorization expired. Reconnect Google Calendar.");
  }
}
async function googleFetch<T>(accessToken: string, url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) throw new GoogleCalendarRequestError(payload?.error?.message ?? payload?.error_description ?? "Google Calendar request failed.", response.status);
  return payload as T;
}
export async function getGoogleAccountEmail(accessToken: string) { const payload = await googleFetch<{ email?: string }>(accessToken, GOOGLE_USERINFO_URL); return payload.email ?? null; }
export async function listGoogleCalendars(accessToken: string) {
  const payload = await googleFetch<{ items?: GoogleCalendarListItem[] }>(accessToken, `${GOOGLE_CALENDAR_BASE_URL}/users/me/calendarList`);
  return (payload.items ?? []).filter((calendar) => ["owner", "writer"].includes(calendar.accessRole ?? ""));
}
async function createGoogleCalendarEvent(args: { accessToken: string; calendarId: string; payload: GoogleCalendarEventPayload }) {
  return googleFetch<GoogleCalendarEventResponse>(args.accessToken, `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(args.calendarId)}/events`, { method: "POST", body: JSON.stringify(args.payload) });
}
export async function upsertGoogleCalendarEvent(args: { accessToken: string; calendarId: string; eventId?: string | null; payload: GoogleCalendarEventPayload }) {
  if (!args.eventId) return createGoogleCalendarEvent(args);
  try {
    return await googleFetch<GoogleCalendarEventResponse>(args.accessToken, `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`, { method: "PATCH", body: JSON.stringify(args.payload) });
  } catch (error) {
    if (error instanceof GoogleCalendarRequestError && [404, 410].includes(error.status)) return createGoogleCalendarEvent(args);
    throw error;
  }
}
export async function deleteGoogleCalendarEvent(args: { accessToken: string; calendarId: string; eventId: string }) {
  const response = await fetch(`${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${args.accessToken}` } });
  if ([404, 410].includes(response.status)) return { deleted: true, missing: true };
  if (!response.ok) {
    const text = await response.text();
    let message = "Google Calendar event deletion failed.";
    try { const payload = text ? JSON.parse(text) : null; message = payload?.error?.message ?? payload?.error_description ?? message; } catch { if (text) message = text; }
    throw new Error(message);
  }
  return { deleted: true, missing: false };
}
