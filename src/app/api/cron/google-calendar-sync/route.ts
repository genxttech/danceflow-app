import { NextRequest, NextResponse } from "next/server";
import { getCronAuthFailure } from "@/lib/security/cron";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  syncGoogleCalendarConnection,
  type ConnectionSyncResult,
  type GoogleCalendarConnectionRow,
} from "@/lib/integrations/google-calendar/sync";

export async function GET(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const admin = createAdminClient();
  const { data: connections, error } = await admin
    .from("studio_google_calendar_connections")
    .select("id, studio_id, connection_scope, instructor_id, calendar_id, sync_lessons, sync_classes, sync_events")
    .eq("status", "connected")
    .not("calendar_id", "is", null)
    .or("sync_lessons.eq.true,sync_classes.eq.true,sync_events.eq.true")
    .order("last_sync_at", { ascending: true, nullsFirst: true })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: false, error: `Failed to load Google Calendar connections: ${error.message}` }, { status: 500 });
  }

  const results: ConnectionSyncResult[] = [];
  for (const connection of (connections ?? []) as GoogleCalendarConnectionRow[]) {
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

  return NextResponse.json({ ok: true, processed: results.length, totals, results });
}

export async function POST(request: NextRequest) { return GET(request); }
