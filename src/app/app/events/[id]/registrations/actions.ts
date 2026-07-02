"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseServiceClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/payments/stripe";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { buildEventConfirmedEmailTemplate } from "@/lib/notifications/templates";

type RegistrationRow = {
  id: string;
  event_id: string;
  client_id: string | null;
  ticket_type_id: string | null;
  quantity: number | null;
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
  order_id?: string | null;
  stripe_checkout_session_id?: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

type AttendanceLookupRow = {
  id: string;
  status?: string | null;
};

type TicketCodeLookupRow = {
  id: string;
  registration_id: string;
  event_id: string | null;
  ticket_code: string | null;
  checked_in_at: string | null;
};

type EventAccessRow = {
  id: string;
  event_type: string | null;
};

type EventSessionRow = {
  id: string;
  event_id: string;
  studio_id: string;
  session_date: string;
  status: string;
};

type EventPaymentRow = {
  id: string;
};


function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) return null;

  return createSupabaseServiceClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function buildReturnUrl(eventId: string, suffix?: string) {
  const base = `/app/events/${eventId}/registrations`;
  if (!suffix) return base;
  return `${base}?${suffix}`;
}

function resolveReturnUrl(params: {
  eventId: string;
  returnTo?: string;
  fallbackSuffix?: string;
}) {
  const { eventId, returnTo, fallbackSuffix } = params;

  if (returnTo && returnTo.startsWith(`/app/events/${eventId}/`)) {
    if (!fallbackSuffix) return returnTo;

    const separator = returnTo.includes("?") ? "&" : "?";
    return `${returnTo}${separator}${fallbackSuffix}`;
  }

  return buildReturnUrl(eventId, fallbackSuffix);
}

function shouldBlockAttendanceForPayment(paymentStatus: string | null) {
  return ["pending", "unpaid", "failed", "refunded"].includes(paymentStatus ?? "");
}

function isRegistrationActiveForCheckIn(status: string | null) {
  return ["confirmed", "registered", "checked_in", "attended"].includes(status ?? "");
}

function normalizeTicketCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
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

  return {
    supabase,
    studioId: context.studioId,
    userId: user.id,
  };
}

async function validateEventAccess(
  supabase: Awaited<ReturnType<typeof createClient>>,
  eventId: string,
  studioId: string,
) {
  const { data: event, error } = await supabase
    .from("events")
    .select("id, event_type")
    .eq("id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle<EventAccessRow>();

  if (error || !event) {
    redirect("/app/events");
  }

  return event;
}

async function getRegistrationForEvent(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data, error } = await supabase
    .from("event_registrations")
    .select(
      `
      id,
      event_id,
      client_id,
      ticket_type_id,
      quantity,
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
    `,
    )
    .eq("id", registrationId)
    .eq("event_id", eventId)
    .maybeSingle<RegistrationRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function findAttendeeByTicketCode(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  ticketCode: string;
}) {
  const { supabase, eventId, ticketCode } = params;
  const normalizedCode = normalizeTicketCode(ticketCode);

  if (!normalizedCode) return null;

  const { data, error } = await supabase
    .from("event_registration_attendees")
    .select("id, registration_id, event_id, ticket_code, checked_in_at")
    .eq("event_id", eventId)
    .eq("ticket_code", normalizedCode)
    .maybeSingle<TicketCodeLookupRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function allAttendeeTicketsCheckedIn(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data, error } = await supabase
    .from("event_registration_attendees")
    .select("id, checked_in_at")
    .eq("event_id", eventId)
    .eq("registration_id", registrationId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  return rows.length > 0 && rows.every((row) => Boolean(row.checked_in_at));
}

async function getAttendeeTicketCheckInState(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data, error } = await supabase
    .from("event_registration_attendees")
    .select("id, checked_in_at")
    .eq("event_id", eventId)
    .eq("registration_id", registrationId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];

  return {
    hasTickets: rows.length > 0,
    allCheckedIn: rows.length > 0 && rows.every((row) => Boolean(row.checked_in_at)),
  };
}

async function upsertAttendanceLink(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  registrationId: string;
  clientId: string;
}) {
  const { supabase, studioId, registrationId, clientId } = params;

  const { data: existing, error: existingError } = await supabase
    .from("attendance_records")
    .select("id")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registrationId)
    .maybeSingle<AttendanceLookupRow>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update({
        client_id: clientId,
      })
      .eq("id", existing.id)
      .eq("studio_id", studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return existing.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("attendance_records")
    .insert({
      studio_id: studioId,
      event_registration_id: registrationId,
      client_id: clientId,
      status: "registered",
    })
    .select("id")
    .single<AttendanceLookupRow>();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return inserted.id;
}

