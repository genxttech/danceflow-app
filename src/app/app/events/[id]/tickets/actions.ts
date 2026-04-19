"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

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

function parseMoney(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalDateTimeLocal(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

async function getStudioContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active studio context found for this user.");
  }

  return {
    supabase,
    studioId: context.studioId as string,
    role: (context.role ?? null) as string | null,
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
    userId: user.id,
  };
}

async function ensureEventAccess(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  eventId: string;
  userId: string;
}) {
  const { supabase, studioId, eventId, userId } = params;

  const { data: event, error } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .eq("studio_id", studioId)
    .single();

  if (error || !event) {
    throw new Error("Event not found.");
  }

  let organizerUserRole: string | null = null;

  if (event.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", userId)
      .eq("active", true)
      .maybeSingle();

    organizerUserRole = organizerUser?.role ?? null;
  }

  return {
    event,
    organizerUserRole,
  };
}

function canManageTickets(params: {
  isPlatformAdmin: boolean;
  studioRole: string | null;
  organizerUserRole: string | null;
}) {
  const { isPlatformAdmin, studioRole, organizerUserRole } = params;

  if (isPlatformAdmin) {
    return true;
  }

  if (studioRole === "studio_owner" || studioRole === "studio_admin") {
    return true;
  }

  if (
    organizerUserRole === "organizer_admin" ||
    organizerUserRole === "organizer_staff"
  ) {
    return true;
  }

  return false;
}

export async function createTicketTypeAction(formData: FormData) {
  const { supabase, studioId, role, isPlatformAdmin, userId } =
    await getStudioContext();

  const eventId = getString(formData, "eventId");
  const name = getString(formData, "name");
  const description = getString(formData, "description");
  const ticketKind = getString(formData, "ticketKind") || "general_admission";
  const price = parseMoney(getString(formData, "price"));
  const currency = (getString(formData, "currency") || "USD").toUpperCase();
  const capacity = parseOptionalInteger(getString(formData, "capacity"));
  const sortOrder = parseOptionalInteger(getString(formData, "sortOrder")) ?? 0;
  const saleStartsAt = parseOptionalDateTimeLocal(
    getString(formData, "saleStartsAt")
  );
  const saleEndsAt = parseOptionalDateTimeLocal(
    getString(formData, "saleEndsAt")
  );
  const active = getBoolean(formData, "active");

  if (!eventId) {
    throw new Error("Missing event id.");
  }

  if (!name) {
    throw new Error("Ticket name is required.");
  }

  const { organizerUserRole } = await ensureEventAccess({
    supabase,
    studioId,
    eventId,
    userId,
  });

  if (
    !canManageTickets({
      isPlatformAdmin,
      studioRole: role,
      organizerUserRole,
    })
  ) {
    throw new Error("You do not have permission to manage tickets.");
  }

  const { error } = await supabase.from("event_ticket_types").insert({
    event_id: eventId,
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
  });

  if (error) {
    throw new Error(`Could not create ticket type: ${error.message}`);
  }

  redirect(`/app/events/${eventId}/tickets`);
}

export async function updateTicketTypeAction(formData: FormData) {
  const { supabase, studioId, role, isPlatformAdmin, userId } =
    await getStudioContext();

  const ticketId = getString(formData, "ticketId");
  const eventId = getString(formData, "eventId");
  const name = getString(formData, "name");
  const description = getString(formData, "description");
  const ticketKind = getString(formData, "ticketKind") || "general_admission";
  const price = parseMoney(getString(formData, "price"));
  const currency = (getString(formData, "currency") || "USD").toUpperCase();
  const capacity = parseOptionalInteger(getString(formData, "capacity"));
  const sortOrder = parseOptionalInteger(getString(formData, "sortOrder")) ?? 0;
  const saleStartsAt = parseOptionalDateTimeLocal(
    getString(formData, "saleStartsAt")
  );
  const saleEndsAt = parseOptionalDateTimeLocal(
    getString(formData, "saleEndsAt")
  );
  const active = getBoolean(formData, "active");

  if (!ticketId) {
    throw new Error("Missing ticket id.");
  }

  if (!eventId) {
    throw new Error("Missing event id.");
  }

  if (!name) {
    throw new Error("Ticket name is required.");
  }

  const { organizerUserRole } = await ensureEventAccess({
    supabase,
    studioId,
    eventId,
    userId,
  });

  if (
    !canManageTickets({
      isPlatformAdmin,
      studioRole: role,
      organizerUserRole,
    })
  ) {
    throw new Error("You do not have permission to manage tickets.");
  }

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
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .eq("event_id", eventId);

  if (error) {
    throw new Error(`Could not update ticket type: ${error.message}`);
  }

  redirect(`/app/events/${eventId}/tickets`);
}