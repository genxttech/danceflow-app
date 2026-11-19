import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SUMMARY_FIELDS,
  loadStudioClientNames,
  one,
  toAppointmentSummary,
  type AppointmentSummaryRow,
  type Embedded,
} from "@/lib/staff/instructorToday";

/**
 * Studio-wide day schedule for the Business app (front desk, admin, owner). Same row shape as the instructor Today plus the instructor, and the same projection
 * rules: no prices, payment state, package balances, contact details or referral source. Instructors are not served here: their window onto client names is the
 * teaching-relationship rule, which a studio-wide list would bypass, so they keep `today`.
 */

// The same explicit allow-list the appointment detail uses for studio-wide ("broad") access; anything else, including roles added later, is denied.
const STUDIO_WIDE_SCHEDULE_ROLES = new Set(["studio_owner", "studio_admin", "front_desk"]);

export function canViewStudioWideSchedule(role: string | null | undefined) {
  return STUDIO_WIDE_SCHEDULE_ROLES.has(role ?? "");
}

/** More than a studio can book in a day; a day beyond it is cut and flagged rather than paged. */
export const STUDIO_DAY_LIMIT = 500;

type ScheduleRow = AppointmentSummaryRow & {
  instructors: Embedded<{ id: string; first_name: string | null; last_name: string | null }>;
};

export async function loadStudioDay(params: {
  supabase: SupabaseClient;
  studioId: string;
  date: string;
  timeZone: string;
  range: { startIso: string; endIso: string };
}) {
  const { supabase, studioId, date, timeZone, range } = params;

  const { data, error } = await supabase
    .from("appointments")
    .select(`${SUMMARY_FIELDS}, instructors ( id, first_name, last_name )`)
    .eq("studio_id", studioId)
    .gte("starts_at", range.startIso)
    .lt("starts_at", range.endIso)
    .order("starts_at", { ascending: true })
    .limit(STUDIO_DAY_LIMIT + 1);

  if (error) throw new Error(`Studio day schedule lookup failed: ${error.message}`);

  const all = (data ?? []) as unknown as ScheduleRow[];
  const truncated = all.length > STUDIO_DAY_LIMIT;
  const rows = all.slice(0, STUDIO_DAY_LIMIT);

  const clientIds = [...new Set(rows.flatMap((row) => [row.client_id, row.partner_client_id]).filter((id): id is string => Boolean(id)))];
  const names = await loadStudioClientNames(supabase, studioId, clientIds);

  const appointments = rows
    .map((row) => {
      const instructor = one(row.instructors);
      return {
        ...toAppointmentSummary(row, names),
        instructor: instructor ? { id: instructor.id, firstName: instructor.first_name ?? "", lastName: instructor.last_name ?? "" } : null,
      };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));

  return { studioId, date, timeZone, truncated, appointments };
}
