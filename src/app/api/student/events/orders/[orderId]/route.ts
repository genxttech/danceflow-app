import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";

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
      }
    | {
        id: string;
        name: string | null;
        slug: string | null;
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

async function userFromRequest(supabase: SupabaseClient, request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

export async function GET(request: NextRequest, { params }: Params) {
  const { orderId } = await params;
  const supabase = getSupabaseAdmin();
  const user = await userFromRequest(supabase, request);

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
        "events:event_id ( id, name, slug )",
      ].join(", ")
    )
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) {
    return jsonError("Event order could not be loaded.", 500);
  }

  const orderRow = order as unknown as EventOrderRow | null;
  const buyerEmail = orderRow?.buyer_email?.trim().toLowerCase();

  if (!orderRow || buyerEmail !== user.email.trim().toLowerCase()) {
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
        "event_registration_attendees ( id, ticket_code, ticket_issued_at )",
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
    ticketsReady,
    totalAmount: Number(orderRow.total_amount ?? 0),
  });
}
