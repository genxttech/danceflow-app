import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { deleteGoogleCredentials, loadGoogleCredentials, saveGoogleCredentials } from "@/lib/integrations/google-calendar/credentials";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/wave/secrets";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
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

/** Token endpoint failure: `invalid_grant` (revoked/expired grant) is permanent; anything else (network, 5xx) is transient. */
export class GoogleTokenError extends Error {
  constructor(message: string, public code: string | null, public status: number | null) { super(message); this.name = "GoogleTokenError"; }
  /** Transient only for network failures, 5xx and 429; every other rejection (invalid_grant, invalid_client, ...) needs a human. */
  get permanent() { return this.code === "invalid_grant" || (this.status !== null && this.status < 500 && this.status !== 429 && this.status !== 408); }
}
class GoogleCalendarRequestError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GoogleCalendarRequestError"; }
}
function googleClientId() { const value = process.env.GOOGLE_CALENDAR_CLIENT_ID; if (!value) throw new Error("Missing GOOGLE_CALENDAR_CLIENT_ID."); return value; }
function googleClientSecret() { const value = process.env.GOOGLE_CALENDAR_CLIENT_SECRET; if (!value) throw new Error("Missing GOOGLE_CALENDAR_CLIENT_SECRET."); return value; }
export const GOOGLE_REQUIRED_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"] as const;
export function googleCalendarScopes() { return ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/userinfo.email"]; }

async function tokenRequest(body: URLSearchParams) {
  let response: Response;
  try { response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); }
  catch { throw new GoogleTokenError("Google token endpoint is unreachable.", null, null); }
  let payload: (GoogleCalendarTokens & { error?: string; error_description?: string }) | null = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload || payload.error) throw new GoogleTokenError(payload?.error_description ?? payload?.error ?? "Google Calendar authorization failed.", payload?.error ?? null, response.status);
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
  const data = await loadGoogleCredentials(admin, connectionId);
  if (!data) throw new Error("Google Calendar credentials are unavailable. Reconnect Google Calendar.");
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) return decryptIntegrationSecret(data.encrypted_access_token);
  if (!data.encrypted_refresh_token) {
    await admin.from("studio_google_calendar_connections").update({ status: "needs_reauth", last_sync_error: "Refresh token missing." }).eq("id", connectionId);
    throw new Error("Google Calendar authorization expired. Reconnect Google Calendar.");
  }
  try {
    const tokens = await refreshGoogleCalendarAccessToken(decryptIntegrationSecret(data.encrypted_refresh_token));
    await saveGoogleCredentials(admin, connectionId, {
      encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
      // a legacy-only connection has no credentials row yet: carry its refresh token over (Google does not return a new one on refresh)
      encrypted_refresh_token: tokens.refresh_token ? encryptIntegrationSecret(tokens.refresh_token) : data.encrypted_refresh_token,
      token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    });
    // A disconnect that landed while this refresh was in flight must win: never resurrect tokens or the connected status.
    const { data: stillActive } = await admin.from("studio_google_calendar_connections").update({ status: "connected", last_sync_error: null }).eq("id", connectionId).neq("status", "disconnected").select("id");
    if (!stillActive || stillActive.length === 0) {
      await deleteGoogleCredentials(admin, connectionId);
      throw new Error("Google Calendar is disconnected.");
    }
    return tokens.access_token;
  } catch (error) {
    if (error instanceof GoogleTokenError && !error.permanent) {
      // Transient (network, 5xx, rate limit): keep the connection, let the next run retry. Do not force a reconnect.
      await admin.from("studio_google_calendar_connections").update({ last_sync_error: "Google is temporarily unavailable. Sync will retry." }).eq("id", connectionId).neq("status", "disconnected");
      throw new Error("Google Calendar is temporarily unavailable. Try again shortly.");
    }
    await admin.from("studio_google_calendar_connections").update({ status: "needs_reauth", last_sync_error: "Google Calendar authorization expired. Reconnect Google Calendar." }).eq("id", connectionId).neq("status", "disconnected");
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

export type GoogleRevokeOutcome = "revoked" | "already_invalid" | "failed" | "no_credentials" | "skipped_shared_account";
/** Google revokes the whole grant of a user for this OAuth client, so it would also kill other DanceFlow connections made with the same Google account. */
export async function googleAccountHasOtherConnection(email: string | null | undefined, excludeConnectionId?: string) {
  if (!email) return false;
  const { data } = await createAdminClient().from("studio_google_calendar_connections").select("id").eq("google_account_email", email).eq("status", "connected");
  return ((data ?? []) as Array<{ id: string }>).some((row) => row.id !== excludeConnectionId);
}
/** Best effort: revokes the grant at Google (https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke). Never throws and never logs a token. */
export async function revokeGoogleToken(token: string): Promise<Exclude<GoogleRevokeOutcome, "no_credentials">> {
  try {
    const response = await fetch(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5_000) });
    if (response.ok) return "revoked";
    if (response.status === 400) return "already_invalid";
    return "failed";
  } catch { return "failed"; }
}
/** Revokes the stored grant for a connection (refresh token preferred: revoking it also invalidates its access tokens). */
export async function revokeGoogleCalendarGrant(connectionId: string): Promise<GoogleRevokeOutcome> {
  try {
    const admin = createAdminClient();
    const credentials = await loadGoogleCredentials(admin, connectionId);
    if (!credentials) return "no_credentials";
    const { data: own } = await admin.from("studio_google_calendar_connections").select("google_account_email").eq("id", connectionId).maybeSingle<{ google_account_email: string | null }>();
    if (await googleAccountHasOtherConnection(own?.google_account_email, connectionId)) return "skipped_shared_account";
    return await revokeGoogleToken(decryptIntegrationSecret(credentials.encrypted_refresh_token ?? credentials.encrypted_access_token));
  } catch { return "failed"; }
}
