import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  deleteGoogleCalendarEvent,
  getValidGoogleCalendarAccessToken,
  upsertGoogleCalendarEvent,
  type GoogleCalendarEventPayload,
} from "@/lib/integrations/google-calendar/client";

export type GoogleCalendarConnectionRow = {
  id: string;
  studio_id: string;
  connection_scope: "studio" | "instructor";
  instructor_id: string | null;
  calendar_id: string | null;
  sync_lessons: boolean | null;
  sync_classes: boolean | null;
  sync_events: boolean | null;
};

type AppointmentSyncRow = {
  id: string;
  title: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
  ends_at: string;
  location_name: string | null;
  instructor_id: string | null;
  clients: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
  instructors: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

type EventSyncRow = {
  id: string;
  name: string;
  event_type: string | null;
  status: string | null;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
};

type SyncItemRow = {
  id: string;
  source_type: string;
  source_id: string;
  google_event_id: string | null;
  google_calendar_id: string;
};

export type ConnectionSyncResult = {
  connectionId: string;
  studioId: string;
  scope: "studio" | "instructor";
  status: "success" | "partial" | "failed" | "skipped";
  synced: number;
  deleted: number;
  failed: number;
  message?: string;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}
function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}
function formatName(first?: string | null, last?: string | null) {
  return [first, last].filter(Boolean).join(" ").trim();
}
function appointmentKind(value: string | null | undefined) {
  const normalized = normalize(value);
  if (["group_class", "class", "workshop"].includes(normalized)) return "class";
  return "lesson";
}
function shouldSyncAppointment(row: AppointmentSyncRow, connection: GoogleCalendarConnectionRow) {
  if (["cancelled", "canceled", "no_show"].includes(normalize(row.status))) return false;
  if (connection.connection_scope === "instructor" && row.instructor_id !== connection.instructor_id) return false;
  return appointmentKind(row.appointment_type) === "class"
    ? Boolean(connection.sync_classes)
    : Boolean(connection.sync_lessons);
}
function appointmentPayload(row: AppointmentSyncRow): GoogleCalendarEventPayload {
  const client = one(row.clients);
  const instructor = one(row.instructors);
  const room = one(row.rooms);
  const clientName = formatName(client?.first_name, client?.last_name);
  const instructorName = formatName(instructor?.first_name, instructor?.last_name);
  return {
    summary: row.title?.trim() || [clientName, appointmentKind(row.appointment_type) === "class" ? "Class" : "Lesson"].filter(Boolean).join(" · ") || "DanceFlow appointment",
    description: [
      "Synced automatically from DanceFlow.",
      clientName ? `Client: ${clientName}` : null,
      instructorName ? `Instructor: ${instructorName}` : null,
      room?.name ? `Room: ${room.name}` : null,
      row.appointment_type ? `Type: ${row.appointment_type.replaceAll("_", " ")}` : null,
    ].filter(Boolean).join("\n"),
    location: row.location_name ?? room?.name ?? undefined,
    start: { dateTime: row.starts_at },
    end: { dateTime: row.ends_at },
    extendedProperties: { private: { danceflowSourceType: "appointment", danceflowSourceId: row.id } },
  };
}
function eventPayload(row: EventSyncRow): GoogleCalendarEventPayload {
  const location = [row.venue_name, row.city, row.state].filter(Boolean).join(", ") || undefined;
  const startDateTime = row.start_time ? `${row.start_date}T${row.start_time}` : null;
  const endDate = row.end_date ?? row.start_date;
  const endDateTime = row.end_time ? `${endDate}T${row.end_time}` : null;
  return {
    summary: row.name,
    description: ["Synced automatically from DanceFlow.", row.event_type ? `Type: ${row.event_type.replaceAll("_", " ")}` : null].filter(Boolean).join("\n"),
    location,
    start: startDateTime ? { dateTime: startDateTime } : { date: row.start_date },
    end: endDateTime ? { dateTime: endDateTime } : { date: endDate },
    extendedProperties: { private: { danceflowSourceType: "event", danceflowSourceId: row.id } },
  };
}

