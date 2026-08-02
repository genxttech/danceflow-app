import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canDisbursePayroll, canPreparePayroll } from "@/lib/auth/permissions";
import {
  approvePeriodEarningAction,
  assignSingleEarningAction,
  removeEarningFromPeriodAction,
  voidEmptyPayPeriodAction,
  generateGustoReadinessAction,
  generateGustoTimeSheetPreviewAction,
  sendGustoTimeSheetsAction,
  createMissingGustoDemoJobAction,
  alignPayPeriodToGustoDemoAction,
  initiateGustoPayrollSyncAction,
  refreshGustoPayrollSyncAction,
  refreshGustoTimeSheetStatusesAction,
  approveDeliveredGustoTimeSheetsAction,
} from "./actions";
import {
  assignEarningsToPayPeriodAction,
  createPayrollBatchAction,
} from "../../actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type PeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string | null;
  status: string;
  compensation_total: number | string | null;
  reimbursement_total: number | string | null;
  deduction_total: number | string | null;
  net_payment_total: number | string | null;
};

type EarningRow = {
  id: string;
  instructor_id: string;
  earning_date: string;
  appointment_type: string | null;
  source_type: string;
  status: string;
  taxable_compensation_amount: number | string | null;
  reimbursement_amount: number | string | null;
  deduction_amount: number | string | null;
  earning_amount: number | string | null;
  payroll_batch_id: string | null;
  worker_classification_snapshot: string | null;
  accounting_category_snapshot: string | null;
  notes: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function money(value: number | string | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
}

function name(value: EarningRow["instructors"]) {
  const row = Array.isArray(value) ? value[0] : value;
  return row
    ? `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Instructor"
    : "Instructor";
}

function label(value: string | null | undefined) {
  return (value || "Not set")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function gustoBlockerLabel(code: string) {
  const labels: Record<string, string> = {
    worker_not_matched: "Instructor is not matched to a Gusto worker.",
    contractor_not_supported_in_time_preview:
      "Contractor time-sheet delivery is not supported yet.",
    shift_source_missing:
      "The earning is not linked to a source appointment.",
    gusto_job_missing:
      "The matched Gusto employee does not have an active job.",
    gusto_pay_period_not_aligned:
      "The DanceFlow dates do not align with a Gusto pay period.",
  };

  return labels[code] ?? label(code);
}

function banner(status: string | undefined) {
  if (status === "earning_assigned") return "Earning added to this pay period.";
  if (status === "earning_removed") return "Earning removed from this pay period.";
  if (status === "earning_approved") return "Earning approved and ready for batching.";
  if (status === "missing_earning") return "Choose a valid earning and try again.";
  if (status === "missing_pay_period") return "That pay period could not be identified. Return to Instructor Pay and try again.";
  if (status === "pay_period_not_found") return "That pay period could not be found. It may have been removed or you may no longer have access.";
  if (status === "pay_period_closed") return "This pay period is closed and can no longer be changed.";
  if (status === "earning_not_found") return "That earning could not be found. Refresh the page and try again.";
  if (status === "earning_not_assignable") return "Only pending or approved earnings can be added to a pay period.";
  if (status === "earning_already_batched") return "This earning is already in a payroll batch and can no longer be moved or removed.";
  if (status === "earning_assigned_elsewhere") return "This earning is already assigned to another pay period.";
  if (status === "earning_outside_period") return "This earning falls outside this pay period's dates.";
  if (status === "assigned_earning_not_found") return "That earning is no longer assigned to this pay period.";
  if (status === "earning_not_approvable") return "Only an unbatched pending earning in this pay period can be approved.";
  if (status === "owner_required_to_void") return "Only the studio owner can void a pay period.";
  if (status === "period_not_empty") return "Remove all unbatched earnings before voiding this pay period.";
  if (status === "period_not_voidable") return "Only an open or in-review pay period can be voided.";
  if (status === "payroll_access_denied") return "You do not have permission to complete that payroll action.";
  if (status === "assign_failed") return "The earning could not be added. No payroll records were changed.";
  if (status === "remove_failed") return "The earning could not be removed. No payroll records were changed.";
  if (status === "approve_failed") return "The earning could not be approved. Its status was not changed.";
  if (status === "void_failed") return "The pay period could not be voided. No payroll records were changed.";
  if (status === "gusto_not_connected") return "Connect Gusto before running payroll readiness.";
  if (status === "gusto_readiness_ready") return "Gusto readiness passed. This period is ready for shift preparation.";
  if (status === "gusto_readiness_blocked") return "Gusto readiness found items that need attention before shift preparation.";
  if (status === "gusto_readiness_failed") return "Gusto readiness could not be completed. No payroll data was sent.";
  if (status === "gusto_preview_requires_readiness") return "Run a successful Gusto readiness review before preparing the shift preview.";
  if (status === "gusto_preview_ready") return "Gusto shift preview is ready. No time sheets were sent.";
  if (status === "gusto_preview_blocked") return "The Gusto shift preview found appointment timing issues that need attention.";
  if (status === "gusto_preview_failed") return "The Gusto shift preview could not be prepared. No time sheets were sent.";
  if (status === "gusto_send_confirmation_required") return "Confirm the send action before transmitting time sheets to Gusto.";
  if (status === "gusto_send_requires_ready_preview") return "Prepare a successful, blocker-free shift preview before sending.";
  if (status === "gusto_time_sheets_sent") return "Time sheets were sent to Gusto successfully. Payroll has not been processed.";
  if (status === "gusto_time_sheets_partial") return "Some time sheets were sent, but at least one item needs retry.";
  if (status === "gusto_time_sheets_failed") return "Gusto time sheets could not be sent. Payroll was not processed.";
  if (status === "gusto_time_sheets_already_sent") return "This preview was already sent to Gusto. Duplicate time sheets were prevented.";
  if (status === "gusto_demo_job_created") return "A demo Gusto job was created. Run readiness again to refresh the job snapshot.";
  if (status === "gusto_demo_job_failed") return "The demo Gusto job could not be created. Review the local server error.";
  if (status === "gusto_demo_job_missing_fields") return "The demo job setup information was incomplete.";
  if (status === "gusto_pay_period_aligned") return "This DanceFlow pay period now matches the selected Gusto pay period. Run readiness again.";
  if (status === "gusto_alignment_period_required") return "Select a Gusto pay period to align.";
  if (status === "gusto_alignment_period_locked") return "Only an open or in-review period can be aligned.";
  if (status === "gusto_alignment_batch_exists") return "A period with a payroll batch cannot be realigned.";
  if (status === "gusto_alignment_earning_outside") return "At least one assigned earning falls outside the selected Gusto date range.";
  if (status === "gusto_alignment_overlap") return "The selected Gusto range overlaps another active DanceFlow pay period.";
  if (status === "gusto_alignment_failed") return "The DanceFlow period could not be aligned. No dates were changed.";
  if (status === "gusto_payroll_sync_confirmation_required") return "Confirm the payroll-sync action before copying Gusto time sheets into payroll.";
  if (status === "gusto_payroll_sync_requires_delivery") return "A successful, complete time-sheet delivery is required before payroll sync.";
  if (status === "gusto_payroll_sync_period_missing") return "The matching Gusto pay schedule or pay period could not be found. Run readiness again.";
  if (status === "gusto_payroll_sync_already_started") return "Payroll sync has already been started for this time-sheet delivery.";
  if (status === "gusto_payroll_sync_started") return "Gusto accepted the payroll sync and is processing it asynchronously.";
  if (status === "gusto_payroll_sync_refreshed") return "The latest Gusto payroll-sync status was retrieved.";
  if (status === "gusto_payroll_sync_completed") return "Gusto completed the payroll sync. Review and process payroll inside Gusto.";
  if (status === "gusto_payroll_sync_failed") return "The Gusto payroll sync failed. Payroll was not submitted.";
  if (status === "gusto_payroll_sync_not_found") return "No Gusto payroll sync exists for this pay period.";
  if (status === "gusto_payroll_sync_refresh_failed") return "The Gusto payroll-sync status could not be refreshed.";
  if (status === "gusto_payroll_sync_requires_approved_time") return "All delivered Gusto time sheets must be approved before payroll sync.";
  if (status === "gusto_payroll_sync_payroll_missing") return "Gusto does not have an unprocessed regular payroll for this exact pay-period range.";
  if (status === "gusto_payroll_sync_worker_not_eligible") return "The delivered employee is not eligible for the matching Gusto payroll. The demo employee may not be fully onboarded or assigned to that pay schedule.";
  if (status === "gusto_payroll_sync_no_eligible_hours") return "Gusto found no payroll-eligible hours for this period even though the delivered time sheet is approved. This is a Gusto demo eligibility/provisioning limitation, not an approval failure.";
  if (status === "gusto_time_sheet_statuses_refreshed") return "The latest Gusto time-sheet approval statuses were retrieved.";
  if (status === "gusto_time_sheet_status_not_found") return "No delivered Gusto time sheets were found for this pay period.";
  if (status === "gusto_time_sheet_status_refresh_failed") return "Gusto time-sheet statuses could not be refreshed.";
  if (status === "gusto_time_sheet_approval_confirmation_required") return "Confirm approval before changing Gusto time-sheet status.";
  if (status === "gusto_time_sheets_approved") return "The delivered Gusto time sheets were approved and are ready for payroll sync.";
  if (status === "gusto_time_sheet_approval_failed") return "The delivered time sheets could not be approved in Gusto.";
  return null;
}

export default async function PayrollPeriodPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!studioId || !canPreparePayroll(role)) redirect("/app");
  const canVoid = canDisbursePayroll(role);

  const { data: periodData, error: periodError } = await supabase
    .from("payroll_pay_periods")
    .select("id, period_start, period_end, pay_date, status, compensation_total, reimbursement_total, deduction_total, net_payment_total")
    .eq("id", id)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (periodError) throw new Error(`Failed to load pay period: ${periodError.message}`);
  if (!periodData) notFound();
  const period = periodData as PeriodRow;

  const [assignedResult, availableResult, batchesResult, gustoReadinessResult, gustoPreviewResult, gustoTransmissionResult, gustoConnectionResult, gustoPeriodsResult, gustoPayrollSyncResult, gustoTimeSheetItemsResult] = await Promise.all([
    supabase
      .from("instructor_earnings")
      .select("id, instructor_id, earning_date, appointment_type, source_type, status, taxable_compensation_amount, reimbursement_amount, deduction_amount, earning_amount, payroll_batch_id, worker_classification_snapshot, accounting_category_snapshot, notes, instructors(first_name, last_name)")
      .eq("studio_id", studioId)
      .eq("pay_period_id", id)
      .order("earning_date", { ascending: true }),
    supabase
      .from("instructor_earnings")
      .select("id, instructor_id, earning_date, appointment_type, source_type, status, taxable_compensation_amount, reimbursement_amount, deduction_amount, earning_amount, payroll_batch_id, worker_classification_snapshot, accounting_category_snapshot, notes, instructors(first_name, last_name)")
      .eq("studio_id", studioId)
      .is("pay_period_id", null)
      .is("payroll_batch_id", null)
      .in("status", ["pending", "approved"])
      .gte("earning_date", period.period_start)
      .lte("earning_date", period.period_end)
      .order("earning_date", { ascending: true }),
    supabase
      .from("payroll_batches")
      .select("id, batch_number, provider, status, earning_count, net_payment_total")
      .eq("studio_id", studioId)
      .eq("pay_period_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("studio_gusto_readiness_reviews")
      .select("id, status, earning_count, ready_count, blocker_count, reviewed_at, studio_gusto_readiness_items(id, earning_id, instructor_id, gusto_worker_uuid, gusto_job_uuid, readiness_status, blocker_codes, details)")
      .eq("studio_id", studioId)
      .eq("pay_period_id", id)
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("studio_gusto_time_sheet_previews")
      .select("id, status, shift_count, ready_count, blocker_count, total_hours, time_zone, prepared_at")
      .eq("studio_id", studioId)
      .eq("pay_period_id", id)
      .order("prepared_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("studio_gusto_time_sheet_transmissions")
      .select("id, preview_id, status, item_count, sent_count, failed_count, skipped_count, initiated_at, completed_at, last_error")
      .eq("studio_id", studioId)
      .eq("pay_period_id", id)
      .order("initiated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("studio_gusto_connections")
      .select("id, environment, status")
      .eq("studio_id", studioId)
      .maybeSingle(),
    supabase
      .from("studio_gusto_pay_periods")
      .select("id, period_start, period_end, pay_date")
      .eq("studio_id", studioId)
      .order("period_start", { ascending: false })
      .limit(24),
    supabase
      .from("studio_gusto_payroll_syncs")
      .select("id, status, gusto_payroll_sync_uuid, gusto_payroll_uuid, initiated_at, last_checked_at, completed_at, last_error")
      .eq("studio_id", studioId)
      .eq("pay_period_id", id)
      .order("initiated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("studio_gusto_time_sheet_transmission_items")
      .select("id, status, gusto_time_sheet_uuid, gusto_response, studio_gusto_time_sheet_transmissions!inner(pay_period_id)")
      .eq("studio_id", studioId)
      .eq("studio_gusto_time_sheet_transmissions.pay_period_id", id),
  ]);

  if (assignedResult.error) throw new Error(`Failed to load assigned earnings: ${assignedResult.error.message}`);
  if (availableResult.error) throw new Error(`Failed to load available earnings: ${availableResult.error.message}`);
  if (batchesResult.error) throw new Error(`Failed to load payroll batches: ${batchesResult.error.message}`);
  if (gustoReadinessResult.error) throw new Error(`Failed to load Gusto readiness: ${gustoReadinessResult.error.message}`);
  if (gustoPreviewResult.error) throw new Error(`Failed to load Gusto preview: ${gustoPreviewResult.error.message}`);
  if (gustoTransmissionResult.error) throw new Error(`Failed to load Gusto transmission: ${gustoTransmissionResult.error.message}`);
  if (gustoConnectionResult.error) throw new Error(`Failed to load Gusto connection: ${gustoConnectionResult.error.message}`);
  if (gustoPeriodsResult.error) throw new Error(`Failed to load Gusto pay periods: ${gustoPeriodsResult.error.message}`);
  if (gustoPayrollSyncResult.error) throw new Error(`Failed to load Gusto payroll sync: ${gustoPayrollSyncResult.error.message}`);
  if (gustoTimeSheetItemsResult.error) throw new Error(`Failed to load Gusto time-sheet statuses: ${gustoTimeSheetItemsResult.error.message}`);

  const assigned = (assignedResult.data ?? []) as EarningRow[];
  const available = (availableResult.data ?? []) as EarningRow[];
  const batches = batchesResult.data ?? [];
  const gustoReadiness = gustoReadinessResult.data;
  const gustoReadinessItems =
    gustoReadiness?.studio_gusto_readiness_items ?? [];
  const gustoBlockedItems = gustoReadinessItems.filter(
    (item) =>
      item.readiness_status === "blocked" ||
      (item.blocker_codes?.length ?? 0) > 0,
  );
  const gustoPreview = gustoPreviewResult.data;
  const gustoTransmission = gustoTransmissionResult.data;
  const gustoConnection = gustoConnectionResult.data;
  const gustoPeriods = gustoPeriodsResult.data ?? [];
  const gustoPayrollSync = gustoPayrollSyncResult.data;
  const gustoTimeSheetItems = gustoTimeSheetItemsResult.data ?? [];
  const gustoTimeSheetStatusCounts = gustoTimeSheetItems.reduce(
    (counts: { approved: number; pending: number; rejected: number }, item) => {
      const response =
        item.gusto_response && typeof item.gusto_response === "object"
          ? (item.gusto_response as { status?: string })
          : {};
      const status = String(response.status ?? "pending").toLowerCase();

      if (status === "approved") counts.approved += 1;
      else if (status === "rejected") counts.rejected += 1;
      else counts.pending += 1;

      return counts;
    },
    { approved: 0, pending: 0, rejected: 0 },
  );
  const allGustoTimeSheetsApproved =
    gustoTimeSheetItems.length > 0 &&
    gustoTimeSheetStatusCounts.approved === gustoTimeSheetItems.length;
  const isGustoDemo = gustoConnection?.environment === "demo";
  const pending = assigned.filter((earning) => earning.status === "pending" && !earning.payroll_batch_id);
  const approved = assigned.filter((earning) => earning.status === "approved" && !earning.payroll_batch_id);
  const batched = assigned.filter((earning) => Boolean(earning.payroll_batch_id));
  const incompleteClassification = assigned.filter(
    (earning) => !earning.worker_classification_snapshot || earning.worker_classification_snapshot === "not_set",
  );
  const missingCategory = assigned.filter((earning) => !earning.accounting_category_snapshot);
  const readyForBatch = approved.length > 0 && incompleteClassification.length === 0 && missingCategory.length === 0;
  const editable = ["open", "in_review"].includes(period.status);
  const message = banner(one(query.status));

  const instructorTotals = new Map<string, { name: string; net: number; count: number }>();
  for (const earning of assigned.filter((item) => item.status !== "void")) {
    const current = instructorTotals.get(earning.instructor_id) ?? {
      name: name(earning.instructors),
      net: 0,
      count: 0,
    };
    current.net +=
      Number(earning.taxable_compensation_amount ?? 0) +
      Number(earning.reimbursement_amount ?? 0) -
      Number(earning.deduction_amount ?? 0);
    current.count += 1;
    instructorTotals.set(earning.instructor_id, current);
  }

  return (
    <div className="max-w-7xl space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <Link href="/app/instructor-pay" className="text-sm font-semibold text-violet-700 hover:text-violet-900">
          ← Instructor Pay
        </Link>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Payroll workspace</p>
            <h1 className="mt-2 text-3xl font-bold text-slate-950">
              {dateLabel(period.period_start)} – {dateLabel(period.period_end)}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              Pay date: {dateLabel(period.pay_date)} · Status: {label(period.status)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/app/instructor-pay/export?payPeriodId=${period.id}`}
              className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-800"
            >
              Export period CSV
            </Link>
            {canVoid && editable && assigned.length === 0 && batches.length === 0 ? (
              <form action={voidEmptyPayPeriodAction} className="flex gap-2">
                <input type="hidden" name="payPeriodId" value={period.id} />
                <input name="reason" placeholder="Reason" className="w-40 rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                <button className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700">
                  Void period
                </button>
              </form>
            ) : null}
          </div>
        </div>
        {message ? <div className="mt-5 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{message}</div> : null}
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <Metric label="Compensation" value={money(period.compensation_total)} />
        <Metric label="Reimbursements" value={money(period.reimbursement_total)} />
        <Metric label="Deductions" value={money(period.deduction_total)} />
        <Metric label="Net payment" value={money(period.net_payment_total)} strong />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Payroll readiness</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Readiness label="Pending review" value={pending.length} tone={pending.length ? "warning" : "good"} />
            <Readiness label="Ready to batch" value={approved.length} tone={approved.length ? "good" : "neutral"} />
            <Readiness label="Already batched" value={batched.length} tone="neutral" />
          </div>
          <div className="mt-4 space-y-2 text-sm">
            {incompleteClassification.length ? <Warning>{incompleteClassification.length} earning(s) need a valid worker classification snapshot.</Warning> : null}
            {missingCategory.length ? <Warning>{missingCategory.length} earning(s) are missing an accounting category.</Warning> : null}
            {!pending.length && !approved.length && assigned.length ? <p className="text-slate-600">All assigned earnings are already batched or closed.</p> : null}
            {!assigned.length ? <p className="text-slate-600">No earnings have been assigned to this period yet.</p> : null}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Next action</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {pending.length
              ? `Review and approve ${pending.length} pending earning${pending.length === 1 ? "" : "s"}.`
              : approved.length
                ? "Approved earnings are ready for a payroll batch."
                : available.length
                  ? "Add the eligible earnings waiting for this period."
                  : "This period has no remaining payroll work."}
          </p>
          {editable ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {available.length ? (
                <form action={assignEarningsToPayPeriodAction}>
                  <input type="hidden" name="payPeriodId" value={period.id} />
                  <button className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800">
                    Add all eligible earnings
                  </button>
                </form>
              ) : null}
              {readyForBatch ? (
                <form action={createPayrollBatchAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="payPeriodId" value={period.id} />
                  <select name="provider" defaultValue="manual" className="rounded-2xl border border-slate-200 px-3 py-2 text-sm">
                    <option value="manual">Provider-neutral CSV</option>
                    <option value="gusto">Gusto-formatted label</option>
                    <option value="quickbooks_payroll">QuickBooks Payroll label</option>
                    <option value="adp">ADP label</option>
                  </select>
                  <button className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white">Create payroll batch</button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-3xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-orange-50 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Gusto readiness</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {gustoReadiness ? `${label(gustoReadiness.status)} · ${gustoReadiness.ready_count}/${gustoReadiness.earning_count} ready` : "Review this period before sending time"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This checks worker matches, employee jobs, appointment-backed shifts, and Gusto pay-period alignment. It does not create time sheets or alter payroll.
            </p>
            {gustoReadiness?.blocker_count ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-semibold text-amber-800">
                  {gustoReadiness.blocker_count} earning
                  {gustoReadiness.blocker_count === 1 ? "" : "s"} need attention.
                </p>
                <div className="space-y-2">
                  {gustoBlockedItems.map((item) => {
                    const earning = assigned.find(
                      (row) => row.id === item.earning_id,
                    );

                    return (
                      <div
                        key={item.id}
                        className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
                      >
                        <p className="text-sm font-semibold text-slate-950">
                          {earning
                            ? `${name(earning.instructors)} · ${dateLabel(earning.earning_date)}`
                            : "Payroll earning"}
                        </p>
                        <ul className="mt-2 space-y-1 text-sm text-amber-900">
                          {((item.blocker_codes ?? []) as string[]).map(
                            (code: string) => (
                              <li key={code}>• {gustoBlockerLabel(code)}</li>
                            ),
                          )}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <form action={generateGustoReadinessAction}>
            <input type="hidden" name="payPeriodId" value={period.id} />
            <button className="rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-violet-800">
              {gustoReadiness ? "Run readiness again" : "Check Gusto readiness"}
            </button>
          </form>
        </div>
      </section>

      {isGustoDemo && gustoReadiness?.status === "blocked" ? (
        <section className="rounded-3xl border border-dashed border-violet-300 bg-violet-50/60 p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
            Demo setup helper
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Resolve the demo-only blockers
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            These controls are available only for the Gusto demo environment. They create the missing test job and safely align this open DanceFlow period to a synced Gusto date range.
          </p>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {gustoBlockedItems.some((item) =>
              (item.blocker_codes ?? []).includes("gusto_job_missing"),
            ) ? (
              <form action={createMissingGustoDemoJobAction} className="rounded-2xl border border-violet-200 bg-white p-4">
                {(() => {
                  const blockedItem = gustoBlockedItems.find((item) =>
                    (item.blocker_codes ?? []).includes("gusto_job_missing"),
                  );
                  const earning = assigned.find(
                    (row) => row.id === blockedItem?.earning_id,
                  );
                  return (
                    <>
                      <input type="hidden" name="payPeriodId" value={period.id} />
                      <p className="font-semibold text-slate-950">Create active demo job</p>
                      <p className="mt-1 text-sm text-slate-600">
                        Creates a Gusto job for {earning ? name(earning.instructors) : "the matched employee"} using the earning date as the hire date.
                      </p>
                      <button className="mt-4 rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white">
                        Create demo Gusto job
                      </button>
                    </>
                  );
                })()}
              </form>
            ) : (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                The matched employee has an active Gusto job.
              </div>
            )}

            {(gustoBlockedItems.some((item) =>
              (item.blocker_codes ?? []).includes("gusto_pay_period_not_aligned"),
            ) || period.period_start !== gustoPeriods[0]?.period_start) ? (
              <form action={alignPayPeriodToGustoDemoAction} className="rounded-2xl border border-orange-200 bg-white p-4">
                <input type="hidden" name="payPeriodId" value={period.id} />
                <p className="font-semibold text-slate-950">Align DanceFlow dates</p>
                <p className="mt-1 text-sm text-slate-600">
                  Choose a synced Gusto range that contains every earning currently assigned to this period.
                </p>
                <select
                  name="gustoPayPeriodId"
                  defaultValue=""
                  className="mt-4 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm"
                  required
                >
                  <option value="" disabled>Select a Gusto pay period</option>
                  {gustoPeriods.map((gustoPeriod) => (
                    <option key={gustoPeriod.id} value={gustoPeriod.id}>
                      {dateLabel(gustoPeriod.period_start)} – {dateLabel(gustoPeriod.period_end)}
                      {gustoPeriod.pay_date ? ` · Pay ${dateLabel(gustoPeriod.pay_date)}` : ""}
                    </option>
                  ))}
                </select>
                <button className="mt-3 rounded-2xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white">
                  Align this DanceFlow period
                </button>
              </form>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="rounded-3xl border border-orange-200 bg-gradient-to-br from-orange-50 via-white to-violet-50 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">Gusto shift preview</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {gustoPreview
                ? `${label(gustoPreview.status)} · ${gustoPreview.ready_count}/${gustoPreview.shift_count} shifts ready`
                : "Prepare the shift-level payload"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This converts approved appointment-backed earnings into shift-level Gusto time-sheet payloads with regular-hour classification. It stores a preview only and does not transmit time or modify payroll.
            </p>
            {gustoPreview ? (
              <p className="mt-3 text-sm font-semibold text-slate-700">
                {Number(gustoPreview.total_hours ?? 0).toFixed(2)} hours · {gustoPreview.time_zone}
                {gustoPreview.blocker_count ? ` · ${gustoPreview.blocker_count} blocked` : ""}
              </p>
            ) : null}
          </div>
          <form action={generateGustoTimeSheetPreviewAction}>
            <input type="hidden" name="payPeriodId" value={period.id} />
            <button
              disabled={gustoReadiness?.status !== "ready" || Boolean(gustoReadiness?.blocker_count)}
              className="rounded-2xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {gustoPreview ? "Prepare preview again" : "Prepare shift preview"}
            </button>
          </form>
        </div>
      </section>

      <section className="rounded-3xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-orange-50 p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Send to Gusto</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {gustoTransmission
                ? `${label(gustoTransmission.status)} · ${gustoTransmission.sent_count} sent`
                : "Transmit the validated shifts"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This sends the latest blocker-free preview as Gusto time sheets. It does not sync the pay period to payroll, calculate payroll, submit payroll, or mark DanceFlow earnings paid.
            </p>
            {gustoTransmission ? (
              <p className="mt-3 text-sm font-semibold text-slate-700">
                {gustoTransmission.item_count} items · {gustoTransmission.failed_count} failed · {gustoTransmission.skipped_count} duplicate-protected
              </p>
            ) : null}
            {gustoTransmission?.last_error ? (
              <p className="mt-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {gustoTransmission.last_error}
              </p>
            ) : null}
          </div>

          <form action={sendGustoTimeSheetsAction} className="w-full max-w-sm space-y-3 rounded-2xl border border-violet-200 bg-white p-4">
            <input type="hidden" name="payPeriodId" value={period.id} />
            <label className="flex items-start gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                name="confirmation"
                value="send"
                className="mt-1 h-4 w-4 rounded border-slate-300 text-violet-700"
              />
              <span>I reviewed the shift preview and authorize DanceFlow to send these time sheets to Gusto.</span>
            </label>
            <button
              disabled={
                !gustoPreview ||
                gustoPreview.status !== "ready" ||
                Boolean(gustoPreview.blocker_count) ||
                gustoTransmission?.status === "succeeded"
              }
              className="w-full rounded-2xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {gustoTransmission?.status === "succeeded"
                ? "Time sheets sent"
                : gustoTransmission && ["partial", "failed"].includes(gustoTransmission.status)
                  ? "Retry unsent time sheets"
                  : "Send time sheets to Gusto"}
            </button>
          </form>
        </div>
      </section>

      {gustoTransmission?.status === "succeeded" ? (
        <section className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-indigo-50 p-6 shadow-sm">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                Gusto time-sheet approval
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                {allGustoTimeSheetsApproved
                  ? "All delivered time sheets are approved"
                  : "Approval is required before payroll sync"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Gusto payroll sync consumes approved time sheets only. DanceFlow reads the current Gusto status and blocks payroll sync while any item remains pending or rejected.
              </p>
              <p className="mt-3 text-sm font-semibold text-slate-700">
                {gustoTimeSheetStatusCounts.approved} approved · {gustoTimeSheetStatusCounts.pending} pending · {gustoTimeSheetStatusCounts.rejected} rejected
              </p>
            </div>

            <div className="w-full max-w-sm space-y-3">
              <form action={refreshGustoTimeSheetStatusesAction}>
                <input type="hidden" name="payPeriodId" value={period.id} />
                <button className="w-full rounded-2xl border border-emerald-200 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-800">
                  Refresh Gusto statuses
                </button>
              </form>

              {!allGustoTimeSheetsApproved ? (
                <form action={approveDeliveredGustoTimeSheetsAction} className="space-y-3 rounded-2xl border border-emerald-200 bg-white p-4">
                  <input type="hidden" name="payPeriodId" value={period.id} />
                  <label className="flex items-start gap-3 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      name="confirmation"
                      value="approve"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-700"
                    />
                    <span>I reviewed the delivered shifts and authorize DanceFlow to approve them in Gusto.</span>
                  </label>
                  <button className="w-full rounded-2xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white">
                    Approve delivered time sheets
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-3xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">
              Gusto payroll sync
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {gustoPayrollSync
                ? `${label(gustoPayrollSync.status)}`
                : "Copy delivered hours into Gusto payroll"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This asynchronous step applies the successfully delivered time sheets to the matching Gusto payroll. It does not calculate, submit, or process payroll, and it does not mark DanceFlow earnings paid.
            </p>
            {gustoPayrollSync ? (
              <div className="mt-3 space-y-1 text-sm text-slate-700">
                <p>
                  Sync ID: <span className="font-mono text-xs">{gustoPayrollSync.gusto_payroll_sync_uuid}</span>
                </p>
                {gustoPayrollSync.gusto_payroll_uuid ? (
                  <p>
                    Payroll ID: <span className="font-mono text-xs">{gustoPayrollSync.gusto_payroll_uuid}</span>
                  </p>
                ) : null}
                {gustoPayrollSync.last_checked_at ? (
                  <p>Last checked: {dateLabel(gustoPayrollSync.last_checked_at)}</p>
                ) : null}
              </div>
            ) : null}
            {gustoPayrollSync?.last_error ? (
              <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {gustoPayrollSync.last_error}
              </p>
            ) : null}
          </div>

          <div className="w-full max-w-sm space-y-3">
            {!gustoPayrollSync ? (
              <form action={initiateGustoPayrollSyncAction} className="space-y-3 rounded-2xl border border-indigo-200 bg-white p-4">
                <input type="hidden" name="payPeriodId" value={period.id} />
                <label className="flex items-start gap-3 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="confirmation"
                    value="sync"
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-700"
                  />
                  <span>I authorize DanceFlow to copy the delivered time sheets into the matching Gusto payroll.</span>
                </label>
                <button
                  disabled={
                    gustoTransmission?.status !== "succeeded" ||
                    !allGustoTimeSheetsApproved
                  }
                  className="w-full rounded-2xl bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Sync hours to Gusto payroll
                </button>
              </form>
            ) : (
              <form action={refreshGustoPayrollSyncAction}>
                <input type="hidden" name="payPeriodId" value={period.id} />
                <button
                  disabled={["completed", "failed", "cancelled"].includes(gustoPayrollSync.status)}
                  className="w-full rounded-2xl border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Refresh payroll-sync status
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">Instructor totals</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[...instructorTotals.values()].map((item) => (
            <div key={item.name} className="rounded-2xl border border-slate-200 p-4">
              <p className="font-semibold text-slate-950">{item.name}</p>
              <p className="mt-1 text-sm text-slate-500">{item.count} earning{item.count === 1 ? "" : "s"}</p>
              <p className="mt-2 text-xl font-bold text-slate-950">{money(item.net)}</p>
            </div>
          ))}
          {!instructorTotals.size ? <p className="text-sm text-slate-500">Instructor totals will appear after earnings are assigned.</p> : null}
        </div>
      </section>

      <EarningSection
        title="Assigned earnings"
        description="Review, approve, or remove unbatched earnings in this pay period."
        earnings={assigned}
        payPeriodId={period.id}
        editable={editable}
        assigned
      />

      <EarningSection
        title="Eligible earnings not yet assigned"
        description="These earnings fall inside the period dates and are not assigned elsewhere."
        earnings={available}
        payPeriodId={period.id}
        editable={editable}
        assigned={false}
      />

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">Payroll batches</h2>
        <p className="mt-1 text-sm text-slate-600">Provider names describe the intended export workflow. DanceFlow does not transmit payroll to those providers in this version.</p>
        <div className="mt-4 space-y-3">
          {batches.map((batch) => (
            <div key={batch.id} className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold text-slate-950">Batch #{batch.batch_number} · {label(batch.provider)}</p>
                <p className="text-sm text-slate-500">{batch.earning_count} earnings · {money(batch.net_payment_total)} · {label(batch.status)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/app/instructor-pay/batches/${batch.id}/pdf`}
                  className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800"
                >
                  Payroll packet PDF
                </Link>
                <Link
                  href={`/app/instructor-pay/export?batchId=${batch.id}`}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700"
                >
                  Detailed CSV
                </Link>
              </div>
            </div>
          ))}
          {!batches.length ? <p className="text-sm text-slate-500">No payroll batches have been created for this period.</p> : null}
        </div>
      </section>
    </div>
  );
}

function Metric({ label: text, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`rounded-3xl border p-5 shadow-sm ${strong ? "border-violet-200 bg-violet-50" : "border-slate-200 bg-white"}`}><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{text}</p><p className="mt-2 text-2xl font-bold text-slate-950">{value}</p></div>;
}

function Readiness({ label: text, value, tone }: { label: string; value: number; tone: "good" | "warning" | "neutral" }) {
  const classes = tone === "good" ? "border-emerald-200 bg-emerald-50" : tone === "warning" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50";
  return <div className={`rounded-2xl border p-4 ${classes}`}><p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{text}</p><p className="mt-2 text-2xl font-bold text-slate-950">{value}</p></div>;
}

function Warning({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">{children}</p>;
}

function EarningSection({
  title,
  description,
  earnings,
  payPeriodId,
  editable,
  assigned,
}: {
  title: string;
  description: string;
  earnings: EarningRow[];
  payPeriodId: string;
  editable: boolean;
  assigned: boolean;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <div className="mt-4 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200">
        {earnings.map((earning) => (
          <div key={earning.id} className="grid gap-4 p-4 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold text-slate-950">{name(earning.instructors)}</p>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{label(earning.status)}</span>
                <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700">{label(earning.worker_classification_snapshot)}</span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{dateLabel(earning.earning_date)} · {label(earning.appointment_type || earning.source_type)}</p>
              <p className="mt-1 text-sm font-semibold text-slate-950">Net {money(Number(earning.taxable_compensation_amount ?? 0) + Number(earning.reimbursement_amount ?? 0) - Number(earning.deduction_amount ?? 0))}</p>
              {earning.notes ? <p className="mt-1 text-xs text-slate-500">{earning.notes}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              {editable && assigned && earning.status === "pending" && !earning.payroll_batch_id ? (
                <form action={approvePeriodEarningAction}>
                  <input type="hidden" name="payPeriodId" value={payPeriodId} />
                  <input type="hidden" name="earningId" value={earning.id} />
                  <button className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white">Approve</button>
                </form>
              ) : null}
              {editable && assigned && !earning.payroll_batch_id ? (
                <form action={removeEarningFromPeriodAction}>
                  <input type="hidden" name="payPeriodId" value={payPeriodId} />
                  <input type="hidden" name="earningId" value={earning.id} />
                  <button className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">Remove</button>
                </form>
              ) : null}
              {editable && !assigned ? (
                <form action={assignSingleEarningAction}>
                  <input type="hidden" name="payPeriodId" value={payPeriodId} />
                  <input type="hidden" name="earningId" value={earning.id} />
                  <button className="rounded-xl bg-indigo-700 px-3 py-2 text-xs font-semibold text-white">Add to period</button>
                </form>
              ) : null}
              {earning.payroll_batch_id ? <span className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">Locked in batch</span> : null}
            </div>
          </div>
        ))}
        {!earnings.length ? <div className="p-5 text-sm text-slate-500">Nothing to show here.</div> : null}
      </div>
    </section>
  );
}
