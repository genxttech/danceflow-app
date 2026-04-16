import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string;
  billing_interval: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  subscription_plans:
    | {
        code: string;
        name: string;
      }
    | {
        code: string;
        name: string;
      }[]
    | null;
};

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
};

type InvoiceRow = {
  id: string;
  studio_id: string;
  studio_subscription_id: string | null;
  stripe_invoice_id: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
};

function getPlan(
  value:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "trialing") return "bg-blue-50 text-blue-700";
  if (status === "past_due") return "bg-amber-50 text-amber-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "open") return "bg-amber-50 text-amber-700";
  if (status === "draft") return "bg-slate-100 text-slate-700";
  if (status === "void") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function statusLabel(status: string) {
  if (status === "trialing") return "Trialing";
  if (status === "active") return "Active";
  if (status === "past_due") return "Past Due";
  if (status === "cancelled") return "Cancelled";
  if (status === "inactive") return "Inactive";
  if (status === "paid") return "Paid";
  if (status === "open") return "Open";
  if (status === "draft") return "Draft";
  if (status === "void") return "Void";
  return status;
}

function daysUntil(dateValue: string | null) {
  if (!dateValue) return null;
  const now = new Date();
  const target = new Date(dateValue);
  const diffMs = target.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export default async function PlatformBillingPage() {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const [
    { data: subscriptions, error: subscriptionsError },
    { data: studios, error: studiosError },
    { data: invoices, error: invoicesError },
  ] = await Promise.all([
    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        studio_id,
        status,
        billing_interval,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        trial_ends_at,
        stripe_subscription_id,
        subscription_plans (
          code,
          name
        )
      `),

    supabase
      .from("studios")
      .select("id, name, created_at")
      .order("created_at", { ascending: false }),

    supabase
      .from("studio_invoices")
      .select(`
        id,
        studio_id,
        studio_subscription_id,
        stripe_invoice_id,
        amount_due,
        amount_paid,
        currency,
        status,
        period_start,
        period_end,
        created_at
      `)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (subscriptionsError) {
    throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  }

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  if (invoicesError) {
    throw new Error(`Failed to load invoices: ${invoicesError.message}`);
  }

  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedStudios = (studios ?? []) as StudioRow[];
  const typedInvoices = (invoices ?? []) as InvoiceRow[];

  const studioById = new Map(typedStudios.map((studio) => [studio.id, studio]));
  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const activeCount = typedSubscriptions.filter((s) => s.status === "active").length;
  const trialingCount = typedSubscriptions.filter((s) => s.status === "trialing").length;
  const pastDueCount = typedSubscriptions.filter((s) => s.status === "past_due").length;
  const cancelledCount = typedSubscriptions.filter((s) => s.status === "cancelled").length;

  const monthlyCount = typedSubscriptions.filter((s) => s.billing_interval === "month").length;
  const yearlyCount = typedSubscriptions.filter((s) => s.billing_interval === "year").length;

  const planMix = typedSubscriptions.reduce<Record<string, number>>((acc, subscription) => {
    const plan = getPlan(subscription.subscription_plans);
    const key = plan?.name ?? "No plan";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const totalInvoicePaid = typedInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount_paid ?? 0),
    0
  );

  const totalInvoiceDue = typedInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount_due ?? 0),
    0
  );

  const billingIssues = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      return { studio, subscription };
    })
    .filter(({ subscription }) => {
      if (!subscription) return true;
      return subscription.status === "past_due" || subscription.status === "cancelled";
    });

  const renewalsEndingSoon = typedSubscriptions
    .map((subscription) => {
      const studio = studioById.get(subscription.studio_id);
      const plan = getPlan(subscription.subscription_plans);
      const days = daysUntil(subscription.current_period_end);

      return {
        subscription,
        studio,
        plan,
        days,
      };
    })
    .filter(
      (item) =>
        item.subscription.status === "active" &&
        item.days != null &&
        item.days >= 0 &&
        item.days <= 14
    )
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));

  const trialsEndingSoon = typedSubscriptions
    .map((subscription) => {
      const studio = studioById.get(subscription.studio_id);
      const plan = getPlan(subscription.subscription_plans);
      const days = daysUntil(subscription.trial_ends_at);

      return {
        subscription,
        studio,
        plan,
        days,
      };
    })
    .filter(
      (item) =>
        item.subscription.status === "trialing" &&
        item.days != null &&
        item.days >= 0 &&
        item.days <= 14
    )
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Billing</h1>
        <p className="mt-2 text-slate-600">
          Monitor SaaS subscriptions, invoice activity, billing issues, renewals, and plan mix across the platform.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Trialing</p>
          <p className="mt-2 text-3xl font-semibold">{trialingCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Past Due</p>
          <p className="mt-2 text-3xl font-semibold">{pastDueCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Cancelled</p>
          <p className="mt-2 text-3xl font-semibold">{cancelledCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Monthly</p>
          <p className="mt-2 text-3xl font-semibold">{monthlyCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Yearly</p>
          <p className="mt-2 text-3xl font-semibold">{yearlyCount}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Revenue Snapshot</h2>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Recent Invoice Paid Total</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                {formatMoney(totalInvoicePaid, "USD")}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Recent Invoice Due Total</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                {formatMoney(totalInvoiceDue, "USD")}
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {Object.keys(planMix).length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500 md:col-span-2">
                No plan mix data yet.
              </div>
            ) : (
              Object.entries(planMix).map(([planName, count]) => (
                <div key={planName} className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">{planName}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{count}</p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Billing Issues</h2>

          {billingIssues.length === 0 ? (
            <div className="mt-5 rounded-xl border border-green-200 bg-green-50 px-4 py-10 text-sm text-green-700">
              No billing issues detected right now.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {billingIssues.map(({ studio, subscription }) => {
                const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                return (
                  <div key={studio.id} className="rounded-xl border bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <Link
                          href={`/platform/studios/${studio.id}`}
                          className="font-medium underline text-slate-900"
                        >
                          {studio.name}
                        </Link>
                        <p className="mt-1 text-sm text-slate-500">
                          {plan?.name ?? "No plan"}
                        </p>
                      </div>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          subscription?.status ?? "inactive"
                        )}`}
                      >
                        {statusLabel(subscription?.status ?? "inactive")}
                      </span>
                    </div>

                    <p className="mt-3 text-sm text-slate-600">
                      Period end: {formatDate(subscription?.current_period_end ?? null)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Renewals Ending Soon</h2>

          {renewalsEndingSoon.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No active renewals ending in the next 14 days.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {renewalsEndingSoon.map((item) => (
                <div key={item.subscription.id} className="rounded-xl border bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Link
                        href={`/platform/studios/${item.subscription.studio_id}`}
                        className="font-medium underline text-slate-900"
                      >
                        {item.studio?.name ?? "Unknown studio"}
                      </Link>
                      <p className="mt-1 text-sm text-slate-500">
                        {item.plan?.name ?? "No plan"} • {item.subscription.billing_interval === "year" ? "Yearly" : "Monthly"}
                      </p>
                    </div>

                    <div className="text-right text-sm text-slate-600">
                      <p>{item.days} days</p>
                      <p>{formatDate(item.subscription.current_period_end)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Trials Ending Soon</h2>

          {trialsEndingSoon.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No trials ending in the next 14 days.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {trialsEndingSoon.map((item) => (
                <div key={item.subscription.id} className="rounded-xl border bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Link
                        href={`/platform/studios/${item.subscription.studio_id}`}
                        className="font-medium underline text-slate-900"
                      >
                        {item.studio?.name ?? "Unknown studio"}
                      </Link>
                      <p className="mt-1 text-sm text-slate-500">
                        {item.plan?.name ?? "No plan"}
                      </p>
                    </div>

                    <div className="text-right text-sm text-slate-600">
                      <p>{item.days} days</p>
                      <p>{formatDate(item.subscription.trial_ends_at)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Recent Invoices</h2>

        {typedInvoices.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
            No invoices yet.
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-xl border">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Studio</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Amount Due</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Amount Paid</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Period</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {typedInvoices.map((invoice) => {
                  const studio = studioById.get(invoice.studio_id);

                  return (
                    <tr key={invoice.id}>
                      <td className="px-4 py-4 text-slate-900">
                        <Link
                          href={`/platform/studios/${invoice.studio_id}`}
                          className="font-medium underline"
                        >
                          {studio?.name ?? "Unknown studio"}
                        </Link>
                      </td>

                      <td className="px-4 py-4">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            invoice.status
                          )}`}
                        >
                          {statusLabel(invoice.status)}
                        </span>
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatMoney(invoice.amount_due, invoice.currency || "USD")}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatMoney(invoice.amount_paid, invoice.currency || "USD")}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatDate(invoice.period_start)} - {formatDate(invoice.period_end)}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatDate(invoice.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}