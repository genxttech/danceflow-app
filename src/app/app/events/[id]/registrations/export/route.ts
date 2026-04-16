import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type AttendanceRow = {
  event_registration_id: string;
  status: string;
  checked_in_at: string | null;
  marked_attended_at: string | null;
};

type PaymentRow = {
  registration_id: string;
  amount: number;
  currency: string;
  payment_method: string;
  status: string;
  refund_amount: number | null;
  refunded_at: string | null;
  created_at: string;
  source: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

type RegistrationRow = {
  id: string;
  status: string;
  payment_status: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  total_amount: number | null;
  currency: string | null;
  registration_source: string | null;
  notes: string | null;
  checked_in_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  client_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  event_ticket_types:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null;
};

function csvEscape(value: unknown) {
  const stringValue = value == null ? "" : String(value);
  const escaped = stringValue.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildCsv(rows: string[][]) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function sanitizeFilenamePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function getTicketName(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? "";
}

function getTicketKind(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.ticket_kind ?? "";
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);

  const searchText = (searchParams.get("q") ?? "").trim().toLowerCase();
  const paymentFilter = (searchParams.get("paymentStatus") ?? "").trim();
  const registrationFilter = (searchParams.get("registrationStatus") ?? "").trim();
  const ticketTypeFilter = (searchParams.get("ticketType") ?? "").trim();

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const studioId = roleRow.studio_id as string;

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, name, slug")
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (eventError || !event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  const { data: registrations, error: registrationsError } = await supabase
    .from("event_registrations")
    .select(`
      id,
      status,
      payment_status,
      attendee_first_name,
      attendee_last_name,
      attendee_email,
      attendee_phone,
      quantity,
      unit_price,
      total_price,
      total_amount,
      currency,
      registration_source,
      notes,
      checked_in_at,
      cancelled_at,
      created_at,
      client_id,
      stripe_checkout_session_id,
      stripe_payment_intent_id,
      event_ticket_types ( name, ticket_kind )
    `)
    .eq("event_id", id)
    .order("created_at", { ascending: false });

  if (registrationsError) {
    return NextResponse.json(
      { error: registrationsError.message },
      { status: 500 }
    );
  }

  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const registrationIds = typedRegistrations.map((row) => row.id);

  let attendanceByRegistrationId = new Map<string, AttendanceRow>();
  let paymentsByRegistrationId = new Map<string, PaymentRow>();

  if (registrationIds.length > 0) {
    const [{ data: attendanceRows, error: attendanceError }, { data: paymentRows, error: paymentError }] =
      await Promise.all([
        supabase
          .from("attendance_records")
          .select(`
            event_registration_id,
            status,
            checked_in_at,
            marked_attended_at
          `)
          .eq("studio_id", studioId)
          .in("event_registration_id", registrationIds),
        supabase
          .from("event_payments")
          .select(`
            registration_id,
            amount,
            currency,
            payment_method,
            status,
            refund_amount,
            refunded_at,
            created_at,
            source,
            stripe_checkout_session_id,
            stripe_payment_intent_id
          `)
          .in("registration_id", registrationIds)
          .order("created_at", { ascending: false }),
      ]);

    if (attendanceError) {
      return NextResponse.json(
        { error: attendanceError.message },
        { status: 500 }
      );
    }

    if (paymentError) {
      return NextResponse.json(
        { error: paymentError.message },
        { status: 500 }
      );
    }

    const typedAttendanceRows = (attendanceRows ?? []) as AttendanceRow[];
    attendanceByRegistrationId = new Map(
      typedAttendanceRows.map((row) => [row.event_registration_id, row])
    );

    const typedPaymentRows = (paymentRows ?? []) as PaymentRow[];
    for (const payment of typedPaymentRows) {
      if (!paymentsByRegistrationId.has(payment.registration_id)) {
        paymentsByRegistrationId.set(payment.registration_id, payment);
      }
    }
  }

  const filteredRegistrations = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id) ?? null;
    const payment = paymentsByRegistrationId.get(registration.id) ?? null;
    const effectiveStatus =
      attendance?.status ??
      (registration.status === "confirmed" ? "registered" : registration.status);
    const paymentStatus = registration.payment_status ?? "pending";
    const ticketTypeName = getTicketName(registration.event_ticket_types);

    if (paymentFilter && paymentStatus !== paymentFilter) {
      return false;
    }

    if (registrationFilter && effectiveStatus !== registrationFilter) {
      return false;
    }

    if (ticketTypeFilter && ticketTypeName !== ticketTypeFilter) {
      return false;
    }

    if (searchText) {
      const haystack = [
        registration.attendee_first_name,
        registration.attendee_last_name,
        registration.attendee_email,
        registration.attendee_phone ?? "",
        ticketTypeName,
        payment?.payment_method ?? "",
        registration.notes ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(searchText)) {
        return false;
      }
    }

    return true;
  });

  const rows: string[][] = [
    [
      "registration_id",
      "registration_status",
      "payment_status",
      "attendee_first_name",
      "attendee_last_name",
      "attendee_email",
      "attendee_phone",
      "ticket_type_name",
      "ticket_kind",
      "quantity",
      "unit_price",
      "total_amount",
      "currency",
      "payment_method",
      "payment_record_status",
      "payment_source",
      "stripe_checkout_session_id",
      "stripe_payment_intent_id",
      "registration_source",
      "crm_linked",
      "client_id",
      "checked_in_at",
      "marked_attended_at",
      "cancelled_at",
      "created_at",
      "notes",
    ],
  ];

  for (const registration of filteredRegistrations) {
    const attendance = attendanceByRegistrationId.get(registration.id) ?? null;
    const payment = paymentsByRegistrationId.get(registration.id) ?? null;
    const effectiveStatus =
      attendance?.status ??
      (registration.status === "confirmed" ? "registered" : registration.status);

    rows.push([
      registration.id,
      effectiveStatus,
      registration.payment_status ?? "pending",
      registration.attendee_first_name,
      registration.attendee_last_name,
      registration.attendee_email,
      registration.attendee_phone ?? "",
      getTicketName(registration.event_ticket_types),
      getTicketKind(registration.event_ticket_types),
      String(registration.quantity ?? 1),
      String(registration.unit_price ?? 0),
      String(registration.total_amount ?? registration.total_price ?? 0),
      registration.currency ?? "USD",
      payment?.payment_method ?? "",
      payment?.status ?? "",
      payment?.source ?? "",
      payment?.stripe_checkout_session_id ??
        registration.stripe_checkout_session_id ??
        "",
      payment?.stripe_payment_intent_id ??
        registration.stripe_payment_intent_id ??
        "",
      registration.registration_source ?? "",
      registration.client_id ? "yes" : "no",
      registration.client_id ?? "",
      attendance?.checked_in_at ?? registration.checked_in_at ?? "",
      attendance?.marked_attended_at ?? "",
      registration.cancelled_at ?? "",
      registration.created_at ?? "",
      registration.notes ?? "",
    ]);
  }

  const csv = buildCsv(rows);
  const filename = `${sanitizeFilenamePart(event.slug || event.name)}-registrations.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}