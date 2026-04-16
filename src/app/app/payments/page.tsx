import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { canViewPayments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import Link from "next/link";

type SearchParams = Promise<{
  q?: string;
  status?: string;
  method?: string;
  range?: string;
  source?: string;
  type?: string;
}>;

type PaymentRow = {
  id: string;
  amount: number;
  payment_method: string;
  status: string;
  created_at: string;
  notes: string | null;
  source: string | null;
  payment_type: string | null;
  currency: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  external_reference: string | null;
  client_memberships:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null;
  client_packages:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusBadgeClass(status: string) {
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "refunded") return "bg-blue-50 text-blue-700";
  return "bg-slate-100 text-slate-700";
}

function sourceBadgeClass(source: string) {
  if (source === "stripe") return "bg-indigo-50 text-indigo-700";
  if (source === "manual") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function paymentTypeBadgeClass(type: string) {
  if (type === "membership") return "bg-purple-50 text-purple-700";
  if (type === "package_sale") return "bg-cyan-50 text-cyan-700";
  if (type === "event_registration") return "bg-rose-50 text-rose-700";
  if (type === "floor_rental") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function sourceLabel(source: string | null) {
  if (source === "stripe") return "Stripe";
  if (source === "manual") return "Manual";
  return "Unknown";
}

function paymentTypeLabel(type: string | null) {
  if (type === "membership") return "Membership";
  if (type === "package_sale") return "Package Sale";
  if (type === "event_registration") return "Event Registration";
  if (type === "floor_rental") return "Floor Rental";
  if (type === "other") return "Other";
  return "General";
}

function methodLabel(method: string) {
  if (method === "bank_transfer") return "Bank Transfer";
  if (method === "ach") return "ACH";
  return method.replaceAll("_", " ");
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

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getPackageName(
  value:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null
) {
  const pkg = Array.isArray(value) ? value[0] : value;
  return pkg?.name_snapshot ?? "—";
}

function getMembershipName(
  value:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null
) {
  const membership = Array.isArray(value) ? value[0] : value;
  return membership?.name_snapshot ?? "—";
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = params.status ?? "all";
  const methodFilter = params.method ?? "all";
  const rangeFilter = params.range ?? "month";
  const sourceFilter = params.source ?? "all";
  const typeFilter = params.type ?? "all";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewPayments(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const monthStart = startOfMonthLocal().toISOString();
  const todayStart = startOfTodayLocal().toISOString();
  const last30Start = startOfLast30DaysLocal().toISOString();

  let paymentsQuery = supabase
    .from("payments")
    .select(`
      id,
      amount,
      payment_method,
      status,
      created_at,
      notes,
      source,
      payment_type,
      currency,
      stripe_invoice_id,
      stripe_payment_intent_id,
      stripe_charge_id,
      external_reference,
      client_memberships (
        name_snapshot
      ),
      client_packages (
        name_snapshot
      ),
      clients (
        first_name,
        last_name
      )
    `)
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false });

  if (rangeFilter === "today") {
    paymentsQuery = paymentsQuery.gte("created_at", todayStart);
  } else if (rangeFilter === "month") {
    paymentsQuery = paymentsQuery.gte("created_at", monthStart);
  } else if (rangeFilter === "last30") {
    paymentsQuery = paymentsQuery.gte("created_at", last30Start);
  }

  if (statusFilter !== "all") {
    paymentsQuery = paymentsQuery.eq("status", statusFilter);
  }

  if (methodFilter !== "all") {
    paymentsQuery = paymentsQuery.eq("payment_method", methodFilter);
  }

  if (sourceFilter !== "all") {
    paymentsQuery = paymentsQuery.eq("source", sourceFilter);
  }

  if (typeFilter !== "all") {
    paymentsQuery = paymentsQuery.eq("payment_type", typeFilter);
  }

  const [
    { data: payments, error: paymentsError },
    { data: monthlyPaid, error: monthlyPaidError },
    { count: paymentsCount, error: paymentsCountError },
  ] = await Promise.all([
    paymentsQuery,
    supabase
      .from("payments")
      .select("amount, currency")
      .eq("studio_id", studioId)
      .eq("status", "paid")
      .gte("created_at", monthStart),
    supabase
      .from("payments")
      .select("*", { count: "exact", head: true })
      .eq("studio_id", studioId),
  ]);

  if (paymentsError) throw new Error(`Failed to load payments: ${paymentsError.message}`);
  if (monthlyPaidError) throw new Error(`Failed to load monthly paid revenue: ${monthlyPaidError.message}`);
  if (paymentsCountError) throw new Error(`Failed to load payment count: ${paymentsCountError.message}`);

  const typedPayments = ((payments ?? []) as PaymentRow[]).filter((payment) => {
    if (!q) return true;

    const haystack = [
      getClientName(payment.clients),
      getPackageName(payment.client_packages),
      getMembershipName(payment.client_memberships),
      payment.payment_method,
      payment.status,
      payment.source ?? "",
      payment.payment_type ?? "",
      payment.notes ?? "",
      payment.stripe_invoice_id ?? "",
      payment.external_reference ?? "",
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(q);
  });

  const paidRevenueTotal = typedPayments
    .filter((payment) => payment.status === "paid")
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

  const monthlyRevenue = (monthlyPaid ?? []).reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0
  );

  const averagePayment =
    typedPayments.length > 0 ? paidRevenueTotal / typedPayments.length : 0;

  const paidCount = typedPayments.filter((p) => p.status === "paid").length;
  const pendingCount = typedPayments.filter((p) => p.status === "pending").length;
  const refundedCount = typedPayments.filter((p) => p.status === "refunded").length;
  const stripeCount = typedPayments.filter((p) => p.source === "stripe").length;
  const manualCount = typedPayments.filter((p) => (p.source ?? "manual") === "manual").length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Payments</h2>
          <p className="mt-2 text-slate-600">
            Review manual and Stripe payment activity, filter transactions, and monitor totals.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Visible Payments</p>
          <p className="mt-2 text-3xl font-semibold">{typedPayments.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Lifetime Total Payments</p>
          <p className="mt-2 text-3xl font-semibold">{paymentsCount ?? 0}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">This Month</p>
          <p className="mt-2 text-3xl font-semibold">{fmtCurrency(monthlyRevenue)}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Average Visible Payment</p>
          <p className="mt-2 text-3xl font-semibold">{fmtCurrency(averagePayment)}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Paid</p>
          <p className="mt-2 text-3xl font-semibold">{paidCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Pending</p>
          <p className="mt-2 text-3xl font-semibold">{pendingCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Refunded</p>
          <p className="mt-2 text-3xl font-semibold">{refundedCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Stripe</p>
          <p className="mt-2 text-3xl font-semibold">{stripeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Manual</p>
          <p className="mt-2 text-3xl font-semibold">{manualCount}</p>
        </div>
      </div>

      <form className="rounded-2xl border bg-white p-5">
        <div className="grid gap-4 xl:grid-cols-[1.4fr_repeat(5,minmax(0,1fr))]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Client, package, membership, Stripe invoice..."
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="range" className="mb-1 block text-sm font-medium">
              Date Range
            </label>
            <select
              id="range"
              name="range"
              defaultValue={rangeFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="today">Today</option>
              <option value="month">This Month</option>
              <option value="last30">Last 30 Days</option>
              <option value="all">All</option>
            </select>
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
              <option value="refunded">Refunded</option>
            </select>
          </div>

          <div>
            <label htmlFor="method" className="mb-1 block text-sm font-medium">
              Method
            </label>
            <select
              id="method"
              name="method"
              defaultValue={methodFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="check">Check</option>
              <option value="ach">ACH</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div>
            <label htmlFor="source" className="mb-1 block text-sm font-medium">
              Source
            </label>
            <select
              id="source"
              name="source"
              defaultValue={sourceFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="manual">Manual</option>
              <option value="stripe">Stripe</option>
            </select>
          </div>

          <div>
            <label htmlFor="type" className="mb-1 block text-sm font-medium">
              Payment Type
            </label>
            <select
              id="type"
              name="type"
              defaultValue={typeFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="membership">Membership</option>
              <option value="package_sale">Package Sale</option>
              <option value="event_registration">Event Registration</option>
              <option value="floor_rental">Floor Rental</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Apply Filters
          </button>
          <Link
            href="/app/payments"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Reset
          </Link>
        </div>
      </form>

      <div className="space-y-4">
        {typedPayments.length === 0 ? (
          <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">
            No payments match your current filters.
          </div>
        ) : (
          typedPayments.map((payment) => {
            const currency = (payment.currency ?? "usd").toUpperCase();
            const membershipName = getMembershipName(payment.client_memberships);
            const packageName = getPackageName(payment.client_packages);

            return (
              <div
                key={payment.id}
                className="rounded-2xl border bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-lg font-semibold text-slate-900">
                        {getClientName(payment.clients)}
                      </p>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          payment.status
                        )}`}
                      >
                        {payment.status}
                      </span>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceBadgeClass(
                          payment.source ?? "manual"
                        )}`}
                      >
                        {sourceLabel(payment.source)}
                      </span>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentTypeBadgeClass(
                          payment.payment_type ?? "other"
                        )}`}
                      >
                        {paymentTypeLabel(payment.payment_type)}
                      </span>
                    </div>

                    <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Membership
                        </p>
                        <p className="mt-1 break-words text-sm font-medium text-slate-900">
                          {membershipName}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Package
                        </p>
                        <p className="mt-1 break-words text-sm font-medium text-slate-900">
                          {packageName}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Amount
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {fmtCurrency(Number(payment.amount ?? 0), currency)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Method
                        </p>
                        <p className="mt-1 text-sm font-medium capitalize text-slate-900">
                          {methodLabel(payment.payment_method)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Date
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {fmtDateTime(payment.created_at)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Stripe Invoice
                        </p>
                        <p className="mt-1 break-all text-sm font-medium text-slate-900">
                          {payment.stripe_invoice_id ?? "—"}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Payment Intent
                        </p>
                        <p className="mt-1 break-all text-sm font-medium text-slate-900">
                          {payment.stripe_payment_intent_id ?? "—"}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          External Reference
                        </p>
                        <p className="mt-1 break-all text-sm font-medium text-slate-900">
                          {payment.external_reference ?? payment.stripe_charge_id ?? "—"}
                        </p>
                      </div>
                    </div>

                    {payment.notes ? (
                      <div className="mt-4 rounded-xl bg-slate-50 p-4">
                        <p className="text-sm text-slate-600">{payment.notes}</p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}