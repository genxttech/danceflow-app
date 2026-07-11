import { NextRequest, NextResponse } from "next/server";
import { getCronAuthFailure } from "@/lib/security/cron";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deleteGoogleCalendarEvent,
  getValidGoogleCalendarAccessToken,
  upsertGoogleCalendarEvent,
  type GoogleCalendarEventPayload,
} from "@/lib/integrations/google-calendar/client";

type GoogleCalendarConnectionRow = {
  id: string;
  studio_id: string;
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
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
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
};

type ConnectionSyncResult = {
  connectionId: string;
  studioId: string;
  status: "success" | "partial" | "failed" | "skipped";
  synced: number;
  deleted: number;
  failed: number;
  message?: string;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatName(
  first: string | null | undefined,
  last: string | null | undefined,
) {
  return [first, last].filter(Boolean).join(" ").trim();
}

function appointmentKind(value: string | null | undefined) {
  const normalized = normalize(value);
  if (
    ["private_lesson", "lesson", "intro_lesson", "coaching"].includes(
      normalized,
    )
  ) {
    return "lesson";
  }
  if (["group_class", "class", "workshop"].includes(normalized)) return "class";
  return "lesson";
}

function shouldSyncAppointment(
  row: AppointmentSyncRow,
  connection: GoogleCalendarConnectionRow,
) {
  if (["cancelled", "canceled", "no_show"].includes(normalize(row.status)))
    return false;
  const kind = appointmentKind(row.appointment_type);
  if (kind === "lesson") return Boolean(connection.sync_lessons);
  if (kind === "class") return Boolean(connection.sync_classes);
  return false;
}

function appointmentPayload(
  row: AppointmentSyncRow,
): GoogleCalendarEventPayload {
  const client = one(row.clients);
  const instructor = one(row.instructors);
  const room = one(row.rooms);
  const clientName = formatName(client?.first_name, client?.last_name);
  const instructorName = formatName(
    instructor?.first_name,
    instructor?.last_name,
  );
  const kind = appointmentKind(row.appointment_type);
  const title =
    row.title?.trim() ||
    [clientName, kind === "class" ? "Class" : "Lesson"]
      .filter(Boolean)
      .join(" · ") ||
    "DanceFlow appointment";
  const location = row.location_name ?? room?.name ?? undefined;

  return {
    summary: title,
    description: [
      "Synced from DanceFlow.",
      clientName ? `Client: ${clientName}` : null,
      instructorName ? `Instructor: ${instructorName}` : null,
      room?.name ? `Room: ${room.name}` : null,
      row.appointment_type
        ? `Type: ${row.appointment_type.replaceAll("_", " ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    location,
    start: { dateTime: row.starts_at },
    end: { dateTime: row.ends_at },
    extendedProperties: {
      private: {
        danceflowSourceType: "appointment",
        danceflowSourceId: row.id,
      },
    },
  };
}

function eventPayload(row: EventSyncRow): GoogleCalendarEventPayload {
  const location =
    [row.venue_name, row.city, row.state].filter(Boolean).join(", ") ||
    undefined;
  const startDateTime = row.start_time
    ? `${row.start_date}T${row.start_time}`
    : null;
  const endDate = row.end_date ?? row.start_date;
  const endDateTime = row.end_time ? `${endDate}T${row.end_time}` : null;

  return {
    summary: row.name,
    description: [
      "Synced from DanceFlow.",
      row.event_type ? `Type: ${row.event_type.replaceAll("_", " ")}` : null,
      row.status ? `Status: ${row.status}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    location,
    start: startDateTime
      ? { dateTime: startDateTime }
      : { date: row.start_date },
    end: endDateTime ? { dateTime: endDateTime } : { date: endDate },
    extendedProperties: {
      private: {
        danceflowSourceType: "event",
        danceflowSourceId: row.id,
      },
    },
  };
}

async function syncConnection(
  connection: GoogleCalendarConnectionRow,
): Promise<ConnectionSyncResult> {
  const admin = createAdminClient();

  if (!connection.calendar_id) {
    return {
      connectionId: connection.id,
      studioId: connection.studio_id,
      status: "skipped",
      synced: 0,
      deleted: 0,
      failed: 0,
      message: "No calendar selected.",
    };
  }

  const connectionId = connection.id;
  const studioId = connection.studio_id;
  const calendarId = connection.calendar_id;

  try {
    const accessToken = await getValidGoogleCalendarAccessToken(connectionId);
    const now = new Date();
    const rangeEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const today = now.toISOString().slice(0, 10);
    const endDate = rangeEnd.toISOString().slice(0, 10);

    const [
      { data: appointments, error: appointmentsError },
      { data: events, error: eventsError },
      { data: existingItems, error: itemsError },
    ] = await Promise.all([
      admin
        .from("appointments")
        .select(
          "id, title, appointment_type, status, starts_at, ends_at, location_name, clients:clients!appointments_client_id_fkey ( first_name, last_name ), instructors ( first_name, last_name ), rooms ( name )",
        )
        .eq("studio_id", studioId)
        .gte("starts_at", now.toISOString())
        .lte("starts_at", rangeEnd.toISOString())
        .order("starts_at", { ascending: true }),
      admin
        .from("events")
        .select(
          "id, name, event_type, status, start_date, end_date, start_time, end_time, venue_name, city, state",
        )
        .eq("studio_id", studioId)
        .gte("start_date", today)
        .lte("start_date", endDate)
        .in("status", ["draft", "published"])
        .order("start_date", { ascending: true }),
      admin
        .from("studio_google_calendar_sync_items")
        .select("id, source_type, source_id, google_event_id")
        .eq("connection_id", connectionId),
    ]);

    if (appointmentsError)
      throw new Error(
        `Failed to load appointments: ${appointmentsError.message}`,
      );
    if (eventsError)
      throw new Error(`Failed to load events: ${eventsError.message}`);
    if (itemsError)
      throw new Error(
        `Failed to load existing sync items: ${itemsError.message}`,
      );

    const typedExistingItems = (existingItems ?? []) as SyncItemRow[];
    const existingBySource = new Map<string, SyncItemRow>();
    for (const item of typedExistingItems) {
      existingBySource.set(`${item.source_type}:${item.source_id}`, item);
    }

    const existingAppointmentIds = typedExistingItems
      .filter((item) => item.source_type === "appointment")
      .map((item) => item.source_id);
    const existingEventIds = typedExistingItems
      .filter((item) => item.source_type === "event")
      .map((item) => item.source_id);

    const [{ data: existingAppointments }, { data: existingEvents }] =
      await Promise.all([
        existingAppointmentIds.length
          ? admin
              .from("appointments")
              .select(
                "id, title, appointment_type, status, starts_at, ends_at, location_name, clients:clients!appointments_client_id_fkey ( first_name, last_name ), instructors ( first_name, last_name ), rooms ( name )",
              )
              .in("id", existingAppointmentIds)
          : Promise.resolve({ data: [] }),
        existingEventIds.length
          ? admin
              .from("events")
              .select(
                "id, name, event_type, status, start_date, end_date, start_time, end_time, venue_name, city, state",
              )
              .in("id", existingEventIds)
          : Promise.resolve({ data: [] }),
      ]);

    const appointmentById = new Map(
      ((existingAppointments ?? []) as AppointmentSyncRow[]).map((row) => [
        row.id,
        row,
      ]),
    );
    const eventById = new Map(
      ((existingEvents ?? []) as EventSyncRow[]).map((row) => [row.id, row]),
    );
    const eligibleKeys = new Set<string>();

    let synced = 0;
    let deleted = 0;
    let failed = 0;
    const failures: string[] = [];

    async function syncOne(
      sourceType: "appointment" | "event",
      sourceId: string,
      payload: GoogleCalendarEventPayload,
    ) {
      const key = `${sourceType}:${sourceId}`;
      eligibleKeys.add(key);
      const existing = existingBySource.get(key);

      try {
        const googleEvent = await upsertGoogleCalendarEvent({
          accessToken,
          calendarId,
          eventId: existing?.google_event_id,
          payload,
        });

        const upsertPayload = {
          studio_id: studioId,
          connection_id: connectionId,
          source_type: sourceType,
          source_id: sourceId,
          google_calendar_id: calendarId,
          google_event_id: googleEvent.id,
          google_event_html_link: googleEvent.htmlLink ?? null,
          last_synced_at: new Date().toISOString(),
          last_sync_status: "success",
          last_sync_error: null,
        };

        const { error } = existing?.id
          ? await admin
              .from("studio_google_calendar_sync_items")
              .update(upsertPayload)
              .eq("id", existing.id)
          : await admin
              .from("studio_google_calendar_sync_items")
              .insert(upsertPayload);

        if (error) throw new Error(error.message);
        synced += 1;
      } catch (error) {
        failed += 1;
        failures.push(
          error instanceof Error
            ? error.message
            : "Unknown Google Calendar sync error",
        );
      }
    }

    for (const appointment of (
      (appointments ?? []) as AppointmentSyncRow[]
    ).filter((row) => shouldSyncAppointment(row, connection))) {
      await syncOne(
        "appointment",
        appointment.id,
        appointmentPayload(appointment),
      );
    }

    if (connection.sync_events) {
      for (const event of (events ?? []) as EventSyncRow[]) {
        await syncOne("event", event.id, eventPayload(event));
      }
    }

    async function deleteSyncedItem(item: SyncItemRow, reason: string) {
      if (!item.google_event_id) return;

      try {
        await deleteGoogleCalendarEvent({
          accessToken,
          calendarId,
          eventId: item.google_event_id,
        });

        const { error } = await admin
          .from("studio_google_calendar_sync_items")
          .update({
            last_synced_at: new Date().toISOString(),
            last_sync_status: "deleted",
            last_sync_error: reason,
          })
          .eq("id", item.id);

        if (error) throw new Error(error.message);
        deleted += 1;
      } catch (error) {
        failed += 1;
        failures.push(
          error instanceof Error
            ? error.message
            : "Unknown Google Calendar cleanup error",
        );
      }
    }

    for (const item of typedExistingItems) {
      const key = `${item.source_type}:${item.source_id}`;
      if (eligibleKeys.has(key)) continue;
      if (!item.google_event_id) continue;

      if (item.source_type === "appointment") {
        const appointment = appointmentById.get(item.source_id);
        if (!appointment) {
          await deleteSyncedItem(
            item,
            "DanceFlow appointment no longer exists.",
          );
          continue;
        }

        const startsAt = new Date(appointment.starts_at).getTime();
        if (startsAt < now.getTime() || startsAt > rangeEnd.getTime()) continue;
        await deleteSyncedItem(
          item,
          "DanceFlow appointment is cancelled or no longer eligible for sync.",
        );
      }

      if (item.source_type === "event") {
        const event = eventById.get(item.source_id);
        if (!event) {
          await deleteSyncedItem(item, "DanceFlow event no longer exists.");
          continue;
        }

        if (event.start_date < today || event.start_date > endDate) continue;
        await deleteSyncedItem(
          item,
          "DanceFlow event is no longer eligible for sync.",
        );
      }
    }

    const status =
      failed > 0 ? (synced + deleted > 0 ? "partial" : "failed") : "success";
    const { error: updateError } = await admin
      .from("studio_google_calendar_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: status,
        last_sync_error: failures[0] ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);

    if (updateError)
      throw new Error(`Failed to save sync result: ${updateError.message}`);

    return {
      connectionId,
      studioId,
      status,
      synced,
      deleted,
      failed,
      message: failures[0] ?? undefined,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown Google Calendar sync error";

    await admin
      .from("studio_google_calendar_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: "failed",
        last_sync_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);

    return {
      connectionId,
      studioId,
      status: "failed",
      synced: 0,
      deleted: 0,
      failed: 1,
      message,
    };
  }
}

export async function GET(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const admin = createAdminClient();
  const { data: connections, error } = await admin
    .from("studio_google_calendar_connections")
    .select(
      "id, studio_id, calendar_id, sync_lessons, sync_classes, sync_events",
    )
    .eq("status", "connected")
    .not("calendar_id", "is", null)
    .or("sync_lessons.eq.true,sync_classes.eq.true,sync_events.eq.true")
    .order("last_sync_at", { ascending: true, nullsFirst: true })
    .limit(25);

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to load Google Calendar connections: ${error.message}`,
      },
      { status: 500 },
    );
  }

  const results: ConnectionSyncResult[] = [];
  for (const connection of (connections ??
    []) as GoogleCalendarConnectionRow[]) {
    results.push(await syncConnection(connection));
  }

  const totals = results.reduce(
    (acc, result) => {
      acc.synced += result.synced;
      acc.deleted += result.deleted;
      acc.failed += result.failed;
      if (result.status === "success") acc.success += 1;
      if (result.status === "partial") acc.partial += 1;
      if (result.status === "failed") acc.failedConnections += 1;
      if (result.status === "skipped") acc.skipped += 1;
      return acc;
    },
    {
      synced: 0,
      deleted: 0,
      failed: 0,
      success: 0,
      partial: 0,
      failedConnections: 0,
      skipped: 0,
    },
  );

  return NextResponse.json({
    ok: true,
    processed: results.length,
    totals,
    results,
  });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
