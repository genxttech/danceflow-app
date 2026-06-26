import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";

type EventPushReason = "ticket_ready" | "reminder" | "updated" | "favorite_new_event";

type EventRegistrationPushRow = {
  id: string;
  studio_id: string;
  event_id: string;
  client_id: string | null;
  user_id: string | null;
  attendee_email: string | null;
  attendee_first_name: string | null;
  quantity: number | null;
  status: string | null;
  events:
    | {
        id: string;
        slug: string;
        name: string;
        start_date: string | null;
        start_time: string | null;
        timezone: string | null;
      }
    | {
        id: string;
        slug: string;
        name: string;
        start_date: string | null;
        start_time: string | null;
        timezone: string | null;
      }[]
    | null;
  event_ticket_types:
    | {
        name: string | null;
      }
    | {
        name: string | null;
      }[]
    | null;
  clients:
    | {
        portal_user_id: string | null;
      }
    | {
        portal_user_id: string | null;
      }[]
    | null;
};

type EventPushRow = {
  id: string;
  studio_id: string;
  slug: string;
  name: string;
  start_date: string | null;
  start_time: string | null;
  timezone: string | null;
};

type FavoriteNewEventRow = EventPushRow & {
  organizer_id: string | null;
  visibility: string | null;
  status: string | null;
  public_directory_enabled: boolean | null;
  studios:
    | {
        id: string;
        name: string | null;
      }
    | {
        id: string;
        name: string | null;
      }[]
    | null;
  organizers:
    | {
        id: string;
        name: string | null;
      }
    | {
        id: string;
        name: string | null;
      }[]
    | null;
};

type FavoriteRow = {
  id: string;
  user_id: string;
  target_type: string | null;
  studio_id: string | null;
  event_id: string | null;
};

const DEFAULT_TIME_ZONE = "America/New_York";

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function clean(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function eventUrl(slug: string) {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://idanceflow.com";

  return `${base.replace(/\/$/, "")}/events/${encodeURIComponent(slug)}`;
}

function formatEventTime(params: {
  startDate?: string | null;
  startTime?: string | null;
  timeZone?: string | null;
}) {
  const { startDate, startTime, timeZone } = params;

  if (!startDate) return "";

  const safeTime = startTime && startTime.trim() ? startTime.trim() : "00:00:00";
  const parsed = new Date(`${startDate}T${safeTime}`);

  if (Number.isNaN(parsed.getTime())) return "";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: startTime ? "numeric" : undefined,
    minute: startTime ? "2-digit" : undefined,
  }).format(parsed);
}

function buildRegistrationMessage(params: {
  row: EventRegistrationPushRow;
  reason: EventPushReason;
}) {
  const event = firstJoin(params.row.events);
  const ticketType = firstJoin(params.row.event_ticket_types);
  const eventName = event?.name || "your event";
  const ticketName = ticketType?.name || "ticket";
  const startsAt = formatEventTime({
    startDate: event?.start_date,
    startTime: event?.start_time,
    timeZone: event?.timezone,
  });

  if (params.reason === "reminder") {
    return {
      title: "Event reminder",
      body: startsAt
        ? `${eventName} starts ${startsAt}. Your QR code is in Wallet.`
        : `${eventName} is coming up. Your QR code is in Wallet.`,
    };
  }

  if (params.reason === "updated") {
    return {
      title: "Event updated",
      body: `${eventName} has an update. Check the event details before you go.`,
    };
  }

  return {
    title: "Your ticket is ready",
    body: `Your DanceFlow ${ticketName} for ${eventName} is now in your Wallet.`,
  };
}

function buildEventUpdatedMessage(row: EventPushRow) {
  return {
    title: "Event updated",
    body: `${row.name || "Your event"} has an update. Check the event details before you go.`,
  };
}

async function findPortalUserByEmail(params: {
  supabase: SupabaseClient;
  studioId: string;
  email: string | null | undefined;
}) {
  const email = clean(params.email);
  if (!email) return null;

  const { data, error } = await params.supabase
    .from("clients")
    .select("portal_user_id")
    .eq("studio_id", params.studioId)
    .ilike("email", email)
    .not("portal_user_id", "is", null)
    .limit(1)
    .maybeSingle<{ portal_user_id: string | null }>();

  if (error) {
    console.error("Could not find mobile account for event push:", error.message);
    return null;
  }

  return data?.portal_user_id ?? null;
}

