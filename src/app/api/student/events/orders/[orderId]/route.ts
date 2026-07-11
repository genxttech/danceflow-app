import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { getStudentApiUser, normalizeStudentApiUuid, sameStudentEmail } from "@/lib/auth/studentApiAuth";

type Params = {
  params: Promise<{ orderId: string }>;
};

type EventOrderRow = {
  id: string;
  event_id: string;
  buyer_email: string | null;
  status: string | null;
  payment_status: string | null;
  total_amount: number | null;
  currency: string | null;
  expires_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  events:
    | {
        id: string;
        name: string | null;
        slug: string | null;
        start_date: string | null;
        start_time: string | null;
        venue_name: string | null;
        city: string | null;
        state: string | null;
      }
    | {
        id: string;
        name: string | null;
        slug: string | null;
        start_date: string | null;
        start_time: string | null;
        venue_name: string | null;
        city: string | null;
        state: string | null;
      }[]
    | null;
};

type RegistrationRow = {
  id: string;
  status: string | null;
  payment_status: string | null;
  quantity: number | null;
  user_id: string | null;
  event_registration_attendees:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        sort_order: number | null;
        checked_in_at: string | null;
        waiver_signed_at: string | null;
        ticket_code: string | null;
        ticket_issued_at: string | null;
      }[]
    | null;
};

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function pickOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function appBaseUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  ).replace(/\/$/, "");
}

function attendeeName(
  attendee: { first_name: string | null; last_name: string | null; sort_order: number | null }
) {
  const fullName = [attendee.first_name, attendee.last_name].filter(Boolean).join(" ").trim();
  return fullName || `Ticket ${attendee.sort_order ?? ""}`.trim();
}

export async function GET(request: NextRequest, { params }: Params) {
  const { orderId } = await params;
  const normalizedOrderId = normalizeStudentApiUuid(orderId);

  if (!normalizedOrderId) {
    return jsonError("Event order was not found.", 404);
  }

  const supabase = getSupabaseAdmin();
  const user = await getStudentApiUser(request);

  if (!user?.email) {
    return jsonError("Sign in to view this event order.", 401);
  }

  const { data: order, error: orderError } = await supabase
    .from("event_orders")
    .select(
      [
        "id",
        "event_id",
        "buyer_email",
        "status",
        "payment_status",
        "total_amount",
        "currency",
        "expires_at",
        "paid_at",
        "cancelled_at",
        "events:event_id ( id, name, slug, start_date, start_time, venue_name, city, state )",
      ].join(", ")
    )
    .eq("id", normalizedOrderId)
    .maybeSingle();

  if (orderError) {
    return jsonError("Event order could not be loaded.", 500);
  }

  const orderRow = order as unknown as EventOrderRow | null;
  const buyerEmail = orderRow?.buyer_email?.trim().toLowerCase();

  if (!orderRow || !sameStudentEmail(user, buyerEmail)) {
    return jsonError("Event order was not found.", 404);
  }

  const { data: registrations, error: registrationsError } = await supabase
    .from("event_registrations")
    .select(
      [
        "id",
        "status",
        "payment_status",
        "quantity",
        "user_id",
        "event_registration_attendees ( id, first_name, last_name, sort_order, checked_in_at, waiver_signed_at, ticket_code, ticket_issued_at )",
      ].join(", ")
    )
    .eq("order_id", orderRow.id)
    .order("id", { ascending: true });

  if (registrationsError) {
    return jsonError("Event tickets could not be loaded.", 500);
  }

  const registrationRows = (registrations ?? []) as unknown as RegistrationRow[];
  const registrationIds = registrationRows.map((registration) => registration.id);
  const attendees = registrationRows.flatMap((registration) => registration.event_registration_attendees ?? []);
  const ticketCodesIssued = attendees.filter((attendee) => Boolean(attendee.ticket_code)).length;
  const ticketCount = attendees.length;
  const paymentStatus = orderRow.payment_status ?? "pending";
  const status = orderRow.status ?? "pending";
  const ticketsReady = paymentStatus === "paid" && ticketCount > 0 && ticketCodesIssued >= ticketCount;
  const event = pickOne(orderRow.events);
  const baseUrl = appBaseUrl(request);
  const tickets = registrationRows.flatMap((registration) =>
    (registration.event_registration_attendees ?? []).map((attendee) => ({
      checkedInAt: attendee.checked_in_at,
      city: event?.city ?? null,
      eventDate: event?.start_date ?? null,
      eventId: orderRow.event_id,
      eventName: event?.name ?? "Event",
      eventSlug: event?.slug ?? null,
      eventTime: event?.start_time ?? null,
      id: attendee.id,
      qrImageUrl: attendee.ticket_code
        ? `${baseUrl}/api/tickets/qr?code=${encodeURIComponent(attendee.ticket_code)}`
        : null,
      registrationId: registration.id,
      state: event?.state ?? null,
      ticketCode: attendee.ticket_code,
      ticketIssuedAt: attendee.ticket_issued_at,
      ticketName: attendeeName(attendee),
      venue: event?.venue_name ?? null,
      waiverSignedAt: attendee.waiver_signed_at,
    }))
  );

  return NextResponse.json({
    cancelledAt: orderRow.cancelled_at,
    currency: orderRow.currency ?? "USD",
    eventId: orderRow.event_id,
    eventName: event?.name ?? "Event",
    eventSlug: event?.slug ?? null,
    expiresAt: orderRow.expires_at,
    orderId: orderRow.id,
    paidAt: orderRow.paid_at,
    paymentStatus,
    registrationIds,
    status,
    ticketCodesIssued,
    ticketCount,
    tickets,
    ticketsReady,
    totalAmount: Number(orderRow.total_amount ?? 0),
  });
}
