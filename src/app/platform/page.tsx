import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getBillingPlan } from "@/lib/billing/plans";

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string;
  billing_interval: string;
  created_at: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancelled_at: string | null;
  cancel_at_period_end: boolean;
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

type OrganizerRow = {
  id: string;
  studio_id: string;
  active: boolean;
};

type EventRow = {
  id: string;
  studio_id: string;
  visibility: string;
  status: string;
  event_type: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  created_at: string;
};

type StudioInvoiceRow = {
  id: string;
  studio_id: string;
  amount_paid: number | null;
  currency: string | null;
  status: string;
  created_at: string;
};

type PlatformErrorLogRow = {
  id: string;
  severity: string;
  source: string;
  message: string;
  created_at: string;
  resolved_at: string | null;
};

type PackageDeductionErrorRow = {
  id: string;
  appointment_id: string | null;
  studio_id: string | null;
  client_id: string | null;
  client_package_id: string | null;
  appointment_type: string | null;
  error_message: string | null;
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

function daysUntil(value: string | null) {
  if (!value) return null;

  const now = new Date();
  const target = new Date(value);
  const diffMs = target.getTime() - now.getTime();

  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function trialStatusLabel(trialEndsAt: string | null) {
  const days = daysUntil(trialEndsAt);

  if (days === null) return "Trial";
  if (days < 0) return "Trial expired";
  if (days === 0) return "Trial ends today";

  return `Trial — ${days} day${days === 1 ? "" : "s"} left`;
}

function trialStatusDetail(trialEndsAt: string | null) {
  if (!trialEndsAt) return "Trial end date unavailable";

  const days = daysUntil(trialEndsAt);

  if (days !== null && days < 0) {
    return `Ended ${formatDate(trialEndsAt)}`;
  }

  return `Ends ${formatDate(trialEndsAt)}`;
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "trialing") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "past_due") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "cancelled" || status === "canceled") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function statusLabel(status: string) {
  if (status === "trialing") return "Trial";
  if (status === "active") return "Active";
  if (status === "past_due") return "Past Due";
  if (status === "cancelled" || status === "canceled") return "Canceled";
  if (status === "inactive") return "Inactive";
  return status;
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

const PLATFORM_TICKET_FEE_RATE = 0.035;
const PAID_REGISTRATION_STATUSES = new Set(["paid", "completed", "succeeded"]);
const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth() {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfYear() {
  const date = new Date();
  date.setMonth(0, 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isOnOrAfter(value: string | null | undefined, start: Date) {
  if (!value) return false;
  return new Date(value).getTime() >= start.getTime();
}

function metricLabel(period: "today" | "month" | "ytd") {
  if (period === "today") return "Today";
  if (period === "month") return "Month";
  return "YTD";
}

function isOrganizerWorkspace(params: {
  studioName: string;
  subscription: SubscriptionRow | undefined;
}) {
  const { studioName, subscription } = params;
  const plan = subscription ? getPlan(subscription.subscription_plans) : null;
  const planCode = plan?.code?.toLowerCase() ?? "";
  const sharedPlan = planCode ? getBillingPlan(planCode as never) : null;

  if (sharedPlan?.audience === "organizer") {
    return true;
  }

  const normalizedName = studioName.trim().toLowerCase();
  return (
    normalizedName.endsWith(" organizer") ||
    normalizedName.includes(" organizer ") ||
    normalizedName.endsWith(" events") ||
    normalizedName.includes(" festival")
  );
}

function hasActiveBillingAccess(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

function hasPaidPlan(subscription: SubscriptionRow | undefined) {
  if (!subscription) return false;
  const plan = getPlan(subscription.subscription_plans);
  return Boolean(plan?.code || plan?.name);
}

export default async function PlatformDashboardPage() {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: organizers, error: organizersError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
    { data: studioInvoices, error: studioInvoicesError },
    { data: platformErrorLogs },
    { data: packageDeductionErrors },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at")
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

    supabase.from("organizers").select("id, studio_id, active"),

    supabase.from("events").select("id, studio_id, visibility, status, event_type"),

    supabase
      .from("event_registrations")
      .select("id, event_id, status, payment_status, total_amount, total_price, created_at"),

    supabase
      .from("studio_invoices")
      .select("id, studio_id, amount_paid, currency, status, created_at"),

    supabase
      .from("platform_error_logs")
      .select("id, severity, source, message, created_at, resolved_at")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(5),

    supabase
      .from("appointment_package_deduction_errors")
      .select(
        "id, appointment_id, studio_id, client_id, client_package_id, appointment_type, error_message, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  if (subscriptionsError) {
    throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  if (studioInvoicesError) {
    throw new Error(`Failed to load studio invoices: ${studioInvoicesError.message}`);
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedStudioInvoices = (studioInvoices ?? []) as StudioInvoiceRow[];
  const typedPlatformErrorLogs = (platformErrorLogs ?? []) as PlatformErrorLogRow[];
  const typedPackageDeductionErrors = (packageDeductionErrors ?? []) as PackageDeductionErrorRow[];

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const studioWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return !isOrganizerWorkspace({
      studioName: studio.name,
      subscription,
    });
  });

  const organizerWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return isOrganizerWorkspace({
      studioName: studio.name,
      subscription,
    });
  });

  const organizersByStudioId = new Map<string, number>();
  for (const organizer of typedOrganizers) {
    organizersByStudioId.set(
      organizer.studio_id,
      (organizersByStudioId.get(organizer.studio_id) ?? 0) + 1
    );
  }

  const eventsByStudioId = new Map<string, number>();
  const publicEventsByStudioId = new Map<string, number>();
  for (const event of typedEvents) {
    eventsByStudioId.set(event.studio_id, (eventsByStudioId.get(event.studio_id) ?? 0) + 1);

    if (event.status === "published" && event.visibility === "public") {
      publicEventsByStudioId.set(
        event.studio_id,
        (publicEventsByStudioId.get(event.studio_id) ?? 0) + 1
      );
    }
  }

  const eventStudioMap = new Map(typedEvents.map((event) => [event.id, event.studio_id]));
  const registrationsByStudioId = new Map<string, number>();
  const revenueByStudioId = new Map<string, number>();
  let grossRegistrationVolume = 0;

  for (const registration of typedRegistrations) {
    const studioId = eventStudioMap.get(registration.event_id);
    if (!studioId) continue;

    registrationsByStudioId.set(
      studioId,
      (registrationsByStudioId.get(studioId) ?? 0) + 1
    );

    if (
      registration.payment_status === "paid" ||
      registration.payment_status === "partial"
    ) {
      const amount = Number(registration.total_amount ?? 0);
      grossRegistrationVolume += amount;
      revenueByStudioId.set(
        studioId,
        (revenueByStudioId.get(studioId) ?? 0) + amount
      );
    }
  }

  const studioWorkspaceIds = new Set(studioWorkspaces.map((studio) => studio.id));
  const organizerWorkspaceIds = new Set(organizerWorkspaces.map((studio) => studio.id));

  const studioSubscriptions = typedSubscriptions.filter((subscription) =>
    studioWorkspaceIds.has(subscription.studio_id)
  );
  const organizerSubscriptions = typedSubscriptions.filter((subscription) =>
    organizerWorkspaceIds.has(subscription.studio_id)
  );

  const activeStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "active"
  ).length;
  const trialingStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "trialing"
  ).length;
  const pastDueStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "past_due"
  ).length;
  const cancelledStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "cancelled" || s.status === "canceled"
  ).length;

  const activeOrganizerWorkspaces = organizerSubscriptions.filter(
    (s) => s.status === "active"
  ).length;
  const trialingOrganizerWorkspaces = organizerSubscriptions.filter(
    (s) => s.status === "trialing"
  ).length;

  const totalOrganizerAccounts = typedOrganizers.length;
  const activeOrganizerAccounts = typedOrganizers.filter((o) => o.active).length;

  const totalEvents = typedEvents.length;
  const publicEvents = typedEvents.filter(
    (event) => event.status === "published" && event.visibility === "public"
  ).length;

  const studioPublicEvents = typedEvents.filter(
    (event) =>
      studioWorkspaceIds.has(event.studio_id) &&
      event.status === "published" &&
      event.visibility === "public"
  ).length;

  const organizerPublicEvents = typedEvents.filter(
    (event) =>
      organizerWorkspaceIds.has(event.studio_id) &&
      event.status === "published" &&
      event.visibility === "public"
  ).length;

  const totalRegistrations = typedRegistrations.length;
  const paidRegistrations = typedRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;

  const studioPlanMix = studioSubscriptions.reduce<Record<string, number>>(
    (acc, subscription) => {
      const plan = getPlan(subscription.subscription_plans);
      const key = plan?.name ?? "No plan";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const organizerPlanMix = organizerSubscriptions.reduce<Record<string, number>>(
    (acc, subscription) => {
      const plan = getPlan(subscription.subscription_plans);
      const key = plan?.name ?? "No plan";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const billingIssues = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      return {
        studio,
        subscription,
        workspaceType: organizerWorkspaceIds.has(studio.id) ? "Organizer" : "Studio",
      };
    })
    .filter(({ subscription }) => {
      if (!subscription) return true;
      return subscription.status === "past_due" || subscription.status === "cancelled" || subscription.status === "canceled";
    });

  const paidAccessWithoutActiveSubscription = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const plan = subscription ? getPlan(subscription.subscription_plans) : null;

      return {
        studio,
        subscription,
        plan,
        workspaceType: organizerWorkspaceIds.has(studio.id) ? "Organizer" : "Studio",
        status: subscription?.status ?? "no_subscription",
      };
    })
    .filter(({ subscription }) => {
      if (!hasPaidPlan(subscription)) return false;
      return !hasActiveBillingAccess(subscription?.status);
    });

  const serverSideAlertCount =
    typedPlatformErrorLogs.length + typedPackageDeductionErrors.length;

  const latestServerSideAlert =
    typedPlatformErrorLogs[0]?.message ??
    typedPackageDeductionErrors[0]?.error_message ??
    null;

  const todayStart = startOfToday();
  const monthStart = startOfMonth();
  const yearStart = startOfYear();

  const paidRegistrationRevenueFor = (start: Date) =>
    typedRegistrations
      .filter((registration) =>
        PAID_REGISTRATION_STATUSES.has((registration.payment_status ?? "").toLowerCase())
      )
      .filter((registration) => isOnOrAfter(registration.created_at, start))
      .reduce((sum, registration) => {
        const amount = Number(registration.total_amount ?? registration.total_price ?? 0);
        return sum + amount;
      }, 0);

  const subscriptionRevenueFor = (start: Date) =>
    typedStudioInvoices
      .filter((invoice) => PAID_INVOICE_STATUSES.has((invoice.status ?? "").toLowerCase()))
      .filter((invoice) => isOnOrAfter(invoice.created_at, start))
      .reduce((sum, invoice) => sum + Number(invoice.amount_paid ?? 0), 0);

  const newTrialSignupsFor = (start: Date) =>
    typedSubscriptions.filter(
      (subscription) =>
        subscription.status === "trialing" && isOnOrAfter(subscription.created_at, start)
    ).length;

  const newSubscriptionPurchasesFor = (start: Date) =>
    typedSubscriptions.filter(
      (subscription) =>
        subscription.status === "active" &&
        isOnOrAfter(subscription.current_period_start ?? subscription.created_at, start)
    ).length;

  const cancellationsFor = (start: Date) =>
    typedSubscriptions.filter((subscription) =>
      isOnOrAfter(subscription.cancelled_at, start)
    ).length;

  const platformMetrics = [
    {
      label: "Ticket platform fees",
      description: "3.5% platform fee from paid event registrations.",
      values: {
        today: paidRegistrationRevenueFor(todayStart) * PLATFORM_TICKET_FEE_RATE,
        month: paidRegistrationRevenueFor(monthStart) * PLATFORM_TICKET_FEE_RATE,
        ytd: paidRegistrationRevenueFor(yearStart) * PLATFORM_TICKET_FEE_RATE,
      },
      format: "money" as const,
    },
    {
      label: "Subscription revenue",
      description: "Paid subscription invoices recorded from Stripe.",
      values: {
        today: subscriptionRevenueFor(todayStart),
        month: subscriptionRevenueFor(monthStart),
        ytd: subscriptionRevenueFor(yearStart),
      },
      format: "money" as const,
    },
    {
      label: "New trial signups",
      description: "Subscriptions that entered trialing status in the period.",
      values: {
        today: newTrialSignupsFor(todayStart),
        month: newTrialSignupsFor(monthStart),
        ytd: newTrialSignupsFor(yearStart),
      },
      format: "number" as const,
    },
    {
      label: "New subscriptions",
      description: "Active subscriptions started in the period.",
      values: {
        today: newSubscriptionPurchasesFor(todayStart),
        month: newSubscriptionPurchasesFor(monthStart),
        ytd: newSubscriptionPurchasesFor(yearStart),
      },
      format: "number" as const,
    },
    {
      label: "Cancellations",
      description: "Subscriptions with a cancellation timestamp in the period.",
      values: {
        today: cancellationsFor(todayStart),
        month: cancellationsFor(monthStart),
        ytd: cancellationsFor(yearStart),
      },
      format: "number" as const,
    },
  ];

  const formatMetricValue = (value: number, format: "money" | "number") =>
    format === "money" ? formatMoney(value, "USD") : value.toLocaleString("en-US");

  const recentStudios = studioWorkspaces.slice(0, 8);
  const recentOrganizers = organizerWorkspaces.slice(0, 8);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_20%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Platform Admin
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Platform Dashboard
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Monitor subscription health, workspace growth, organizer adoption, public events, and registration activity across the platform without mixing studio and organizer counts together.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform/studios"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Studio Directory
              </Link>
              <Link
                href="/platform/organizers"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Organizer Directory
              </Link>
              <Link
                href="/platform/billing"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Billing Health
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-sm text-sky-700">Studio Workspaces</p>
              <p className="mt-1 text-2xl font-semibold text-sky-950">
                {studioWorkspaces.length}
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-sm text-violet-700">Organizer Workspaces</p>
              <p className="mt-1 text-2xl font-semibold text-violet-950">
                {organizerWorkspaces.length}
              </p>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm text-emerald-700">Public Events</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-950">
                {publicEvents}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Gross Reg Volume</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">
                {formatMoney(grossRegistrationVolume, "USD")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Platform Health & Revenue Snapshot
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Daily, monthly, and YTD launch visibility
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Track billing risk, backend issues, revenue movement, trial growth, paid subscription growth, and cancellations before users report problems.
            </p>
          </div>
          <Link
            href="/platform/alerts"
            className="inline-flex rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Review alerts
          </Link>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-5">
          {platformMetrics.map((metric) => (
            <div key={metric.label} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm font-semibold text-slate-950">{metric.label}</p>
              <p className="mt-1 min-h-10 text-xs leading-5 text-slate-500">
                {metric.description}
              </p>
              <div className="mt-4 space-y-3">
                {(["today", "month", "ytd"] as const).map((period) => (
                  <div key={period} className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {metricLabel(period)}
                    </span>
                    <span className="text-sm font-semibold text-slate-950">
                      {formatMetricValue(metric.values[period], metric.format)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {paidAccessWithoutActiveSubscription.length > 0 ? (
        <section className="rounded-[32px] border border-rose-200 bg-rose-50 p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">
                Billing Risk
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-rose-950">
                Paid-plan access without active subscription
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-rose-800">
                {paidAccessWithoutActiveSubscription.length} paid-plan workspace{paidAccessWithoutActiveSubscription.length === 1 ? "" : "s"} need review before launch. These accounts have paid plan records but are not active or trialing.
              </p>
            </div>

            <Link
              href="/platform/billing"
              className="inline-flex rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-800"
            >
              Review in Billing
            </Link>
          </div>
        </section>
      ) : null}

      {serverSideAlertCount > 0 ? (
        <section className="rounded-[32px] border border-amber-200 bg-amber-50 p-6 shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Server-Side Alerts
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-amber-950">
                Backend errors need review
              </h2>
              <p className="mt-2 text-sm leading-6 text-amber-800">
                {serverSideAlertCount} unresolved server-side alert{serverSideAlertCount === 1 ? "" : "s"} may need attention before users report an issue.
                {latestServerSideAlert ? ` Latest: ${latestServerSideAlert}` : ""}
              </p>
            </div>

            <div className="w-full xl:max-w-xl">
              <div className="mb-3 flex justify-end">
                <Link
                  href="/platform/alerts"
                  className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-800"
                >
                  View all alerts
                </Link>
              </div>

              <div className="grid gap-3">
                {typedPlatformErrorLogs.slice(0, 3).map((errorLog) => (
                <div
                  key={errorLog.id}
                  className="rounded-2xl border border-amber-200 bg-white/80 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-amber-950">
                      {errorLog.source}
                    </p>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                      {errorLog.severity}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-amber-800">
                    {errorLog.message}
                  </p>
                  <p className="mt-2 text-xs text-amber-700">
                    {formatDate(errorLog.created_at)}
                  </p>
                </div>
              ))}

                {typedPackageDeductionErrors.slice(0, 3).map((errorLog) => (
                  <div
                    key={errorLog.id}
                    className="rounded-2xl border border-orange-200 bg-white/80 p-4"
                  >
                    <p className="text-sm font-semibold text-orange-950">
                      Package deduction error
                    </p>
                    <p className="mt-2 line-clamp-2 text-sm text-orange-800">
                      {errorLog.error_message ?? "Package credit deduction failed."}
                    </p>
                    <p className="mt-2 text-xs text-orange-700">
                      {errorLog.appointment_type ?? "Appointment"} • {formatDate(errorLog.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Studio Active + Trial</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {activeStudioWorkspaces + trialingStudioWorkspaces}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {activeStudioWorkspaces} active • {trialingStudioWorkspaces} trial
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Organizer Active + Trial</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {activeOrganizerWorkspaces + trialingOrganizerWorkspaces}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {activeOrganizerWorkspaces} active • {trialingOrganizerWorkspaces} trial
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Studio Billing Issues</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {pastDueStudioWorkspaces + cancelledStudioWorkspaces}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {pastDueStudioWorkspaces} past due • {cancelledStudioWorkspaces} cancelled
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Organizer Accounts</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {totalOrganizerAccounts}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {activeOrganizerAccounts} active
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Studio Public Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{studioPublicEvents}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Organizer Public Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {organizerPublicEvents}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{totalRegistrations}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Paid Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{paidRegistrations}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Subscription Mix</h2>
              <p className="mt-1 text-sm text-slate-500">
                See studio and organizer plan distribution separately.
              </p>
            </div>

            <Link href="/platform/billing" className="text-sm font-medium underline">
              Open billing
            </Link>
          </div>

          <div className="mt-5 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Studio Plans</p>
              <div className="mt-4 space-y-3">
                {Object.keys(studioPlanMix).length === 0 ? (
                  <p className="text-sm text-slate-500">No studio subscriptions yet.</p>
                ) : (
                  Object.entries(studioPlanMix).map(([planName, count]) => (
                    <div key={planName} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{planName}</span>
                      <span className="font-semibold text-slate-950">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Organizer Plans</p>
              <div className="mt-4 space-y-3">
                {Object.keys(organizerPlanMix).length === 0 ? (
                  <p className="text-sm text-slate-500">No organizer subscriptions yet.</p>
                ) : (
                  Object.entries(organizerPlanMix).map(([planName, count]) => (
                    <div key={planName} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{planName}</span>
                      <span className="font-semibold text-slate-950">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Gross Registration Volume</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatMoney(grossRegistrationVolume, "USD")}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Based on paid and partially paid event registrations.
            </p>
          </div>
        </div>

        <details className="group rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 transition hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Billing Issues</h2>
              <p className="mt-1 text-sm text-slate-500">
                {billingIssues.length === 0
                  ? "No workspaces need subscription attention right now."
                  : `${billingIssues.length} workspace${billingIssues.length === 1 ? "" : "s"} need payment or subscription attention.`}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${
                billingIssues.length === 0
                  ? "bg-green-50 text-green-700 ring-1 ring-green-200"
                  : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
              }`}>
                {billingIssues.length} issue{billingIssues.length === 1 ? "" : "s"}
              </span>
              <span className="text-sm font-semibold text-slate-500 group-open:hidden">
                Expand
              </span>
              <span className="hidden text-sm font-semibold text-slate-500 group-open:inline">
                Collapse
              </span>
            </div>
          </summary>

          <div className="mt-5">
            <div className="flex justify-end">
              <Link href="/platform/billing" className="text-sm font-medium underline">
                Open billing
              </Link>
            </div>

            {billingIssues.length === 0 ? (
              <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-10 text-sm text-green-700">
                No billing issues detected right now.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {billingIssues.slice(0, 8).map(({ studio, subscription, workspaceType }) => {
                  const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                  return (
                    <div key={studio.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <Link
                            href={`/platform/studios/${studio.id}`}
                            className="font-medium text-slate-900 underline"
                          >
                            {studio.name}
                          </Link>
                          <p className="mt-1 text-sm text-slate-500">
                            {workspaceType} • Plan: {plan?.name ?? "No plan"}
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
        </details>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid gap-4 lg:grid-cols-2">
            <details className="group rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">Recent Studios</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {recentStudios.length} recent studio workspace{recentStudios.length === 1 ? "" : "s"}.
                  </p>
                </div>

                <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
                  <span className="group-open:hidden">Expand</span>
                  <span className="hidden group-open:inline">Collapse</span>
                </span>
              </summary>

              <div className="mt-4 border-t border-slate-200 pt-4">
                <div className="flex justify-end">
                  <Link href="/platform/studios" className="text-sm font-medium underline">
                    Open full list
                  </Link>
                </div>

                {recentStudios.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-sm text-slate-500">
                    No studios yet.
                  </div>
                ) : (
                  <div className="mt-4 space-y-2">
                    {recentStudios.map((studio) => {
                      const subscription = subscriptionByStudioId.get(studio.id);
                      const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                      return (
                        <div key={studio.id} className="rounded-xl border border-slate-200 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <Link
                                href={`/platform/studios/${studio.id}`}
                                className="font-medium text-slate-900 underline"
                              >
                                {studio.name}
                              </Link>
                              <p className="mt-1 text-sm text-slate-500">
                                Created {formatDate(studio.created_at)}
                              </p>
                            </div>

                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                subscription?.status ?? "inactive"
                              )}`}
                            >
                              {subscription?.status === "trialing"
  ? trialStatusLabel(subscription.trial_ends_at)
  : statusLabel(subscription?.status ?? "inactive")}
                            </span>
                          </div>

                          <p className="mt-2 text-sm text-slate-600">
  {plan?.name ?? "No plan"} • {eventsByStudioId.get(studio.id) ?? 0} events •{" "}
  {registrationsByStudioId.get(studio.id) ?? 0} registrations
</p>

{subscription?.status === "trialing" ? (
  <p className="mt-1 text-xs font-medium text-sky-700">
    {trialStatusDetail(subscription.trial_ends_at)}
  </p>
) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </details>

            <details className="group rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">Recent Organizers</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {recentOrganizers.length} recent organizer workspace{recentOrganizers.length === 1 ? "" : "s"}.
                  </p>
                </div>

                <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
                  <span className="group-open:hidden">Expand</span>
                  <span className="hidden group-open:inline">Collapse</span>
                </span>
              </summary>

              <div className="mt-4 border-t border-slate-200 pt-4">
                <div className="flex justify-end">
                  <Link href="/platform/organizers" className="text-sm font-medium underline">
                    Open full list
                  </Link>
                </div>

                {recentOrganizers.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-sm text-slate-500">
                    No organizers yet.
                  </div>
                ) : (
                  <div className="mt-4 space-y-2">
                    {recentOrganizers.map((studio) => {
                      const subscription = subscriptionByStudioId.get(studio.id);
                      const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                      return (
                        <div key={studio.id} className="rounded-xl border border-slate-200 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <Link
                                href={`/platform/studios/${studio.id}`}
                                className="font-medium text-slate-900 underline"
                              >
                                {studio.name}
                              </Link>
                              <p className="mt-1 text-sm text-slate-500">
                                Created {formatDate(studio.created_at)}
                              </p>
                            </div>

                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                subscription?.status ?? "inactive"
                              )}`}
                            >
                              {subscription?.status === "trialing"
  ? trialStatusLabel(subscription.trial_ends_at)
  : statusLabel(subscription?.status ?? "inactive")}
                            </span>
                          </div>

                          <p className="mt-2 text-sm text-slate-600">
  {plan?.name ?? "No plan"} • {organizersByStudioId.get(studio.id) ?? 0} organizer accounts •{" "}
  {publicEventsByStudioId.get(studio.id) ?? 0} public events
</p>

{subscription?.status === "trialing" ? (
  <p className="mt-1 text-xs font-medium text-sky-700">
    {trialStatusDetail(subscription.trial_ends_at)}
  </p>
) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">Platform Actions</h2>

            <div className="mt-5 grid gap-3">
              <Link
                href="/platform/studios"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review studio directory
              </Link>

              <Link
                href="/platform/organizers"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review organizer directory
              </Link>

              <Link
                href="/platform/billing"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Resolve billing issues
              </Link>

              <Link
                href="/platform/alerts"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review platform alerts
              </Link>

              <Link
                href="/platform/subscriptions"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review subscriptions
              </Link>
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">Workspace Mix</h2>

            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Studios</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {studioWorkspaces.length}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Organizers</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {organizerWorkspaces.length}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Public Event Split</p>
                <p className="mt-1 text-sm text-slate-700">
                  Studios: {studioPublicEvents} • Organizers: {organizerPublicEvents}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Revenue Mix</p>
                <p className="mt-1 text-sm text-slate-700">
                  Platform registrations total {formatMoney(grossRegistrationVolume, "USD")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}