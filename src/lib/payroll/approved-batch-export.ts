import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 9B: where a payroll batch export reads its figures from.
 *
 * Every batch export loads through get_payroll_batch_export, the trusted,
 * explicitly studio-scoped reader: the caller must be an owner/admin of the
 * named studio or a platform admin naming that studio, and the batch must
 * belong to it. Platform admins therefore export without any direct table
 * read; the payroll tables keep their owner/admin-only SELECT policies.
 *
 * - "snapshot": the batch was approved with an immutable approval snapshot;
 *   every payroll figure, name and note comes from the frozen snapshot lines
 *   (and paid details from the immutable payment evidence), never from the
 *   live, still-mutable earning, instructor or client rows.
 * - "legacy": the batch was approved before snapshots existed. Its figures
 *   are read from the current payroll records and the export says so; no
 *   snapshot is invented for it.
 * - "live": the batch is not approved yet (draft / in review), so the export
 *   is a working copy of the current records.
 *
 * Approved ("snapshot" / "legacy") exports append an export evidence event
 * via record_payroll_export after the file has been generated and before it
 * is returned; if the event cannot be recorded, no file is returned.
 */

export type BatchExportRow = {
  id: string;
  pay_period_id: string;
  batch_number: number | string;
  provider: string;
  provider_batch_reference: string | null;
  status: string;
  compensation_total: number | string | null;
  reimbursement_total: number | string | null;
  deduction_total: number | string | null;
  net_payment_total: number | string | null;
  earning_count: number;
  approved_at: string | null;
  paid_at: string | null;
  payment_method: string | null;
  created_at: string;
};

/** Presentation fields of the named studio, from the trusted reader (no direct studios read). */
export type ExportStudio = {
  name: string;
  public_name: string | null;
  public_logo_url: string | null;
};

export type BatchExportPeriod = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string | null;
  status: string;
};

export type ApprovalSnapshot = {
  id: string;
  payroll_batch_id: string;
  pay_period_id: string;
  batch_number: number | string;
  provider: string;
  provider_batch_reference: string | null;
  period_start: string;
  period_end: string;
  pay_date: string | null;
  approved_at: string;
  approved_by_name: string | null;
  approved_by_role: string;
  worker_count: number;
  earning_count: number;
  compensation_total: number | string;
  reimbursement_total: number | string;
  deduction_total: number | string;
  net_payment_total: number | string;
  fingerprint: string;
};

export type ApprovalSnapshotLine = {
  line_number: number;
  earning_id: string;
  instructor_id: string;
  instructor_name: string | null;
  client_name: string | null;
  appointment_id: string | null;
  appointment_type: string | null;
  source_type: string;
  earning_date: string;
  gross_revenue_basis: number | string;
  pay_mode: string;
  pay_rate_amount: number | string;
  pay_percentage: number | string;
  attendance_count: number;
  earning_amount: number | string;
  worker_classification_snapshot: string | null;
  accounting_category_snapshot: string | null;
  taxable_compensation_amount: number | string;
  reimbursement_amount: number | string;
  deduction_amount: number | string;
  net_amount: number | string;
  notes: string | null;
};

export type PaymentEvidence = {
  paid_at: string;
  paid_by_name: string | null;
  paid_by_role: string;
  payment_method: string;
  provider_batch_reference: string | null;
};

type PersonName = { first_name: string | null; last_name: string | null };

/** Current-records earning row (only for batches without a snapshot). */
export type LiveEarningRow = {
  id: string;
  earning_date: string;
  source_type: string | null;
  appointment_type: string | null;
  gross_revenue_basis: number | string | null;
  pay_mode: string | null;
  pay_rate_amount: number | string | null;
  pay_percentage: number | string | null;
  attendance_count: number | null;
  earning_amount: number | string | null;
  status: string;
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
  instructors: PersonName | null;
  clients: PersonName | null;
};

export type BatchExportSource =
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; stage: string; message: string }
  | { kind: "live"; batch: BatchExportRow; studio: ExportStudio; period: BatchExportPeriod | null; earnings: LiveEarningRow[] }
  | {
      kind: "legacy";
      batch: BatchExportRow;
      studio: ExportStudio;
      period: BatchExportPeriod | null;
      earnings: LiveEarningRow[];
      payment: PaymentEvidence | null;
    }
  | {
      kind: "snapshot";
      batch: BatchExportRow;
      studio: ExportStudio;
      snapshot: ApprovalSnapshot;
      lines: ApprovalSnapshotLine[];
      payment: PaymentEvidence | null;
    };

type ExportPayload = {
  batch: BatchExportRow;
  studio: ExportStudio | null;
  period: BatchExportPeriod | null;
  snapshot: ApprovalSnapshot | null;
  lines: ApprovalSnapshotLine[] | null;
  payment: PaymentEvidence | null;
  earnings: LiveEarningRow[] | null;
};

export async function loadBatchExportSource(
  supabase: SupabaseClient,
  studioId: string,
  batchId: string,
): Promise<BatchExportSource> {
  const { data, error } = await supabase.rpc("get_payroll_batch_export", {
    p_studio_id: studioId,
    p_batch_id: batchId,
  });
  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("Payroll batch not found")) return { kind: "not_found" };
    if (message.includes("Payroll access denied")) return { kind: "forbidden" };
    return { kind: "error", stage: "load", message };
  }
  const payload = data as ExportPayload | null;
  if (!payload?.batch) return { kind: "not_found" };

  const batch = payload.batch;
  // studios.name is NOT NULL and the batch belongs to the named studio, so a
  // missing studio here is a broken invariant, not something to paper over.
  const studio = payload.studio;
  if (!studio?.name) return { kind: "error", stage: "studio", message: "Export studio is missing." };
  const period = payload.period ?? null;
  const payment = payload.payment ?? null;
  const earnings = payload.earnings ?? [];

  if (!["approved", "paid"].includes(batch.status)) return { kind: "live", batch, studio, period, earnings };
  if (!payload.snapshot) return { kind: "legacy", batch, studio, period, earnings, payment };

  const snapshot = payload.snapshot;
  const lines = payload.lines ?? [];
  if (lines.length !== Number(snapshot.earning_count)) {
    return { kind: "error", stage: "snapshot_lines", message: "Snapshot line count does not match its header." };
  }
  return { kind: "snapshot", batch, studio, snapshot, lines, payment };
}

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Line count and net total (to the cent) of exactly what an export contains. */
export function exportedTotals(lines: Array<{ net: number | string | null | undefined }>) {
  const cents = lines.reduce((sum, line) => sum + Math.round(toNumber(line.net) * 100), 0);
  return { lineCount: lines.length, netPaymentTotal: cents / 100 };
}

export async function recordPayrollExport(
  supabase: SupabaseClient,
  input: { studioId: string; batchId: string; exportType: "csv" | "pdf"; lineCount: number; netPaymentTotal: number },
) {
  const { error } = await supabase.rpc("record_payroll_export", {
    p_studio_id: input.studioId,
    p_batch_id: input.batchId,
    p_export_type: input.exportType,
    p_line_count: input.lineCount,
    p_net_payment_total: input.netPaymentTotal,
  });
  return error ? { ok: false as const, message: error.message } : { ok: true as const };
}

export const LEGACY_EXPORT_NOTICE =
  "This batch was approved before DanceFlow kept immutable approval snapshots. Its figures are read from the current payroll records for this batch.";
