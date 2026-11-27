import type { SupabaseClient } from "@supabase/supabase-js";
import { loadStudioClientNames } from "@/lib/staff/instructorToday";

/**
 * Pulse "missing confirmation" read (audit decision O5, owner window 2026-11-26: 48 hours). Read only: nothing is sent, confirmed or changed.
 *
 * An appointment is waiting for a confirmation when all of these hold:
 *  - it belongs to the studio and names one dancer (`client_id`);
 *  - its status is `scheduled` or `rescheduled` (a dancer's confirmation moves it to `confirmed`; cancelled, attended and no-show are over);
 *  - it is not a group class (nobody can confirm one, also not an older class row that still carries a `client_id`) and not a floor space rental;
 *  - it has not started, and it starts no later than 48 elapsed hours from now (the limit itself is included).
 * Whether a confirmation link was ever sent is not considered: the confirmation tokens are not readable by staff sessions, and a dancer can confirm in the app too.
 */

export const CONFIRMATION_WINDOW_HOURS = 48;
const WAITING_STATUSES = ["scheduled", "rescheduled"];
const NOT_CONFIRMED_BY_DANCERS = ["floor_space_rental", "group_class"];
const LIST_LIMIT = 5;

export type PulseConfirmationItem = { id: string; startsAt: string; appointmentType: string; clientName: string | null };
export type ConfirmationsData = { windowHours: number; total: number; truncated: boolean; upcoming: PulseConfirmationItem[] };

type Row = { id: string; client_id: string | null; appointment_type: string | null; starts_at: string };

export function confirmationWindow(now: Date) {
  return { after: now.toISOString(), until: new Date(now.getTime() + CONFIRMATION_WINDOW_HOURS * 3_600_000).toISOString() };
}

export async function loadMissingConfirmations(params: {
  supabase: SupabaseClient;
  studioId: string;
  now: Date;
  /** "own" limits everything to the viewer's instructor id and never reads a client name. */
  scope: "all" | "own";
  instructorId: string | null;
}): Promise<ConfirmationsData> {
  const { supabase, studioId, now, scope, instructorId } = params;
  const empty = { windowHours: CONFIRMATION_WINDOW_HOURS, total: 0, truncated: false, upcoming: [] };
  if (scope === "own" && !instructorId) return empty;
  const { after, until } = confirmationWindow(now);
  const query = (columns: string, head: boolean) => {
    let q = head ? supabase.from("appointments").select(columns, { count: "exact", head: true }) : supabase.from("appointments").select(columns);
    q = q
      .eq("studio_id", studioId)
      .in("status", WAITING_STATUSES)
      .not("client_id", "is", null)
      .neq("appointment_type", NOT_CONFIRMED_BY_DANCERS[0])
      .neq("appointment_type", NOT_CONFIRMED_BY_DANCERS[1])
      .gt("starts_at", after)
      .lte("starts_at", until);
    return scope === "own" ? q.eq("instructor_id", instructorId as string) : q;
  };
  const [count, list] = await Promise.all([
    query("id", true),
    query("id, client_id, appointment_type, starts_at", false).order("starts_at", { ascending: true }).limit(LIST_LIMIT),
  ]);
  if (count.error) throw new Error(`Pulse confirmations count failed: ${count.error.message}`);
  if (list.error) throw new Error(`Pulse confirmations list failed: ${list.error.message}`);
  const rows = (list.data ?? []) as unknown as Row[];
  const total = count.count ?? 0;
  const names =
    scope === "all"
      ? await loadStudioClientNames(supabase, studioId, [...new Set(rows.map((row) => row.client_id).filter((id): id is string => Boolean(id)))])
      : new Map<string, { firstName: string; lastName: string }>();
  return {
    windowHours: CONFIRMATION_WINDOW_HOURS,
    total,
    truncated: total > rows.length,
    upcoming: rows.map((row) => {
      const name = scope === "all" && row.client_id ? names.get(row.client_id) : undefined;
      return {
        id: row.id,
        startsAt: row.starts_at,
        appointmentType: row.appointment_type ?? "appointment",
        clientName: name ? [name.firstName, name.lastName].filter(Boolean).join(" ") || null : null,
      };
    }),
  };
}
