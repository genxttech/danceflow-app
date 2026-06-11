"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

export type SellTicketsState = {
  error?: string;
  success?: string;
};

type EventRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  name: string;
  status: string;
};

type TicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  price: number | string;
  currency: string;
  capacity: number | null;
  active: boolean;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

type ExistingRegistrationRow = {
  quantity: number | null;
  status: string | null;
};

type InsertedRegistrationRow = {
  id: string;
  event_id: string;
  client_id: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  checked_in_at: string | null;
  stripe_payment_intent_id: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInteger(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseMoney(value: number | string | null | undefined) {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));

  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePaymentMethod(value: string) {
  const normalized = value.trim().toLowerCase();

  if (
    normalized === "cash" ||
    normalized === "external_card" ||
    normalized === "check" ||
    normalized === "comp" ||
    normalized === "other"
  ) {
    return normalized;
  }

  return "other";
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function isCancelledLikeStatus(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  return (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "refunded" ||
    normalized === "void"
  );
}

async function getWorkspaceContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  return {
    supabase,
    userId: user.id,
    studioId: context.studioId,
    studioRole: context.studioRole ?? null,
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
  };
}

function canSellTickets(params: {
  studioRole: string | null;
  isPlatformAdmin: boolean;
}) {
  if (params.isPlatformAdmin) return true;

  const role = (params.studioRole ?? "").trim().toLowerCase();

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "front_desk" ||
    role === "organizer_owner" ||
    role === "organizer_admin" ||
    role === "organizer_staff"
  );
}

async function getClientIfProvided(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
}) {
  const { supabase, studioId, clientId } = params;

  if (!clientId) return null;

  const { data, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, phone")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle<ClientRow>();

  if (error) {
    throw new Error(`Could not validate client: ${error.message}`);
  }

  return data ?? null;
}

async function getSoldQuantity(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  ticketTypeId: string;
}) {
  const { supabase, ticketTypeId } = params;

  const { data, error } = await supabase
    .from("event_registrations")
    .select("quantity, status")
    .eq("ticket_type_id", ticketTypeId);

  if (error) {
    throw new Error(`Could not check ticket capacity: ${error.message}`);
  }

  return ((data ?? []) as ExistingRegistrationRow[]).reduce((total, row) => {
    if (isCancelledLikeStatus(row.status)) return total;
    return total + Number(row.quantity ?? 0);
  }, 0);
}

async function insertAttendanceRecord(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  registrationId: string;
  clientId: string | null;
}) {
  const { supabase, studioId, registrationId, clientId } = params;

  if (!clientId) return;

  const { error } = await supabase.from("attendance_records").insert({
    studio_id: studioId,
    event_registration_id: registrationId,
    client_id: clientId,
    status: "registered",
  });

  if (error) {
    throw new Error(`Registration was created, but attendance setup failed: ${error.message}`);
  }
}

async function insertManualTicketRecords(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registration: InsertedRegistrationRow;
  ticket: TicketTypeRow;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}) {
  const { supabase, registration, ticket, quantity, unitPrice, totalPrice } =
    params;

  const { error: itemError } = await supabase
    .from("event_registration_items")
    .insert({
      registration_id: registration.id,
      ticket_type_id: ticket.id,
      ticket_name_snapshot: ticket.name,
      quantity,
      unit_price: unitPrice,
      line_total: totalPrice,
    });

  if (itemError) {
    throw new Error(
      `Registration was created, but ticket item setup failed: ${itemError.message}`
    );
  }

  const attendeeRows = Array.from({ length: quantity }, (_, index) => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

    return {
      registration_id: registration.id,
      event_id: registration.event_id,
      ticket_type_id: ticket.id,
      first_name: registration.attendee_first_name,
      last_name:
        quantity === 1
          ? registration.attendee_last_name
          : `${registration.attendee_last_name} ${index + 1}`.trim(),
      email: index === 0 ? registration.attendee_email : null,
      phone: index === 0 ? registration.attendee_phone ?? null : null,
      attendee_role: "attendee",
      sort_order: index + 1,
      ticket_code: `MAN-${suffix}`,
      ticket_token: randomUUID(),
      ticket_issued_at: new Date().toISOString(),
    };
  });

  const { error: attendeeError } = await supabase
    .from("event_registration_attendees")
    .insert(attendeeRows);

  if (attendeeError) {
    throw new Error(
      `Registration was created, but QR ticket setup failed: ${attendeeError.message}`
    );
  }
}

async function logManualEventPayment(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registration: InsertedRegistrationRow;
  amount: number;
  currency: string;
  paymentMethod: string;
  notes?: string;
}) {
  const { supabase, registration, amount, currency, paymentMethod, notes } =
    params;

  if (amount <= 0 && paymentMethod === "comp") {
    return;
  }

  const paymentLog: Record<string, string | number | null> = {
    event_id: registration.event_id,
    registration_id: registration.id,
    amount,
    currency,
    payment_method: paymentMethod,
    status: "paid",
    source: "manual_ticket_sale",
    stripe_payment_intent_id: null,
  };

  if (notes) {
    paymentLog.notes = notes;
  }

  const { error } = await supabase.from("event_payments").insert(paymentLog);

  if (error) {
    throw new Error(`Registration was created, but payment logging failed: ${error.message}`);
  }
}

