import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { getValidGoogleCalendarAccessToken, listGoogleCalendars } from "@/lib/integrations/google-calendar/client";
import {
  disconnectGoogleCalendarAction,
  refreshGoogleCalendarsAction,
  syncGoogleCalendarNowAction,
  updateGoogleCalendarSettingsAction,
} from "./actions";

type SearchParams = Promise<{
  connected?: string;
  saved?: string;
  disconnected?: string;
  refreshed?: string;
  synced?: string;
  failed?: string;
  error?: string;
}>;

type GoogleCalendarConnectionRow = {
  id: string;
  status: string;
  google_account_email: string | null;
  calendar_id: string | null;
  calendar_summary: string | null;
  scopes: string[] | null;
  sync_lessons: boolean | null;
  sync_classes: boolean | null;
  sync_events: boolean | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  updated_at: string | null;
};

type SyncItemRow = {
  id: string;
  source_type: string;
  source_id: string;
  google_event_html_link: string | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatLabel(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  if (!normalized) return "Not recorded";
  return normalized.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusClass(status: string | null | undefined) {
  switch (status) {
    case "connected":
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "partial":
    case "needs_reauth":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "failed":
    case "disconnected":
      return "border-rose-200 bg-rose-50 text-rose-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function Badge({ value }: { value: string | null | undefined }) {
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${statusClass(value)}`}>
      {formatLabel(value)}
    </span>
  );
}

function StatCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-slate-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p>
    </div>
  );
}

export default async function GoogleCalendarIntegrationPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");

  const supabase = await createClient();
  const { data: connection, error: connectionError } = await supabase
    .from("studio_google_calendar_connections")
    .select("id, status, google_account_email, calendar_id, calendar_summary, scopes, sync_lessons, sync_classes, sync_events, last_sync_at, last_sync_status, last_sync_error, updated_at")
    .eq("studio_id", context.studioId)
    .maybeSingle<GoogleCalendarConnectionRow>();

  if (connectionError) throw new Error(`Failed to load Google Calendar connection: ${connectionError.message}`);

  const { data: syncItems, error: syncItemsError } = connection?.id
    ? await supabase
        .from("studio_google_calendar_sync_items")
        .select("id, source_type, source_id, google_event_html_link, last_synced_at, last_sync_status, last_sync_error")
        .eq("connection_id", connection.id)
        .order("last_synced_at", { ascending: false })
        .limit(10)
    : { data: [] as SyncItemRow[], error: null };

  if (syncItemsError) throw new Error(`Failed to load Google Calendar sync history: ${syncItemsError.message}`);

  let calendars: Array<{ id: string; summary: string; primary?: boolean }> = [];
  let calendarLoadError: string | null = null;

  if (connection?.status === "connected") {
    try {
      const accessToken = await getValidGoogleCalendarAccessToken(connection.id);
      calendars = await listGoogleCalendars(accessToken);
    } catch (error) {
      calendarLoadError = error instanceof Error ? error.message : "Calendar list could not be loaded.";
    }
  }

  const isConnected = connection?.status === "connected";
  const syncedCount = (syncItems ?? []).filter((item) => item.last_sync_status === "success").length;
  const failedCount = (syncItems ?? []).filter((item) => item.last_sync_status === "failed").length;
  const returnTo = "/app/settings/integrations/google-calendar";

  return (
    <main className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-fuchsia-200 bg-gradient-to-br from-[#5B197A] via-[#7E22CE] to-[#BE185D] text-white shadow-sm">
        <div className="p-7 sm:p-8">
          <Link href="/app/settings/integrations" className="inline-flex items-center gap-2 text-sm font-semibold text-fuchsia-100 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Integration Hub
          </Link>
          <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-fuchsia-100">Google Calendar</p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Sync DanceFlow to your studio calendar.</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-fuchsia-50">
                Start with safe one-way outbound sync from DanceFlow to Google Calendar. DanceFlow remains the source of truth for bookings, payments, attendance, rooms, and student notifications.
              </p>
            </div>
            <Badge value={connection?.status ?? "not_connected"} />
          </div>
        </div>
      </section>

      {params.connected ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">Google Calendar connected.</div> : null}
      {params.saved ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">Google Calendar settings saved.</div> : null}
      {params.disconnected ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">Google Calendar disconnected.</div> : null}
      {params.synced ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">Sync complete. {params.synced} item{params.synced === "1" ? "" : "s"} synced, {params.failed ?? "0"} failed.</div> : null}
      {params.error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-900">Google Calendar needs attention: {params.error.replaceAll("_", " ")}</div> : null}
      {calendarLoadError ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">{calendarLoadError}</div> : null}

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard label="Account" value={connection?.google_account_email ?? "Not connected"} helper="The Google account authorized for this studio." />
        <StatCard label="Calendar" value={connection?.calendar_summary ?? connection?.calendar_id ?? "Not selected"} helper="DanceFlow will create and update events here." />
        <StatCard label="Last Sync" value={formatDateTime(connection?.last_sync_at)} helper={connection?.last_sync_status ? formatLabel(connection.last_sync_status) : "No sync has run yet."} />
        <StatCard label="Recent Items" value={`${syncedCount} synced`} helper={`${failedCount} recent failure${failedCount === 1 ? "" : "s"} in the latest sync log.`} />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-fuchsia-50 text-[#BE185D]"><CalendarDays className="h-5 w-5" /></span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Connection</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Connect and choose what syncs.</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">Google Calendar sync is one-way outbound in this phase. Make schedule changes in DanceFlow, then sync.</p>
            </div>
          </div>

          {!isConnected ? (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm text-slate-600">Connect Google Calendar to select a target calendar and enable outbound schedule sync.</p>
              <a href="/api/integrations/google-calendar/connect" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#46115E]">
                Connect Google Calendar <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          ) : (
            <form action={updateGoogleCalendarSettingsAction} className="mt-6 space-y-5">
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="calendarSummary" value={calendars.find((calendar) => calendar.id === connection.calendar_id)?.summary ?? connection.calendar_summary ?? ""} />

              <label className="block">
                <span className="text-sm font-semibold text-slate-700">Target Google Calendar</span>
                <select name="calendarId" defaultValue={connection.calendar_id ?? "primary"} className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 shadow-sm">
                  {calendars.length ? calendars.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>{calendar.summary}{calendar.primary ? " · Primary" : ""}</option>
                  )) : (
                    <option value={connection.calendar_id ?? "primary"}>{connection.calendar_summary ?? connection.calendar_id ?? "Primary calendar"}</option>
                  )}
                </select>
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-800">
                  <input type="checkbox" name="syncLessons" defaultChecked={Boolean(connection.sync_lessons)} className="mr-2" />
                  Private lessons
                </label>
                <label className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-800">
                  <input type="checkbox" name="syncClasses" defaultChecked={Boolean(connection.sync_classes)} className="mr-2" />
                  Group classes
                </label>
                <label className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-800">
                  <input type="checkbox" name="syncEvents" defaultChecked={Boolean(connection.sync_events)} className="mr-2" />
                  Studio events
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button type="submit" className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#46115E]">Save settings</button>
              </div>
            </form>
          )}
        </section>

        <aside className="space-y-6">
          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck className="h-5 w-5" /></span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Safe Sync Rules</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">DanceFlow stays the source of truth.</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">This sync does not read Google Calendar changes back into DanceFlow yet. That prevents outside edits from bypassing billing, packages, rooms, attendance, or student notifications.</p>
              </div>
            </div>
          </section>

          {isConnected ? (
            <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Actions</p>
              <div className="mt-5 flex flex-col gap-3">
                <form action={syncGoogleCalendarNowAction}>
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#46115E]"><RefreshCw className="h-4 w-4" /> Sync next 90 days</button>
                </form>
                <form action={refreshGoogleCalendarsAction}>
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">Refresh calendar access</button>
                </form>
                <form action={disconnectGoogleCalendarAction}>
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100">Disconnect Google Calendar</button>
                </form>
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Sync Log</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Recently synced calendar items</h2>
          </div>
          {connection?.last_sync_error ? <Badge value="failed" /> : <Badge value={connection?.last_sync_status ?? "not_synced"} />}
        </div>

        {connection?.last_sync_error ? (
          <div className="mt-5 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{connection.last_sync_error}</p>
          </div>
        ) : null}

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {(syncItems ?? []).length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Synced</th>
                  <th className="px-4 py-3">Google</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {((syncItems ?? []) as SyncItemRow[]).map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-3 font-semibold text-slate-950">{formatLabel(item.source_type)}</td>
                    <td className="px-4 py-3"><Badge value={item.last_sync_status} /></td>
                    <td className="px-4 py-3 text-slate-600">{formatDateTime(item.last_synced_at)}</td>
                    <td className="px-4 py-3">
                      {item.google_event_html_link ? (
                        <a href={item.google_event_html_link} className="inline-flex items-center gap-2 font-semibold text-[#BE185D]" target="_blank" rel="noreferrer">Open <ExternalLink className="h-3.5 w-3.5" /></a>
                      ) : (
                        <span className="text-slate-500">Not available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-6 text-sm text-slate-500">No Google Calendar sync items have been created yet.</div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-fuchsia-50 text-[#BE185D]"><Sparkles className="h-5 w-5" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">ARIA Calendar Readiness</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Calendar sync prepares the studio for smarter scheduling assistance.</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Once Google Calendar sync is stable, ARIA can later help review calendar exceptions, missing instructor coverage, and schedule readiness without taking control away from the studio.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
