import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { canViewPayments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import Link from "next/link";
import {
  BadgeDollarSign,
  CreditCard,
  Filter,
  Landmark,
  Receipt,
  RotateCcw,
  Zap,
} from "lucide-react";

type SearchParams = Promise<{
  q?: string;
  status?: string;
  method?: string;
  range?: string;
  source?: string;
  channel?: string;
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
  payment_channel: string | null;
  currency: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_refund_id: string | null;
  refund_amount: number | null;
  refunded_at: string | null;
  external_reference: string | null;
  quick_charge_category: string | null;
  guest_name: string | null;
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

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

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
  if (type === "pay_as_you_go_lesson") return "bg-emerald-50 text-emerald-700";
  if (type === "other") return "bg-orange-50 text-orange-700";
  return "bg-slate-100 text-slate-700";
}

function sourceLabel(source: string | null) {
  if (source === "stripe") return "Stripe";
  if (source === "terminal") return "Card Reader";
  if (source === "manual") return "Manual";
  if (source === "schedule_closeout") return "Daily Closeout";
  if (source === "appointment_detail") return "Lesson Detail";
  if (source === "client_record") return "Client Record";
  if (source === "lesson_payment") return "Lesson Payment";
  return "Unknown";
}

function paymentTypeLabel(type: string | null) {
  if (type === "membership") return "Membership";
  if (type === "package_sale") return "Package Sale";
  if (type === "event_registration") return "Event Registration";
  if (type === "floor_rental") return "Floor Rental";
  if (type === "pay_as_you_go_lesson") return "Lesson Payment";
  if (type === "other") return "Quick / Other";
  return "General";
}

function methodLabel(method: string) {
  if (method === "bank_transfer") return "Bank Transfer";
  if (method === "ach") return "ACH";
  if (method === "card_present") return "In-person card";
  return method.replaceAll("_", " ");
}

function channelLabel(channel: string | null) {
  if (channel === "terminal") return "Card Reader";
  if (channel === "online") return "Online";
  if (channel === "manual") return "Manual";
  return null;
}

function paymentNeedsRefundFulfillmentReview(payment: PaymentRow) {
  if (!payment.refund_amount || Number(payment.refund_amount) <= 0) return false;

  const paymentType = (payment.payment_type ?? "").toLowerCase();
  return [
    "package_sale",
    "package_purchase",
    "membership",
    "lesson",
    "lesson_payment",
    "private_lesson",
    "group_class",
    "pay_as_you_go_lesson",
  ].includes(paymentType);
}

function refundFulfillmentReviewLabel(payment: PaymentRow) {
  const paymentType = (payment.payment_type ?? "").toLowerCase();

  if (paymentType.includes("package")) return "Review package credits and package ledger.";
  if (paymentType === "membership") return "Review membership status, renewal settings, and included balances.";
  if (paymentType.includes("lesson") || paymentType === "group_class") return "Review the linked lesson or class balance.";

  return "Review related client balances before closing this refund.";
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
  return client ? `${client.first_name} ${client.last_name}` : "Walk-in / Guest";
}

function quickChargeLabel(value: string | null) {
  if (value === "group_class") return "Group Class";
  if (value === "social_party") return "Social Party";
  if (value === "practice_party") return "Practice Party";
  if (value === "floor_fee") return "Floor Fee";
  if (value === "private_lesson_ad_hoc") return "Private Lesson";
  if (value === "merchandise") return "Merchandise";
  if (value === "other") return "Other";
  return null;
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
  const channelFilter = params.channel ?? "all";
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
      payment_channel,
      currency,
      stripe_invoice_id,
      stripe_payment_intent_id,
      stripe_charge_id,
      stripe_refund_id,
      refund_amount,
      refunded_at,
      external_reference,
      quick_charge_category,
      guest_name,
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

  if (channelFilter !== "all") {
    paymentsQuery = paymentsQuery.eq("payment_channel", channelFilter);
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

  if (paymentsError) {
    throw new Error(`Failed to load payments: ${paymentsError.message}`);
  }

  if (monthlyPaidError) {
    throw new Error(
      `Failed to load monthly paid revenue: ${monthlyPaidError.message}`
    );
  }

  if (paymentsCountError) {
    throw new Error(
      `Failed to load payment count: ${paymentsCountError.message}`
    );
  }

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
      payment.payment_channel ?? "",
      payment.notes ?? "",
      payment.stripe_invoice_id ?? "",
      payment.external_reference ?? "",
      payment.quick_charge_category ?? "",
      payment.guest_name ?? "",
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
  const refundedCount = typedPayments.filter(
    (p) => p.status === "refunded"
  ).length;
  const stripeCount = typedPayments.filter((p) => p.source === "stripe").length;
  const terminalCount = typedPayments.filter(
    (p) => p.payment_channel === "terminal"
  ).length;
  const manualCount = typedPayments.filter(
    (p) => (p.source ?? "manual") === "manual"
  ).length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
  Client Payments
</h1>

<p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
  Review package sales, membership payments, floor rental payments, quick charges,
  and manual transactions from one searchable payment history.
</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/payments/quick-charge"
                className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-white/90"
              >
                <Zap className="h-4 w-4" />
                Quick Charge
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
  <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
    <h2 className="text-lg font-semibold text-sky-950">
      Payment History
    </h2>
    <p className="mt-2 text-sm leading-7 text-sky-900">
      Quickly review every client payment, including packages, memberships,
      floor rentals, events, quick charges, and general balance payments.
    </p>
  </div>

  <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
    <h2 className="text-lg font-semibold text-violet-950">
      Find What You Need
    </h2>
    <p className="mt-2 text-sm leading-7 text-violet-900">
      Use filters to search by client, date range, status, method, source, or
      payment type when questions come up.
    </p>
  </div>

  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
    <h2 className="text-lg font-semibold text-amber-950">
      Front Desk Confidence
    </h2>
    <p className="mt-2 text-sm leading-7 text-amber-900">
      Give staff a simple place to confirm whether a payment was paid,
      pending, refunded, manual, or processed through Stripe.
    </p>
  </div>
</div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Visible Payments"
          value={typedPayments.length}
          icon={Receipt}
        />
        <StatCard
          label="Lifetime Total Payments"
          value={paymentsCount ?? 0}
          icon={BadgeDollarSign}
        />
        <StatCard
          label="This Month"
          value={fmtCurrency(monthlyRevenue)}
          icon={CreditCard}
        />
        <StatCard
          label="Average Visible Payment"
          value={fmtCurrency(averagePayment)}
          icon={Landmark}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <StatCard label="Paid" value={paidCount} icon={CreditCard} />
        <StatCard label="Pending" value={pendingCount} icon={Receipt} />
        <StatCard label="Refunded" value={refundedCount} icon={RotateCcw} />
        <StatCard label="Stripe" value={stripeCount} icon={CreditCard} />
        <StatCard label="Card Reader" value={terminalCount} icon={CreditCard} />
        <StatCard label="Manual" value={manualCount} icon={Landmark} />
      </div>

      <form className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Filter className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Filter payment activity
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Search by client, transaction reference, source, type, or narrow
              the visible payment window.
            </p>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_repeat(6,minmax(0,1fr))]">
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
            <label htmlFor="channel" className="mb-1 block text-sm font-medium">
              Channel
            </label>
            <select
              id="channel"
              name="channel"
              defaultValue={channelFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="terminal">Card Reader</option>
              <option value="online">Online</option>
              <option value="manual">Manual</option>
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
              <option value="other">Quick / Other</option>
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
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-slate-500 shadow-sm">
            <p className="text-base font-medium text-slate-900">
              No payments match your current filters.
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Adjust the filters above to broaden the payment view.
            </p>
          </div>
        ) : (
          typedPayments.map((payment) => {
            const currency = (payment.currency ?? "usd").toUpperCase();
            const membershipName = getMembershipName(payment.client_memberships);
            const packageName = getPackageName(payment.client_packages);
            const quickLabel = quickChargeLabel(payment.quick_charge_category);
            const displayName = payment.guest_name || getClientName(payment.clients);

            return (
              <div
                key={payment.id}
                className="rounded-2xl border bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-lg font-semibold text-slate-900">
                        {displayName}
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
                          Quick Charge
                        </p>
                        <p className="mt-1 break-words text-sm font-medium text-slate-900">
                          {quickLabel ?? "—"}
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
                        {channelLabel(payment.payment_channel) ? (
                          <p className="mt-1 text-xs text-slate-500">
                            {channelLabel(payment.payment_channel)}
                          </p>
                        ) : null}
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
                          Linked Record
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {payment.payment_channel === "terminal" &&
                        payment.status !== "paid" ? (
                          <Link
                            href={`/app/payments/terminal/${payment.id}`}
                            className="font-medium text-[var(--brand-primary)] underline"
                          >
                            Open card reader collection
                          </Link>
                        ) : payment.payment_type === "pay_as_you_go_lesson" &&
                          payment.external_reference ? (
                            <Link
                              href={`/app/schedule/${payment.external_reference}`}
                              className="text-[var(--brand-primary)] hover:underline"
                            >
                              Open linked lesson
                            </Link>
                          ) : payment.quick_charge_category ? (
                            "Quick charge"
                          ) : payment.payment_type === "membership" ? (
                            "Membership billing"
                          ) : payment.payment_type === "package_sale" ? (
                            "Package sale"
                          ) : payment.payment_type === "event_registration" ? (
                            "Event registration"
                          ) : payment.stripe_invoice_id ||
                            payment.stripe_payment_intent_id ||
                            payment.stripe_charge_id ? (
                            "Stripe payment"
                          ) : payment.external_reference ? (
                            "Linked record"
                          ) : (
                            "—"
                          )}
                        </p>
                      </div>
                    </div>

                    {payment.notes ? (
                      <div className="mt-4 rounded-xl bg-slate-50 p-4">
                        <p className="text-sm text-slate-600">
                          {payment.notes}
                        </p>
                      </div>
                    ) : null}

                    {payment.refund_amount && Number(payment.refund_amount) > 0 ? (
                      <div className="mt-4 space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
                        <p>
                          Refunded {fmtCurrency(Number(payment.refund_amount), currency)}
                          {payment.refunded_at ? ` on ${fmtDateTime(payment.refunded_at)}` : ""}
                          {payment.stripe_refund_id ? ` · Stripe refund ${payment.stripe_refund_id}` : ""}
                        </p>
                        {paymentNeedsRefundFulfillmentReview(payment) ? (
                          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
                            <p className="font-semibold">Refund review needed</p>
                            <p className="mt-1 leading-6">
                              {refundFulfillmentReviewLabel(payment)}
                            </p>
                          </div>
                        ) : null}
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
