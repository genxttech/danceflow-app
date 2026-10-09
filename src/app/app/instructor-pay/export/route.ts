import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canPreparePayroll } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { toCsv } from "@/lib/utils/csv";
import {
  exportedTotals,
  loadBatchExportSource,
  recordPayrollExport,
  type ApprovalSnapshot,
  type ApprovalSnapshotLine,
  type PaymentEvidence,
} from "@/lib/payroll/approved-batch-export";

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

const HEADERS = [
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
  "Record Source",
];

const SOURCE_SNAPSHOT = "Approval snapshot";
const SOURCE_LEGACY = "Current records (approved before snapshots)";
const SOURCE_LIVE = "Current records";

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

function liveRow(earning: EarningExportRow, recordSource: string) {
  return [
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
    recordSource,
  ];
}

// Every figure, name and note comes from the frozen approval snapshot; the
// paid details come from the immutable payment evidence.
function snapshotRow(line: ApprovalSnapshotLine, snapshot: ApprovalSnapshot, payment: PaymentEvidence | null) {
  return [
    line.earning_date,
    line.instructor_name || "Instructor",
    line.client_name ?? "",
    labelize(line.appointment_type),
    labelize(line.source_type),
    Number(line.gross_revenue_basis ?? 0),
    labelize(line.pay_mode),
    Number(line.pay_rate_amount ?? 0),
    Number(line.pay_percentage ?? 0),
    line.attendance_count ?? 0,
    Number(line.earning_amount ?? 0),
    payment ? "Paid" : "Approved",
    payment?.paid_at ?? null,
    labelize(payment?.payment_method),
    labelize(line.worker_classification_snapshot),
    line.accounting_category_snapshot ?? "",
    Number(line.taxable_compensation_amount ?? 0),
    Number(line.reimbursement_amount ?? 0),
    Number(line.deduction_amount ?? 0),
    snapshot.pay_period_id,
    snapshot.payroll_batch_id,
    line.notes ?? "",
    line.appointment_id ?? "",
    line.earning_id,
    SOURCE_SNAPSHOT,
  ];
}

function csvResponse(rows: unknown[][], filenamePart: string) {
  const csv = toCsv(HEADERS, rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="danceflow-instructor-pay-${safeFilenamePart(filenamePart)}.csv"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const EXPORT_FAILED = { error: "The instructor-pay export could not be generated. No data was downloaded." };

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
  const studioId = context.studioId;

  // Batch exports load through the trusted, studio-scoped reader (owner /
  // admin of this studio, or a platform admin naming it). Approved and paid
  // batches export their approval evidence and record the export.
  if (batchId) {
    const source = await loadBatchExportSource(supabase, studioId, batchId);
    if (source.kind === "not_found") {
      return NextResponse.json({ error: "Payroll batch not found." }, { status: 404 });
    }
    if (source.kind === "forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (source.kind === "error") {
      console.error("Instructor pay export failed", { studioId, batchId, stage: source.stage, message: source.message });
      return NextResponse.json(EXPORT_FAILED, { status: 500 });
    }
    if (source.kind === "snapshot") {
      const rows = source.lines.map((line) => snapshotRow(line, source.snapshot, source.payment));
      const totals = exportedTotals(source.lines.map((line) => ({ net: line.net_amount })));
      const recorded = await recordPayrollExport(supabase, { studioId, batchId: source.batch.id, exportType: "csv", ...totals });
      if (!recorded.ok) {
        console.error("Instructor pay export evidence failed", { studioId, batchId, message: recorded.message });
        return NextResponse.json(EXPORT_FAILED, { status: 500 });
      }
      return csvResponse(rows, `batch-${batchId}`);
    }

    // Current records, newest first (as before).
    const newestFirst = [...source.earnings].reverse() as EarningExportRow[];
    if (source.kind === "legacy") {
      // A legacy approved batch exports the whole batch so its export evidence
      // describes the batch, not a filtered subset.
      const rows = newestFirst.map((earning) => liveRow(earning, SOURCE_LEGACY));
      const counted = newestFirst
        .filter((earning) => earning.status !== "void")
        .map((earning) => ({
          net:
            Number(earning.taxable_compensation_amount ?? 0) +
            Number(earning.reimbursement_amount ?? 0) -
            Number(earning.deduction_amount ?? 0),
        }));
      const recorded = await recordPayrollExport(supabase, {
        studioId,
        batchId: source.batch.id,
        exportType: "csv",
        ...exportedTotals(counted),
      });
      if (!recorded.ok) {
        console.error("Instructor pay export evidence failed", { studioId, batchId, message: recorded.message });
        return NextResponse.json(EXPORT_FAILED, { status: 500 });
      }
      return csvResponse(rows, `batch-${batchId}`);
    }

    // Draft / in-review batch: a working copy, filtered as requested, no evidence.
    const filtered = newestFirst.filter(
      (earning) =>
        (!["pending", "approved", "paid", "void"].includes(status) || earning.status === status) &&
        (instructorId === "all" || earning.instructor_id === instructorId) &&
        (!payPeriodId || earning.pay_period_id === payPeriodId),
    );
    return csvResponse(filtered.map((earning) => liveRow(earning, SOURCE_LIVE)), `batch-${batchId}`);
  }

  let query = supabase
    .from("instructor_earnings")
    .select(
      "id, earning_date, source_type, appointment_type, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, status, paid_at, payment_method, notes, appointment_id, instructor_id, pay_period_id, payroll_batch_id, worker_classification_snapshot, accounting_category_snapshot, taxable_compensation_amount, reimbursement_amount, deduction_amount, instructors(first_name, last_name), clients(first_name, last_name)",
    )
    .eq("studio_id", studioId)
    .order("earning_date", { ascending: false })
    .limit(5000);

  if (["pending", "approved", "paid", "void"].includes(status)) {
    query = query.eq("status", status);
  }

  if (instructorId !== "all") { query = query.eq("instructor_id", instructorId); }
  if (payPeriodId) { query = query.eq("pay_period_id", payPeriodId); }

  const { data, error } = await query;

  if (error) {
    console.error("Instructor pay export failed", {
      studioId,
      batchId,
      status,
      instructorId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return NextResponse.json(EXPORT_FAILED, { status: 500 });
  }

  const rows = ((data ?? []) as EarningExportRow[]).map((earning) => liveRow(earning, SOURCE_LIVE));
  return csvResponse(rows, payPeriodId ? `period-${payPeriodId}` : status);
}