async function upsertAttendanceStatus(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  registration: RegistrationRow;
  status: string;
  checkedInAt?: string | null;
  markedAttendedAt?: string | null;
  eventSessionId?: string | null;
}) {
  const {
    supabase,
    studioId,
    registration,
    status,
    checkedInAt,
    markedAttendedAt,
  } = params;

  if (!registration.client_id) {
    return null;
  }

  const { data: existing, error: existingError } = await supabase
    .from("attendance_records")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registration.id)
    .maybeSingle<AttendanceLookupRow>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const payload = {
    studio_id: studioId,
    client_id: registration.client_id,
    event_registration_id: registration.id,
    status,
    checked_in_at: checkedInAt ?? null,
    marked_attended_at: markedAttendedAt ?? null,
  };

  if (existing) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update(payload)
      .eq("id", existing.id)
      .eq("studio_id", studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return existing.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("attendance_records")
    .insert(payload)
    .select("id")
    .single<AttendanceLookupRow>();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return inserted.id;
}

async function getEventSessionForEvent(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  eventId: string;
  eventSessionId: string;
}) {
  const { supabase, studioId, eventId, eventSessionId } = params;

  const { data, error } = await supabase
    .from("event_sessions")
    .select("id, event_id, studio_id, session_date, status")
    .eq("id", eventSessionId)
    .eq("event_id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle<EventSessionRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function getAttendanceForRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  registrationId: string;
  eventSessionId?: string | null;
}) {
  const { supabase, studioId, registrationId } = params;

  const { data, error } = await supabase
    .from("attendance_records")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registrationId)
    .maybeSingle<AttendanceLookupRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function ensureClientInStudio(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
}) {
  const { supabase, studioId, clientId } = params;

  const { data: client, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, phone")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle<ClientRow>();

  if (error) {
    throw new Error(error.message);
  }

  return client ?? null;
}

async function logEventPayment(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registration: RegistrationRow;
  studioId: string;
  amount: number;
  currency: string;
  paymentMethod?: string;
  status?: string;
  source?: string;
  stripePaymentIntentId?: string | null;
}) {
  const {
    supabase,
    registration,
    studioId,
    amount,
    currency,
    paymentMethod = "other",
    status = "paid",
    source = "event_registration",
    stripePaymentIntentId = null,
  } = params;

  const { error } = await supabase.from("event_payments").insert({
    event_id: registration.event_id,
    registration_id: registration.id,
    amount,
    currency,
    payment_method: paymentMethod,
    status,
    source,
    stripe_payment_intent_id: stripePaymentIntentId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  );
}

function makeTicketCode() {
  return `DF-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

function makeTicketToken() {
  return randomUUID().replaceAll("-", "");
}

type TicketTypeForResend = {
  id: string;
  name: string | null;
  attendees_per_ticket: number | null;
};

type EventForResend = {
  id: string;
  slug: string;
  name: string;
};

type RegistrationForResend = RegistrationRow & {
  studio_id: string;
  order_id: string | null;
  stripe_checkout_session_id: string | null;
  event_ticket_types?: TicketTypeForResend | TicketTypeForResend[] | null;
  events?: EventForResend | EventForResend[] | null;
  event_registration_attendees?: Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    ticket_code: string | null;
    sort_order: number | null;
  }> | null;
};

type RegistrationSiblingForResend = RegistrationForResend & {
  order_id: string | null;
  stripe_checkout_session_id: string | null;
};

type TicketPurchaseLineForEmail = {
  name: string;
  quantity: number;
  totalPrice?: number;
};

function singleRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

async function ensureTicketRowsForRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registration: RegistrationRow;
}) {
  const { supabase, registration } = params;

  if (!registration.ticket_type_id) {
    throw new Error("Registration is missing a ticket type.");
  }

  const { data: ticketType, error: ticketTypeError } = await supabase
    .from("event_ticket_types")
    .select("id, name, attendees_per_ticket")
    .eq("id", registration.ticket_type_id)
    .maybeSingle<TicketTypeForResend>();

  if (ticketTypeError || !ticketType) {
    throw new Error(ticketTypeError?.message ?? "Ticket type not found.");
  }

  const quantity = Math.max(1, Number(registration.quantity ?? 1));
  const admitsPerTicket = Math.max(1, Number(ticketType.attendees_per_ticket ?? 1));
  const expectedAttendees = Math.max(1, quantity * admitsPerTicket);
  const now = new Date().toISOString();

  const { data: existingItems, error: itemsLookupError } = await supabase
    .from("event_registration_items")
    .select("id")
    .eq("registration_id", registration.id)
    .limit(1);

  if (itemsLookupError) {
    throw new Error(itemsLookupError.message);
  }

  if (!existingItems?.length) {
    const unitPrice = Number(
      registration.total_amount ?? registration.total_price ?? 0,
    );
    const lineTotal = Number(
      registration.total_amount ?? registration.total_price ?? unitPrice,
    );

    const { error: itemInsertError } = await supabase
      .from("event_registration_items")
      .insert({
        registration_id: registration.id,
        ticket_type_id: registration.ticket_type_id,
        ticket_name_snapshot: ticketType.name || "Event ticket",
        quantity,
        unit_price: unitPrice,
        line_total: lineTotal,
        created_at: now,
      });

    if (itemInsertError) {
      throw new Error(itemInsertError.message);
    }
  }

  const { data: existingAttendees, error: attendeesLookupError } =
    await supabase
      .from("event_registration_attendees")
      .select("id, sort_order, first_name, last_name, email, phone, ticket_code, ticket_token, ticket_issued_at")
      .eq("registration_id", registration.id);

  if (attendeesLookupError) {
    throw new Error(attendeesLookupError.message);
  }

  const attendeesBySortOrder = new Map<number, any>();
  for (const attendee of existingAttendees ?? []) {
    const sortOrder = Number(attendee.sort_order ?? 1);
    if (!attendeesBySortOrder.has(sortOrder)) {
      attendeesBySortOrder.set(sortOrder, attendee);
    }
  }

  const rowsToInsert = [];
  for (let slot = 1; slot <= expectedAttendees; slot += 1) {
    if (attendeesBySortOrder.has(slot)) continue;

    rowsToInsert.push({
      registration_id: registration.id,
      event_id: registration.event_id,
      ticket_type_id: registration.ticket_type_id,
      first_name:
        slot === 1
          ? registration.attendee_first_name || "Guest"
          : "Guest",
      last_name:
        slot === 1
          ? registration.attendee_last_name || "Attendee"
          : `${slot}`,
      email: registration.attendee_email || null,
      phone: registration.attendee_phone || null,
      attendee_role: "attendee",
      sort_order: slot,
      ticket_code: makeTicketCode(),
      ticket_token: makeTicketToken(),
      ticket_issued_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  if (rowsToInsert.length) {
    const { error: attendeesInsertError } = await supabase
      .from("event_registration_attendees")
      .insert(rowsToInsert);

    if (attendeesInsertError) {
      throw new Error(attendeesInsertError.message);
    }
  }

  const { data: refreshedAttendees, error: refreshedError } = await supabase
    .from("event_registration_attendees")
    .select("id, sort_order, ticket_code, ticket_token, ticket_issued_at")
    .eq("registration_id", registration.id);

  if (refreshedError) {
    throw new Error(refreshedError.message);
  }

  await Promise.all(
    (refreshedAttendees ?? [])
      .filter((attendee) => !attendee.ticket_code || !attendee.ticket_token)
      .map((attendee) =>
        supabase
          .from("event_registration_attendees")
          .update({
            ticket_code: attendee.ticket_code || makeTicketCode(),
            ticket_token: attendee.ticket_token || makeTicketToken(),
            ticket_issued_at: attendee.ticket_issued_at || now,
            updated_at: now,
          })
          .eq("id", attendee.id),
      ),
  );
}

async function queueTicketConfirmationResend(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
}) {
  const registrationSelect = `
      id,
      event_id,
      studio_id,
      client_id,
      ticket_type_id,
      quantity,
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
      stripe_payment_intent_id,
      order_id,
      stripe_checkout_session_id,
      events (
        id,
        slug,
        name
      ),
      event_ticket_types (
        id,
        name,
        attendees_per_ticket
      ),
      event_registration_attendees (
        id,
        first_name,
        last_name,
        email,
        ticket_code,
        sort_order
      )
    `;

  const { data: registration, error } = await params.supabase
    .from("event_registrations")
    .select(registrationSelect)
    .eq("id", params.registrationId)
    .eq("event_id", params.eventId)
    .maybeSingle<RegistrationForResend>();

  if (error || !registration) {
    throw new Error(error?.message ?? "Registration not found.");
  }

  const event = singleRelation(registration.events);

  if (!event) {
    throw new Error("Event not found for registration.");
  }

  let relatedRegistrations: RegistrationSiblingForResend[] = [
    registration as RegistrationSiblingForResend,
  ];

  if (registration.order_id) {
    const { data: siblings, error: siblingsError } = await params.supabase
      .from("event_registrations")
      .select(registrationSelect)
      .eq("event_id", params.eventId)
      .eq("order_id", registration.order_id)
      .order("created_at", { ascending: true })
      .returns<RegistrationSiblingForResend[]>();

    if (siblingsError) {
      throw new Error(siblingsError.message);
    }

    if (siblings?.length) {
      relatedRegistrations = siblings;
    }
  } else if (registration.stripe_checkout_session_id) {
    const { data: siblings, error: siblingsError } = await params.supabase
      .from("event_registrations")
      .select(registrationSelect)
      .eq("event_id", params.eventId)
      .eq("stripe_checkout_session_id", registration.stripe_checkout_session_id)
      .order("created_at", { ascending: true })
      .returns<RegistrationSiblingForResend[]>();

    if (siblingsError) {
      throw new Error(siblingsError.message);
    }

    if (siblings?.length) {
      relatedRegistrations = siblings;
    }
  }

  const ticketCodes = relatedRegistrations.flatMap((relatedRegistration) => {
    const attendeeRows = [...(relatedRegistration.event_registration_attendees ?? [])].sort(
      (left, right) => Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0),
    );

    const ticketType = singleRelation(relatedRegistration.event_ticket_types);
    const ticketTypeName = ticketType?.name ?? "Event ticket";

    return attendeeRows
      .map((attendee, index) => {
        const attendeeFullName =
          `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim() ||
          `Attendee ${index + 1}`;
        const code =
          typeof attendee.ticket_code === "string" ? attendee.ticket_code.trim() : "";

        return code
          ? {
              name:
                relatedRegistrations.length > 1
                  ? `${attendeeFullName} — ${ticketTypeName}`
                  : attendeeFullName,
              code,
            }
          : null;
      })
      .filter(Boolean) as Array<{ name: string; code: string }>;
  });

  if (!ticketCodes.length) {
    throw new Error("No ticket codes were available to send.");
  }

  const purchasedItems: TicketPurchaseLineForEmail[] = relatedRegistrations.map(
    (relatedRegistration) => {
      const ticketType = singleRelation(relatedRegistration.event_ticket_types);

      return {
        name: ticketType?.name ?? "Event ticket",
        quantity: Number(relatedRegistration.quantity ?? 1),
        totalPrice: Number(
          relatedRegistration.total_price ?? relatedRegistration.total_amount ?? 0,
        ),
      };
    },
  );

  const totalPrice = relatedRegistrations.reduce(
    (sum, relatedRegistration) =>
      sum + Number(relatedRegistration.total_price ?? relatedRegistration.total_amount ?? 0),
    0,
  );
  const totalQuantity = relatedRegistrations.reduce(
    (sum, relatedRegistration) => sum + Number(relatedRegistration.quantity ?? 1),
    0,
  );

  const primaryTicketType = singleRelation(registration.event_ticket_types);

  const template = buildEventConfirmedEmailTemplate({
    eventName: event.name,
    attendeeFirstName: registration.attendee_first_name,
    attendeeLastName: registration.attendee_last_name,
    ticketTypeName:
      purchasedItems.length > 1
        ? "Multiple ticket options"
        : primaryTicketType?.name ?? "Event ticket",
    quantity: totalQuantity,
    totalPrice,
    currency: registration.currency || "USD",
    eventUrl: `${getAppUrl()}/events/${encodeURIComponent(event.slug)}`,
    ticketCodes,
    purchasedItems: purchasedItems.length > 1 ? purchasedItems : undefined,
  });

  const result = await queueOutboundDelivery({
    studioId: registration.studio_id,
    channel: "email",
    templateKey: "event_registration_ticket_confirmation_resend",
    recipientEmail: registration.attendee_email,
    subject: template.subject,
    bodyText: template.bodyText,
    bodyHtml: template.bodyHtml,
    relatedTable: "event_registrations",
    relatedId: registration.id,
    dedupeKey: `event_registration_resend:email:${registration.id}:${Date.now()}`,
  });

  if (!result.queued) {
    throw new Error("Ticket confirmation could not be queued.");
  }
}