async function userIdsForRegistration(params: {
  supabase: SupabaseClient;
  row: EventRegistrationPushRow;
}) {
  const ids = new Set<string>();

  const directUserId = clean(params.row.user_id);
  if (directUserId) ids.add(directUserId);

  const linkedClient = firstJoin(params.row.clients);
  const linkedPortalUserId = clean(linkedClient?.portal_user_id);
  if (linkedPortalUserId) ids.add(linkedPortalUserId);

  if (ids.size === 0) {
    const emailUserId = await findPortalUserByEmail({
      supabase: params.supabase,
      studioId: params.row.studio_id,
      email: params.row.attendee_email,
    });

    if (emailUserId) ids.add(emailUserId);
  }

  return Array.from(ids);
}

function isPublicDiscoverableEvent(row: {
  visibility?: string | null;
  status?: string | null;
  public_directory_enabled?: boolean | null;
  start_date?: string | null;
  start_time?: string | null;
}) {
  if (row.status !== "published") return false;
  if (row.visibility !== "public" && !row.public_directory_enabled) return false;

  const startsAt = row.start_date
    ? new Date(`${row.start_date}T${row.start_time || "00:00:00"}`)
    : null;

  if (startsAt && !Number.isNaN(startsAt.getTime()) && startsAt.getTime() < Date.now()) {
    return false;
  }

  return true;
}

function buildFavoriteNewEventMessage(row: FavoriteNewEventRow) {
  const studio = firstJoin(row.studios);
  const organizer = firstJoin(row.organizers);
  const hostName = organizer?.name || studio?.name || "A saved DanceFlow host";

  return {
    title: "New event from a saved host",
    body: `${hostName} added ${row.name || "a new event"}.`,
  };
}

async function hasAlreadyLoggedFavoriteEventPush(params: {
  supabase: SupabaseClient;
  userId: string;
  eventId: string;
}) {
  const { data, error } = await params.supabase
    .from("mobile_notification_log")
    .select("id")
    .eq("user_id", params.userId)
    .eq("category", "favorites")
    .contains("data", {
      reason: "favorite_new_event",
      eventId: params.eventId,
    })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Could not check favorite event push history:", error.message);
    return false;
  }

  return Boolean(data?.id);
}

async function loadRegistrationForPush(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  const { data, error } = await params.supabase
    .from("event_registrations")
    .select(
      `
      id,
      studio_id,
      event_id,
      client_id,
      user_id,
      attendee_email,
      attendee_first_name,
      quantity,
      status,
      events (
        id,
        slug,
        name,
        start_date,
        start_time,
        timezone
      ),
      event_ticket_types (
        name
      ),
      clients (
        portal_user_id
      )
    `,
    )
    .eq("id", params.registrationId)
    .maybeSingle();

  if (error || !data) {
    console.error("Could not load event registration for push:", error?.message);
    return null;
  }

  return data as unknown as EventRegistrationPushRow;
}

async function safeSendEventPush(params: {
  userId: string;
  title: string;
  body: string;
  reason: EventPushReason;
  eventId: string;
  registrationId?: string | null;
  eventSlug?: string | null;
}) {
  try {
    await sendMobilePushToUser({
      userId: params.userId,
      category: "event",
      title: params.title,
      body: params.body,
      data: {
        screen: "event",
        reason: params.reason,
        eventId: params.eventId,
        registrationId: params.registrationId ?? null,
        eventSlug: params.eventSlug ?? null,
      },
    });
  } catch (error) {
    console.error("Could not send event push notification:", error);
  }
}

export async function sendEventRegistrationPush(params: {
  supabase: SupabaseClient;
  registrationId: string;
  reason?: Extract<EventPushReason, "ticket_ready" | "reminder">;
}) {
  const reason = params.reason ?? "ticket_ready";
  const row = await loadRegistrationForPush({
    supabase: params.supabase,
    registrationId: params.registrationId,
  });

  if (!row) return;
  if (!["confirmed", "attended", "checked_in"].includes(row.status ?? "")) return;

  const event = firstJoin(row.events);
  if (!event?.id) return;

  const userIds = await userIdsForRegistration({
    supabase: params.supabase,
    row,
  });

  if (userIds.length === 0) return;

  const message = buildRegistrationMessage({ row, reason });

  await Promise.all(
    userIds.map((userId) =>
      safeSendEventPush({
        userId,
        title: message.title,
        body: message.body,
        reason,
        eventId: event.id,
        registrationId: row.id,
        eventSlug: event.slug,
      }),
    ),
  );
}

