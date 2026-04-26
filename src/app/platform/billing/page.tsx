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
  if (status === "cancelled" || status === "canceled") return "bg-red-50 text-red-700";
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
  if (status === "cancelled" || status === "canceled") return "Canceled";
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

function hasActiveBillingAccess(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

function hasPaidPlan(subscription: SubscriptionRow | undefined) {
  if (!subscription) return false;
  const plan = getPlan(subscription.subscription_plans);
  return Boolean(plan?.code || plan?.name || subscription.stripe_subscription_id);
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
const trialingWithoutEndDateCount = typedSubscriptions.filter(
  (s) => s.status === "trialing" && !s.trial_ends_at
).length;
const nextTrialEnding = typedSubscriptions
  .filter((s) => s.status === "trialing" && daysUntil(s.trial_ends_at) !== null)
  .map((subscription) => ({
    subscription,
    days: daysUntil(subscription.trial_ends_at),
  }))
  .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999))[0];

const pastDueCount = typedSubscriptions.filter((s) => s.status === "past_due").length;
  const cancelledCount = typedSubscriptions.filter((s) => s.status === "cancelled" || s.status === "canceled").length;

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
      return subscription.status === "past_due" || subscription.status === "cancelled" || subscription.status === "canceled";
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

  const paidAccessWithoutActiveSubscription = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const plan = subscription ? getPlan(subscription.subscription_plans) : null;

      return {
        studio,
        subscription,
        plan,
        status: subscription?.status ?? "no_subscription",
      };
    })
    .filter(({ subscription }) => {
      if (!hasPaidPlan(subscription)) return false;
      return !hasActiveBillingAccess(subscription?.status);
    });

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
            DanceFlow Platform Admin
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            Billing Oversight
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-white/85 md:text-base">
            Monitor subscriptions, trial health, invoice activity, and paid-plan access so no studio or organizer uses paid features without an active subscription.
          </p>
        </div>

        <div className="grid gap-4 border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 p-6 md:grid-cols-3 xl:grid-cols-6">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <p className="text-sm text-emerald-700">Active</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-950">{activeCount}</p>
          </div>

          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
  <p className="text-sm text-sky-700">Trialing</p>
  <p className="mt-2 text-3xl font-semibold text-sky-950">{trialingCount}</p>
  <p className="mt-2 text-xs font-medium text-sky-700">
    {nextTrialEnding?.days != null
      ? nextTrialEnding.days < 0
        ? "A trial is expired"
        : nextTrialEnding.days === 0
          ? "Next trial ends today"
          : `Next trial ends in ${nextTrialEnding.days} day${nextTrialEnding.days === 1 ? "" : "s"}`
      : trialingWithoutEndDateCount > 0
        ? `${trialingWithoutEndDateCount} missing trial end date`
        : "No trial end dates pending"}
  </p>
</div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <p className="text-sm text-amber-700">Past Due</p>
            <p className="mt-2 text-3xl font-semibold text-amber-950">{pastDueCount}</p>
          </div>

          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
            <p className="text-sm text-rose-700">Canceled</p>
            <p className="mt-2 text-3xl font-semibold text-rose-950">{cancelledCount}</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Monthly</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">{monthlyCount}</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Yearly</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">{yearlyCount}</p>
          </div>
        </div>
      </section>

      {paidAccessWithoutActiveSubscription.length > 0 ? (
        <section className="rounded-[32px] border border-rose-200 bg-rose-50 p-6 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">
                Launch Alert
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-rose-950">
                Paid-plan access without active subscription
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-rose-800">
                These accounts have a paid plan or Stripe subscription reference, but their subscription is not active or trialing. Review them before launch so paid workspaces are not being used for free.
              </p>
            </div>
            <span className="rounded-full bg-rose-100 px-4 py-2 text-sm font-semibold text-rose-800 ring-1 ring-rose-200">
              {paidAccessWithoutActiveSubscription.length} to review
            </span>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-rose-200 bg-white">
            <table className="min-w-full divide-y divide-rose-100 text-sm">
              <thead className="bg-rose-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-rose-900">Account</th>
                  <th className="px-4 py-3 text-left font-medium text-rose-900">Plan</th>
                  <th className="px-4 py-3 text-left font-medium text-rose-900">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-rose-900">Stripe Subscription</th>
                  <th className="px-4 py-3 text-left font-medium text-rose-900">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rose-100">
                {paidAccessWithoutActiveSubscription.map(({ studio, subscription, plan, status }) => (
                  <tr key={studio.id}>
                    <td className="px-4 py-4">
                      <Link href={`/platform/studios/${studio.id}`} className="font-medium text-slate-950 underline">
                        {studio.name}
                      </Link>
                    </td>
                    <td className="px-4 py-4 text-slate-700">{plan?.name ?? "Paid plan"}</td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(status)}`}>
                        {statusLabel(status)}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-slate-700">{subscription?.stripe_subscription_id ?? "—"}</td>
                    <td className="px-4 py-4 text-slate-700">{formatDate(studio.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800 shadow-sm">
          No paid-plan access without an active or trialing subscription was detected.
        </section>
      )}

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