async function createLeadFromRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
  registration: RegistrationRow;
}) {
  const { supabase, studioId, userId, registration } = params;

  const { error } = await supabase.from("leads").insert({
    studio_id: studioId,
    first_name: registration.attendee_first_name || "Event",
    last_name: registration.attendee_last_name || "Registrant",
    email: registration.attendee_email || null,
    phone: registration.attendee_phone || null,
    lead_source: "event_registration",
    status: "new",
    notes: `Created from event registration ${registration.id}`,
    created_by: userId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function markRegistrationPaymentStatus(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
  paymentStatus: string;
  registrationStatus?: string;
}) {
  const {
    supabase,
    eventId,
    registrationId,
    paymentStatus,
    registrationStatus,
  } = params;

  const payload: Record<string, string> = {
    payment_status: paymentStatus,
  };

  if (registrationStatus) {
    payload.status = registrationStatus;
  }

  const { error } = await supabase
    .from("event_registrations")
    .update(payload)
    .eq("id", registrationId)
    .eq("event_id", eventId);

  if (error) {
    throw new Error(error.message);
  }
}

async function findLatestPaymentForRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registrationId: string;
}) {
  const { supabase, registrationId } = params;

  const { data, error } = await supabase
    .from("event_payments")
    .select("id")
    .eq("registration_id", registrationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<EventPaymentRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

export async function confirmEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const { error } = await supabase
      .from("event_registrations")
      .update({ status: "confirmed" })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (error) {
      throw new Error(error.message);
    }

    redirect(buildReturnUrl(eventId, "success=registration_confirmed"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=registration_confirm_failed"));
  }
}

export async function cancelEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const { error: registrationError } = await supabase
      .from("event_registrations")
      .update({
        status: "cancelled",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationError) {
      throw new Error(registrationError.message);
    }

    const { error: attendanceUpdateError } = await supabase
      .from("attendance_records")
      .update({
        status: "cancelled",
      })
      .eq("studio_id", studioId)
      .eq("event_registration_id", registrationId);

    if (attendanceUpdateError) {
      throw new Error(attendanceUpdateError.message);
    }

    redirect(buildReturnUrl(eventId, "success=registration_cancelled"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=registration_cancel_failed"));
  }
}


export async function checkInEventTicketCodeAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const ticketCode = getString(formData, "ticketCode");
  const eventSessionId = getString(formData, "eventSessionId");
  const returnTo = getString(formData, "returnTo");

  if (!eventId) {
    redirect("/app/events");
  }

  if (!ticketCode) {
    redirect(
      resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=ticket_code_required",
      }),
    );
  }

  let nextUrl = resolveReturnUrl({
    eventId,
    returnTo,
    fallbackSuffix: "error=checkin_failed",
  });

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    const event = await validateEventAccess(supabase, eventId, studioId);
    const isGroupClass = event.event_type === "group_class";

    const attendee = await findAttendeeByTicketCode({
      supabase,
      eventId,
      ticketCode,
    });

    if (!attendee) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=ticket_code_not_found",
      });
    } else if (isGroupClass && !eventSessionId) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=session_required",
      });
    } else {
      const registration = await getRegistrationForEvent({
        supabase,
        eventId,
        registrationId: attendee.registration_id,
      });

      if (!registration) {
        nextUrl = resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=registration_not_found",
        });
      } else if (["cancelled", "refunded"].includes(registration.status ?? "")) {
        nextUrl = resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=cannot_check_in_cancelled",
        });
      } else if (!isRegistrationActiveForCheckIn(registration.status)) {
        nextUrl = resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=ticket_not_confirmed",
        });
      } else if (shouldBlockAttendanceForPayment(registration.payment_status)) {
        nextUrl = resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=cannot_check_in_unpaid",
        });
      } else {
        if (isGroupClass) {
          const session = await getEventSessionForEvent({
            supabase,
            studioId,
            eventId,
            eventSessionId,
          });

          if (!session || session.status === "cancelled") {
            nextUrl = resolveReturnUrl({
              eventId,
              returnTo,
              fallbackSuffix: "error=session_not_found",
            });
          }
        }

        if (!nextUrl.includes("error=session_not_found")) {
          const existingAttendance = await getAttendanceForRegistration({
            supabase,
            studioId,
            registrationId: attendee.registration_id,
            eventSessionId: isGroupClass ? eventSessionId : null,
          });

          const attendeeAlreadyCheckedIn = Boolean(attendee.checked_in_at);
          const sessionAlreadyCheckedIn =
            existingAttendance?.status === "checked_in" ||
            existingAttendance?.status === "attended";

          // QR tickets are issued per attendee row. Do not treat the parent
          // registration-level checked_in_at as proof that this specific QR ticket
          // has already been checked in, because one registration can contain
          // multiple attendee tickets.
          const shouldTreatAsAlreadyCheckedIn = isGroupClass
            ? sessionAlreadyCheckedIn
            : attendeeAlreadyCheckedIn;

          if (shouldTreatAsAlreadyCheckedIn) {
            nextUrl = resolveReturnUrl({
              eventId,
              returnTo,
              fallbackSuffix: `warning=already_checked_in&ticket=${encodeURIComponent(
                normalizeTicketCode(ticketCode),
              )}`,
            });
          } else {
            const now = new Date().toISOString();
            const serviceSupabase = createServiceRoleClient();
            const writeSupabase: any = serviceSupabase ?? supabase;

            const { error: attendeeUpdateError } = await writeSupabase
              .from("event_registration_attendees")
              .update({
                checked_in_at: now,
                checked_in_by: userId,
                updated_at: now,
              })
              .eq("id", attendee.id)
              .eq("event_id", eventId);

            if (attendeeUpdateError) {
              throw new Error(attendeeUpdateError.message);
            }

            const registrationFullyCheckedIn = await allAttendeeTicketsCheckedIn({
              supabase,
              eventId,
              registrationId: attendee.registration_id,
            });

            if (registrationFullyCheckedIn) {
              const { error: registrationUpdateError } = await writeSupabase
                .from("event_registrations")
                .update({
                  checked_in_at: now,
                })
                .eq("id", attendee.registration_id)
                .eq("event_id", eventId);

              if (registrationUpdateError) {
                throw new Error(registrationUpdateError.message);
              }
            }

            await upsertAttendanceStatus({
              supabase,
              studioId,
              registration: {
                ...registration,
                checked_in_at: now,
              },
              status: "checked_in",
              checkedInAt: now,
              markedAttendedAt: null,
              eventSessionId: isGroupClass ? eventSessionId : null,
            });

            nextUrl = resolveReturnUrl({
              eventId,
              returnTo,
              fallbackSuffix: `success=checked_in&ticket=${encodeURIComponent(
                normalizeTicketCode(ticketCode),
              )}`,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error("Event ticket code check-in failed", error);

    nextUrl = resolveReturnUrl({
      eventId,
      returnTo,
      fallbackSuffix: "error=checkin_failed",
    });
  }

  redirect(nextUrl);
}

export async function checkInEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const eventSessionId = getString(formData, "eventSessionId");
  const returnTo = getString(formData, "returnTo");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  let nextUrl = resolveReturnUrl({
    eventId,
    returnTo,
    fallbackSuffix: "error=checkin_failed",
  });

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    const event = await validateEventAccess(supabase, eventId, studioId);
    const isGroupClass = event.event_type === "group_class";

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=registration_not_found",
      });
    } else if (["cancelled", "refunded"].includes(registration.status ?? "")) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=cannot_check_in_cancelled",
      });
    } else if (!isRegistrationActiveForCheckIn(registration.status)) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=ticket_not_confirmed",
      });
    } else if (shouldBlockAttendanceForPayment(registration.payment_status)) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=cannot_check_in_unpaid",
      });
    } else if (isGroupClass && !eventSessionId) {
      nextUrl = resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=session_required",
      });
    } else {
      if (isGroupClass) {
        const session = await getEventSessionForEvent({
          supabase,
          studioId,
          eventId,
          eventSessionId,
        });

        if (!session || session.status === "cancelled") {
          nextUrl = resolveReturnUrl({
            eventId,
            returnTo,
            fallbackSuffix: "error=session_not_found",
          });
        }
      }

      if (!nextUrl.includes("error=session_not_found")) {
        const existingAttendance = await getAttendanceForRegistration({
          supabase,
          studioId,
          registrationId,
          eventSessionId: isGroupClass ? eventSessionId : null,
        });
        const attendeeTicketState = await getAttendeeTicketCheckInState({
          supabase,
          eventId,
          registrationId,
        });
        const alreadyCheckedIn = attendeeTicketState.hasTickets
          ? attendeeTicketState.allCheckedIn
          : existingAttendance?.status === "checked_in" ||
            existingAttendance?.status === "attended" ||
            (!isGroupClass &&
              (registration.checked_in_at ||
                registration.status === "checked_in"));

        if (alreadyCheckedIn) {
          nextUrl = resolveReturnUrl({
            eventId,
            returnTo,
            fallbackSuffix: "warning=already_checked_in",
          });
        } else {
          const now = new Date().toISOString();
          const serviceSupabase = createServiceRoleClient();
          const writeSupabase: any = serviceSupabase ?? supabase;

          const { error: registrationUpdateError } = await writeSupabase
            .from("event_registrations")
            .update({
              checked_in_at: now,
            })
            .eq("id", registrationId)
            .eq("event_id", eventId);

          if (registrationUpdateError) {
            throw new Error(registrationUpdateError.message);
          }

          const { error: attendeeUpdateError } = await writeSupabase
            .from("event_registration_attendees")
            .update({
              checked_in_at: now,
              checked_in_by: userId,
              updated_at: now,
            })
            .eq("registration_id", registrationId)
            .eq("event_id", eventId);

          if (attendeeUpdateError) {
            throw new Error(attendeeUpdateError.message);
          }

          await upsertAttendanceStatus({
            supabase,
            studioId,
            registration: {
              ...registration,
              checked_in_at: now,
            },
            status: "checked_in",
            checkedInAt: now,
            markedAttendedAt: null,
            eventSessionId: isGroupClass ? eventSessionId : null,
          });

          nextUrl = resolveReturnUrl({
            eventId,
            returnTo,
            fallbackSuffix: "success=checked_in",
          });
        }
      }
    }
  } catch (error) {
    console.error("Event check-in failed", error);

    nextUrl = resolveReturnUrl({
      eventId,
      returnTo,
      fallbackSuffix: "error=checkin_failed",
    });
  }

  redirect(nextUrl);
}

export async function markEventRegistrationAttendedAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const checkedInAt = registration.checked_in_at ?? new Date().toISOString();
    const markedAttendedAt = new Date().toISOString();

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        checked_in_at: checkedInAt,
        status: "attended",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration: {
        ...registration,
        checked_in_at: checkedInAt,
      },
      status: "attended",
      checkedInAt,
      markedAttendedAt,
    });

    redirect(buildReturnUrl(eventId, "success=marked_attended"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=mark_attended_failed"));
  }
}

export async function linkEventRegistrationToClientAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const clientId = getString(formData, "clientId");

  if (!eventId || !registrationId || !clientId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const client = await ensureClientInStudio({
      supabase,
      studioId,
      clientId,
    });

    if (!client) {
      redirect(buildReturnUrl(eventId, "error=client_not_found"));
    }

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        client_id: client.id,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    await upsertAttendanceLink({
      supabase,
      studioId,
      registrationId,
      clientId: client.id,
    });

    redirect(buildReturnUrl(eventId, "success=registration_linked"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=link_client_failed"));
  }
}

export async function upsertEventAttendanceAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const clientId = getString(formData, "clientId");
  const status = getString(formData, "status") as
    | "registered"
    | "checked_in"
    | "attended"
    | "no_show"
    | "cancelled";

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    let nextClientId = registration.client_id ?? null;

    if (clientId) {
      const client = await ensureClientInStudio({
        supabase,
        studioId,
        clientId,
      });

      if (!client) {
        redirect(buildReturnUrl(eventId, "error=client_not_found"));
      }

      nextClientId = client.id;
    }

    const checkedInAt =
      status === "checked_in" || status === "attended"
        ? (registration.checked_in_at ?? new Date().toISOString())
        : null;

    const registrationStatus =
      status === "cancelled"
        ? "cancelled"
        : status === "attended"
          ? "attended"
          : status === "checked_in"
            ? "checked_in"
            : registration.status === "confirmed"
              ? "confirmed"
              : "confirmed";

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        client_id: nextClientId,
        status: registrationStatus,
        checked_in_at: checkedInAt,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    if (nextClientId) {
      await upsertAttendanceLink({
        supabase,
        studioId,
        registrationId,
        clientId: nextClientId,
      });
    }

    if (status === "registered") {
      const { data: attendanceRecord, error: attendanceLookupError } =
        await supabase
          .from("attendance_records")
          .select("id")
          .eq("studio_id", studioId)
          .eq("event_registration_id", registrationId)
          .maybeSingle<AttendanceLookupRow>();

      if (attendanceLookupError) {
        throw new Error(attendanceLookupError.message);
      }

      if (attendanceRecord) {
        const { error: resetError } = await supabase
          .from("attendance_records")
          .update({
            client_id: nextClientId,
            status: "registered",
            checked_in_at: null,
            marked_attended_at: null,
          })
          .eq("id", attendanceRecord.id)
          .eq("studio_id", studioId);

        if (resetError) {
          throw new Error(resetError.message);
        }
      }

      redirect(buildReturnUrl(eventId, "success=attendance_updated"));
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration: {
        ...registration,
        client_id: nextClientId,
        checked_in_at: checkedInAt,
      },
      status,
      checkedInAt,
      markedAttendedAt: status === "attended" ? new Date().toISOString() : null,
    });

    redirect(buildReturnUrl(eventId, "success=attendance_updated"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=attendance_update_failed"));
  }
}

