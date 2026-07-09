import Link from "next/link";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getBillingPlan } from "@/lib/billing/plans";
import { createClient } from "@/lib/supabase/server";

type SearchParams = Promise<{
  range?: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  billing_plan: string | null;
  subscription_status: string | null;
  active: boolean | null;
};

type SubscriptionPlanRow = {
  code: string | null;
  name: string | null;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string | null;
  billing_interval: string | null;
  created_at: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancelled_at: string | null;
  cancel_at_period_end: boolean | null;
  subscription_plans: SubscriptionPlanRow | SubscriptionPlanRow[] | null;
};

type AddonEntitlementRow = {
  id: string;
  studio_id: string | null;
  feature_key: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
};

type StudioInvoiceRow = {
  id: string;
  studio_id: string;
  amount_due: number | null;
  amount_paid: number | null;
  currency: string | null;
  status: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
};

type EventPaymentRow = {
  id: string;
  registration_id: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  source: string | null;
  payment_method: string | null;
  refund_amount: number | null;
  platform_fee_amount: number | null;
  stripe_processing_fee_amount: number | null;
  stripe_application_fee_amount: number | null;
  created_at: string;
};

type EventRegistrationAccountingRow = {
  id: string;
  event_id: string;
  studio_id: string | null;
};

type PlatformExpenseRow = {
  id: string;
  expense_date: string;
  vendor_name: string;
  description: string | null;
  category: string;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  status: string;
  tax_treatment: string | null;
  is_recurring: boolean | null;
  recurrence_frequency: string | null;
  receipt_url: string | null;
  notes: string | null;
  created_at: string;
};

const PLATFORM_TICKET_FEE_RATE = 0.035;
const ORGANIZER_SUITE_ADDON_CENTS = 1200;

const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);
const EVENT_REVENUE_STATUSES = new Set([
  "paid",
  "processed",
  "succeeded",
  "complete",
  "completed",
  "refunded",
]);

const RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "180", label: "Last 180 days", days: 180 },
  { value: "365", label: "Last 12 months", days: 365 },
];

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  organizer: "Organizer Suite",
};

const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  software_tools: "Software Tools",
  hosting_infrastructure: "Hosting / Infrastructure",
  payment_processing: "Payment Processing",
  contractor_payroll: "Contractor / Payroll",
  marketing_ads: "Marketing / Ads",
  professional_services: "Professional Services",
  taxes_licenses: "Taxes / Licenses",
  office_admin: "Office / Admin",
  travel_meals: "Travel / Meals",
  owner_draw: "Owner Draw",
  other: "Other",
};

function getRange(value: string | undefined) {
  return RANGE_OPTIONS.find((option) => option.value === value) ?? RANGE_OPTIONS[1];
}

