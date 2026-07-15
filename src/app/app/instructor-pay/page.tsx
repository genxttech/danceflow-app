import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canDisbursePayroll, canPreparePayroll } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  createInstructorAdjustmentAction,
  generateInstructorEarningsAction,
  overrideInstructorEarningAction,
  saveInstructorCompensationRuleAction,
  saveInstructorPayrollProfileAction,
  updateInstructorEarningStatusAction,
} from "./actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
};

type RuleRow = {
  id: string;
  instructor_id: string;
  private_lesson_pay_mode: string;
  private_lesson_flat_amount: number | string | null;
  private_lesson_percentage: number | string | null;
  private_lesson_duration_rates_enabled?: boolean | null;
  private_lesson_30_min_flat_amount?: number | string | null;
  private_lesson_45_min_flat_amount?: number | string | null;
  private_lesson_60_min_flat_amount?: number | string | null;
  group_class_pay_mode: string;
  group_class_flat_amount: number | string | null;
  group_class_percentage: number | string | null;
  group_class_per_attendee_amount: number | string | null;
  notes: string | null;
};


type PayrollProfileRow = {
  id: string;
  instructor_id: string;
  worker_classification: "not_set" | "contractor" | "employee" | "owner";
  payroll_active: boolean;
  external_payroll_id: string | null;
  payroll_notes: string | null;
};

type EarningRow = {
  id: string;
  instructor_id: string;
  appointment_id: string | null;
  client_id: string | null;
  earning_date: string;
  source_type: string;
  appointment_type: string | null;
  gross_revenue_basis: number | string | null;
  pay_mode: string;
  pay_rate_amount: number | string | null;
  pay_percentage: number | string | null;
  attendance_count: number | null;
  earning_amount: number | string | null;
  status: string;
  notes: string | null;
  paid_at: string | null;
  payment_method: string | null;
  adjustment_type?: string | null;
  override_reason?: string | null;
  instructors?: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
  clients?: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
};