export async function createLeadFromRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    await createLeadFromRegistration({
      supabase,
      studioId,
      userId,
      registration,
    });

    redirect(buildReturnUrl(eventId, "success=lead_created"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=lead_create_failed"));
  }
}

export async function markEventRegistrationPaidAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const amount = Number(
      registration.total_amount ?? registration.total_price ?? 0,
    );
    const currency = registration.currency ?? "USD";

    await markRegistrationPaymentStatus({
      supabase,
      eventId,
      registrationId,
      paymentStatus: "paid",
      registrationStatus:
        registration.status === "pending" ? "confirmed" : undefined,
    });

    if (amount > 0) {
      await logEventPayment({
        supabase,
        registration,
        studioId,
        amount,
        currency,
        paymentMethod: "other",
        status: "paid",
        source: "manual_admin_mark_paid",
        stripePaymentIntentId: registration.stripe_payment_intent_id,
      });
    }

    redirect(buildReturnUrl(eventId, "success=registration_paid"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=mark_paid_failed"));
  }
}


export async function resendEventTicketConfirmationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  let resultQuery = "error=resend_ticket_failed";

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      resultQuery = "error=registration_not_found";
    } else if (!isRegistrationActiveForCheckIn(registration.status)) {
      resultQuery = "error=resend_not_confirmed";
    } else if (shouldBlockAttendanceForPayment(registration.payment_status)) {
      resultQuery = "error=resend_not_paid";
    } else if (!registration.attendee_email) {
      resultQuery = "error=resend_missing_email";
    } else {
      await ensureTicketRowsForRegistration({ supabase, registration });
      await queueTicketConfirmationResend({
        supabase,
        eventId,
        registrationId,
      });

      resultQuery = "success=ticket_confirmation_resent";
    }
  } catch (error) {
    console.error("resend ticket confirmation failed:", error);
    resultQuery = "error=resend_ticket_failed";
  }

  redirect(buildReturnUrl(eventId, resultQuery));
}


export async function updateEventRegistrationAttendeeAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const attendeeId = getString(formData, "attendeeId");
  const firstName = getString(formData, "firstName");
  const lastName = getString(formData, "lastName");
  const email = getString(formData, "email");
  const phone = getString(formData, "phone");

  if (!eventId || !registrationId || !attendeeId) {
    redirect("/app/events");
  }

  if (!firstName || !lastName) {
    redirect(buildReturnUrl(eventId, "error=attendee_name_required"));
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const { data: attendee, error: attendeeLookupError } = await supabase
      .from("event_registration_attendees")
      .select("id, registration_id, event_id, sort_order")
      .eq("id", attendeeId)
      .eq("registration_id", registrationId)
      .eq("event_id", eventId)
      .maybeSingle<{
        id: string;
        registration_id: string;
        event_id: string | null;
        sort_order: number | null;
      }>();

    if (attendeeLookupError) {
      throw new Error(attendeeLookupError.message);
    }

    if (!attendee) {
      redirect(buildReturnUrl(eventId, "error=attendee_not_found"));
    }

    const payload = {
      first_name: firstName,
      last_name: lastName,
      email: email || null,
      phone: phone || null,
      updated_at: new Date().toISOString(),
    };

    const { error: attendeeUpdateError } = await supabase
      .from("event_registration_attendees")
      .update(payload)
      .eq("id", attendeeId)
      .eq("registration_id", registrationId)
      .eq("event_id", eventId);

    if (attendeeUpdateError) {
      throw new Error(attendeeUpdateError.message);
    }

    if (Number(attendee.sort_order ?? 1) === 1) {
      const { error: registrationUpdateError } = await supabase
        .from("event_registrations")
        .update({
          attendee_first_name: firstName,
          attendee_last_name: lastName,
          attendee_email: email || registration.attendee_email,
          attendee_phone: phone || null,
        })
        .eq("id", registrationId)
        .eq("event_id", eventId);

      if (registrationUpdateError) {
        throw new Error(registrationUpdateError.message);
      }
    }

    redirect(buildReturnUrl(eventId, "success=attendee_updated"));
  } catch (error) {
    console.error("update event registration attendee failed:", error);
    redirect(buildReturnUrl(eventId, "error=attendee_update_failed"));
  }
}


