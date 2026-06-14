import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type ExpenseRow = {
  id: string;
  expense_date: string | null;
  vendor_name: string | null;
  category: string | null;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  related_event_id: string | null;
  related_client_id: string | null;
  related_appointment_id: string | null;
  notes: string | null;
  created_at: string | null;
};

type EventLookupRow = {
  id: string;
  name: string | null;
  event_type: string | null;
  start_date: string | null;
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

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "month";
  const rangeStartDate = getRangeStart(range);
  const rangeStartDateOnly = rangeStartDate.toISOString().slice(0, 10);
  const todayDateOnly = new Date().toISOString().slice(0, 10);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "") || !context.studioId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { data, error } = await supabase
    .from("expenses")
    .select(
      "id, expense_date, vendor_name, category, amount, currency, payment_method, related_event_id, related_client_id, related_appointment_id, notes, created_at",
    )
    .eq("studio_id", context.studioId)
    .gte("expense_date", rangeStartDateOnly)
    .lte("expense_date", todayDateOnly)
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    return new NextResponse(`Failed to export expenses: ${error.message}`, {
      status: 500,
    });
  }

  const expenses = (data ?? []) as ExpenseRow[];
  const eventIds = uniqueStrings(expenses.map((expense) => expense.related_event_id));
  const eventById = new Map<string, EventLookupRow>();

  if (eventIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("events")
      .select("id, name, event_type, start_date")
      .eq("studio_id", context.studioId)
      .in("id", eventIds);

    if (eventsError) {
      return new NextResponse(
        `Failed to load related event details for expenses export: ${eventsError.message}`,
        { status: 500 },
      );
    }

    for (const event of (events ?? []) as EventLookupRow[]) {
      eventById.set(event.id, event);
    }
  }

  const rows = expenses.map((expense) => {
    const event = expense.related_event_id
      ? eventById.get(expense.related_event_id)
      : null;

    return [
      expense.expense_date,
      expense.vendor_name,
      expense.category,
      expense.amount ?? 0,
      expense.currency ?? "USD",
      expense.payment_method,
      expense.related_event_id,
      event?.name ?? null,
      event?.event_type ?? null,
      event?.start_date ?? null,
      expense.related_client_id,
      expense.related_appointment_id,
      expense.notes,
      expense.created_at,
      expense.id,
    ];
  });

  const csv = toCsv(
    [
      "Expense Date",
      "Vendor",
      "Category",
      "Amount",
      "Currency",
      "Payment Method",
      "Related Event ID",
      "Related Event",
      "Related Event Type",
      "Related Event Date",
      "Related Client ID",
      "Related Appointment ID",
      "Notes",
      "Created At",
      "Expense ID",
    ],
    rows,
  );

  return csvResponse(csv, `danceflow-expenses-${range}.csv`);
}