export async function cleanupGoogleCalendarConnectionEvents(connection: GoogleCalendarConnectionRow) {
  const admin = createAdminClient();
  if (!connection.calendar_id) return { deleted: 0, failed: 0 };
  const accessToken = await getValidGoogleCalendarAccessToken(connection.id);
  const { data: items, error } = await admin
    .from("studio_google_calendar_sync_items")
    .select("id, google_event_id, google_calendar_id")
    .eq("connection_id", connection.id)
    .not("google_event_id", "is", null);
  if (error) throw new Error(`Failed to load synced Google events: ${error.message}`);

  let deleted = 0;
  let failed = 0;
  for (const item of items ?? []) {
    try {
      await deleteGoogleCalendarEvent({
        accessToken,
        calendarId: item.google_calendar_id || connection.calendar_id,
        eventId: item.google_event_id,
      });
      await admin.from("studio_google_calendar_sync_items").update({
        google_event_id: null,
        google_event_html_link: null,
        last_synced_at: new Date().toISOString(),
        last_sync_status: "deleted",
        last_sync_error: null,
      }).eq("id", item.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      await admin.from("studio_google_calendar_sync_items").update({
        last_sync_status: "failed",
        last_sync_error: error instanceof Error ? error.message : "Google Calendar cleanup failed.",
      }).eq("id", item.id);
    }
  }
  return { deleted, failed };
}

export async function syncGoogleCalendarConnection(connection: GoogleCalendarConnectionRow): Promise<ConnectionSyncResult> {
  const admin = createAdminClient();
  if (!connection.calendar_id) {
    return { connectionId: connection.id, studioId: connection.studio_id, scope: connection.connection_scope, status: "skipped", synced: 0, deleted: 0, failed: 0, message: "No calendar selected." };
  }

  try {
    const accessToken = await getValidGoogleCalendarAccessToken(connection.id);
    const now = new Date();
    const rangeEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const today = now.toISOString().slice(0, 10);
    const endDate = rangeEnd.toISOString().slice(0, 10);

    let appointmentsQuery = admin.from("appointments").select(
      "id, title, appointment_type, status, starts_at, ends_at, location_name, instructor_id, clients:clients!appointments_client_id_fkey ( first_name, last_name ), instructors ( first_name, last_name ), rooms ( name )",
    ).eq("studio_id", connection.studio_id).gte("starts_at", now.toISOString()).lte("starts_at", rangeEnd.toISOString());
    if (connection.connection_scope === "instructor" && connection.instructor_id) {
      appointmentsQuery = appointmentsQuery.eq("instructor_id", connection.instructor_id);
    }

    const [{ data: appointments, error: appointmentsError }, { data: events, error: eventsError }, { data: existingItems, error: itemsError }] = await Promise.all([
      appointmentsQuery.order("starts_at", { ascending: true }),
      connection.connection_scope === "studio"
        ? admin.from("events").select("id, name, event_type, status, start_date, end_date, start_time, end_time, venue_name, city, state").eq("studio_id", connection.studio_id).gte("start_date", today).lte("start_date", endDate).in("status", ["draft", "published"]).order("start_date", { ascending: true })
        : Promise.resolve({ data: [] as EventSyncRow[], error: null }),
      admin.from("studio_google_calendar_sync_items").select("id, source_type, source_id, google_event_id, google_calendar_id").eq("connection_id", connection.id),
    ]);
    if (appointmentsError) throw new Error(`Failed to load appointments: ${appointmentsError.message}`);
    if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
    if (itemsError) throw new Error(`Failed to load sync items: ${itemsError.message}`);

    const existing = new Map<string, SyncItemRow>();
    for (const item of (existingItems ?? []) as SyncItemRow[]) existing.set(`${item.source_type}:${item.source_id}`, item);
    const eligible = new Set<string>();
    let synced = 0, deleted = 0, failed = 0;
    const failures: string[] = [];

    async function syncOne(sourceType: "appointment" | "event", sourceId: string, payload: GoogleCalendarEventPayload) {
      const key = `${sourceType}:${sourceId}`;
      eligible.add(key);
      const item = existing.get(key);
      try {
        const googleEvent = await upsertGoogleCalendarEvent({ accessToken, calendarId: connection.calendar_id!, eventId: item?.google_event_id, payload });
        const record = {
          studio_id: connection.studio_id,
          connection_id: connection.id,
          source_type: sourceType,
          source_id: sourceId,
          google_calendar_id: connection.calendar_id,
          google_event_id: googleEvent.id,
          google_event_html_link: googleEvent.htmlLink ?? null,
          last_synced_at: new Date().toISOString(),
          last_sync_status: "success",
          last_sync_error: null,
        };
        const { error } = item?.id
          ? await admin.from("studio_google_calendar_sync_items").update(record).eq("id", item.id)
          : await admin.from("studio_google_calendar_sync_items").insert(record);
        if (error) throw new Error(error.message);
        synced += 1;
      } catch (error) {
        failed += 1;
        failures.push(error instanceof Error ? error.message : "Unknown Google Calendar sync error");
      }
    }

    for (const appointment of ((appointments ?? []) as AppointmentSyncRow[]).filter((row) => shouldSyncAppointment(row, connection))) {
      await syncOne("appointment", appointment.id, appointmentPayload(appointment));
    }
    if (connection.connection_scope === "studio" && connection.sync_events) {
      for (const event of (events ?? []) as EventSyncRow[]) await syncOne("event", event.id, eventPayload(event));
    }

    for (const item of (existingItems ?? []) as SyncItemRow[]) {
      const key = `${item.source_type}:${item.source_id}`;
      if (eligible.has(key) || !item.google_event_id) continue;
      try {
        await deleteGoogleCalendarEvent({ accessToken, calendarId: item.google_calendar_id || connection.calendar_id, eventId: item.google_event_id });
        await admin.from("studio_google_calendar_sync_items").update({
          google_event_id: null,
          google_event_html_link: null,
          last_synced_at: new Date().toISOString(),
          last_sync_status: "deleted",
          last_sync_error: "No longer eligible for this calendar connection.",
        }).eq("id", item.id);
        deleted += 1;
      } catch (error) {
        failed += 1;
        failures.push(error instanceof Error ? error.message : "Unknown Google Calendar cleanup error");
      }
    }

    const status = failed > 0 ? (synced + deleted > 0 ? "partial" : "failed") : "success";
    await admin.from("studio_google_calendar_connections").update({
      last_sync_at: new Date().toISOString(), last_sync_status: status, last_sync_error: failures[0] ?? null,
    }).eq("id", connection.id);
    return { connectionId: connection.id, studioId: connection.studio_id, scope: connection.connection_scope, status, synced, deleted, failed, message: failures[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Google Calendar sync error";
    await admin.from("studio_google_calendar_connections").update({ last_sync_at: new Date().toISOString(), last_sync_status: "failed", last_sync_error: message }).eq("id", connection.id);
    return { connectionId: connection.id, studioId: connection.studio_id, scope: connection.connection_scope, status: "failed", synced: 0, deleted: 0, failed: 1, message };
  }
}
