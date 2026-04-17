import Link from "next/link";
import { redirect } from "next/navigation";
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
  return value.replaceAll("_", " ");
}

function paymentStatusBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "refunded") return "bg-blue-50 text-blue-700";
  return "bg-slate-100 text-slate-700";
}

function appointmentStatusBadgeClass(status: string | null) {
  if (status === "scheduled") return "bg-sky-50 text-sky-700";
  if (status === "attended") return "bg-green-50 text-green-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-700";
  if (status === "no_show") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
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
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">Reports</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
              Studio performance dashboard
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              A clean owner view of revenue, leads, attendance, and package
              activity for {rangeLabel(range).toLowerCase()}.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/app/reports?range=today"
              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                range === "today"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Today
            </Link>
            <Link
              href="/app/reports?range=month"
              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                range === "month"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Month
            </Link>
            <Link
              href="/app/reports?range=last30"
              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                range === "last30"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Last 30 Days
            </Link>
            <Link
              href="/app/reports?range=quarter"
              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                range === "quarter"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Quarter
            </Link>
            <Link
              href="/app/reports?range=year"
              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                range === "year"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Year
            </Link>
          </div>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Revenue Collected</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtCurrency(revenueTotal)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {fmtNumber(paidPayments.length)} paid payments in{" "}
            {rangeLabel(range).toLowerCase()}.
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">New Leads</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtNumber(leadsOnly.length)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Conversion rate: {conversionRate}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Attendance Rate</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {attendanceRate}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {fmtNumber(attendedAppointments.length)} attended,{" "}
            {fmtNumber(noShows.length)} no-shows.
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Active Students</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtNumber(activeStudentsCount ?? 0)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Current active client records across the studio.
          </p>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Revenue snapshot
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Payments by status, method, and sale type.
              </p>
            </div>
            <Link
              href="/app/payments"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Payments
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(paidPayments.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Pending</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(pendingPayments.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Refunded</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(refundedPayments.length)}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Methods
              </h3>
              <div className="mt-3 space-y-3">
                {topPaymentMethods.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No payment activity in this range.
                  </p>
                ) : (
                  topPaymentMethods.map(([method, count]) => (
                    <div
                      key={method}
                      className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                    >
                      <span className="text-sm font-medium text-slate-700">
                        {labelize(method)}
                      </span>
                      <span className="text-sm font-semibold text-slate-950">
                        {fmtNumber(count)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payment Types
              </h3>
              <div className="mt-3 space-y-3">
                {topPaymentTypes.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No payment type data in this range.
                  </p>
                ) : (
                  topPaymentTypes.map(([type, count]) => (
                    <div
                      key={type}
                      className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                    >
                      <span className="text-sm font-medium text-slate-700">
                        {labelize(type)}
                      </span>
                      <span className="text-sm font-semibold text-slate-950">
                        {fmtNumber(count)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Average Paid Payment</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {fmtCurrency(averagePaidPayment)}
            </p>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Growth snapshot
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Lead intake and where interest is coming from.
              </p>
            </div>
            <Link
              href="/app/leads"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Leads
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">New Leads</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(leadsOnly.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Converted</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(convertedLeads.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Archived</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(archivedLeads.length)}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top Lead Sources
            </h3>
            <div className="mt-3 space-y-3">
              {topLeadSources.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No lead sources recorded in this range.
                </p>
              ) : (
                topLeadSources.map(([source, count]) => (
                  <div
                    key={source}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {sourceLabel(source)}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtNumber(count)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Lead Conversion Rate</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {conversionRate}
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Attendance snapshot
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Appointment outcomes for the selected date range.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Scheduled</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(scheduledAppointments.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Attended</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(attendedAppointments.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Cancelled</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(cancelledAppointments.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">No-Shows</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(noShows.length)}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Appointment Types
            </h3>
            <div className="mt-3 space-y-3">
              {topAppointmentTypes.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No appointment activity in this range.
                </p>
              ) : (
                topAppointmentTypes.map(([type, count]) => (
                  <div
                    key={type}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {labelize(type)}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtNumber(count)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Packages snapshot
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Package activity and top-selling package names.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Packages Sold</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(typedPackages.length)}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Distinct Package Names</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(topPackages.length)}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top Packages
            </h3>
            <div className="mt-3 space-y-3">
              {topPackages.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No package sales in this range.
                </p>
              ) : (
                topPackages.map(([name, count]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-slate-700">
                      {name}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {fmtNumber(count)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Recent payments
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Latest payment activity in the selected range.
              </p>
            </div>
            <Link
              href="/app/payments"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View all
            </Link>
          </div>

          <div className="mt-6 space-y-3">
            {typedPayments.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                No payments found for this range.
              </div>
            ) : (
              typedPayments.slice(0, 8).map((payment) => (
                <div
                  key={payment.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">
                      {fmtCurrency(Number(payment.amount ?? 0))}
                    </p>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentStatusBadgeClass(
                        payment.status,
                      )}`}
                    >
                      {labelize(payment.status)}
                    </span>
                    <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
                      {labelize(payment.payment_method)}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-slate-700">
                    {getClientName(payment.clients)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {labelize(payment.payment_type)} •{" "}
                    {labelize(payment.source)} •{" "}
                    {fmtDateTime(payment.created_at)}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Export data
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Download studio data for deeper analysis or bookkeeping.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-3">
            <a
              href="/app/reports/export/clients"
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export Clients CSV
            </a>
            <a
              href="/app/reports/export/appointments"
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export Appointments CSV
            </a>
            <a
              href="/app/reports/export/payments"
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export Payments CSV
            </a>
            <a
              href="/app/reports/export/balances"
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export Balances CSV
            </a>
            <a
              href="/app/reports/export/ledger"
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export Lesson Ledger CSV
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}