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
  notes: string | null;
  created_at: string | null;
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
      "id, expense_date, vendor_name, category, amount, currency, payment_method, notes, created_at",
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

  const rows = ((data ?? []) as ExpenseRow[]).map((expense) => [
    expense.expense_date,
    expense.vendor_name,
    expense.category,
    expense.amount ?? 0,
    expense.currency ?? "USD",
    expense.payment_method,
    expense.notes,
    expense.created_at,
    expense.id,
  ]);

  const csv = toCsv(
    [
      "Expense Date",
      "Vendor",
      "Category",
      "Amount",
      "Currency",
      "Payment Method",
      "Notes",
      "Created At",
      "Expense ID",
    ],
    rows,
  );

  return csvResponse(csv, `danceflow-expenses-${range}.csv`);
}
