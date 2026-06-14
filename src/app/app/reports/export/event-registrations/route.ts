import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRegistrationExportRow = {
  id: string;
  event_id: string | null;
  ticket_type_id: string | null;
  status: string | null;
  payment_status: string | null;
  quantity: number | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  checked_in_at: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  created_at: string | null;
  events:
    | { name: string | null; event_type: string | null; start_date: string | null }
    | { name: string | null; event_type: string | null; start_date: string | null }[]
    | null;
  event_ticket_types:
    | { name: string | null; ticket_kind: string | null }
    | { name: string | null; ticket_kind: string | null }[]
    | null;
};

type AttendeeTicketExportRow = {
  id: string;
  registration_id: string | null;
  ticket_code: string | null;
  checked_in_at: string | null;
};

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonthLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function startOfLast30DaysLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
}

function startOfQuarterLocal() {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
}

function startOfYearLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), 0, 1);
}

function getRangeStart(range: string) {
  if (range === "today") return startOfTodayLocal();
  if (range === "last30") return startOfLast30DaysLocal();
  if (range === "quarter") return startOfQuarterLocal();
  if (range === "year") return startOfYearLocal();
  return startOfMonthLocal();
}

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function firstRelated<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "month";
  const rangeStart = getRangeStart(range).toISOString();

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "") || !context.studioId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { data, error } = await supabase
    .from("event_registrations")
    .select(
      `
        id,
        event_id,
        ticket_type_id,
        status,
        payment_status,
        quantity,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        created_at,
        events ( name, event_type, start_date ),
        event_ticket_types ( name, ticket_kind )
      `,
    )
    .eq("studio_id", context.studioId)
    .gte("created_at", rangeStart)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    return new NextResponse(
      `Failed to export event registrations: ${error.message}`,
      { status: 500 },
    );
  }

  const registrations = (data ?? []) as EventRegistrationExportRow[];
  const registrationIds = registrations.map((registration) => registration.id);
  const attendeesByRegistrationId = new Map<string, AttendeeTicketExportRow[]>();

  if (registrationIds.length > 0) {
    const { data: attendees, error: attendeesError } = await supabase
      .from("event_registration_attendees")
      .select("id, registration_id, ticket_code, checked_in_at")
      .in("registration_id", registrationIds)
      .order("registration_id", { ascending: true });

    if (attendeesError) {
      return new NextResponse(
        `Failed to export event ticket check-in details: ${attendeesError.message}`,
        { status: 500 },
      );
    }

    for (const attendee of (attendees ?? []) as AttendeeTicketExportRow[]) {
      if (!attendee.registration_id) continue;
      const existing = attendeesByRegistrationId.get(attendee.registration_id) ?? [];
      existing.push(attendee);
      attendeesByRegistrationId.set(attendee.registration_id, existing);
    }
  }

  const rows = registrations.map((registration) => {
    const event = firstRelated(registration.events);
    const ticket = firstRelated(registration.event_ticket_types);
    const attendeeTickets = attendeesByRegistrationId.get(registration.id) ?? [];
    const ticketCodes = attendeeTickets
      .map((attendee) => attendee.ticket_code)
      .filter(Boolean)
      .join(" | ");
    const checkedInTicketCount = attendeeTickets.filter((attendee) => attendee.checked_in_at).length;
    const ticketCount = attendeeTickets.length;
    const firstTicketCheckedInAt = attendeeTickets.find((attendee) => attendee.checked_in_at)?.checked_in_at ?? null;
    const isCheckedIn = Boolean(registration.checked_in_at) || checkedInTicketCount > 0;

    return [
      event?.name,
      event?.event_type,
      event?.start_date,
      ticket?.name,
      ticket?.ticket_kind,
      registration.attendee_first_name,
      registration.attendee_last_name,
      registration.attendee_email,
      registration.quantity ?? 1,
      ticketCount,
      checkedInTicketCount,
      ticketCodes,
      registration.total_amount ?? registration.total_price ?? 0,
      registration.currency ?? "USD",
      registration.status,
      registration.payment_status,
      isCheckedIn ? "Yes" : "No",
      registration.checked_in_at,
      firstTicketCheckedInAt,
      registration.created_at,
      registration.id,
      registration.event_id,
    ];
  });

  const csv = toCsv(
    [
      "Event",
      "Event Type",
      "Event Date",
      "Ticket Type",
      "Ticket Kind",
      "First Name",
      "Last Name",
      "Email",
      "Quantity",
      "QR Ticket Count",
      "QR Tickets Checked In",
      "Ticket Codes",
      "Amount",
      "Currency",
      "Registration Status",
      "Payment Status",
      "Checked In",
      "Registration Checked In At",
      "First Ticket Checked In At",
      "Created At",
      "Registration ID",
      "Event ID",
    ],
    rows,
  );

  return csvResponse(csv, `danceflow-event-registrations-${range}.csv`);
}