export async function sendEventUpdatedPush(params: {
  supabase: SupabaseClient;
  eventId: string;
  studioId: string;
}) {
  const { data: eventData, error: eventError } = await params.supabase
    .from("events")
    .select("id, studio_id, slug, name, start_date, start_time, timezone")
    .eq("id", params.eventId)
    .eq("studio_id", params.studioId)
    .maybeSingle();

  if (eventError || !eventData) {
    console.error("Could not load event for update push:", eventError?.message);
    return;
  }

  const event = eventData as EventPushRow;

  const startsAt = event.start_date
    ? new Date(`${event.start_date}T${event.start_time || "00:00:00"}`)
    : null;

  if (startsAt && !Number.isNaN(startsAt.getTime()) && startsAt.getTime() < Date.now()) {
    return;
  }

  const { data: registrations, error: registrationError } = await params.supabase
    .from("event_registrations")
    .select(
      `
      id,
      studio_id,
      event_id,
      client_id,
      user_id,
      attendee_email,
      attendee_first_name,
      quantity,
      status,
      events (
        id,
        slug,
        name,
        start_date,
        start_time,
        timezone
      ),
      event_ticket_types (
        name
      ),
      clients (
        portal_user_id
      )
    `,
    )
    .eq("event_id", params.eventId)
    .eq("studio_id", params.studioId)
    .in("status", ["confirmed", "attended", "checked_in"]);

  if (registrationError) {
    console.error("Could not load event registrations for update push:", registrationError.message);
    return;
  }

  const rows = (registrations ?? []) as unknown as EventRegistrationPushRow[];
  const message = buildEventUpdatedMessage(event);
  const sentUserIds = new Set<string>();

  for (const row of rows) {
    const userIds = await userIdsForRegistration({
      supabase: params.supabase,
      row,
    });

    for (const userId of userIds) {
      if (sentUserIds.has(userId)) continue;
      sentUserIds.add(userId);

      await safeSendEventPush({
        userId,
        title: message.title,
        body: message.body,
        reason: "updated",
        eventId: event.id,
        registrationId: row.id,
        eventSlug: event.slug,
      });
    }
  }
}

export async function sendFavoriteNewEventPush(params: {
  supabase: SupabaseClient;
  eventId: string;
  studioId: string;
}) {
  const { data: eventData, error: eventError } = await params.supabase
    .from("events")
    .select(
      `
      id,
      studio_id,
      organizer_id,
      slug,
      name,
      start_date,
      start_time,
      timezone,
      visibility,
      status,
      public_directory_enabled,
      studios (
        id,
        name
      ),
      organizers (
        id,
        name
      )
    `,
    )
    .eq("id", params.eventId)
    .eq("studio_id", params.studioId)
    .maybeSingle();

  if (eventError || !eventData) {
    console.error("Could not load event for favorite push:", eventError?.message);
    return;
  }

  const event = eventData as unknown as FavoriteNewEventRow;

  if (!isPublicDiscoverableEvent(event)) return;

  const { data: favorites, error: favoritesError } = await params.supabase
    .from("user_favorites")
    .select("id, user_id, target_type, studio_id, event_id")
    .eq("target_type", "studio")
    .eq("studio_id", params.studioId);

  if (favoritesError) {
    console.error("Could not load saved studios for favorite push:", favoritesError.message);
    return;
  }

  const rows = (favorites ?? []) as FavoriteRow[];
  const userIds = Array.from(
    new Set(rows.map((row) => clean(row.user_id)).filter(Boolean)),
  );

  if (userIds.length === 0) return;

  const message = buildFavoriteNewEventMessage(event);

  for (const userId of userIds) {
    const alreadySent = await hasAlreadyLoggedFavoriteEventPush({
      supabase: params.supabase,
      userId,
      eventId: event.id,
    });

    if (alreadySent) continue;

    try {
      await sendMobilePushToUser({
        userId,
        category: "favorites",
        title: message.title,
        body: message.body,
        data: {
          screen: "event",
          reason: "favorite_new_event",
          eventId: event.id,
          eventSlug: event.slug,
          studioId: event.studio_id,
          organizerId: event.organizer_id,
          url: eventUrl(event.slug),
        },
      });
    } catch (error) {
      console.error("Could not send favorite event push notification:", error);
    }
  }
}