export async function refundEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const amount = Number(
      registration.total_amount ?? registration.total_price ?? 0,
    );
    const currency = registration.currency ?? "USD";

    if (registration.stripe_payment_intent_id) {
      const stripe = getStripe();
      await stripe.refunds.create({
        payment_intent: registration.stripe_payment_intent_id,
      });
    }

    await markRegistrationPaymentStatus({
      supabase,
      eventId,
      registrationId,
      paymentStatus: "refunded",
      registrationStatus: "cancelled",
    });

    const latestPayment = await findLatestPaymentForRegistration({
      supabase,
      registrationId,
    });

    if (latestPayment) {
      const { error: paymentUpdateError } = await supabase
        .from("event_payments")
        .update({
          status: "refunded",
          refund_amount: amount,
          refunded_at: new Date().toISOString(),
        })
        .eq("id", latestPayment.id);

      if (paymentUpdateError) {
        throw new Error(paymentUpdateError.message);
      }
    } else if (amount > 0) {
      await logEventPayment({
        supabase,
        registration,
        studioId,
        amount,
        currency,
        paymentMethod: "other",
        status: "refunded",
        source: "refund",
        stripePaymentIntentId: registration.stripe_payment_intent_id,
      });

      const latestInserted = await findLatestPaymentForRegistration({
        supabase,
        registrationId,
      });

      if (latestInserted) {
        const { error: paymentUpdateError } = await supabase
          .from("event_payments")
          .update({
            refund_amount: amount,
            refunded_at: new Date().toISOString(),
          })
          .eq("id", latestInserted.id);

        if (paymentUpdateError) {
          throw new Error(paymentUpdateError.message);
        }
      }
    }

    const { error: attendanceUpdateError } = await supabase
      .from("attendance_records")
      .update({
        status: "cancelled",
      })
      .eq("studio_id", studioId)
      .eq("event_registration_id", registrationId);

    if (attendanceUpdateError) {
      throw new Error(attendanceUpdateError.message);
    }

    redirect(buildReturnUrl(eventId, "success=registration_refunded"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=refund_failed"));
  }
}