export async function sellTicketsAction(
  _previousState: SellTicketsState,
  formData: FormData
): Promise<SellTicketsState> {
  const eventId = getString(formData, "eventId");
  const ticketTypeId = getString(formData, "ticketTypeId");
  const clientId = getString(formData, "clientId");
  const quantity = parsePositiveInteger(getString(formData, "quantity"));
  const paymentMethod = normalizePaymentMethod(
    getString(formData, "paymentMethod")
  );
  const notes = getString(formData, "notes");

  let attendeeFirstName = getString(formData, "attendeeFirstName");
  let attendeeLastName = getString(formData, "attendeeLastName");
  let attendeeEmail = normalizeEmail(getString(formData, "attendeeEmail"));
  let attendeePhone = getString(formData, "attendeePhone");

  let redirectTo = "";

  if (!eventId) {
    return { error: "Choose an event." };
  }

  if (!ticketTypeId) {
    return { error: "Choose a ticket type." };
  }

  if (quantity <= 0) {
    return { error: "Enter a ticket quantity greater than 0." };
  }

  try {
    const { supabase, userId, studioId, studioRole, isPlatformAdmin } =
      await getWorkspaceContext();

    if (!canSellTickets({ studioRole, isPlatformAdmin })) {
      return {
        error:
          "You do not have permission to sell event tickets from this workspace.",
      };
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, studio_id, organizer_id, name, status")
      .eq("id", eventId)
      .eq("studio_id", studioId)
      .maybeSingle<EventRow>();

    if (eventError) {
      throw new Error(eventError.message);
    }

    if (!event) {
      return { error: "Event not found for this workspace." };
    }

    if (event.status === "cancelled" || event.status === "completed") {
      return {
        error: "Tickets cannot be sold for a cancelled or completed event.",
      };
    }

    const { data: ticket, error: ticketError } = await supabase
      .from("event_ticket_types")
      .select("id, event_id, name, price, currency, capacity, active")
      .eq("id", ticketTypeId)
      .eq("event_id", event.id)
      .maybeSingle<TicketTypeRow>();

    if (ticketError) {
      throw new Error(ticketError.message);
    }

    if (!ticket) {
      return { error: "Ticket type not found for this event." };
    }

    if (!ticket.active) {
      return { error: "This ticket type is inactive." };
    }

    const client = await getClientIfProvided({
      supabase,
      studioId,
      clientId,
    });

    if (clientId && !client) {
      return { error: "Selected client was not found in this workspace." };
    }

    if (client) {
      attendeeFirstName = attendeeFirstName || client.first_name || "";
      attendeeLastName = attendeeLastName || client.last_name || "";
      attendeeEmail = attendeeEmail || normalizeEmail(client.email || "");
      attendeePhone = attendeePhone || client.phone || "";
    }

    if (!attendeeFirstName) {
      return { error: "Enter the attendee first name." };
    }

    if (!attendeeLastName) {
      return { error: "Enter the attendee last name." };
    }

    if (!attendeeEmail) {
      return { error: "Enter the attendee email." };
    }

    const soldQuantity = await getSoldQuantity({
      supabase,
      ticketTypeId: ticket.id,
    });

    if (ticket.capacity !== null && ticket.capacity !== undefined) {
      const remaining = Number(ticket.capacity) - soldQuantity;

      if (quantity > remaining) {
        return {
          error: `Only ${Math.max(
            remaining,
            0
          )} ticket(s) remain for ${ticket.name}.`,
        };
      }
    }

    const unitPrice = paymentMethod === "comp" ? 0 : parseMoney(ticket.price);
    const totalPrice = unitPrice * quantity;
    const currency = ticket.currency || "USD";

    const { data: registration, error: registrationError } = await supabase
      .from("event_registrations")
      .insert({
        event_id: event.id,
        ticket_type_id: ticket.id,
        studio_id: studioId,
        user_id: null,
        client_id: client?.id ?? null,
        status: "confirmed",
        attendee_first_name: attendeeFirstName,
        attendee_last_name: attendeeLastName,
        attendee_email: attendeeEmail,
        attendee_phone: attendeePhone || null,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        total_amount: totalPrice,
        currency,
        registration_source: "admin",
        source: "admin",
        notes:
          notes ||
          `Manual ticket sale created from workspace by user ${userId}. Payment method: ${paymentMethod}.`,
        payment_status: "paid",
        portal_user_id: null,
        stripe_checkout_session_id: null,
        stripe_payment_intent_id: null,
      })
      .select(
        `
        id,
        event_id,
        client_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        status,
        payment_status,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        stripe_payment_intent_id
      `
      )
      .single<InsertedRegistrationRow>();

    if (registrationError || !registration) {
      return {
        error: `Could not complete manual ticket sale: ${
          registrationError?.message ?? "Unknown error."
        }`,
      };
    }

    await insertManualTicketRecords({
      supabase,
      registration,
      ticket,
      quantity,
      unitPrice,
      totalPrice,
    });

    await logManualEventPayment({
      supabase,
      registration,
      amount: totalPrice,
      currency,
      paymentMethod,
      notes:
        notes ||
        `Manual ticket sale created from workspace by user ${userId}. Payment method: ${paymentMethod}.`,
    });

    await insertAttendanceRecord({
      supabase,
      studioId,
      registrationId: registration.id,
      clientId: registration.client_id,
    });

    redirectTo = `/app/events/${event.id}/registrations?success=manual_ticket_sale_created`;
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Something went wrong while selling tickets.",
    };
  }

  redirect(redirectTo);
}