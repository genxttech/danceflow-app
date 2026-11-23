import { NextRequest, NextResponse } from "next/server";
import { getCronAuthFailure } from "@/lib/security/cron";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  syncGoogleCalendarConnection,
  type ConnectionSyncResult,
  type GoogleCalendarConnectionRow,
} from "@/lib/integrations/google-calendar/sync";

export const maxDuration = 60;
/** No new connection starts after this; leaves room under maxDuration for the connection in flight. */
export const GOOGLE_CALENDAR_CRON_BUDGET_MS = 40_000;

export async function GET(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const startedAt = Date.now();
  const admin = createAdminClient();

  // A personal connection of a deactivated instructor must not be synced, and must not occupy the oldest-first queue
  // (skipped rows never advance last_sync_at), so they are excluded in the query rather than filtered afterwards.
  const { data: instructorConnections, error: instructorError } = await admin
    .from("studio_google_calendar_connections")
    .select("instructor_id")
    .eq("status", "connected")
    .eq("connection_scope", "instructor")
    .not("instructor_id", "is", null);
  if (instructorError) {
    return NextResponse.json({ ok: false, error: `Failed to load Google Calendar connections: ${instructorError.message}` }, { status: 500 });
  }
  const instructorIds = [...new Set((instructorConnections ?? []).map((row: { instructor_id: string | null }) => row.instructor_id).filter((id): id is string => Boolean(id)))];
  let inactiveInstructorIds: string[] = [];
  if (instructorIds.length > 0) {
    const { data: inactive, error: inactiveError } = await admin.from("instructors").select("id").in("id", instructorIds).eq("active", false);
    if (inactiveError) {
      return NextResponse.json({ ok: false, error: `Failed to load instructors: ${inactiveError.message}` }, { status: 500 });
    }
    inactiveInstructorIds = (inactive ?? []).map((row: { id: string }) => row.id);
  }

  let query = admin
    .from("studio_google_calendar_connections")
    .select("id, studio_id, connection_scope, instructor_id, calendar_id, sync_lessons, sync_classes, sync_events")
    .eq("status", "connected")
    .not("calendar_id", "is", null)
    .or("sync_lessons.eq.true,sync_classes.eq.true,sync_events.eq.true");
  // NULL-safe: studio-scope rows have a NULL instructor_id, and NOT (NULL = ANY(...)) is NULL, which would drop them. A second or= is ANDed with the first by PostgREST.
  if (inactiveInstructorIds.length > 0) query = query.or(`instructor_id.is.null,instructor_id.not.in.(${inactiveInstructorIds.join(",")})`);
  const { data: connections, error } = await query
    .order("last_sync_at", { ascending: true, nullsFirst: true })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: false, error: `Failed to load Google Calendar connections: ${error.message}` }, { status: 500 });
  }

  const results: ConnectionSyncResult[] = [];
  let deferred = 0;
  for (const connection of (connections ?? []) as GoogleCalendarConnectionRow[]) {
    if (Date.now() - startedAt >= GOOGLE_CALENDAR_CRON_BUDGET_MS) {
      deferred += 1; // untouched: last_sync_at is not advanced, so it leads the next run's oldest-first order
      continue;
    }
    results.push(await syncGoogleCalendarConnection(connection));
  }

  const totals = results.reduce((acc, result) => {
    acc.synced += result.synced;
    acc.deleted += result.deleted;
    acc.failed += result.failed;
    if (result.status === "success") acc.success += 1;
    if (result.status === "partial") acc.partial += 1;
    if (result.status === "failed") acc.failedConnections += 1;
    if (result.status === "skipped") acc.skipped += 1;
    return acc;
  }, { synced: 0, deleted: 0, failed: 0, success: 0, partial: 0, failedConnections: 0, skipped: 0 });

  return NextResponse.json({ ok: true, processed: results.length, deferred, totals, results });
}

export async function POST(request: NextRequest) { return GET(request); }
