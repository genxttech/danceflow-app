import Link from "next/link";
import { redirect } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import {
  ArrowRight,
  CalendarCheck,
  CreditCard,
  Download,
  FileText,
  UserPlus,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  range?: string;
}>;

type PaymentRow = {
  id: string;
  amount: number | null;
  status: string | null;
  payment_method: string | null;
  payment_type: string | null;
  source: string | null;
  created_at: string;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

type ClientRow = {
  id: string;
  status: string | null;
  created_at: string;
  referral_source: string | null;
};

type AppointmentRow = {
  id: string;
  status: string | null;
  starts_at: string;
  appointment_type: string | null;
};

type ClientPackageRow = {
  id: string;
  active: boolean | null;
  created_at: string;
  name_snapshot: string | null;
  price_snapshot: number | null;
};

function fmtCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function fmtNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

function rangeLabel(range: string) {
  if (range === "today") return "Today";
  if (range === "last30") return "Last 30 Days";
  if (range === "quarter") return "This Quarter";
  if (range === "year") return "This Year";
  return "This Month";
}

function getClientName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  if (!client) return "Unknown Client";

  return (
    [client.first_name ?? "", client.last_name ?? ""].join(" ").trim() ||
    "Unknown Client"
  );
}

function labelize(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function paymentStatusBadgeClass(status: string | null) {
  if (status === "paid") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "pending") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (status === "failed") return "bg-red-50 text-red-700 ring-red-200";
  if (status === "refunded") return "bg-blue-50 text-blue-700 ring-blue-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function sourceLabel(value: string | null) {
  if (value === "website") return "Website";
  if (value === "public_discovery") return "Public Discovery";
  if (value === "referral") return "Referral";
  if (value === "walk_in") return "Walk-In";
  return labelize(value);
}

function sortEntriesDesc<T extends string>(
  record: Record<T, number>,
): Array<[T, number]> {
  return (Object.entries(record) as Array<[T, number]>).sort(
    (a, b) => b[1] - a[1],
  );
}

function percentage(part: number, total: number) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function RangePill({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
        active
          ? "border-white bg-white text-[#4A1363] shadow-sm"
          : "border-white/25 bg-white/10 text-white hover:bg-white/15"
      }`}
    >
      {children}
    </Link>
  );
}

function MetricCard({
  label,
  value,
  helper,
  icon: Icon,
  accent = "purple",
}: {
  label: string;
  value: string;
  helper: string;
  icon: ComponentType<{ className?: string }>;
  accent?: "purple" | "amber" | "blue" | "emerald";
}) {
  const accentClasses = {
    purple: "bg-[#F3E8FF] text-[#6B21A8]",
    amber: "bg-[#FEF3C7] text-[#92400E]",
    blue: "bg-[#DBEAFE] text-[#1D4ED8]",
    emerald: "bg-[#D1FAE5] text-[#047857]",
  }[accent];

  return (
    <div className="group rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#D8B4FE] hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            {value}
          </p>
          <p className="mt-2 text-sm leading-5 text-slate-600">{helper}</p>
        </div>
        <div className={`rounded-2xl p-3 ${accentClasses}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function ReportPanel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-white shadow-sm">
      <div className="border-b border-[#F3E8FF] bg-gradient-to-r from-[#FCF8FF] to-white px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              DanceFlow Reports
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              {subtitle}
            </p>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}

function PanelAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#E9D5FF] bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] transition hover:bg-[#F3E8FF]"
    >
      {children}
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}

function MiniStat({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
      {helper ? <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p> : null}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
      {message}
    </div>
  );
}

