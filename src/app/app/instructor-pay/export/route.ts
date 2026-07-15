import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canPreparePayroll } from "@/lib/auth/permissions";
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
  pay_period_id: string | null;
  payroll_batch_id: string | null;
  worker_classification_snapshot: string | null;
  accounting_category_snapshot: string | null;
  taxable_compensation_amount: number | string | null;
  reimbursement_amount: number | string | null;
  deduction_amount: number | string | null;
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


function csvSafe(value: unknown) {
  if (typeof value !== "string") return value;
  const normalized = value.replace(/\u0000/g, "");
  return /^[\s]*[=+\-@\t\r]/.test(normalized)
    ? `'${normalized}`
    : normalized;
}

function safeFilenamePart(value: string | null | undefined) {
  return (value || "all").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const instructorId = url.searchParams.get("instructorId") ?? "all";
  const batchId = url.searchParams.get("batchId");
  const payPeriodId = url.searchParams.get("payPeriodId");

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (!context.studioId || !canPreparePayroll(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let query = supabase
    .from("instructor_earnings")
    .select(
      "id, earning_date, source_type, appointment_type, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, status, paid_at, payment_method, notes, appointment_id, instructor_id, pay_period_id, payroll_batch_id, worker_classification_snapshot, accounting_category_snapshot, taxable_compensation_amount, reimbursement_amount, deduction_amount, instructors(first_name, last_name), clients(first_name, last_name)",
    )
    .eq("studio_id", context.studioId)
    .order("earning_date", { ascending: false })
    .limit(5000);

  if (["pending", "approved", "paid", "void"].includes(status)) {
    query = query.eq("status", status);
  }

  if (instructorId !== "all") { query = query.eq("instructor_id", instructorId); }
  if (batchId) { query = query.eq("payroll_batch_id", batchId); }
  if (payPeriodId) { query = query.eq("pay_period_id", payPeriodId); }

  const { data, error } = await query;

  if (error) {
    console.error("Instructor pay export failed", {
      studioId: context.studioId,
      batchId,
      status,
      instructorId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return NextResponse.json(
      { error: "The instructor-pay export could not be generated. No data was downloaded." },
      { status: 500 },
    );
  }

  const rows = ((data ?? []) as EarningExportRow[]).map((earning) =>
    [
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
      labelize(earning.worker_classification_snapshot),
      earning.accounting_category_snapshot ?? "",
      Number(earning.taxable_compensation_amount ?? 0),
      Number(earning.reimbursement_amount ?? 0),
      Number(earning.deduction_amount ?? 0),
      earning.pay_period_id ?? "",
      earning.payroll_batch_id ?? "",
      earning.notes ?? "",
      earning.appointment_id ?? "",
      earning.id,
    ].map(csvSafe),
  );

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
      "Worker Classification",
      "Accounting Category",
      "Taxable Compensation",
      "Reimbursement",
      "Deduction",
      "Pay Period ID",
      "Payroll Batch ID",
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
      "Content-Disposition": `attachment; filename="danceflow-instructor-pay-${safeFilenamePart(batchId ? `batch-${batchId}` : payPeriodId ? `period-${payPeriodId}` : status)}.csv"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
