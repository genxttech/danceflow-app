import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  generateInstructorEarningsAction,
  saveInstructorCompensationRuleAction,
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
  group_class_pay_mode: string;
  group_class_flat_amount: number | string | null;
  group_class_percentage: number | string | null;
  group_class_per_attendee_amount: number | string | null;
  notes: string | null;
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

  if (!canManageInstructors(role) || !["studio_owner", "studio_admin"].includes(role)) redirect("/app");

  const [instructorsResult, rulesResult, earningsResult] = await Promise.all([
    supabase
      .from("instructors")
      .select("id, first_name, last_name, active")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true }),
    supabase
      .from("instructor_compensation_rules")
      .select("id, instructor_id, private_lesson_pay_mode, private_lesson_flat_amount, private_lesson_percentage, group_class_pay_mode, group_class_flat_amount, group_class_percentage, group_class_per_attendee_amount, notes")
      .eq("studio_id", studioId),
    supabase
      .from("instructor_earnings")
      .select("id, instructor_id, appointment_id, client_id, earning_date, source_type, appointment_type, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, status, notes, paid_at, payment_method, instructors(first_name, last_name), clients(first_name, last_name)")
      .eq("studio_id", studioId)
      .order("earning_date", { ascending: false })
      .limit(100),
  ]);

  if (instructorsResult.error) {
    throw new Error(`Failed to load instructors: ${instructorsResult.error.message}`);
  }

  if (rulesResult.error) {
    throw new Error(`Failed to load compensation rules: ${rulesResult.error.message}`);
  }

  if (earningsResult.error) {
    throw new Error(`Failed to load instructor earnings: ${earningsResult.error.message}`);
  }

  const instructors = (instructorsResult.data ?? []) as InstructorRow[];
  const rules = (rulesResult.data ?? []) as RuleRow[];
  const earnings = (earningsResult.data ?? []) as EarningRow[];
  const rulesByInstructor = new Map(rules.map((rule) => [rule.instructor_id, rule]));
  const activeInstructors = instructors.filter((instructor) => instructor.active);
  const configuredInstructorCount = activeInstructors.filter((instructor) => ruleIsConfigured(rulesByInstructor.get(instructor.id))).length;
  const missingRuleCount = Math.max(activeInstructors.length - configuredInstructorCount, 0);

  const pendingTotal = earnings
    .filter((earning) => earning.status === "pending")
    .reduce((sum, earning) => sum + Number(earning.earning_amount ?? 0), 0);
  const approvedTotal = earnings
    .filter((earning) => earning.status === "approved")
    .reduce((sum, earning) => sum + Number(earning.earning_amount ?? 0), 0);
  const paidTotal = earnings
    .filter((earning) => earning.status === "paid")
    .reduce((sum, earning) => sum + Number(earning.earning_amount ?? 0), 0);
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
          <Link
            href="/app/instructors"
            className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Manage instructors
          </Link>
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

      {missingRuleCount > 0 ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 shadow-sm">
          <p className="font-semibold">{missingRuleCount} active instructor{missingRuleCount === 1 ? "" : "s"} still need compensation rules.</p>
          <p className="mt-1 text-amber-800">DanceFlow only stages earnings for instructors with configured rules. Set at least one private lesson or group class rule before generating pending earnings.</p>
        </section>
      ) : null}

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
            return (
              <form key={instructor.id} action={saveInstructorCompensationRuleAction} className="rounded-3xl border border-slate-200 p-5">
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
            );
          })}
        </div>
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
                    {earning.status === "pending" ? (
                      <form action={updateInstructorEarningStatusAction}>
                        <input type="hidden" name="earningId" value={earning.id} />
                        <input type="hidden" name="nextStatus" value="approved" />
                        <button className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700">Approve</button>
                      </form>
                    ) : null}
                    {earning.status !== "paid" && earning.status !== "void" ? (
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
