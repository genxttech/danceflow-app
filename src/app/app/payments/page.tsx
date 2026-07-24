import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { canViewPayments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import SellWorkspaceHeader from "@/components/app/sell/SellWorkspaceHeader";
import Link from "next/link";
import {
  ArrowUpRight,
  BadgeDollarSign,
  CreditCard,
  Filter,
  Receipt,
  RotateCcw,
  WalletCards,
} from "lucide-react";

type SearchParams = Promise<{
  q?: string;
  status?: string;
  method?: string;
  range?: string;
  type?: string;
}>;

type PaymentRow = {
  id: string;
  package_sale_id: string | null;
  payment_arrangement_id: string | null;
  amount: number;
  payment_method: string;
  status: string;
  created_at: string;
  notes: string | null;
  source: string | null;
  payment_type: string | null;
  payment_channel: string | null;
  currency: string | null;
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

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(value ?? 0));
}

function formatDate(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relationName(
  value:
    | { name_snapshot: string | null }
    | { name_snapshot: string | null }[]
    | null,
) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name_snapshot ?? null;
}

function clientName(value: PaymentRow["clients"], guestName: string | null) {
  if (guestName) return guestName;
  const client = Array.isArray(value) ? value[0] : value;
  return client
    ? `${client.first_name} ${client.last_name}`.trim()
    : "Walk-in / Guest";
}

function statusClass(status: string) {
  if (status === "paid") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "pending") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (status === "failed") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (status === "refunded") return "bg-blue-50 text-blue-700 ring-blue-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function typeLabel(payment: PaymentRow) {
  if (payment.payment_arrangement_id) {
    return `${relationName(payment.client_packages) || "Package"} installment`;
  }
  if (payment.payment_type === "package_sale") {
    return relationName(payment.client_packages) || "Package sale";
  }
  if (payment.payment_type === "membership") {
    return relationName(payment.client_memberships) || "Membership";
  }
  if (payment.payment_type === "floor_rental") return "Floor rental";
  if (payment.payment_type === "event_registration") return "Event registration";
  if (payment.payment_type === "pay_as_you_go_lesson") return "Lesson payment";
  if (payment.quick_charge_category) {
    return payment.quick_charge_category.replaceAll("_", " ");
  }
  return payment.notes?.split("|")[0]?.trim() || "General payment";
}

