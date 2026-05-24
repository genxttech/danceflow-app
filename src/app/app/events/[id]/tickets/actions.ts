"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStudioContextForStudio } from "@/lib/auth/studio";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return false;
  return value === "true" || value === "on";
}

function parseOptionalInteger(value: string) {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInteger(value: string, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, parsed);
}

function parseMoney(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalTimezoneOffset(value: string) {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalDateTimeLocal(value: string, timezoneOffsetMinutes: number | null) {
  if (!value) return null;

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (match && timezoneOffsetMinutes !== null) {
    const [, year, month, day, hour, minute, second = "00"] = match;
    const utcFromWallClock = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    const parsed = new Date(utcFromWallClock + timezoneOffsetMinutes * 60_000);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

type EventAccess = {
  event: {
    id: string;
    studio_id: string;
    organizer_id: string | null;
  };
  studioRole: string | null;
  organizerUserRole: string | null;
  isPlatformAdmin: boolean;
  userId: string;
};

function canManageTickets(params: {
  isPlatformAdmin: boolean;
  studioRole: string | null | undefined;
  organizerUserRole: string | null | undefined;
  isStudioHostedEvent: boolean;
}) {
  const normalizedStudioRole = (params.studioRole ?? "").trim().toLowerCase();
  const normalizedOrganizerRole = (params.organizerUserRole ?? "")
    .trim()
    .toLowerCase();

  if (params.isPlatformAdmin) return true;

  if (
    normalizedOrganizerRole === "organizer_owner" ||
    normalizedOrganizerRole === "organizer_admin" ||
    normalizedOrganizerRole === "organizer_staff"
  ) {
    return true;
  }

  if (
    params.isStudioHostedEvent &&
    (normalizedStudioRole === "studio_owner" ||
      normalizedStudioRole === "studio_admin" ||
      normalizedStudioRole === "organizer_owner" ||
      normalizedStudioRole === "organizer_admin")
  ) {
    return true;
  }

  return false;
}

async function getTicketEventAccess(eventId: string): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  access: EventAccess;
}> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: event, error } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .single();

  if (error || !event) {
    throw new Error("Event not found.");
  }

  const typedEvent = event as {
    id: string;
    studio_id: string;
    organizer_id: string | null;
  };

  const context = await getStudioContextForStudio(typedEvent.studio_id);

  let organizerUserRole: string | null = null;

  if (typedEvent.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", typedEvent.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    organizerUserRole = organizerUser?.role ?? null;
  }

  const access: EventAccess = {
    event: typedEvent,
    studioRole: context.studioRole ?? null,
    organizerUserRole,
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
    userId: user.id,
  };

  if (
    !canManageTickets({
      isPlatformAdmin: access.isPlatformAdmin,
      studioRole: access.studioRole,
      organizerUserRole: access.organizerUserRole,
      isStudioHostedEvent: !access.event.organizer_id,
    })
  ) {
    throw new Error(
      `You do not have permission to manage tickets. Role: ${
        access.studioRole ?? "none"
      }. Organizer role: ${access.organizerUserRole ?? "none"}. Studio hosted: ${
        !access.event.organizer_id
      }.`
    );
  }

  return { supabase, access };
}

function getAttendeesPerTicket(formData: FormData) {
  return parsePositiveInteger(
    getString(formData, "attendeesPerTicket") ||
      getString(formData, "attendees_per_ticket"),
    1
  );
}

export async function createTicketTypeAction(formData: FormData) {
  let redirectTo = "";

  try {
    const eventId = getString(formData, "eventId");
    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const ticketKind = getString(formData, "ticketKind") || "general_admission";
    const price = parseMoney(getString(formData, "price"));
    const currency = (getString(formData, "currency") || "USD").toUpperCase();
    const capacity = parseOptionalInteger(getString(formData, "capacity"));
    const sortOrder = parseOptionalInteger(getString(formData, "sortOrder")) ?? 0;
    const timezoneOffsetMinutes = parseOptionalTimezoneOffset(
      getString(formData, "timezoneOffsetMinutes")
    );
    const saleStartsAt = parseOptionalDateTimeLocal(
      getString(formData, "saleStartsAt"),
      timezoneOffsetMinutes
    );
    const saleEndsAt = parseOptionalDateTimeLocal(
      getString(formData, "saleEndsAt"),
      timezoneOffsetMinutes
    );
    const active = getBoolean(formData, "active");
    const attendeesPerTicket = getAttendeesPerTicket(formData);

    if (!eventId) {
      throw new Error("Missing event id.");
    }

    if (!name) {
      throw new Error("Ticket name is required.");
    }

    const { supabase, access } = await getTicketEventAccess(eventId);

    const { error } = await supabase.from("event_ticket_types").insert({
      event_id: access.event.id,
      name,
      description: description || null,
      ticket_kind: ticketKind,
      price,
      currency,
      capacity,
      sort_order: sortOrder,
      sale_starts_at: saleStartsAt,
      sale_ends_at: saleEndsAt,
      active,
      attendees_per_ticket: attendeesPerTicket,
    });

    if (error) {
      throw new Error(`Could not create ticket type: ${error.message}`);
    }

    redirectTo = `/app/events/${access.event.id}/tickets`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create ticket type.";

    const fallbackEventId = getString(formData, "eventId");

    redirect(
      `/app/events/${encodeURIComponent(
        fallbackEventId
      )}/tickets?error=${encodeURIComponent(message)}`
    );
  }

  redirect(redirectTo);
}

export async function updateTicketTypeAction(formData: FormData) {
  let redirectTo = "";

  try {
    const ticketId = getString(formData, "ticketId");
    const eventId = getString(formData, "eventId");
    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const ticketKind = getString(formData, "ticketKind") || "general_admission";
    const price = parseMoney(getString(formData, "price"));
    const currency = (getString(formData, "currency") || "USD").toUpperCase();
    const capacity = parseOptionalInteger(getString(formData, "capacity"));
    const sortOrder = parseOptionalInteger(getString(formData, "sortOrder")) ?? 0;
    const timezoneOffsetMinutes = parseOptionalTimezoneOffset(
      getString(formData, "timezoneOffsetMinutes")
    );
    const saleStartsAt = parseOptionalDateTimeLocal(
      getString(formData, "saleStartsAt"),
      timezoneOffsetMinutes
    );
    const saleEndsAt = parseOptionalDateTimeLocal(
      getString(formData, "saleEndsAt"),
      timezoneOffsetMinutes
    );
    const active = getBoolean(formData, "active");
    const attendeesPerTicket = getAttendeesPerTicket(formData);

    if (!ticketId) {
      throw new Error("Missing ticket id.");
    }

    if (!eventId) {
      throw new Error("Missing event id.");
    }

    if (!name) {
      throw new Error("Ticket name is required.");
    }

    const { supabase, access } = await getTicketEventAccess(eventId);

    const { error } = await supabase
      .from("event_ticket_types")
      .update({
        name,
        description: description || null,
        ticket_kind: ticketKind,
        price,
        currency,
        capacity,
        sort_order: sortOrder,
        sale_starts_at: saleStartsAt,
        sale_ends_at: saleEndsAt,
        active,
        attendees_per_ticket: attendeesPerTicket,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ticketId)
      .eq("event_id", access.event.id);

    if (error) {
      throw new Error(`Could not update ticket type: ${error.message}`);
    }

    redirectTo = `/app/events/${access.event.id}/tickets`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update ticket type.";

    const fallbackEventId = getString(formData, "eventId");

    redirect(
      `/app/events/${encodeURIComponent(
        fallbackEventId
      )}/tickets?error=${encodeURIComponent(message)}`
    );
  }

  redirect(redirectTo);
}

