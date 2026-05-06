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
  instructor_id: string | null;
  duration_minutes: number | null;
  price_amount: number | null;
  payment_status: string | null;
};

type ClientPackageRow = {
  id: string;
  active: boolean | null;
  created_at: string;
  name_snapshot: string | null;
  price_snapshot: number | null;
  sold_price: number | null;
};

type ClientMembershipRow = {
  id: string;
  status: string | null;
  created_at: string;
  name_snapshot: string | null;
  price_snapshot: number | null;
  signup_fee_snapshot: number | null;
  billing_interval_snapshot: string | null;
};

type EventRegistrationRevenueRow = {
  id: string;
  event_id: string | null;
  studio_id: string | null;
  quantity: number | null;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  created_at: string;
};

type ExpenseRow = {
  id: string;
  expense_date: string;
  vendor_name: string;
  category: string;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
};

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type InstructorSummary = {
  instructorId: string;
  name: string;
  totalAppointments: number;
  attended: number;
  scheduled: number;
  cancelled: number;
  noShows: number;
  minutes: number;
  revenue: number;
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

function isFloorRentalPayment(payment: PaymentRow) {
  const paymentType = (payment.payment_type ?? "").toLowerCase();
  const source = (payment.source ?? "").toLowerCase();

  return (
    paymentType === "floor_fee" ||
    paymentType === "floor_space_rental" ||
    source === "floor_rental" ||
    source === "portal_floor_rental_balance_checkout"
  );
}

function labelize(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ");
}

function expenseCategoryLabel(value: string | null | undefined) {
  if (value === "floor_fee") return "Floor Rental / Floor Fee";
  if (value === "rent") return "Rent";
  if (value === "instructor_pay") return "Instructor Pay";
  if (value === "marketing") return "Marketing";
  if (value === "software") return "Software";
  if (value === "supplies") return "Supplies";
  if (value === "costumes_retail_inventory") return "Costumes / Retail Inventory";
  if (value === "event_expense") return "Event Expense";
  if (value === "travel") return "Travel";
  if (value === "meals") return "Meals";
  if (value === "utilities") return "Utilities";
  if (value === "insurance") return "Insurance";
  if (value === "professional_services") return "Professional Services";
  return labelize(value);
}

function paymentStatusBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "refunded") return "bg-blue-50 text-blue-700";
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

  if (!studioId) {
    redirect("/app");
  }

  const rangeStartDate = getRangeStart(range);
  const rangeStart = rangeStartDate.toISOString();
  const rangeStartDateOnly = rangeStartDate.toISOString().slice(0, 10);
  const todayDateOnly = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  const [
    { data: payments, error: paymentsError },
    { data: leads, error: leadsError },
    { data: appointments, error: appointmentsError },
    { data: packages, error: packagesError },
    { data: memberships, error: membershipsError },
    { data: eventRegistrations, error: eventRegistrationsError },
    { data: expenses, error: expensesError },
    { data: instructors, error: instructorsError },
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
      .select(
        "id, status, starts_at, appointment_type, instructor_id, duration_minutes, price_amount, payment_status",
      )
      .eq("studio_id", studioId)
      .gte("starts_at", rangeStart)
      .lte("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1000),

    supabase
      .from("client_packages")
      .select("id, active, created_at, name_snapshot, price_snapshot, sold_price")
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("client_memberships")
      .select(
        "id, status, created_at, name_snapshot, price_snapshot, signup_fee_snapshot, billing_interval_snapshot",
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("event_registrations")
      .select(
        "id, event_id, studio_id, quantity, payment_status, total_amount, total_price, currency, created_at",
      )
      .eq("studio_id", studioId)
      .gte("created_at", rangeStart)
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("expenses")
      .select(
        "id, expense_date, vendor_name, category, amount, currency, payment_method, notes, created_at",
      )
      .eq("studio_id", studioId)
      .gte("expense_date", rangeStartDateOnly)
      .lte("expense_date", todayDateOnly)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000),

    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .order("first_name", { ascending: true })
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
  if (membershipsError) {
    throw new Error(
      `Failed to load membership report data: ${membershipsError.message}`,
    );
  }
  if (eventRegistrationsError) {
    throw new Error(
      `Failed to load event revenue report data: ${eventRegistrationsError.message}`,
    );
  }
  if (expensesError) {
    throw new Error(
      `Failed to load expense report data: ${expensesError.message}`,
    );
  }
  if (instructorsError) {
    throw new Error(
      `Failed to load instructor report data: ${instructorsError.message}`,
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
  const typedMemberships = (memberships ?? []) as ClientMembershipRow[];
  const typedEventRegistrations =
    (eventRegistrations ?? []) as EventRegistrationRevenueRow[];
  const typedExpenses = (expenses ?? []) as ExpenseRow[];
  const typedInstructors = (instructors ?? []) as InstructorRow[];

  const paidPayments = typedPayments.filter((item) => item.status === "paid");
  const pendingPayments = typedPayments.filter(
    (item) => item.status === "pending",
  );
  const refundedPayments = typedPayments.filter(
    (item) => item.status === "refunded",
  );

  const floorRentalPayments = paidPayments.filter(isFloorRentalPayment);
  const nonFloorStudioPayments = paidPayments.filter(
    (payment) => !isFloorRentalPayment(payment),
  );

  const floorRentalRevenueTotal = floorRentalPayments.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );

  const studioPaymentRevenueTotal = nonFloorStudioPayments.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );

  const averagePaidPayment =
    nonFloorStudioPayments.length > 0
      ? studioPaymentRevenueTotal / nonFloorStudioPayments.length
      : 0;

  const paidEventRegistrations = typedEventRegistrations.filter(
    (item) => item.payment_status === "paid" || item.payment_status === "partial",
  );

  const refundedEventRegistrations = typedEventRegistrations.filter(
    (item) => item.payment_status === "refunded",
  );

  const eventRevenueTotal = paidEventRegistrations.reduce(
    (sum, item) => sum + Number(item.total_amount ?? item.total_price ?? 0),
    0,
  );

  const eventRefundedTotal = refundedEventRegistrations.reduce(
    (sum, item) => sum + Number(item.total_amount ?? item.total_price ?? 0),
    0,
  );

  const manualExpensesTotal = typedExpenses.reduce(
    (sum, item) => sum + Number(item.amount ?? 0),
    0,
  );

  const floorFeeExpenseTotal = typedExpenses
    .filter((item) => item.category === "floor_fee")
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);

  const otherExpensesTotal = manualExpensesTotal - floorFeeExpenseTotal;

  const revenueTotal =
    studioPaymentRevenueTotal + eventRevenueTotal + floorRentalRevenueTotal;

  const refundedTotal =
    refundedPayments.reduce((sum, item) => sum + Number(item.amount ?? 0), 0) +
    eventRefundedTotal;

  const knownFeesTotal = 0;

  const estimatedNetIncome =
    revenueTotal - refundedTotal - manualExpensesTotal - knownFeesTotal;

  const paidRevenueItemsCount =
    paidPayments.length + paidEventRegistrations.length;

  const packageRevenueSnapshot = typedPackages.reduce(
    (sum, item) => sum + Number(item.sold_price ?? item.price_snapshot ?? 0),
    0,
  );

  const membershipRevenueSnapshot = typedMemberships.reduce(
    (sum, item) =>
      sum +
      Number(item.price_snapshot ?? 0) +
      Number(item.signup_fee_snapshot ?? 0),
    0,
  );

  const leadsOnly = typedLeads.filter((item) => item.status === "lead");
  const convertedLeads = typedLeads.filter((item) => item.status === "active");
  const archivedLeads = typedLeads.filter((item) => item.status === "archived");

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
  const topAppointmentTypes = sortEntriesDesc(appointmentTypeCounts).slice(0, 5);
  const topPackages = sortEntriesDesc(packageCounts).slice(0, 5);

  const conversionRate = percentage(
    convertedLeads.length,
    leadsOnly.length + convertedLeads.length,
  );

  const attendanceRate = percentage(
    attendedAppointments.length,
    attendedAppointments.length + cancelledAppointments.length + noShows.length,
  );

  const instructorNameById = new Map(
    typedInstructors.map((instructor) => [
      instructor.id,
      [instructor.first_name ?? "", instructor.last_name ?? ""].join(" ").trim() ||
        "Unnamed Instructor",
    ]),
  );

  const instructorStatsById = new Map<string, InstructorSummary>();

  for (const appointment of typedAppointments) {
    const instructorId = appointment.instructor_id ?? "unassigned";
    const existing = instructorStatsById.get(instructorId) ?? {
      instructorId,
      name:
        instructorId === "unassigned"
          ? "Unassigned"
          : instructorNameById.get(instructorId) ??
            `Instructor ${instructorId.slice(0, 8)}`,
      totalAppointments: 0,
      attended: 0,
      scheduled: 0,
      cancelled: 0,
      noShows: 0,
      minutes: 0,
      revenue: 0,
    };

    existing.totalAppointments += 1;
    existing.minutes += Number(appointment.duration_minutes ?? 0);

    if (appointment.status === "attended") existing.attended += 1;
    if (appointment.status === "scheduled") existing.scheduled += 1;
    if (appointment.status === "cancelled") existing.cancelled += 1;
    if (appointment.status === "no_show") existing.noShows += 1;
    if (appointment.payment_status === "paid") {
      existing.revenue += Number(appointment.price_amount ?? 0);
    }

    instructorStatsById.set(instructorId, existing);
  }

  const instructorSummaries = Array.from(instructorStatsById.values()).sort(
    (a, b) => b.totalAppointments - a.totalAppointments,
  );

  const totalInstructorMinutes = instructorSummaries.reduce(
    (sum, item) => sum + item.minutes,
    0,
  );

  const totalInstructorRevenue = instructorSummaries.reduce(
    (sum, item) => sum + item.revenue,
    0,
  );

  return (
    <div className="space-y-8">
      <section className="rounded-[32px] border border-white/15 bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Reports
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Track studio performance, client activity, revenue, expenses, and
              package usage from one place for {rangeLabel(range).toLowerCase()}.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              ["today", "Today"],
              ["month", "Month"],
              ["last30", "Last 30 Days"],
              ["quarter", "Quarter"],
              ["year", "Year"],
            ].map(([value, label]) => (
              <Link
                key={value}
                href={`/app/reports?range=${value}`}
                className={`rounded-full border px-4 py-2 text-sm font-medium ${
                  range === value
                    ? "border-white bg-white text-slate-950"
                    : "border-white/25 bg-white/10 text-white hover:bg-white/15"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Revenue Collected</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtCurrency(revenueTotal)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {fmtNumber(paidRevenueItemsCount)} paid revenue records in{" "}
            {rangeLabel(range).toLowerCase()}.
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Expenses Recorded</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {fmtCurrency(manualExpensesTotal)}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Includes {fmtCurrency(floorFeeExpenseTotal)} in floor fees.
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
        <div className="rounded-3xl border border-[#E9D5FF] bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Profit & Loss
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Profit & Loss Summary
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Review income, refunds, expenses, and estimated net income for{" "}
                {rangeLabel(range).toLowerCase()}.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full bg-[#F3E8FF] px-3 py-1 text-xs font-semibold text-[#6B21A8] ring-1 ring-[#E9D5FF]">
              {rangeLabel(range)}
            </span>
          </div>

          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between rounded-2xl bg-emerald-50 px-4 py-3">
              <span className="text-sm font-medium text-emerald-900">
                Income collected
              </span>
              <span className="text-sm font-semibold text-emerald-900">
                {fmtCurrency(revenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Studio payments
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(studioPaymentRevenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Event / ticket registrations
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(eventRevenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Floor rental revenue
              </span>
              <span className="text-sm font-semibold text-slate-950">
                {fmtCurrency(floorRentalRevenueTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Refunds recorded
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(refundedTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-rose-50 px-4 py-3">
              <span className="text-sm font-medium text-rose-900">
                Expenses recorded
              </span>
              <span className="text-sm font-semibold text-rose-900">
                -{fmtCurrency(manualExpensesTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Floor rental / floor fee expenses
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(floorFeeExpenseTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Other expenses
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(otherExpensesTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">
                Known processing/platform fees
              </span>
              <span className="text-sm font-semibold text-slate-950">
                -{fmtCurrency(knownFeesTotal)}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-2xl border border-[#D8B4FE] bg-[#FCF8FF] px-4 py-4">
              <span className="text-sm font-semibold text-slate-950">
                Estimated net income
              </span>
              <span className="text-xl font-semibold text-[#5B197A]">
                {fmtCurrency(estimatedNetIncome)}
              </span>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            This report uses revenue, refunds, and manually recorded expenses
            currently available in DanceFlow. Floor fees paid to outside studios
            are treated as expenses. Floor rental fees collected by a host studio
            are treated as revenue.
          </div>
        </div>

        <div className="rounded-3xl border border-[#E9D5FF] bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Instructor Stats
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Instructor Activity
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Review instructor appointment activity in the selected range.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
              {rangeLabel(range)}
            </span>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Instructors</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(instructorSummaries.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Teaching Hours</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(Math.round(totalInstructorMinutes / 60))}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid Lesson Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(totalInstructorRevenue)}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            {instructorSummaries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                No instructor activity found for this range.
              </div>
            ) : (
              instructorSummaries.slice(0, 5).map((instructor) => (
                <div
                  key={instructor.instructorId}
                  className="rounded-2xl bg-slate-50 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-slate-950">
                        {instructor.name}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {fmtNumber(instructor.attended)} attended ·{" "}
                        {fmtNumber(instructor.scheduled)} scheduled ·{" "}
                        {fmtNumber(instructor.noShows)} no-shows
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-sm font-semibold text-slate-950">
                        {fmtNumber(instructor.totalAppointments)}
                      </p>
                      <p className="text-xs text-slate-500">appointments</p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
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
                Studio payments plus event registration revenue by status,
                method, and sale type.
              </p>
            </div>
            <Link
              href="/app/payments"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Payments
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid Payments</p>
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

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid Event Registrations</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(paidEventRegistrations.length)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {fmtCurrency(eventRevenueTotal)} event/ticket revenue
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

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Average Paid Studio Payment</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(averagePaidPayment)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Studio Payment Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(studioPaymentRevenueTotal)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Event/Ticket Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(eventRevenueTotal)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Floor Rental Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(floorRentalRevenueTotal)}
              </p>
            </div>
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
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                Expenses snapshot
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Manual business expenses recorded for the selected date range.
              </p>
            </div>
            <Link
              href="/app/expenses"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Open Expenses
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Total Expenses</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(manualExpensesTotal)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Floor Fees</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(floorFeeExpenseTotal)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Expense Records</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(typedExpenses.length)}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            {typedExpenses.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                No expenses found for this range.
              </div>
            ) : (
              typedExpenses.slice(0, 5).map((expense) => (
                <div
                  key={expense.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {expense.vendor_name}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {expenseCategoryLabel(expense.category)} •{" "}
                        {labelize(expense.payment_method)} •{" "}
                        {new Date(
                          `${expense.expense_date}T00:00:00`,
                        ).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>

                    <p className="font-semibold text-slate-950">
                      {fmtCurrency(Number(expense.amount ?? 0))}
                    </p>
                  </div>

                  {expense.notes ? (
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {expense.notes}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            P&L notes
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Floor fees are separated so independent instructors and studios can
            understand them correctly.
          </p>

          <div className="mt-6 space-y-3 text-sm leading-6">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
              <p className="font-semibold">Host studio collecting floor rent</p>
              <p className="mt-1">
                Floor rental payments collected from instructors are counted as
                revenue.
              </p>
            </div>

            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
              <p className="font-semibold">Instructor paying floor fees</p>
              <p className="mt-1">
                Floor fees paid to another studio are counted as expenses when
                recorded in Expenses.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-700">
              Future versions can add receipt attachments, deeper category
              breakdowns, and exportable P&L statements.
            </div>
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
              <p className="text-sm text-slate-500">Package Revenue Snapshot</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(packageRevenueSnapshot)}
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
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Membership snapshot
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Membership activity recorded for the selected date range.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Memberships Started</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(typedMemberships.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">
                Membership Revenue Snapshot
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(membershipRevenueSnapshot)}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            Use this section to review membership starts and recorded membership
            revenue for the selected range.
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Event revenue snapshot
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Paid event and ticket registrations recorded for the selected date
            range.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Paid Event Registrations</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtNumber(paidEventRegistrations.length)}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Event/Ticket Revenue</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {fmtCurrency(eventRevenueTotal)}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            Event revenue is calculated from paid event registrations recorded
            during the selected range.
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
                    {labelize(payment.source)} • {fmtDateTime(payment.created_at)}
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