function methodLabel(value: string) {
  if (value === "ach") return "ACH";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function startOfRange(value: string) {
  const now = new Date();
  if (value === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  if (value === "last30") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            {label}
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-xl bg-[var(--brand-primary-soft)] p-2.5 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const range = params.range ?? "month";
  const status = params.status ?? "all";
  const method = params.method ?? "all";
  const type = params.type ?? "all";
  const q = (params.q ?? "").trim().toLowerCase();

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewPayments(context.studioRole ?? "")) {
    redirect("/app");
  }

  let query = supabase
    .from("payments")
    .select(`
      id,
      package_sale_id,
      payment_arrangement_id,
      amount,
      payment_method,
      status,
      created_at,
      notes,
      source,
      payment_type,
      payment_channel,
      currency,
      refund_amount,
      refunded_at,
      external_reference,
      quick_charge_category,
      guest_name,
      client_memberships (name_snapshot),
      client_packages (name_snapshot),
      clients (first_name, last_name)
    `)
    .eq("studio_id", context.studioId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (range !== "all") query = query.gte("created_at", startOfRange(range));
  if (status !== "all") query = query.eq("status", status);
  if (method !== "all") query = query.eq("payment_method", method);
  if (type !== "all") query = query.eq("payment_type", type);

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load payment ledger: ${error.message}`);
  }

  const payments = ((data ?? []) as PaymentRow[]).filter((payment) => {
    if (!q) return true;
    return [
      clientName(payment.clients, payment.guest_name),
      typeLabel(payment),
      payment.payment_method,
      payment.status,
      payment.notes ?? "",
      payment.external_reference ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  const paid = payments.filter((payment) => payment.status === "paid");
  const pending = payments.filter((payment) => payment.status === "pending");
  const refunded = payments.filter((payment) => payment.status === "refunded");

  const paidTotal = paid.reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
  const pendingTotal = pending.reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
  const refundedTotal = refunded.reduce(
    (sum, payment) => sum + Number(payment.refund_amount ?? payment.amount ?? 0),
    0,
  );

  return (
    <div className="space-y-6 p-1">
      <SellWorkspaceHeader
        role={context.studioRole}
        isPlatformAdmin={context.isPlatformAdmin}
        eyebrow="Revenue operations"
        title="Payment Ledger"
        description="Review every payment as a financial transaction with its date, client, description, method, amount, and status."
        actions={(
          <Link href="/app/payments/take" className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95">
            <WalletCards className="h-4 w-4" />
            Take payment
          </Link>
        )}
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Stat label="Collected" value={formatMoney(paidTotal)} icon={BadgeDollarSign} />
        <Stat label="Pending" value={formatMoney(pendingTotal)} icon={Receipt} />
        <Stat label="Refunded" value={formatMoney(refundedTotal)} icon={RotateCcw} />
        <Stat label="Visible entries" value={String(payments.length)} icon={CreditCard} />
      </section>

      <form className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-[var(--brand-primary-soft)] p-2.5 text-[var(--brand-primary)]">
            <Filter className="h-4 w-4" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-950">Filter ledger</h2>
            <p className="text-sm text-slate-500">Narrow the visible transaction rows.</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[1.5fr_repeat(4,1fr)_auto]">
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Client, description, method, reference..."
            className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
          />

          <select name="range" defaultValue={range} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
            <option value="today">Today</option>
            <option value="month">This month</option>
            <option value="last30">Last 30 days</option>
            <option value="all">All time</option>
          </select>

          <select name="status" defaultValue={status} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
            <option value="all">All statuses</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
          </select>

          <select name="method" defaultValue={method} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
            <option value="all">All methods</option>
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="check">Check</option>
            <option value="ach">ACH</option>
            <option value="venmo">Venmo</option>
            <option value="zelle">Zelle</option>
            <option value="other">Other</option>
          </select>

          <select name="type" defaultValue={type} className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm">
            <option value="all">All payment types</option>
            <option value="package_sale">Package sales</option>
            <option value="membership">Memberships</option>
            <option value="floor_rental">Floor rentals</option>
            <option value="event_registration">Events</option>
            <option value="general">General</option>
          </select>

          <button className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">
            Apply
          </button>
        </div>
      </form>

      <section className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
        <div className="hidden grid-cols-[155px_minmax(180px,1fr)_minmax(220px,1.4fr)_130px_125px_105px_48px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 lg:grid">
          <span>Date</span>
          <span>Client</span>
          <span>Description</span>
          <span>Method</span>
          <span className="text-right">Amount</span>
          <span>Status</span>
          <span />
        </div>

        {payments.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-semibold text-slate-950">No ledger entries match these filters.</p>
            <p className="mt-2 text-sm text-slate-500">Broaden the date range or clear one of the filters.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {payments.map((payment) => {
              const currency = (payment.currency ?? "usd").toUpperCase();
              return (
                <div
                  key={payment.id}
                  className="grid gap-3 px-5 py-4 transition hover:bg-slate-50 lg:grid-cols-[155px_minmax(180px,1fr)_minmax(220px,1.4fr)_130px_125px_105px_48px] lg:items-center lg:gap-4"
                >
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Date</p>
                    <p className="text-sm text-slate-700">{formatDate(payment.created_at)}</p>
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Client</p>
                    <p className="truncate font-semibold text-slate-950">
                      {clientName(payment.clients, payment.guest_name)}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Description</p>
                    <p className="truncate text-sm font-medium capitalize text-slate-800">
                      {typeLabel(payment)}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {payment.payment_arrangement_id ? (
                        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                          Payment arrangement
                        </span>
                      ) : payment.package_sale_id ? (
                        <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-[11px] font-semibold text-cyan-700">
                          Split sale
                        </span>
                      ) : null}
                      {payment.payment_channel ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                          {payment.payment_channel.replaceAll("_", " ")}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Method</p>
                    <p className="text-sm font-medium text-slate-800">
                      {methodLabel(payment.payment_method)}
                    </p>
                  </div>

                  <div className="lg:text-right">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Amount</p>
                    <p className="font-semibold text-slate-950">
                      {formatMoney(Number(payment.amount ?? 0), currency)}
                    </p>
                  </div>

                  <div>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1 ${statusClass(payment.status)}`}>
                      {payment.status}
                    </span>
                  </div>

                  <div>
                    {payment.payment_channel === "terminal" && payment.status !== "paid" ? (
                      <Link
                        href={`/app/payments/terminal/${payment.id}`}
                        aria-label="Open terminal payment"
                        className="inline-flex rounded-lg p-2 text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                      >
                        <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
