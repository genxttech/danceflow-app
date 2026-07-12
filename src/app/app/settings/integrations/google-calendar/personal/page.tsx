import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { getGoogleCalendarAccess } from "@/lib/integrations/google-calendar/access";
import { getValidGoogleCalendarAccessToken, listGoogleCalendars } from "@/lib/integrations/google-calendar/client";
import {
  disconnectGoogleCalendarAction,
  refreshGoogleCalendarsAction,
  syncGoogleCalendarNowAction,
  updateGoogleCalendarSettingsAction,
} from "../actions";

type SearchParams = Promise<{ connected?: string; saved?: string; disconnected?: string; refreshed?: string; synced?: string; deleted?: string; failed?: string; error?: string }>;
type Connection = {
  id: string;
  status: string;
  google_account_email: string | null;
  calendar_id: string | null;
  calendar_summary: string | null;
  sync_lessons: boolean | null;
  sync_classes: boolean | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
};
function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
export default async function PersonalGoogleCalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  let access;
  try { access = await getGoogleCalendarAccess("instructor"); } catch { redirect("/app?calendar=not_linked"); }
  const { data: connection, error } = await access.supabase
    .from("studio_google_calendar_connections")
    .select("id, status, google_account_email, calendar_id, calendar_summary, sync_lessons, sync_classes, last_sync_at, last_sync_status, last_sync_error")
    .eq("studio_id", access.context.studioId)
    .eq("connection_scope", "instructor")
    .eq("instructor_id", access.instructorId)
    .maybeSingle<Connection>();
  if (error) throw new Error(`Failed to load personal Google Calendar connection: ${error.message}`);

  let calendars: Array<{ id: string; summary: string; primary?: boolean }> = [];
  let calendarLoadError: string | null = null;
  if (connection?.status === "connected") {
    try { calendars = await listGoogleCalendars(await getValidGoogleCalendarAccessToken(connection.id)); }
    catch (caught) { calendarLoadError = caught instanceof Error ? caught.message : "Calendars could not be loaded."; }
  }
  const returnTo = "/app/settings/integrations/google-calendar/personal";
  const connected = connection?.status === "connected";
  const instructorName = access.instructor ? `${access.instructor.first_name} ${access.instructor.last_name}`.trim() : "Instructor";

  return (
    <main className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-fuchsia-200 bg-gradient-to-br from-[#5B197A] via-[#7E22CE] to-[#BE185D] text-white shadow-sm">
        <div className="p-7 sm:p-8">
          <div className="flex flex-wrap gap-4 text-sm font-semibold text-fuchsia-100">
            <Link href="/app/settings/integrations/google-calendar">Studio Calendar</Link>
            <Link href="/app/settings/integrations">Integration Hub</Link>
          </div>
          <p className="mt-6 text-sm font-semibold uppercase tracking-[0.24em] text-fuchsia-100">My Teaching Calendar</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Keep your assigned DanceFlow schedule on your own calendar.</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-fuchsia-50">
            {instructorName}'s assigned lessons and classes automatically sync every 30 minutes. Studio events and other instructors' appointments are not included.
          </p>
        </div>
      </section>

      {params.connected ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">Your teaching calendar is connected.</div> : null}
      {params.saved ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">Personal calendar settings saved.</div> : null}
      {params.disconnected ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">Personal calendar disconnected and DanceFlow-created entries removed.</div> : null}
      {params.synced ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">Sync complete: {params.synced} synced, {params.deleted ?? "0"} removed, {params.failed ?? "0"} failed.</div> : null}
      {params.error || calendarLoadError ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-900">{calendarLoadError ?? `Google Calendar needs attention: ${params.error?.replaceAll("_", " ")}`}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-fuchsia-50 text-[#BE185D]"><CalendarDays className="h-5 w-5" /></span>
            <div><h2 className="text-xl font-semibold text-slate-950">Personal instructor connection</h2><p className="mt-2 text-sm leading-6 text-slate-600">This connection follows your instructor assignment, regardless of whether your studio role is owner, admin, or instructor.</p></div>
          </div>

          {!connected ? (
            <a href="/api/integrations/google-calendar/connect?scope=instructor" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-3 text-sm font-semibold text-white hover:bg-[#46115E]">Connect my Google Calendar <ExternalLink className="h-4 w-4" /></a>
          ) : (
            <form action={updateGoogleCalendarSettingsAction} className="mt-6 space-y-5">
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="connectionScope" value="instructor" />
              <label className="block"><span className="text-sm font-semibold text-slate-700">Target Google Calendar</span>
                <select name="calendarId" defaultValue={connection.calendar_id ?? "primary"} className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.summary}{calendar.primary ? " · Primary" : ""}</option>)}
                </select>
              </label>
              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4"><input type="checkbox" name="syncLessons" defaultChecked={connection.sync_lessons ?? true} className="mt-1" /><span><strong className="block text-sm text-slate-950">Assigned lessons</strong><span className="text-xs text-slate-500">Private, intro, and coaching appointments assigned to you.</span></span></label>
              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4"><input type="checkbox" name="syncClasses" defaultChecked={connection.sync_classes ?? true} className="mt-1" /><span><strong className="block text-sm text-slate-950">Assigned classes</strong><span className="text-xs text-slate-500">Group classes and workshops assigned to you.</span></span></label>
              <button className="rounded-xl bg-[#5B197A] px-4 py-3 text-sm font-semibold text-white">Save personal calendar settings</button>
            </form>
          )}
        </section>

        <div className="space-y-6">
          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3"><ShieldCheck className="h-6 w-6 text-emerald-600" /><div><h2 className="text-lg font-semibold text-slate-950">Connection status</h2><p className="mt-2 text-sm text-slate-600">Account: {connection?.google_account_email ?? "Not connected"}</p><p className="mt-1 text-sm text-slate-600">Calendar: {connection?.calendar_summary ?? "Not selected"}</p><p className="mt-1 text-sm text-slate-600">Last auto-sync: {formatDateTime(connection?.last_sync_at)}</p></div></div>
          </section>
          {connected ? <>
            <form action={syncGoogleCalendarNowAction}><input type="hidden" name="returnTo" value={returnTo} /><input type="hidden" name="connectionScope" value="instructor" /><button className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"><RefreshCw className="h-4 w-4" />Sync now</button></form>
            <form action={refreshGoogleCalendarsAction}><input type="hidden" name="returnTo" value={returnTo} /><input type="hidden" name="connectionScope" value="instructor" /><button className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700">Refresh authorization</button></form>
            <form action={disconnectGoogleCalendarAction}><input type="hidden" name="returnTo" value={returnTo} /><input type="hidden" name="connectionScope" value="instructor" /><button className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">Disconnect and remove synced entries</button></form>
          </> : null}
        </div>
      </div>
    </main>
  );
}