function BreakdownList({
  entries,
  formatter = labelize,
  emptyMessage,
}: {
  entries: Array<[string, number]>;
  formatter?: (value: string) => string;
  emptyMessage: string;
}) {
  if (entries.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <div className="space-y-3">
      {entries.map(([key, count]) => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
        >
          <span className="text-sm font-medium text-slate-700">
            {formatter(key)}
          </span>
          <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-950 ring-1 ring-slate-200">
            {fmtNumber(count)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExportLink({ href, label, helper }: { href: string; label: string; helper: string }) {
  return (
    <a
      href={href}
      className="group rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] px-4 py-4 transition hover:border-[#D8B4FE] hover:bg-[#F3E8FF]"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-white p-2 text-[#6B21A8] shadow-sm">
          <Download className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-950">{label}</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">{helper}</p>
        </div>
      </div>
    </a>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const range = params.range ?? "month";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const rangeStart = getRangeStart(range).toISOString();
  const nowIso = new Date().toISOString();

  const [
    { data: payments, error: paymentsError },
    { data: leads, error: leadsError },
    { data: appointments, error: appointmentsError },
    { data: packages, error: packagesError },
    { count: activeStudentsCount, error: activeStudentsError },
  ] = await Promise.all([
    supabase
      .from("payments")
      .select(
        `
          id,
          amount,
          status,
          payment_method,
          payment_type,
          source,
          created_at,
          clients (
            first_name,
            last_name
          )
        `,
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("clients")
      .select("id, status, created_at, referral_source")
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("appointments")
      .select("id, status, starts_at, appointment_type")
      .eq("studio_id", studioId)
      .gte("starts_at", rangeStart)
      .lte("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1000),

    supabase
      .from("client_packages")
      .select("id, active, created_at, name_snapshot, price_snapshot")
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("status", "active"),
  ]);

  if (paymentsError) {
    throw new Error(
      `Failed to load payments report data: ${paymentsError.message}`,
    );
  }
  if (leadsError) {
    throw new Error(`Failed to load lead report data: ${leadsError.message}`);
  }
  if (appointmentsError) {
    throw new Error(
      `Failed to load appointment report data: ${appointmentsError.message}`,
    );
  }
  if (packagesError) {
    throw new Error(
      `Failed to load package report data: ${packagesError.message}`,
    );
  }
  if (activeStudentsError) {
    throw new Error(
      `Failed to load active students count: ${activeStudentsError.message}`,
    );
  }

  const typedPayments = (payments ?? []) as PaymentRow[];
  const typedLeads = (leads ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedPackages = (packages ?? []) as ClientPackageRow[];

  const paidPayments = typedPayments.filter((item) => item.status === "paid");
  const pendingPayments = typedPayments.filter(
    (item) => item.status === "pending",
  );
  const refundedPayments = typedPayments.filter(
    (item) => item.status === "refunded",
  );

  const revenueTotal = paidPayments.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );
  const averagePaidPayment =
    paidPayments.length > 0 ? revenueTotal / paidPayments.length : 0;

  const leadsOnly = typedLeads.filter((item) => item.status === "lead");
  const convertedLeads = typedLeads.filter((item) => item.status === "active");
  const archivedLeads = typedLeads.filter(
    (item) => item.status === "archived",
  );

  const attendedAppointments = typedAppointments.filter(
    (item) => item.status === "attended",
  );
  const cancelledAppointments = typedAppointments.filter(
    (item) => item.status === "cancelled",
  );
  const noShows = typedAppointments.filter((item) => item.status === "no_show");
  const scheduledAppointments = typedAppointments.filter(
    (item) => item.status === "scheduled",
  );

  const paymentMethodCounts: Record<string, number> = {};
  const paymentTypeCounts: Record<string, number> = {};
  const leadSourceCounts: Record<string, number> = {};
  const appointmentTypeCounts: Record<string, number> = {};
  const packageCounts: Record<string, number> = {};

  for (const payment of typedPayments) {
    const methodKey = payment.payment_method ?? "unknown";
    paymentMethodCounts[methodKey] = (paymentMethodCounts[methodKey] ?? 0) + 1;

    const typeKey = payment.payment_type ?? "other";
    paymentTypeCounts[typeKey] = (paymentTypeCounts[typeKey] ?? 0) + 1;
  }

  for (const lead of leadsOnly) {
    const sourceKey = lead.referral_source ?? "unknown";
    leadSourceCounts[sourceKey] = (leadSourceCounts[sourceKey] ?? 0) + 1;
  }

  for (const appointment of typedAppointments) {
    const typeKey = appointment.appointment_type ?? "other";
    appointmentTypeCounts[typeKey] =
      (appointmentTypeCounts[typeKey] ?? 0) + 1;
  }

  for (const pkg of typedPackages) {
    const key = pkg.name_snapshot?.trim() || "Unnamed Package";
    packageCounts[key] = (packageCounts[key] ?? 0) + 1;
  }

  const topPaymentMethods = sortEntriesDesc(paymentMethodCounts).slice(0, 5);
  const topPaymentTypes = sortEntriesDesc(paymentTypeCounts).slice(0, 5);
  const topLeadSources = sortEntriesDesc(leadSourceCounts).slice(0, 5);
  const topAppointmentTypes = sortEntriesDesc(appointmentTypeCounts).slice(
    0,
    5,
  );
  const topPackages = sortEntriesDesc(packageCounts).slice(0, 5);

  const conversionRate = percentage(
    convertedLeads.length,
    leadsOnly.length + convertedLeads.length,
  );
  const attendanceRate = percentage(
    attendedAppointments.length,
    attendedAppointments.length +
      cancelledAppointments.length +
      noShows.length,
  );

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              DanceFlow Reports
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Studio Performance
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              Track revenue, leads, attendance, and package activity for {rangeLabel(range).toLowerCase()}. Use these cards to spot what needs attention and where the studio is growing.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <RangePill href="/app/reports?range=today" active={range === "today"}>Today</RangePill>
            <RangePill href="/app/reports?range=month" active={range === "month"}>Month</RangePill>
            <RangePill href="/app/reports?range=last30" active={range === "last30"}>Last 30 Days</RangePill>
            <RangePill href="/app/reports?range=quarter" active={range === "quarter"}>Quarter</RangePill>
            <RangePill href="/app/reports?range=year" active={range === "year"}>Year</RangePill>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-4 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Range</p>
            <p className="mt-1 text-sm font-semibold">{rangeLabel(range)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Paid payments</p>
            <p className="mt-1 text-sm font-semibold">{fmtNumber(paidPayments.length)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">New client records</p>
            <p className="mt-1 text-sm font-semibold">{fmtNumber(typedLeads.length)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Appointments reviewed</p>
            <p className="mt-1 text-sm font-semibold">{fmtNumber(typedAppointments.length)}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Revenue Collected"
          value={fmtCurrency(revenueTotal)}
          helper={`${fmtNumber(paidPayments.length)} paid payments · average ${fmtCurrency(averagePaidPayment)}`}
          icon={CreditCard}
          accent="purple"
        />
        <MetricCard
          label="New Leads"
          value={fmtNumber(leadsOnly.length)}
          helper={`Conversion rate: ${conversionRate}`}
          icon={UserPlus}
          accent="amber"
        />
        <MetricCard
          label="Attendance Rate"
          value={attendanceRate}
          helper={`${fmtNumber(attendedAppointments.length)} attended · ${fmtNumber(noShows.length)} no-shows`}
          icon={CalendarCheck}
          accent="blue"
        />
        <MetricCard
          label="Active Students"
          value={fmtNumber(activeStudentsCount ?? 0)}
          helper="Current active client records across the studio."
          icon={Users}
          accent="emerald"
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <ReportPanel
          title="Revenue snapshot"
          subtitle="Payments by status, method, and sale type."
          action={<PanelAction href="/app/payments">Open Payments</PanelAction>}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <MiniStat label="Paid" value={fmtNumber(paidPayments.length)} />
            <MiniStat label="Pending" value={fmtNumber(pendingPayments.length)} />
            <MiniStat label="Refunded" value={fmtNumber(refundedPayments.length)} />
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Methods
              </h3>
              <BreakdownList
                entries={topPaymentMethods}
                emptyMessage="No payment activity in this range."
              />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Types
              </h3>
              <BreakdownList
                entries={topPaymentTypes}
                emptyMessage="No payment type data in this range."
              />
            </div>
          </div>
        </ReportPanel>

        <ReportPanel
          title="Growth snapshot"
          subtitle="Lead intake and where interest is coming from."
          action={<PanelAction href="/app/leads">Open Leads</PanelAction>}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <MiniStat label="New Leads" value={fmtNumber(leadsOnly.length)} />
            <MiniStat label="Converted" value={fmtNumber(convertedLeads.length)} />
            <MiniStat label="Archived" value={fmtNumber(archivedLeads.length)} />
          </div>

          <div className="mt-6">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top Lead Sources
            </h3>
            <BreakdownList
              entries={topLeadSources}
              formatter={sourceLabel}
              emptyMessage="No lead sources recorded in this range."
            />
          </div>

          <div className="mt-6 rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4">
            <p className="text-sm font-semibold text-[#6B21A8]">Lead Conversion Rate</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{conversionRate}</p>
            <p className="mt-1 text-sm leading-5 text-slate-600">
              Based on new leads and clients converted to active during this range.
            </p>
          </div>
        </ReportPanel>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <ReportPanel
          title="Attendance snapshot"
          subtitle="Appointment outcomes for the selected date range."
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MiniStat label="Scheduled" value={fmtNumber(scheduledAppointments.length)} />
            <MiniStat label="Attended" value={fmtNumber(attendedAppointments.length)} />
            <MiniStat label="Cancelled" value={fmtNumber(cancelledAppointments.length)} />
            <MiniStat label="No-Shows" value={fmtNumber(noShows.length)} />
          </div>

          <div className="mt-6">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Appointment Types
            </h3>
            <BreakdownList
              entries={topAppointmentTypes}
              emptyMessage="No appointment activity in this range."
            />
          </div>
        </ReportPanel>

        <ReportPanel
          title="Packages snapshot"
          subtitle="Package activity and top-selling package names."
          action={<PanelAction href="/app/packages">Open Packages</PanelAction>}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <MiniStat label="Packages Sold" value={fmtNumber(typedPackages.length)} />
            <MiniStat label="Distinct Packages" value={fmtNumber(topPackages.length)} />
          </div>

          <div className="mt-6">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top Packages
            </h3>
            <BreakdownList
              entries={topPackages}
              formatter={(value) => value}
              emptyMessage="No package sales in this range."
            />
          </div>
        </ReportPanel>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <ReportPanel
          title="Recent payments"
          subtitle="Latest payment activity in the selected range."
          action={<PanelAction href="/app/payments">View All</PanelAction>}
        >
          <div className="space-y-3">
            {typedPayments.length === 0 ? (
              <EmptyState message="No payments found for this range." />
            ) : (
              typedPayments.slice(0, 8).map((payment) => (
                <div
                  key={payment.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-[#D8B4FE] hover:bg-[#FCF8FF]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">
                      {fmtCurrency(Number(payment.amount ?? 0))}
                    </p>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${paymentStatusBadgeClass(
                        payment.status,
                      )}`}
                    >
                      {labelize(payment.status)}
                    </span>
                    <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                      {labelize(payment.payment_method)}
                    </span>
                  </div>

                  <p className="mt-2 text-sm font-medium text-slate-700">
                    {getClientName(payment.clients)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {labelize(payment.payment_type)} • {labelize(payment.source)} • {fmtDateTime(payment.created_at)}
                  </p>
                </div>
              ))
            )}
          </div>
        </ReportPanel>

        <ReportPanel
          title="Export data"
          subtitle="Download studio data for bookkeeping, tax prep, or deeper analysis."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <ExportLink
              href="/app/reports/export/clients"
              label="Clients CSV"
              helper="Names, contact details, statuses, and lead source fields."
            />
            <ExportLink
              href="/app/reports/export/appointments"
              label="Appointments CSV"
              helper="Lesson and appointment history for the studio."
            />
            <ExportLink
              href="/app/reports/export/payments"
              label="Payments CSV"
              helper="Payment records for bookkeeping and reconciliation."
            />
            <ExportLink
              href="/app/reports/export/balances"
              label="Balances CSV"
              helper="Client package balances and remaining credits."
            />
            <ExportLink
              href="/app/reports/export/ledger"
              label="Lesson Ledger CSV"
              helper="Usage ledger for lesson/package activity."
            />
          </div>

          <div className="mt-6 rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-white p-2 text-[#6B21A8] shadow-sm">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-950">Export tip</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Use the date filter above before exporting when you want to review a specific month, quarter, or year.
                </p>
              </div>
            </div>
          </div>
        </ReportPanel>
      </section>
    </div>
  );
}
