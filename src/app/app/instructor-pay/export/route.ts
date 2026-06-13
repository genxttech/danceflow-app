import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { toCsv } from "@/lib/utils/csv";

type EarningExportRow = {
  id: string;
  earning_date: string | null;
  source_type: string | null;
  appointment_type: string | null;
  gross_revenue_basis: number | string | null;
  pay_mode: string | null;
  pay_rate_amount: number | string | null;
  pay_percentage: number | string | null;
  attendance_count: number | null;
  earning_amount: number | string | null;
  status: string | null;
  paid_at: string | null;
  payment_method: string | null;
  notes: string | null;
  appointment_id: string | null;
  instructor_id: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

function relationName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null,
  fallback: string,
) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row) return fallback;
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || fallback;
}

function labelize(value: string | null | undefined) {
  if (!value) return "";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function safeFilenamePart(value: string | null | undefined) {
  return (value || "all").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const instructorId = url.searchParams.get("instructorId") ?? "all";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (!context.studioId || !canManageInstructors(role) || !["studio_owner", "studio_admin"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let query = supabase
    .from("instructor_earnings")
    .select(
      "id, earning_date, source_type, appointment_type, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, status, paid_at, payment_method, notes, appointment_id, instructor_id, instructors(first_name, last_name), clients(first_name, last_name)",
    )
    .eq("studio_id", context.studioId)
    .order("earning_date", { ascending: false })
    .limit(5000);

  if (["pending", "approved", "paid", "void"].includes(status)) {
    query = query.eq("status", status);
  }

  if (instructorId !== "all") {
    query = query.eq("instructor_id", instructorId);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: `Instructor pay export failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = ((data ?? []) as EarningExportRow[]).map((earning) => [
    earning.earning_date,
    relationName(earning.instructors, "Instructor"),
    relationName(earning.clients, ""),
    labelize(earning.appointment_type),
    labelize(earning.source_type),
    Number(earning.gross_revenue_basis ?? 0),
    labelize(earning.pay_mode),
    Number(earning.pay_rate_amount ?? 0),
    Number(earning.pay_percentage ?? 0),
    earning.attendance_count ?? 0,
    Number(earning.earning_amount ?? 0),
    labelize(earning.status),
    earning.paid_at,
    labelize(earning.payment_method),
    earning.notes ?? "",
    earning.appointment_id ?? "",
    earning.id,
  ]);

  const csv = toCsv(
    [
      "Earning Date",
      "Instructor",
      "Client",
      "Lesson/Class Type",
      "Source",
      "Revenue Basis",
      "Pay Rule",
      "Flat/Per-Student Amount",
      "Percentage",
      "Attendance Count",
      "Earning Amount",
      "Status",
      "Paid At",
      "Payment Method",
      "Notes",
      "Appointment ID",
      "Earning ID",
    ],
    rows,
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="danceflow-instructor-pay-${safeFilenamePart(status)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
