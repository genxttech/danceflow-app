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

  const rows = ((data ?? []) as EventRegistrationExportRow[]).map(
    (registration) => {
      const event = firstRelated(registration.events);
      const ticket = firstRelated(registration.event_ticket_types);
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
        registration.total_amount ?? registration.total_price ?? 0,
        registration.currency ?? "USD",
        registration.status,
        registration.payment_status,
        registration.checked_in_at ? "Yes" : "No",
        registration.checked_in_at,
        registration.created_at,
        registration.id,
        registration.event_id,
      ];
    },
  );

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
      "Amount",
      "Currency",
      "Registration Status",
      "Payment Status",
      "Checked In",
      "Checked In At",
      "Created At",
      "Registration ID",
      "Event ID",
    ],
    rows,
  );

  return csvResponse(csv, `danceflow-event-registrations-${range}.csv`);
}