function getPlan(value: SubscriptionPlanRow | SubscriptionPlanRow[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatLabel(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function categoryLabel(value: string | null | undefined) {
  const normalized = normalize(value) || "other";
  return EXPENSE_CATEGORY_LABELS[normalized] ?? formatLabel(normalized);
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function isOnOrAfter(value: string | null | undefined, start: Date) {
  if (!value) return false;
  return new Date(value).getTime() >= start.getTime();
}

function isPaidInvoiceStatus(value: string | null | undefined) {
  return PAID_INVOICE_STATUSES.has(normalize(value));
}

function isEventRevenueStatus(value: string | null | undefined) {
  return EVENT_REVENUE_STATUSES.has(normalize(value));
}

function toMoney(value: number | null | undefined) {
  return Number(value ?? 0);
}

function monthKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
}

function getPlanCode(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const subscriptionPlan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return normalize(subscriptionPlan?.code) || normalize(params.studio.billing_plan);
}

function getPlanName(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const planCode = getPlanCode(params);
  const subscriptionPlan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return subscriptionPlan?.name?.trim() || PLAN_LABELS[planCode] || (planCode ? formatLabel(planCode) : "No plan");
}

function getBillingStatus(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  return (
    normalize(params.subscription?.status) ||
    normalize(params.studio.subscription_status) ||
    (params.studio.active === false ? "inactive" : "not_started")
  );
}

function monthlyPlanAmount(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const plan = getBillingPlan(getPlanCode(params));
  if (!plan) return 0;
  return (plan.amountMonthlyCents ?? 0) / 100;
}

function estimatedPlatformFee(payment: EventPaymentRow) {
  return toMoney(payment.platform_fee_amount) || toMoney(payment.amount) * PLATFORM_TICKET_FEE_RATE;
}

function StatCard({
  label,
  value,
  helper,
  tone = "slate",
}: {
  label: string;
  value: string;
  helper: string;
  tone?: "slate" | "emerald" | "sky" | "amber" | "rose" | "violet";
}) {
  const tones = {
    slate: "border-slate-200 bg-white text-slate-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    violet: "border-violet-200 bg-violet-50 text-violet-950",
  };

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${tones[tone]}`}>
      <p className="text-sm font-medium opacity-75">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-2 text-xs leading-5 opacity-75">{helper}</p>
    </div>
  );
}

function statusBadgeClass(status: string | null | undefined) {
  const normalized = normalize(status);

  if (normalized === "paid" || normalized === "active" || normalized === "succeeded") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }

  if (normalized === "trialing") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  }

  if (normalized === "past_due" || normalized === "open") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }

  if (normalized === "refunded" || normalized === "canceled" || normalized === "cancelled") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

export default async function PlatformAccountingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const params = await searchParams;
  const range = getRange(params.range);
  const rangeStart = new Date(Date.now() - range.days * 24 * 60 * 60 * 1000);
  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: addonEntitlements, error: addonEntitlementsError },
    { data: invoices, error: invoicesError },
    { data: eventPayments, error: eventPaymentsError },
    { data: eventRegistrations, error: eventRegistrationsError },
    { data: platformExpenses, error: platformExpensesError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at, billing_plan, subscription_status, active")
      .order("created_at", { ascending: false }),
    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        studio_id,
        status,
        billing_interval,
        created_at,
        current_period_start,
        current_period_end,
        trial_ends_at,
        cancelled_at,
        cancel_at_period_end,
        subscription_plans (
          code,
          name
        )
      `),
    supabase
      .from("usage_addon_entitlements")
      .select("id, studio_id, feature_key, status, source, created_at")
      .eq("feature_key", "organizer_suite"),
    supabase
      .from("studio_invoices")
      .select("id, studio_id, amount_due, amount_paid, currency, status, period_start, period_end, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("event_payments")
      .select(`
        id,
        registration_id,
        amount,
        currency,
        status,
        source,
        payment_method,
        refund_amount,
        platform_fee_amount,
        stripe_processing_fee_amount,
        stripe_application_fee_amount,
        created_at
      `)
      .order("created_at", { ascending: false }),
    supabase
      .from("event_registrations")
      .select("id, event_id, studio_id"),
    supabase
      .from("platform_expenses")
      .select("id, expense_date, vendor_name, description, category, amount, currency, payment_method, status, tax_treatment, is_recurring, recurrence_frequency, receipt_url, notes, created_at")
      .gte("expense_date", rangeStart.toISOString().slice(0, 10))
      .lte("expense_date", new Date().toISOString().slice(0, 10))
      .order("expense_date", { ascending: false }),
  ]);

  if (studiosError) throw new Error(`Failed to load studios: ${studiosError.message}`);
  if (subscriptionsError) throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  if (addonEntitlementsError) throw new Error(`Failed to load add-ons: ${addonEntitlementsError.message}`);
  if (invoicesError) throw new Error(`Failed to load invoices: ${invoicesError.message}`);
  if (eventPaymentsError) throw new Error(`Failed to load event payments: ${eventPaymentsError.message}`);
  if (eventRegistrationsError) throw new Error(`Failed to load event registrations: ${eventRegistrationsError.message}`);
  if (platformExpensesError) throw new Error(`Failed to load platform expenses: ${platformExpensesError.message}`);

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedAddonEntitlements = (addonEntitlements ?? []) as AddonEntitlementRow[];
  const typedInvoices = (invoices ?? []) as StudioInvoiceRow[];
  const typedEventPayments = (eventPayments ?? []) as EventPaymentRow[];
  const typedEventRegistrations = (eventRegistrations ?? []) as EventRegistrationAccountingRow[];
  const typedPlatformExpenses = (platformExpenses ?? []) as PlatformExpenseRow[];

  const studioById = new Map(typedStudios.map((studio) => [studio.id, studio]));
  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );
  const registrationById = new Map(
    typedEventRegistrations.map((registration) => [registration.id, registration])
  );

  const workspaceRows = typedStudios.map((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    const status = getBillingStatus({ studio, subscription });
    const planName = getPlanName({ studio, subscription });
    const mrr = status === "active" ? monthlyPlanAmount({ studio, subscription }) : 0;

    return {
      studio,
      subscription,
      status,
      planName,
      mrr,
    };
  });

  const activeAddonEntitlements = typedAddonEntitlements.filter(
    (entitlement) => normalize(entitlement.status) === "active"
  );

  const invoicesInRange = typedInvoices.filter((invoice) =>
    isOnOrAfter(invoice.created_at, rangeStart)
  );
  const paidInvoicesInRange = invoicesInRange.filter((invoice) =>
    isPaidInvoiceStatus(invoice.status)
  );

  const eventPaymentsInRange = typedEventPayments.filter((payment) =>
    isOnOrAfter(payment.created_at, rangeStart)
  );
  const revenueEventPaymentsInRange = eventPaymentsInRange.filter((payment) =>
    isEventRevenueStatus(payment.status)
  );

  const subscriptionCollections = paidInvoicesInRange.reduce(
    (sum, invoice) => sum + toMoney(invoice.amount_paid),
    0
  );

  const recurringMrr = workspaceRows.reduce((sum, row) => sum + row.mrr, 0);
  const organizerSuiteMrr = activeAddonEntitlements.length * (ORGANIZER_SUITE_ADDON_CENTS / 100);
  const estimatedMrr = recurringMrr + organizerSuiteMrr;

  const grossTicketVolume = revenueEventPaymentsInRange.reduce(
    (sum, payment) => sum + toMoney(payment.amount),
    0
  );
  const ticketRefunds = eventPaymentsInRange.reduce(
    (sum, payment) => sum + toMoney(payment.refund_amount),
    0
  );
  const recordedPlatformFees = revenueEventPaymentsInRange.reduce(
    (sum, payment) => sum + toMoney(payment.platform_fee_amount),
    0
  );
  const estimatedPlatformFees = revenueEventPaymentsInRange.reduce(
    (sum, payment) => sum + estimatedPlatformFee(payment),
    0
  );
  const platformFeeRevenue = recordedPlatformFees || estimatedPlatformFees;
  const stripeProcessingFees = revenueEventPaymentsInRange.reduce(
    (sum, payment) => sum + toMoney(payment.stripe_processing_fee_amount),
    0
  );

  const totalPlatformRevenue = subscriptionCollections + platformFeeRevenue;
  const contributionBeforeOperatingExpenses = totalPlatformRevenue - stripeProcessingFees;
  const uncapturedPlatformFees = revenueEventPaymentsInRange.filter(
    (payment) => !payment.platform_fee_amount
  ).length;

  const activeExpenseRows = typedPlatformExpenses.filter(
    (expense) => normalize(expense.status) !== "excluded"
  );
  const operatingExpenseRows = activeExpenseRows.filter(
    (expense) => normalize(expense.category) !== "owner_draw"
  );
  const ownerDrawRows = activeExpenseRows.filter(
    (expense) => normalize(expense.category) === "owner_draw"
  );

  const operatingExpenses = operatingExpenseRows.reduce(
    (sum, expense) => sum + toMoney(expense.amount),
    0
  );
  const ownerDraws = ownerDrawRows.reduce(
    (sum, expense) => sum + toMoney(expense.amount),
    0
  );
  const netPlatformIncome = contributionBeforeOperatingExpenses - operatingExpenses;

  const expenseByCategory = Array.from(
    operatingExpenseRows
      .reduce<
        Map<string, { key: string; label: string; total: number; count: number }>
      >((map, expense) => {
        const key = normalize(expense.category) || "other";
        const existing = map.get(key) ?? {
          key,
          label: categoryLabel(key),
          total: 0,
          count: 0,
        };

        existing.total += toMoney(expense.amount);
        existing.count += 1;
        map.set(key, existing);
        return map;
      }, new Map())
      .values()
  ).sort((a, b) => b.total - a.total);

  const latestExpenses = activeExpenseRows.slice(0, 8);

  const revenueByPlan = new Map<
    string,
    { planName: string; invoiceRevenue: number; activeWorkspaces: number; estimatedMrr: number }
  >();

  for (const row of workspaceRows) {
    const existing = revenueByPlan.get(row.planName) ?? {
      planName: row.planName,
      invoiceRevenue: 0,
      activeWorkspaces: 0,
      estimatedMrr: 0,
    };

    if (row.status === "active") {
      existing.activeWorkspaces += 1;
      existing.estimatedMrr += row.mrr;
    }

    revenueByPlan.set(row.planName, existing);
  }

  for (const invoice of paidInvoicesInRange) {
    const studio = studioById.get(invoice.studio_id);
    if (!studio) continue;

    const subscription = subscriptionByStudioId.get(studio.id);
    const planName = getPlanName({ studio, subscription });
    const existing = revenueByPlan.get(planName) ?? {
      planName,
      invoiceRevenue: 0,
      activeWorkspaces: 0,
      estimatedMrr: 0,
    };

    existing.invoiceRevenue += toMoney(invoice.amount_paid);
    revenueByPlan.set(planName, existing);
  }

  const workspaceAccountingRows = workspaceRows
    .map((row) => {
      const invoiceRevenue = paidInvoicesInRange
        .filter((invoice) => invoice.studio_id === row.studio.id)
        .reduce((sum, invoice) => sum + toMoney(invoice.amount_paid), 0);

      const relatedEventPayments = revenueEventPaymentsInRange.filter((payment) => {
        if (!payment.registration_id) return false;

        const registration = registrationById.get(payment.registration_id);
        return registration?.studio_id === row.studio.id;
      });

      return {
        ...row,
        invoiceRevenue,
        grossTicketVolume: relatedEventPayments.reduce(
          (sum, payment) => sum + toMoney(payment.amount),
          0
        ),
        platformFeeRevenue: relatedEventPayments.reduce(
          (sum, payment) => sum + estimatedPlatformFee(payment),
          0
        ),
        refunds: relatedEventPayments.reduce(
          (sum, payment) => sum + toMoney(payment.refund_amount),
          0
        ),
      };
    })
    .map((row) => ({
      ...row,
      totalPlatformRevenue: row.invoiceRevenue + row.platformFeeRevenue,
    }))
    .sort((a, b) => b.totalPlatformRevenue - a.totalPlatformRevenue)
    .slice(0, 12);

  const monthlyRows = new Map<
    string,
    {
      key: string;
      subscriptionCollections: number;
      platformFees: number;
      refunds: number;
      processingFees: number;
      operatingExpenses: number;
      ownerDraws: number;
    }
  >();

  for (const invoice of paidInvoicesInRange) {
    const key = monthKey(invoice.created_at);
    const existing = monthlyRows.get(key) ?? {
      key,
      subscriptionCollections: 0,
      platformFees: 0,
      refunds: 0,
      processingFees: 0,
      operatingExpenses: 0,
      ownerDraws: 0,
    };

    existing.subscriptionCollections += toMoney(invoice.amount_paid);
    monthlyRows.set(key, existing);
  }

  for (const payment of revenueEventPaymentsInRange) {
    const key = monthKey(payment.created_at);
    const existing = monthlyRows.get(key) ?? {
      key,
      subscriptionCollections: 0,
      platformFees: 0,
      refunds: 0,
      processingFees: 0,
      operatingExpenses: 0,
      ownerDraws: 0,
    };

    existing.platformFees += estimatedPlatformFee(payment);
    existing.refunds += toMoney(payment.refund_amount);
    existing.processingFees += toMoney(payment.stripe_processing_fee_amount);
    monthlyRows.set(key, existing);
  }

  for (const expense of activeExpenseRows) {
    const key = monthKey(expense.expense_date);
    const existing = monthlyRows.get(key) ?? {
      key,
      subscriptionCollections: 0,
      platformFees: 0,
      refunds: 0,
      processingFees: 0,
      operatingExpenses: 0,
      ownerDraws: 0,
    };

    if (normalize(expense.category) === "owner_draw") {
      existing.ownerDraws += toMoney(expense.amount);
    } else {
      existing.operatingExpenses += toMoney(expense.amount);
    }

    monthlyRows.set(key, existing);
  }

  const monthlyAccountingRows = Array.from(monthlyRows.values()).sort((a, b) =>
    b.key.localeCompare(a.key)
  );

  const latestPaidInvoices = paidInvoicesInRange.slice(0, 8);
  const planRows = Array.from(revenueByPlan.values()).sort(
    (a, b) => b.invoiceRevenue + b.estimatedMrr - (a.invoiceRevenue + a.estimatedMrr)
  );

  const accountingInsight =
    netPlatformIncome < 0
      ? {
          title: "Platform expenses are outpacing revenue in this range.",
          insight: `${formatMoney(totalPlatformRevenue)} in platform revenue less ${formatMoney(stripeProcessingFees)} in recorded Stripe processing fees and ${formatMoney(operatingExpenses)} in operating expenses leaves ${formatMoney(netPlatformIncome)} net income signal.`,
          recommendation: "Review the expense categories and recent ledger entries before expanding recurring spend or paid acquisition.",
          metric: formatMoney(netPlatformIncome),
        }
      : uncapturedPlatformFees > 0
        ? {
            title: "Some event fee revenue is still estimated.",
            insight: `${uncapturedPlatformFees} event payment${uncapturedPlatformFees === 1 ? "" : "s"} in this range do not have recorded platform fee amounts, so the page falls back to the 3.5% fee estimate for those rows. Net income is currently ${formatMoney(netPlatformIncome)} after operating expenses.`,
            recommendation: "Use this as an operating view, then confirm Stripe fee sync before using the numbers for formal accounting close.",
            metric: formatMoney(netPlatformIncome),
          }
        : {
            title: "Platform P&L is ready for accounting review.",
            insight: `This view shows ${formatMoney(subscriptionCollections)} in subscription collections, ${formatMoney(platformFeeRevenue)} in event platform fees, and ${formatMoney(operatingExpenses)} in operating expenses for ${range.label.toLowerCase()}.`,
            recommendation: "Use the monthly P&L summary, expense mix, and recent ledger entries to review profitability before accounting export.",
            metric: formatMoney(netPlatformIncome),
          };

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Platform Accounting
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                DanceFlow P&L Review
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Review subscription collections, event platform fees, refunds, processing costs, operating expenses, owner draws, and net income signals for the DanceFlow SaaS business.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {RANGE_OPTIONS.map((option) => (
                <Link
                  key={option.value}
                  href={`/platform/accounting?range=${option.value}`}
                  className={`rounded-xl border px-4 py-2 text-sm font-semibold ${
                    option.value === range.value
                      ? "border-white bg-white text-[var(--brand-primary)]"
                      : "border-white/20 bg-white/10 text-white hover:bg-white/15"
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <AriaInsightCard
        eyebrow="ARIA Accounting Signal"
        title={accountingInsight.title}
        insight={accountingInsight.insight}
        recommendation={accountingInsight.recommendation}
        metric={accountingInsight.metric}
        primaryAction={{ href: "/platform/billing", label: "Review Billing" }}
        secondaryAction={{ href: "/platform/analytics", label: "Open Analytics" }}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Platform Revenue"
          value={formatMoney(totalPlatformRevenue)}
          helper={`${formatMoney(subscriptionCollections)} subscriptions + ${formatMoney(platformFeeRevenue)} event platform fees`}
          tone="emerald"
        />
        <StatCard
          label="Estimated MRR"
          value={formatMoney(estimatedMrr)}
          helper={`${formatMoney(recurringMrr)} workspace MRR + ${formatMoney(organizerSuiteMrr)} Organizer Suite add-ons`}
          tone="sky"
        />
        <StatCard
          label="Ticket Volume"
          value={formatMoney(grossTicketVolume)}
          helper={`${formatMoney(ticketRefunds)} in recorded ticket refunds during ${range.label.toLowerCase()}`}
          tone="violet"
        />
        <StatCard
          label="Net Income Signal"
          value={formatMoney(netPlatformIncome)}
          helper={`${formatMoney(contributionBeforeOperatingExpenses)} contribution - ${formatMoney(operatingExpenses)} operating expenses`}
          tone={netPlatformIncome >= 0 ? "emerald" : "rose"}
        />
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Operating Expenses"
          value={formatMoney(operatingExpenses)}
          helper={`${operatingExpenseRows.length} expense item${operatingExpenseRows.length === 1 ? "" : "s"} excluding owner draws and excluded rows`}
          tone="rose"
        />
        <StatCard
          label="Owner Draws"
          value={formatMoney(ownerDraws)}
          helper="Tracked separately from operating expenses"
          tone="sky"
        />
        <StatCard
          label="Processing Fees"
          value={formatMoney(stripeProcessingFees)}
          helper="Recorded Stripe processing fees from event payments"
          tone="amber"
        />
        <StatCard
          label="Contribution Before Opex"
          value={formatMoney(contributionBeforeOperatingExpenses)}
          helper="Platform revenue less recorded processing fees"
          tone={contributionBeforeOperatingExpenses >= 0 ? "violet" : "rose"}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Monthly Close View
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Monthly P&L Summary
              </h2>
            </div>
            <p className="text-sm text-slate-500">{range.label}</p>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            {monthlyAccountingRows.length ? (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Month</th>
                    <th className="px-4 py-3">Subscriptions</th>
                    <th className="px-4 py-3">Platform Fees</th>
                    <th className="px-4 py-3">Refunds</th>
                    <th className="px-4 py-3">Processing Fees</th>
                    <th className="px-4 py-3">Operating Expenses</th>
                    <th className="px-4 py-3">Owner Draws</th>
                    <th className="px-4 py-3">Net Income</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {monthlyAccountingRows.map((row) => (
                    <tr key={row.key}>
                      <td className="px-4 py-3 font-semibold text-slate-900">{monthLabel(row.key)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatMoney(row.subscriptionCollections)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatMoney(row.platformFees)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatMoney(row.refunds)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatMoney(row.processingFees)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatMoney(row.operatingExpenses)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatMoney(row.ownerDraws)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-950">
                        {formatMoney(row.subscriptionCollections + row.platformFees - row.processingFees - row.operatingExpenses)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="bg-slate-50 p-5 text-sm text-slate-500">
                No accounting activity is available for this range.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Expense Mix
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Operating Expenses by Category
              </h2>
            </div>
            <Link href="/platform/expenses" className="text-sm font-semibold text-[#BE185D]">
              Expense ledger
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {expenseByCategory.length ? (
              expenseByCategory.slice(0, 8).map((row) => (
                <div key={row.key} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">{row.label}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {row.count} item{row.count === 1 ? "" : "s"}
                      </p>
                    </div>
                    <p className="text-lg font-semibold text-slate-950">{formatMoney(row.total)}</p>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
                No operating expenses are available for this range.
              </div>
            )}
          </div>

          <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
            Owner draws are tracked separately and do not reduce operating profit.
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Plan Revenue
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Revenue by Plan
            </h2>
          </div>
          <Link href="/platform/billing" className="text-sm font-semibold text-[#BE185D]">
            Billing details
          </Link>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {planRows.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Active Workspaces</th>
                  <th className="px-4 py-3">Estimated MRR</th>
                  <th className="px-4 py-3">Collections</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {planRows.map((row) => (
                  <tr key={row.planName}>
                    <td className="px-4 py-3 font-semibold text-slate-900">{row.planName}</td>
                    <td className="px-4 py-3 text-slate-600">{formatNumber(row.activeWorkspaces)}</td>
                    <td className="px-4 py-3 text-slate-600">{formatMoney(row.estimatedMrr)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-950">{formatMoney(row.invoiceRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-5 text-sm text-slate-500">
              No plan revenue is available for this range.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Account Review
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Top Revenue Workspaces
            </h2>
          </div>
          <Link href="/platform/studios" className="text-sm font-semibold text-[#BE185D]">
            Studio directory
          </Link>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {workspaceAccountingRows.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Subscriptions</th>
                  <th className="px-4 py-3">Platform Fees</th>
                  <th className="px-4 py-3">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {workspaceAccountingRows.map((row) => (
                  <tr key={row.studio.id}>
                    <td className="px-4 py-3 font-semibold text-slate-900">
                      <Link href={`/platform/studios/${row.studio.id}`} className="hover:text-[#BE185D]">
                        {row.studio.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.planName}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(row.status)}`}>
                        {formatLabel(row.status || "unknown")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{formatMoney(row.invoiceRevenue)}</td>
                    <td className="px-4 py-3 text-slate-600">{formatMoney(row.platformFeeRevenue)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-950">
                      {formatMoney(row.totalPlatformRevenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-5 text-sm text-slate-500">
              No workspace revenue is available for this range.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Expense Detail
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Recent Platform Expenses
            </h2>
          </div>
          <Link href="/platform/expenses" className="text-sm font-semibold text-[#BE185D]">
            Manage expenses
          </Link>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {latestExpenses.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {latestExpenses.map((expense) => (
                  <tr key={expense.id}>
                    <td className="px-4 py-3 text-slate-600">{formatDate(expense.expense_date)}</td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">{expense.vendor_name}</p>
                      {expense.description ? (
                        <p className="mt-1 text-xs text-slate-500">{expense.description}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{categoryLabel(expense.category)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(expense.status)}`}>
                        {formatLabel(normalize(expense.status) || "draft")}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-950">
                      {formatMoney(toMoney(expense.amount), expense.currency ?? "USD")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-5 text-sm text-slate-500">
              No platform expenses are available for this range.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Invoice Detail
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Recent Paid Subscription Invoices
            </h2>
          </div>
          <p className="text-sm text-slate-500">Accountant review starter list</p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {latestPaidInvoices.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {latestPaidInvoices.map((invoice) => {
                  const studio = studioById.get(invoice.studio_id);

                  return (
                    <tr key={invoice.id}>
                      <td className="px-4 py-3 text-slate-600">{formatDate(invoice.created_at)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {studio ? (
                          <Link href={`/platform/studios/${studio.id}`} className="hover:text-[#BE185D]">
                            {studio.name}
                          </Link>
                        ) : (
                          "Unknown workspace"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(invoice.status)}`}>
                          {formatLabel(normalize(invoice.status) || "unknown")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {formatDate(invoice.period_start)} - {formatDate(invoice.period_end)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-950">
                        {formatMoney(toMoney(invoice.amount_paid), invoice.currency ?? "USD")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-5 text-sm text-slate-500">
              No paid invoices are available for this range.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}