import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import { toIsoUtc } from "@/lib/staff/instructorToday";
import { canViewStudioWideSchedule } from "@/lib/staff/studioSchedule";

/**
 * The Business home summary: counts and the next appointment, nothing that names a person or carries money. Studio-wide for owner, admin and front desk; for an
 * instructor it is their OWN day (the same boundary as `today`: the explicit instructor_id filter, never RLS alone). Client names are deliberately absent so the
 * teaching-relationship rule has nothing to apply to; the app opens the appointment for detail.
 */

const UPCOMING_STATUSES = ["scheduled", "confirmed", "rescheduled"];
const DAY_ROW_LIMIT = 500;
const NEW_CLIENT_WINDOW_DAYS = 7;

type PulseRow = { id: string; status: string; starts_at: string };
type NextRow = { id: string; title: string | null; appointment_type: string; status: string; starts_at: string; ends_at: string };

export async function loadPulse(params: {
  supabase: SupabaseClient;
  studioId: string;
  userId: string;
  studioRole: string;
  timeZone: string;
  date: string;
  range: { startIso: string; endIso: string };
  now: Date;
}) {
  const { supabase, studioId, userId, studioRole, timeZone, date, range, now } = params;
  const studioWide = canViewStudioWideSchedule(studioRole);
  const nowIso = now.toISOString();
  const base = { studioId, timeZone, date, asOf: nowIso, scope: studioWide ? ("studio" as const) : ("own" as const) };
  const empty = { today: { total: 0, upcoming: 0, cancelled: 0, truncated: false }, next: null, newClientsLast7Days: null };

  let instructorId: string | null = null;
  if (!studioWide) {
    instructorId = await resolveViewerInstructorId(supabase, studioId, userId);
    // No linked instructor means no own day, never everyone's.
    if (!instructorId) return { ...base, instructorId, ...empty };
  }

  let dayQuery = supabase
    .from("appointments")
    .select("id, status, starts_at")
    .eq("studio_id", studioId)
    .gte("starts_at", range.startIso)
    .lt("starts_at", range.endIso);
  let nextQuery = supabase
    .from("appointments")
    .select("id, title, appointment_type, status, starts_at, ends_at")
    .eq("studio_id", studioId)
    .in("status", UPCOMING_STATUSES)
    .gte("starts_at", nowIso);
  if (instructorId) {
    dayQuery = dayQuery.eq("instructor_id", instructorId);
    nextQuery = nextQuery.eq("instructor_id", instructorId);
  }

  const since = new Date(now.getTime() - NEW_CLIENT_WINDOW_DAYS * 86_400_000).toISOString();
  const [day, next, newClients] = await Promise.all([
    dayQuery.limit(DAY_ROW_LIMIT + 1),
    nextQuery.order("starts_at", { ascending: true }).limit(1),
    studioWide
      ? supabase.from("clients").select("id", { count: "exact", head: true }).eq("studio_id", studioId).gte("created_at", since)
      : Promise.resolve(null),
  ]);

  if (day.error) throw new Error(`Pulse day lookup failed: ${day.error.message}`);
  if (next.error) throw new Error(`Pulse next lookup failed: ${next.error.message}`);
  if (newClients?.error) throw new Error(`Pulse new clients lookup failed: ${newClients.error.message}`);

  const all = (day.data ?? []) as PulseRow[];
  const rows = all.slice(0, DAY_ROW_LIMIT);
  const live = rows.filter((row) => row.status !== "cancelled");
  const nextRow = ((next.data ?? []) as NextRow[])[0] ?? null;

  return {
    ...base,
    instructorId,
    today: {
      total: live.length,
      upcoming: live.filter((row) => new Date(row.starts_at).getTime() >= now.getTime()).length,
      cancelled: rows.length - live.length,
      truncated: all.length > DAY_ROW_LIMIT,
    },
    next: nextRow
      ? {
          id: nextRow.id,
          appointmentType: nextRow.appointment_type,
          title: nextRow.title,
          status: nextRow.status,
          startsAt: toIsoUtc(nextRow.starts_at),
          endsAt: toIsoUtc(nextRow.ends_at),
        }
      : null,
    newClientsLast7Days: studioWide ? (newClients?.count ?? 0) : null,
  };
}
