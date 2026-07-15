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

  const [assignedResult, availableResult, batchesResult] = await Promise.all([
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
  ]);

  if (assignedResult.error) throw new Error(`Failed to load assigned earnings: ${assignedResult.error.message}`);
  if (availableResult.error) throw new Error(`Failed to load available earnings: ${availableResult.error.message}`);
  if (batchesResult.error) throw new Error(`Failed to load payroll batches: ${batchesResult.error.message}`);

  const assigned = (assignedResult.data ?? []) as EarningRow[];
  const available = (availableResult.data ?? []) as EarningRow[];
  const batches = batchesResult.data ?? [];
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