function formatCurrency(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function labelForAppointmentType(value: string | null | undefined) {
  if (value === "private_lesson") return "Private lesson";
  if (value === "intro_lesson") return "Intro lesson";
  if (value === "coaching") return "Coaching";
  if (value === "group_class") return "Group class";
  if (value === "practice_party") return "Practice party";
  return "Lesson or class";
}

function labelForPayMode(value: string) {
  if (value === "flat") return "Flat rate";
  if (value === "percentage") return "Percentage";
  if (value === "per_attendee") return "Per attendee";
  if (value === "manual_adjustment") return "Manual adjustment";
  if (value === "manual_override") return "Manual override";
  return "Not configured";
}

function statusClass(value: string) {
  if (value === "paid") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (value === "approved") return "bg-blue-50 text-blue-700 ring-blue-200";
  if (value === "void") return "bg-slate-100 text-slate-600 ring-slate-200";
  return "bg-amber-50 text-amber-700 ring-amber-200";
}

function ruleIsConfigured(rule: RuleRow | undefined) {
  if (!rule) return false;
  return rule.private_lesson_pay_mode !== "none" || rule.group_class_pay_mode !== "none";
}

function sourceSummary(earning: EarningRow) {
  if (earning.source_type === "manual_adjustment") {
    return earning.notes || "Manual adjustment added from Instructor Pay.";
  }
  if (earning.pay_mode === "manual_override") {
    return earning.override_reason ? `Manually overridden: ${earning.override_reason}` : "This earning was manually overridden.";
  }
  if (earning.pay_mode === "flat") {
    return `Created from a completed ${labelForAppointmentType(earning.appointment_type).toLowerCase()} using a flat-rate rule.`;
  }
  if (earning.pay_mode === "percentage") {
    return `Created from a completed ${labelForAppointmentType(earning.appointment_type).toLowerCase()} using ${Number(earning.pay_percentage ?? 0)}% of the lesson or class value.`;
  }
  if (earning.pay_mode === "per_attendee") {
    return `Created from a completed ${labelForAppointmentType(earning.appointment_type).toLowerCase()} using ${earning.attendance_count ?? 0} attended student${Number(earning.attendance_count ?? 0) === 1 ? "" : "s"}.`;
  }
  return "Created from a completed lesson or class using the instructor compensation rule.";
}

function instructorName(instructor: InstructorRow | Pick<InstructorRow, "first_name" | "last_name">) {
  return `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim() || "Instructor";
}

function relationName(value: EarningRow["instructors"]) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row) return "Instructor";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Instructor";
}

function clientRelationName(value: EarningRow["clients"]) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row) return "—";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "—";
}

function stringParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function statusMessage(status: string | undefined, params: Record<string, string | string[] | undefined>) {
  if (!status) return null;
  if (status === "rule_saved") return "Instructor compensation rule saved.";
  if (status === "payroll_profile_saved") return "Instructor payroll profile saved.";
  if (status === "worker_classification_required") return "Set the instructor worker classification before staging compensation.";
  if (status === "payroll_profile_inactive") return "This instructor is not active for payroll.";
  if (status === "adjustment_created") return "Manual adjustment added for review.";
  if (status === "override_saved") return "Instructor earning override saved.";
  if (status === "earning_updated") return "Instructor earning updated.";
  if (status === "earning_locked") return "This earning is already paid or voided, so it cannot be changed from this page.";
  if (status === "earning_unchanged") return "This earning already has that status.";
  if (status === "earnings_generated") {
    const scanned = stringParam(params, "scanned") ?? "0";
    const staged = stringParam(params, "staged") ?? "0";
    const skipped = stringParam(params, "skipped") ?? "0";
    return `Earnings review complete. Scanned ${scanned}, staged ${staged}, skipped ${skipped}.`;
  }
  if (status.includes("failed") || status.includes("missing") || status.includes("invalid")) {
    return "Something needs attention. Review the form and try again.";
  }
  return null;
}

export default async function InstructorPayPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canPreparePayroll(role)) redirect("/app");
  const canMarkPaid = canDisbursePayroll(role);

  const statusFilter = stringParam(params, "statusFilter") ?? "all";
  const instructorFilter = stringParam(params, "instructorId") ?? "all";

  let earningsQuery = supabase
    .from("instructor_earnings")
    .select("id, instructor_id, appointment_id, client_id, earning_date, source_type, appointment_type, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, status, notes, paid_at, payment_method, adjustment_type, override_reason, instructors(first_name, last_name), clients(first_name, last_name)")
    .eq("studio_id", studioId)
    .order("earning_date", { ascending: false })
    .limit(500);

  if (["pending", "approved", "paid", "void"].includes(statusFilter)) {
    earningsQuery = earningsQuery.eq("status", statusFilter);
  }

  if (instructorFilter !== "all") {
    earningsQuery = earningsQuery.eq("instructor_id", instructorFilter);
  }

  const [instructorsResult, rulesResult, payrollProfilesResult, earningsResult] =
    await Promise.all([
    supabase
      .from("instructors")
      .select("id, first_name, last_name, active")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true }),
    supabase
      .from("instructor_compensation_rules")
      .select("id, instructor_id, private_lesson_pay_mode, private_lesson_flat_amount, private_lesson_percentage, private_lesson_duration_rates_enabled, private_lesson_30_min_flat_amount, private_lesson_45_min_flat_amount, private_lesson_60_min_flat_amount, group_class_pay_mode, group_class_flat_amount, group_class_percentage, group_class_per_attendee_amount, notes")
      .eq("studio_id", studioId),
    supabase
      .from("instructor_payroll_profiles")
      .select("id, instructor_id, worker_classification, payroll_active, external_payroll_id, payroll_notes")
      .eq("studio_id", studioId),
    earningsQuery,
  ]);

  if (instructorsResult.error) {
    throw new Error(`Failed to load instructors: ${instructorsResult.error.message}`);
  }

  if (rulesResult.error) {
    throw new Error(`Failed to load compensation rules: ${rulesResult.error.message}`);
  }

  if (payrollProfilesResult.error) {
    throw new Error(
      `Failed to load payroll profiles: ${payrollProfilesResult.error.message}`,
    );
  }

  if (earningsResult.error) {
    throw new Error(`Failed to load instructor earnings: ${earningsResult.error.message}`);
  }

  const instructors = (instructorsResult.data ?? []) as InstructorRow[];
  const rules = (rulesResult.data ?? []) as RuleRow[];
  const payrollProfiles = (payrollProfilesResult.data ?? []) as PayrollProfileRow[];
  const earnings = (earningsResult.data ?? []) as EarningRow[];
  const payrollProfilesByInstructor = new Map(
    payrollProfiles.map((profile) => [profile.instructor_id, profile]),
  );
  const rulesByInstructor = new Map(rules.map((rule) => [rule.instructor_id, rule]));
  const activeInstructors = instructors.filter((instructor) => instructor.active);
  const configuredInstructorCount = activeInstructors.filter((instructor) => ruleIsConfigured(rulesByInstructor.get(instructor.id))).length;
  const missingRuleCount = Math.max(
    activeInstructors.length - configuredInstructorCount,
    0,
  );
  const payrollReadyInstructorCount = activeInstructors.filter((instructor) => {
    const profile = payrollProfilesByInstructor.get(instructor.id);
    return (
      profile?.payroll_active === true &&
      profile.worker_classification !== "not_set"
    );
  }).length;
  const missingPayrollProfileCount = Math.max(
    activeInstructors.length - payrollReadyInstructorCount,
    0,
  );

  const pendingTotal = earnings
    .filter((earning) => earning.status === "pending")
    .reduce((sum, earning) => sum + Number(earning.earning_amount ?? 0), 0);
  const approvedTotal = earnings
    .filter((earning) => earning.status === "approved")
    .reduce((sum, earning) => sum + Number(earning.earning_amount ?? 0), 0);
  const paidTotal = earnings
    .filter((earning) => earning.status === "paid")
    .reduce((sum, earning) => sum + Number(earning.earning_amount ?? 0), 0);
  const outstandingTotal = pendingTotal + approvedTotal;
  const activeCompensationTotal = pendingTotal + approvedTotal + paidTotal;
  const paidShare =
    activeCompensationTotal > 0
      ? `${Math.round((paidTotal / activeCompensationTotal) * 100)}%`
      : "—";
  const pendingCount = earnings.filter((earning) => earning.status === "pending").length;
  const approvedCount = earnings.filter((earning) => earning.status === "approved").length;
  const paidCount = earnings.filter((earning) => earning.status === "paid").length;

  const compensationInsights = [
    {
      title: "Ready for payroll prep",
      metric: formatCurrency(outstandingTotal),
      detail:
        outstandingTotal > 0
          ? `${formatCurrency(outstandingTotal)} is pending or approved. Review pending earnings, approve anything ready, then export the pay file for your bookkeeper or payroll provider.`
          : earnings.length > 0
            ? "There are no pending or approved earnings in the current view. Paid earnings are already marked complete."
            : "No earnings are showing in this view yet. Generate pending earnings after lessons or classes are completed.",
      tone: outstandingTotal > 0 ? "warning" : "neutral",
    },
    {
      title: "Rule coverage",
      metric: `${configuredInstructorCount}/${activeInstructors.length}`,
      detail:
        missingRuleCount > 0
          ? `${missingRuleCount} active instructor${missingRuleCount === 1 ? "" : "s"} still need compensation rules before DanceFlow can stage their earnings automatically.`
          : activeInstructors.length > 0
            ? "All active instructors have at least one compensation rule configured."
            : "Add active instructors before setting compensation rules.",
      tone: missingRuleCount > 0 ? "warning" : "good",
    },
    {
      title: "Paid completion",
      metric: paidShare,
      detail:
        activeCompensationTotal > 0
          ? `${paidCount} paid, ${approvedCount} approved, and ${pendingCount} pending earnings are included in this view.`
          : "No active earnings are included in this view yet.",
      tone: outstandingTotal > 0 ? "neutral" : "good",
    },
  ];
  const exportParams = new URLSearchParams();
  if (["pending", "approved", "paid", "void"].includes(statusFilter)) {
    exportParams.set("status", statusFilter);
  }
  if (instructorFilter !== "all") {
    exportParams.set("instructorId", instructorFilter);
  }
  const exportHref = `/app/instructor-pay/export${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;
  const message = statusMessage(stringParam(params, "status"), params);

  return (
    <div className="max-w-7xl space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
              Instructor Pay
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              Instructor compensation
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Set instructor pay rules and stage earnings from completed lessons and group classes. This is compensation tracking and payroll prep, not payroll tax processing.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={exportHref}
              className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-100"
            >
              Export CSV
            </Link>
            <Link
              href="/app/instructors"
              className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Manage instructors
            </Link>
          </div>
        </div>

        {message ? (
          <div className="mt-5 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            {message}
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <div className="rounded-3xl border border-amber-100 bg-amber-50 p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Pending</p>
          <p className="mt-2 text-3xl font-bold text-slate-950">{formatCurrency(pendingTotal)}</p>
          <p className="mt-1 text-sm text-slate-600">Waiting for review.</p>
        </div>
        <div className="rounded-3xl border border-blue-100 bg-blue-50 p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Approved</p>
          <p className="mt-2 text-3xl font-bold text-slate-950">{formatCurrency(approvedTotal)}</p>
          <p className="mt-1 text-sm text-slate-600">Ready to mark paid.</p>
        </div>
        <div className="rounded-3xl border border-emerald-100 bg-emerald-50 p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Paid</p>
          <p className="mt-2 text-3xl font-bold text-slate-950">{formatCurrency(paidTotal)}</p>
          <p className="mt-1 text-sm text-slate-600">Marked paid in DanceFlow.</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rules ready</p>
          <p className="mt-2 text-3xl font-bold text-slate-950">{configuredInstructorCount}/{activeInstructors.length}</p>
          <p className="mt-1 text-sm text-slate-600">Active instructors with at least one pay rule.</p>
        </div>
      </section>

      <section className="rounded-3xl border border-violet-200 bg-[#FCF8FF] p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
              ARIA Compensation Insights
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Instructor pay readiness
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              ARIA reviews instructor pay activity in this view and highlights what should be reviewed before payroll prep or bookkeeper export.
            </p>
          </div>
          <Link
            href="/app/reports"
            className="inline-flex w-fit rounded-2xl border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50"
          >
            View reports
          </Link>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {compensationInsights.map((insight) => (
            <div
              key={insight.title}
              className={`rounded-2xl border p-4 ${
                insight.tone === "warning"
                  ? "border-amber-200 bg-amber-50"
                  : insight.tone === "good"
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-violet-100 bg-white"
              }`}
            >
              <p
                className={`text-xs font-semibold uppercase tracking-wide ${
                  insight.tone === "warning"
                    ? "text-amber-700"
                    : insight.tone === "good"
                      ? "text-emerald-700"
                      : "text-violet-700"
                }`}
              >
                {insight.title}
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-950">
                {insight.metric}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {insight.detail}
              </p>
            </div>
          ))}
        </div>
      </section>

      {missingRuleCount > 0 ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 shadow-sm">
          <p className="font-semibold">{missingRuleCount} active instructor{missingRuleCount === 1 ? "" : "s"} still need compensation rules.</p>
          <p className="mt-1 text-amber-800">DanceFlow only stages earnings for instructors with configured rules. Set at least one private lesson or group class rule before generating pending earnings.</p>
        </section>
      ) : null}

      {missingPayrollProfileCount > 0 ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 shadow-sm">
          <p className="font-semibold">
            {missingPayrollProfileCount} active instructor
            {missingPayrollProfileCount === 1 ? "" : "s"} need payroll setup.
          </p>
          <p className="mt-1 text-amber-800">
            Set a worker classification and keep the instructor active for
            payroll before DanceFlow can stage earnings or adjustments.
          </p>
        </section>
      ) : null}

      <section className="rounded-3xl border border-violet-100 bg-violet-50 p-5 text-sm text-violet-950 shadow-sm">
        <p className="font-semibold">Rules and overrides</p>
        <p className="mt-1 text-violet-900">Use duration-based private lesson rates when instructors are paid differently for 30, 45, and 60 minute lessons. Use manual adjustments for bonuses, deductions, reimbursements, or corrections. Use earning overrides only for one-off lesson exceptions.</p>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Stage earnings from completed lessons</h2>
            <p className="mt-1 text-sm text-slate-600">
              Scan completed lessons and group classes, then create pending earnings using each instructor&apos;s rule. DanceFlow keeps one earning per instructor and lesson to prevent duplicate pay entries.
            </p>
          </div>
          <form action={generateInstructorEarningsAction} className="grid gap-3 md:grid-cols-[150px_150px_auto] md:items-end">
            <label className="text-sm font-medium text-slate-700">
              From
              <input name="fromDate" type="date" className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              To
              <input name="toDate" type="date" className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
            </label>
            <button className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
              Generate pending earnings
            </button>
          </form>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">Compensation rules</h2>
          <p className="mt-1 text-sm text-slate-600">
            Rules are applied automatically when eligible lessons or classes are completed or paid.
          </p>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {instructors.map((instructor) => {
            const rule = rulesByInstructor.get(instructor.id);
            const payrollProfile = payrollProfilesByInstructor.get(instructor.id);
            return (
              <div key={instructor.id} className="space-y-4 rounded-3xl border border-slate-200 p-5">
                <form
                  action={saveInstructorPayrollProfileAction}
                  className="rounded-2xl border border-violet-100 bg-violet-50 p-4"
                >
                  <input type="hidden" name="instructorId" value={instructor.id} />
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-slate-950">{instructorName(instructor)}</h3>
                      <p className="text-sm text-slate-500">{instructor.active ? "Active instructor" : "Inactive instructor"}</p>
                    </div>
                    <Link href={`/app/instructors/${instructor.id}`} className="text-sm font-semibold text-violet-700 hover:text-violet-900">
                      Profile
                    </Link>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <label className="text-sm font-medium text-slate-700">
                      Worker classification
                      <select
                        name="workerClassification"
                        defaultValue={payrollProfile?.worker_classification ?? "not_set"}
                        className="mt-1 w-full rounded-2xl border border-violet-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="not_set">Not set</option>
                        <option value="contractor">Contractor</option>
                        <option value="employee">Employee</option>
                        <option value="owner">Owner</option>
                      </select>
                    </label>
                    <label className="text-sm font-medium text-slate-700">
                      External payroll ID
                      <input
                        name="externalPayrollId"
                        defaultValue={payrollProfile?.external_payroll_id ?? ""}
                        className="mt-1 w-full rounded-2xl border border-violet-200 bg-white px-3 py-2 text-sm"
                        placeholder="Optional provider ID"
                      />
                    </label>
                  </div>
                  <label className="mt-3 flex items-start gap-2 rounded-2xl border border-violet-200 bg-white p-3 text-sm text-slate-700">
                    <input
                      name="payrollActive"
                      type="checkbox"
                      defaultChecked={payrollProfile?.payroll_active ?? true}
                      className="mt-1"
                    />
                    <span>Active for payroll preparation</span>
                  </label>
                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Payroll notes
                    <input
                      name="payrollNotes"
                      defaultValue={payrollProfile?.payroll_notes ?? ""}
                      className="mt-1 w-full rounded-2xl border border-violet-200 bg-white px-3 py-2 text-sm"
                      placeholder="Internal payroll note"
                    />
                  </label>
                  <button className="mt-3 rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">
                    Save payroll profile
                  </button>
                </form>

                <form action={saveInstructorCompensationRuleAction}>
                <input type="hidden" name="instructorId" value={instructor.id} />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-950">{instructorName(instructor)}</h3>
                    <p className="text-sm text-slate-500">{instructor.active ? "Active instructor" : "Inactive instructor"}</p>
                  </div>
                  <Link href={`/app/instructors/${instructor.id}`} className="text-sm font-semibold text-violet-700 hover:text-violet-900">
                    Profile
                  </Link>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-sm font-semibold text-slate-950">Private lessons</p>
                    <label className="mt-3 block text-sm font-medium text-slate-700">
                      Rule
                      <select name="privateLessonPayMode" defaultValue={rule?.private_lesson_pay_mode ?? "none"} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm">
                        <option value="none">Not configured</option>
                        <option value="flat">Flat rate</option>
                        <option value="percentage">Percentage of lesson value</option>
                      </select>
                    </label>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <label className="text-sm font-medium text-slate-700">
                        Flat $
                        <input name="privateLessonFlatAmount" type="number" step="0.01" min="0" defaultValue={Number(rule?.private_lesson_flat_amount ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                      <label className="text-sm font-medium text-slate-700">
                        Percent
                        <input name="privateLessonPercentage" type="number" step="0.01" min="0" defaultValue={Number(rule?.private_lesson_percentage ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                    </div>
                    <label className="mt-3 flex items-start gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                      <input name="privateLessonDurationRatesEnabled" type="checkbox" defaultChecked={Boolean(rule?.private_lesson_duration_rates_enabled)} className="mt-1" />
                      <span>Use duration rates for flat-rate private lessons</span>
                    </label>
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      <label className="text-sm font-medium text-slate-700">
                        30 min $
                        <input name="privateLesson30MinFlatAmount" type="number" step="0.01" min="0" defaultValue={Number(rule?.private_lesson_30_min_flat_amount ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                      <label className="text-sm font-medium text-slate-700">
                        45 min $
                        <input name="privateLesson45MinFlatAmount" type="number" step="0.01" min="0" defaultValue={Number(rule?.private_lesson_45_min_flat_amount ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                      <label className="text-sm font-medium text-slate-700">
                        60 min $
                        <input name="privateLesson60MinFlatAmount" type="number" step="0.01" min="0" defaultValue={Number(rule?.private_lesson_60_min_flat_amount ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-sm font-semibold text-slate-950">Group classes</p>
                    <label className="mt-3 block text-sm font-medium text-slate-700">
                      Rule
                      <select name="groupClassPayMode" defaultValue={rule?.group_class_pay_mode ?? "none"} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm">
                        <option value="none">Not configured</option>
                        <option value="flat">Flat rate</option>
                        <option value="percentage">Percentage of class value</option>
                        <option value="per_attendee">Per attended student</option>
                      </select>
                    </label>
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      <label className="text-sm font-medium text-slate-700">
                        Flat $
                        <input name="groupClassFlatAmount" type="number" step="0.01" min="0" defaultValue={Number(rule?.group_class_flat_amount ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                      <label className="text-sm font-medium text-slate-700">
                        Percent
                        <input name="groupClassPercentage" type="number" step="0.01" min="0" defaultValue={Number(rule?.group_class_percentage ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                      <label className="text-sm font-medium text-slate-700">
                        Per student $
                        <input name="groupClassPerAttendeeAmount" type="number" step="0.01" min="0" defaultValue={Number(rule?.group_class_per_attendee_amount ?? 0)} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                    </div>
                  </div>
                </div>

                <label className="mt-4 block text-sm font-medium text-slate-700">
                  Notes
                  <input name="notes" defaultValue={rule?.notes ?? ""} className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" placeholder="Optional internal note" />
                </label>

                <button className="mt-4 rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">
                  Save rule
                </button>
                </form>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">Manual adjustments</h2>
          <p className="mt-1 text-sm text-slate-600">Add a one-off bonus, deduction, reimbursement, or correction for an instructor. Adjustments are staged as pending so they can be reviewed before being marked paid.</p>
        </div>
        <form action={createInstructorAdjustmentAction} className="mt-5 grid gap-3 md:grid-cols-[1fr_160px_150px_160px] md:items-end">
          <label className="text-sm font-medium text-slate-700">
            Instructor
            <select name="instructorId" required className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm">
              <option value="">Choose instructor</option>
              {instructors.map((instructor) => (
                <option key={instructor.id} value={instructor.id}>{instructorName(instructor)}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Type
            <select name="adjustmentType" defaultValue="bonus" className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm">
              <option value="bonus">Bonus</option>
              <option value="deduction">Deduction</option>
              <option value="reimbursement">Reimbursement</option>
              <option value="correction">Correction</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Amount
            <input name="earningAmount" type="number" step="0.01" min="0" required className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Date
            <input name="earningDate" type="date" className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm font-medium text-slate-700 md:col-span-3">
            Reason
            <input name="notes" required className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" placeholder="Example: Showcase bonus, mileage reimbursement, or correction for last week" />
          </label>
          <button className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Add adjustment
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Recent instructor earnings</h2>
            <p className="mt-1 text-sm text-slate-600">
              Review pending earnings, approve them, and mark them paid after external payment or payroll processing.
            </p>
          </div>
        </div>

        <form className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-[180px_1fr_auto] md:items-end">
          <label className="text-sm font-medium text-slate-700">
            Status
            <select name="statusFilter" defaultValue={statusFilter} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
              <option value="void">Voided</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Instructor
            <select name="instructorId" defaultValue={instructorFilter} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">All instructors</option>
              {instructors.map((instructor) => (
                <option key={instructor.id} value={instructor.id}>
                  {instructorName(instructor)}
                </option>
              ))}
            </select>
          </label>
          <button className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Apply filters
          </button>
        </form>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {earnings.length === 0 ? (
            <div className="p-6 text-sm text-slate-600">
              No instructor earnings have been staged yet. Set rules, then generate pending earnings from completed lessons or classes. Earnings are staged automatically from normal lesson activity once rules exist, but this review button can backfill anything completed before rules were set.
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {earnings.map((earning) => (
                <div key={earning.id} className="grid gap-4 p-4 lg:grid-cols-[1.2fr_1fr_auto] lg:items-center">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-950">{relationName(earning.instructors)}</p>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusClass(earning.status)}`}>
                        {earning.status.charAt(0).toUpperCase() + earning.status.slice(1)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">
                      {labelForAppointmentType(earning.appointment_type)} · {formatDate(earning.earning_date)} · Client: {clientRelationName(earning.clients)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Rule: {labelForPayMode(earning.pay_mode)}
                      {earning.pay_mode === "percentage" ? ` (${Number(earning.pay_percentage ?? 0)}%)` : ""}
                      {earning.pay_mode === "per_attendee" ? ` (${earning.attendance_count ?? 0} attended)` : ""}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{sourceSummary(earning)}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Basis</p>
                      <p className="font-semibold text-slate-950">{formatCurrency(earning.gross_revenue_basis)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Earning</p>
                      <p className="font-semibold text-slate-950">{formatCurrency(earning.earning_amount)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Paid</p>
                      <p className="font-semibold text-slate-950">{earning.paid_at ? formatDate(earning.paid_at) : "—"}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    {earning.appointment_id ? (
                      <Link href={`/app/schedule/${earning.appointment_id}`} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                        Open lesson
                      </Link>
                    ) : null}
                    {earning.status !== "paid" && earning.status !== "void" ? (
                      <form action={overrideInstructorEarningAction} className="flex flex-wrap gap-2">
                        <input type="hidden" name="earningId" value={earning.id} />
                        <input name="overrideAmount" type="number" step="0.01" defaultValue={Number(earning.earning_amount ?? 0)} className="w-24 rounded-xl border border-slate-200 px-2 py-2 text-xs" aria-label="Override amount" />
                        <input name="overrideReason" className="w-44 rounded-xl border border-slate-200 px-2 py-2 text-xs" placeholder="Override reason" aria-label="Override reason" />
                        <button className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800 hover:bg-violet-100">Save override</button>
                      </form>
                    ) : null}
                    {earning.status === "pending" ? (
                      <form action={updateInstructorEarningStatusAction}>
                        <input type="hidden" name="earningId" value={earning.id} />
                        <input type="hidden" name="nextStatus" value="approved" />
                        <button className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700">Approve</button>
                      </form>
                    ) : null}
                    {canMarkPaid && earning.status === "approved" ? (
                      <form action={updateInstructorEarningStatusAction} className="flex gap-2">
                        <input type="hidden" name="earningId" value={earning.id} />
                        <input type="hidden" name="nextStatus" value="paid" />
                        <select name="paymentMethod" defaultValue="external_payroll" className="rounded-xl border border-slate-200 px-2 py-2 text-xs">
                          <option value="external_payroll">External payroll</option>
                          <option value="check">Check</option>
                          <option value="cash">Cash</option>
                          <option value="venmo">Venmo</option>
                          <option value="zelle">Zelle</option>
                        </select>
                        <button className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700">Mark paid</button>
                      </form>
                    ) : null}
                    {earning.status !== "paid" && earning.status !== "void" ? (
                      <form action={updateInstructorEarningStatusAction}>
                        <input type="hidden" name="earningId" value={earning.id} />
                        <input type="hidden" name="nextStatus" value="void" />
                        <button className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Void</button>
                      </form>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
