import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getBillingPlan } from "@/lib/billing/plans";
import {
  createPlatformBroadcastAlertAction,
  setPlatformBroadcastAlertActiveAction,
} from "./actions";

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  billing_plan: string | null;
  subscription_status: string | null;
  active: boolean | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  last_workspace_access_at: string | null;
  last_workspace_access_user_id: string | null;
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

type PaymentRow = {
  id: string;
  studio_id: string;
  amount: number | null;
  currency: string | null;
  status: string | null;
  payment_type: string | null;
  source: string | null;
  paid_at: string | null;
  created_at: string;
};

type EventPaymentRow = {
  id: string;
  amount: number | null;
  currency: string | null;
  status: string | null;
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

type SmsMessageLogRow = {
  id: string;
  status: string | null;
  direction: string | null;
  provider_error_message: string | null;
  created_at: string;
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

type PlatformBroadcastAlertRow = {
  id: string;
  title: string;
  message: string;
  alert_type: string;
  audience: string;
  active: boolean;
  dismissible: boolean;
  starts_at: string | null;
  ends_at: string | null;
  read_more_url: string | null;
  read_more_label: string | null;
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

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatLastWorkspaceAccess(value: string | null) {
  if (!value) return "Never";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
  if (!trialEndsAt) return "Trial active";

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

function platformAlertTypeClass(type: string) {
  if (type === "success") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (type === "warning") return "border-amber-200 bg-amber-50 text-amber-950";
  if (type === "maintenance") return "border-violet-200 bg-violet-50 text-violet-950";
  if (type === "critical") return "border-rose-200 bg-rose-50 text-rose-950";
  return "border-sky-200 bg-sky-50 text-sky-950";
}

function audienceLabel(value: string) {
  if (value === "all_workspace_users") return "All workspace users";
  if (value === "studio_owners") return "Studio owners";
  if (value === "organizers") return "Organizers";
  if (value === "instructors") return "Instructors";
  if (value === "independent_instructors") return "Independent instructors";
  if (value === "portal_users") return "Portal users";
  if (value === "all_users") return "All users";
  return value.replaceAll("_", " ");
}

function alertTypeLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
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
const PAID_PAYMENT_STATUSES = new Set([
  "paid",
  "processed",
  "succeeded",
  "complete",
  "completed",
]);

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
  studioBillingPlan?: string | null;
  subscription: SubscriptionRow | undefined;
}) {
  const { studioName, studioBillingPlan, subscription } = params;
  const plan = subscription ? getPlan(subscription.subscription_plans) : null;
  const planCode =
    plan?.code?.toLowerCase() ?? studioBillingPlan?.trim().toLowerCase() ?? "";
  const sharedPlan = planCode ? getBillingPlan(planCode as never) : null;

  if (sharedPlan?.audience === "organizer" || planCode === "organizer") {
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

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  organizer: "Organizer",
};

function normalizeStatus(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function getPlanLabelFromCode(value: string | null | undefined) {
  const code = (value ?? "").trim().toLowerCase();
  if (!code) return null;

  return (
    PLAN_LABELS[code] ??
    code
      .split(/[\-_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

function getEffectivePlanName(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const plan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return plan?.name ?? getPlanLabelFromCode(params.studio.billing_plan) ?? "No plan";
}

function getEffectivePlanCode(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const plan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return plan?.code ?? params.studio.billing_plan ?? null;
}

function getEffectiveTrialEndsAt(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  return (
    params.subscription?.trial_ends_at ??
    params.studio.trial_ends_at ??
    params.subscription?.current_period_end ??
    null
  );
}

function getEffectiveBillingStatus(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const subscriptionStatus = normalizeStatus(params.subscription?.status);
  if (subscriptionStatus) return subscriptionStatus;

  const studioStatus = normalizeStatus(params.studio.subscription_status);
  if (studioStatus) return studioStatus;

  return params.studio.active === false ? "inactive" : "not_started";
}

function getWorkspaceStatusLabel(studio: StudioRow) {
  return studio.active === false ? "Workspace Disabled" : "Workspace Active";
}

function hasPaidPlan(params: { studio: StudioRow; subscription?: SubscriptionRow }) {
  const planCode = getEffectivePlanCode(params);
  const planName = getEffectivePlanName(params);

  return Boolean(planCode || (planName && planName !== "No plan"));
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
    { data: payments, error: paymentsError },
    { data: eventPayments, error: eventPaymentsError },
    { data: platformErrorLogs },
    { data: packageDeductionErrors },
    { data: smsMessageLogs, error: smsMessageLogsError },
    { data: platformBroadcastAlerts, error: platformBroadcastAlertsError },
  ] = await Promise.all([
    supabase
  .from("studios")
  .select(
    "id, name, created_at, billing_plan, subscription_status, active, stripe_customer_id, stripe_subscription_id, trial_ends_at, last_workspace_access_at, last_workspace_access_user_id"
  )
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
      .from("payments")
      .select("id, studio_id, amount, currency, status, payment_type, source, paid_at, created_at"),

    supabase
      .from("event_payments")
      .select("id, amount, currency, status, created_at"),

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

    supabase
      .from("sms_message_logs")
      .select("id, status, direction, provider_error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(500),

    supabase
      .from("platform_alerts")
      .select("id, title, message, alert_type, audience, active, dismissible, starts_at, ends_at, read_more_url, read_more_label, created_at")
      .order("created_at", { ascending: false })
      .limit(8),
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

  if (paymentsError) {
    throw new Error(`Failed to load payments: ${paymentsError.message}`);
  }

  if (platformBroadcastAlertsError) {
    throw new Error(`Failed to load platform broadcast alerts: ${platformBroadcastAlertsError.message}`);
  }

  if (eventPaymentsError) {
    throw new Error(`Failed to load event payments: ${eventPaymentsError.message}`);
  }

  if (smsMessageLogsError) {
    throw new Error(`Failed to load SMS message logs: ${smsMessageLogsError.message}`);
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedStudioInvoices = (studioInvoices ?? []) as StudioInvoiceRow[];
  const typedPayments = (payments ?? []) as PaymentRow[];
  const typedEventPayments = (eventPayments ?? []) as EventPaymentRow[];
  const typedPlatformErrorLogs = (platformErrorLogs ?? []) as PlatformErrorLogRow[];
  const typedPackageDeductionErrors = (packageDeductionErrors ?? []) as PackageDeductionErrorRow[];
  const typedSmsMessageLogs = (smsMessageLogs ?? []) as SmsMessageLogRow[];
  const typedPlatformBroadcastAlerts = (platformBroadcastAlerts ?? []) as PlatformBroadcastAlertRow[];
  const activePlatformBroadcastAlerts = typedPlatformBroadcastAlerts.filter((alert) => alert.active);

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const studioWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return !isOrganizerWorkspace({
      studioName: studio.name,
      studioBillingPlan: studio.billing_plan,
      subscription,
    });
  });

  const organizerWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return isOrganizerWorkspace({
      studioName: studio.name,
      studioBillingPlan: studio.billing_plan,
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

  const grossStudioPaymentVolume = typedPayments
    .filter((payment) =>
      PAID_PAYMENT_STATUSES.has((payment.status ?? "").toLowerCase())
    )
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

  const grossEventPaymentVolume = typedEventPayments
    .filter((payment) =>
      PAID_PAYMENT_STATUSES.has((payment.status ?? "").toLowerCase())
    )
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

  const grossSubscriptionPaymentVolume = typedStudioInvoices
    .filter((invoice) =>
      PAID_INVOICE_STATUSES.has((invoice.status ?? "").toLowerCase())
    )
    .reduce((sum, invoice) => sum + Number(invoice.amount_paid ?? 0), 0);

  const grossPaymentVolume =
    grossStudioPaymentVolume + grossEventPaymentVolume + grossSubscriptionPaymentVolume;

  const studioWorkspaceIds = new Set(studioWorkspaces.map((studio) => studio.id));
  const organizerWorkspaceIds = new Set(organizerWorkspaces.map((studio) => studio.id));

  const getStatusForStudio = (studio: StudioRow) =>
    getEffectiveBillingStatus({
      studio,
      subscription: subscriptionByStudioId.get(studio.id),
    });

  const activeStudioWorkspaces = studioWorkspaces.filter(
    (studio) => getStatusForStudio(studio) === "active"
  ).length;
  const trialingStudioWorkspaces = studioWorkspaces.filter(
    (studio) => getStatusForStudio(studio) === "trialing"
  ).length;
  const pastDueStudioWorkspaces = studioWorkspaces.filter(
    (studio) => getStatusForStudio(studio) === "past_due"
  ).length;
  const cancelledStudioWorkspaces = studioWorkspaces.filter((studio) => {
    const status = getStatusForStudio(studio);
    return status === "cancelled" || status === "canceled";
  }).length;

  const activeOrganizerWorkspaces = organizerWorkspaces.filter(
    (studio) => getStatusForStudio(studio) === "active"
  ).length;
  const trialingOrganizerWorkspaces = organizerWorkspaces.filter(
    (studio) => getStatusForStudio(studio) === "trialing"
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

  const studioPlanMix = studioWorkspaces.reduce<Record<string, number>>(
    (acc, studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const key = getEffectivePlanName({ studio, subscription });
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const organizerPlanMix = organizerWorkspaces.reduce<Record<string, number>>(
    (acc, studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const key = getEffectivePlanName({ studio, subscription });
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const billingIssues = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const status = getEffectiveBillingStatus({ studio, subscription });

      return {
        studio,
        subscription,
        status,
        workspaceType: organizerWorkspaceIds.has(studio.id) ? "Organizer" : "Studio",
      };
    })
    .filter(({ status }) => {
      return status === "past_due" || status === "cancelled" || status === "canceled";
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
    .filter(({ studio, subscription }) => {
      const status = getEffectiveBillingStatus({ studio, subscription });

      if (!hasPaidPlan({ studio, subscription })) return false;
      return !hasActiveBillingAccess(status);
    });

  const serverSideAlertCount =
    typedPlatformErrorLogs.length + typedPackageDeductionErrors.length;

  const latestServerSideAlert =
    typedPlatformErrorLogs[0]?.message ??
    typedPackageDeductionErrors[0]?.error_message ??
    null;

  const smsFailedMessages = typedSmsMessageLogs.filter((message) =>
    ["failed", "undelivered", "suppressed"].includes((message.status ?? "").toLowerCase())
  ).length;
  const smsQueuedMessages = typedSmsMessageLogs.filter(
    (message) => (message.status ?? "").toLowerCase() === "queued"
  ).length;

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

  const eventPaymentRevenueFor = (start: Date) =>
    typedEventPayments
      .filter((payment) =>
        PAID_PAYMENT_STATUSES.has((payment.status ?? "").toLowerCase())
      )
      .filter((payment) => isOnOrAfter(payment.created_at, start))
      .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

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
      description: "3.5% platform fee from collected event payments.",
      values: {
        today: eventPaymentRevenueFor(todayStart) * PLATFORM_TICKET_FEE_RATE,
        month: eventPaymentRevenueFor(monthStart) * PLATFORM_TICKET_FEE_RATE,
        ytd: eventPaymentRevenueFor(yearStart) * PLATFORM_TICKET_FEE_RATE,
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
  const neverAccessedStudios = studioWorkspaces.filter(
    (studio) => !studio.last_workspace_access_at
  );
  const staleAccessStudios = studioWorkspaces
    .filter((studio) => {
      if (!studio.last_workspace_access_at) return false;
      return Date.now() - new Date(studio.last_workspace_access_at).getTime() >
        1000 * 60 * 60 * 24 * 30;
    })
    .sort((a, b) =>
      new Date(a.last_workspace_access_at ?? 0).getTime() -
      new Date(b.last_workspace_access_at ?? 0).getTime()
    );

  const attentionItems = [
    {
      label: "Paid access risk",
      count: paidAccessWithoutActiveSubscription.length,
      detail: "Paid-plan workspaces without active or trialing subscription access.",
      href: "/platform/billing",
      action: "Review billing",
      tone: "rose" as const,
    },
    {
      label: "Billing issues",
      count: billingIssues.length,
      detail: "Past due or canceled subscriptions that may need follow-up.",
      href: "/platform/billing",
      action: "Open billing health",
      tone: "amber" as const,
    },
    {
      label: "Workspace inactivity",
      count: neverAccessedStudios.length + staleAccessStudios.length,
      detail: "Studio workspaces never accessed or not opened in 30+ days.",
      href: "/platform/studios",
      action: "Review studios",
      tone: "sky" as const,
    },
    {
      label: "Server-side alerts",
      count: serverSideAlertCount,
      detail: "Unresolved platform errors and package deduction problems.",
      href: "/platform/alerts",
      action: "Review alerts",
      tone: "orange" as const,
    },
    {
      label: "SMS delivery watch",
      count: smsFailedMessages + smsQueuedMessages,
      detail: "Queued or failed texts that may need Twilio, webhook, or carrier approval review.",
      href: "/platform/sms",
      action: "Open SMS status",
      tone: smsFailedMessages > 0 ? "rose" as const : "sky" as const,
    },
    {
      label: "Active broadcasts",
      count: activePlatformBroadcastAlerts.length,
      detail: "Dashboard announcements currently visible to users.",
      href: "/platform/alerts",
      action: "Manage broadcasts",
      tone: "violet" as const,
    },
  ];

  const attentionToneClass = {
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    orange: "border-orange-200 bg-orange-50 text-orange-950",
    violet: "border-violet-200 bg-violet-50 text-violet-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
  };

  const attentionButtonClass = {
    rose: "bg-rose-700 text-white hover:bg-rose-800",
    amber: "bg-amber-700 text-white hover:bg-amber-800",
    orange: "bg-orange-700 text-white hover:bg-orange-800",
    violet: "bg-violet-700 text-white hover:bg-violet-800",
    sky: "bg-sky-700 text-white hover:bg-sky-800",
  };

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
              <Link
                href="/platform/sms"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                SMS Status
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
              <p className="text-sm text-amber-700">Gross Payment Volume</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">
                {formatMoney(grossPaymentVolume, "USD")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Needs Attention
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Platform operations console
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Start here each day. These cards highlight billing risk, backend issues, active broadcasts, and the fastest admin actions to take next.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/api/platform/daily-digest"
              className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              Open digest endpoint
            </Link>
            <Link
              href="/platform/billing"
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              Billing health
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {attentionItems.map((item) => (
            <div
              key={item.label}
              className={`rounded-3xl border p-5 ${attentionToneClass[item.tone]}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{item.label}</p>
                  <p className="mt-1 text-3xl font-semibold">{item.count}</p>
                </div>
                <span className="rounded-full bg-white/70 px-2.5 py-1 text-xs font-semibold ring-1 ring-black/5">
                  {item.count > 0 ? "Review" : "Clear"}
                </span>
              </div>
              <p className="mt-3 min-h-12 text-sm leading-6 opacity-85">
                {item.detail}
              </p>
              <Link
                href={item.href}
                className={`mt-4 inline-flex rounded-xl px-3 py-2 text-xs font-semibold shadow-sm transition ${attentionButtonClass[item.tone]}`}
              >
                {item.action}
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-3">
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-rose-950">Top billing risks</h3>
              <Link href="/platform/billing" className="text-xs font-semibold text-rose-800 underline">
                View all
              </Link>
            </div>
            {paidAccessWithoutActiveSubscription.length === 0 ? (
              <p className="mt-4 rounded-2xl border border-rose-100 bg-white/70 p-4 text-sm text-rose-800">
                No paid-access mismatches found.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {paidAccessWithoutActiveSubscription.slice(0, 3).map(({ studio, status, workspaceType }) => (
                  <Link
                    key={studio.id}
                    href={`/platform/studios/${studio.id}`}
                    className="block rounded-2xl border border-rose-100 bg-white/80 p-4 transition hover:bg-white"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-rose-950">{studio.name}</p>
                      <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-800">
                        {workspaceType}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-rose-700">Status: {statusLabel(status)}</p>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-amber-950">Latest backend issues</h3>
              <Link href="/platform/alerts" className="text-xs font-semibold text-amber-800 underline">
                View all
              </Link>
            </div>
            {serverSideAlertCount === 0 ? (
              <p className="mt-4 rounded-2xl border border-amber-100 bg-white/70 p-4 text-sm text-amber-800">
                No unresolved backend issues found.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {typedPlatformErrorLogs.slice(0, 2).map((errorLog) => (
                  <div key={errorLog.id} className="rounded-2xl border border-amber-100 bg-white/80 p-4">
                    <p className="text-sm font-semibold text-amber-950">{errorLog.source}</p>
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-amber-800">{errorLog.message}</p>
                    <p className="mt-2 text-xs text-amber-700">{formatDateTime(errorLog.created_at)}</p>
                  </div>
                ))}
                {typedPackageDeductionErrors.slice(0, 2).map((errorLog) => (
                  <div key={errorLog.id} className="rounded-2xl border border-orange-100 bg-white/80 p-4">
                    <p className="text-sm font-semibold text-orange-950">Package deduction error</p>
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-orange-800">
                      {errorLog.error_message ?? "Package credit deduction failed."}
                    </p>
                    <p className="mt-2 text-xs text-orange-700">{formatDateTime(errorLog.created_at)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
            <h3 className="text-sm font-semibold text-emerald-950">Today at a glance</h3>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white/80 px-4 py-3">
                <span className="text-sm text-emerald-800">Ticket platform fees</span>
                <span className="text-sm font-semibold text-emerald-950">
                  {formatMoney(eventPaymentRevenueFor(todayStart) * PLATFORM_TICKET_FEE_RATE, "USD")}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white/80 px-4 py-3">
                <span className="text-sm text-emerald-800">Subscription revenue</span>
                <span className="text-sm font-semibold text-emerald-950">
                  {formatMoney(subscriptionRevenueFor(todayStart), "USD")}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white/80 px-4 py-3">
                <span className="text-sm text-emerald-800">New trials</span>
                <span className="text-sm font-semibold text-emerald-950">{newTrialSignupsFor(todayStart)}</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white/80 px-4 py-3">
                <span className="text-sm text-emerald-800">Cancellations</span>
                <span className="text-sm font-semibold text-emerald-950">{cancellationsFor(todayStart)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>


      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Platform Broadcasts
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Dashboard announcements
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Send temporary notices to user dashboards for maintenance, outages, feature announcements, or important updates. Add an optional Read more link for a knowledgebase article or announcement detail page.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <span className="font-semibold text-slate-950">{activePlatformBroadcastAlerts.length}</span>{" "}
            active broadcast{activePlatformBroadcastAlerts.length === 1 ? "" : "s"}
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <form action={createPlatformBroadcastAlertAction} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <h3 className="text-lg font-semibold text-slate-950">Create broadcast alert</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Keep the dashboard message short. Use Read more for full details, screenshots, or setup instructions.
            </p>

            <div className="mt-5 grid gap-4">
              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Title <span className="sr-only">required</span>
                <input name="title" required className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950" placeholder="Scheduled maintenance" />
              </label>

              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Short message <span className="sr-only">required</span>
                <textarea name="message" required rows={4} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950" placeholder="DanceFlow will be unavailable tonight from 11:00 PM to midnight while we complete maintenance." />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Alert type
                  <select name="alertType" defaultValue="info" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950">
                    <option value="info">Info</option>
                    <option value="success">Success / Feature</option>
                    <option value="warning">Warning</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>

                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Audience
                  <select name="audience" defaultValue="all_workspace_users" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950">
                    <option value="all_workspace_users">All workspace users</option>
                    <option value="studio_owners">Studio owners</option>
                    <option value="organizers">Organizers</option>
                    <option value="instructors">Instructors</option>
                    <option value="independent_instructors">Independent instructors</option>
                    <option value="portal_users">Portal users</option>
                    <option value="all_users">All users</option>
                  </select>
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Starts at
                  <input name="startsAt" type="datetime-local" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950" />
                </label>

                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Ends at
                  <input name="endsAt" type="datetime-local" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950" />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Read more URL
                  <input name="readMoreUrl" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950" placeholder="/help/announcements/calendar-sync" />
                </label>

                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Link label
                  <input name="readMoreLabel" defaultValue="Read more" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950" />
                </label>
              </div>

              <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                <label className="inline-flex items-center gap-2">
                  <input name="active" type="checkbox" defaultChecked className="h-4 w-4 rounded border-slate-300" />
                  Active now
                </label>
                <label className="inline-flex items-center gap-2">
                  <input name="dismissible" type="checkbox" defaultChecked className="h-4 w-4 rounded border-slate-300" />
                  Users can dismiss
                </label>
              </div>

              <button type="submit" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90">
                Send broadcast alert
              </button>
            </div>
          </form>

          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Recent broadcasts</h3>
                <p className="mt-1 text-sm text-slate-600">Deactivate an alert when it should stop showing immediately.</p>
              </div>
            </div>

            {typedPlatformBroadcastAlerts.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
                No broadcast alerts have been created yet.
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {typedPlatformBroadcastAlerts.map((alert) => (
                  <div key={alert.id} className={`rounded-2xl border p-4 ${platformAlertTypeClass(alert.alert_type)}`}>
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold">{alert.title}</p>
                          <span className="rounded-full bg-white/70 px-2.5 py-1 text-xs font-semibold ring-1 ring-black/5">
                            {alert.active ? "Active" : "Inactive"}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-6 opacity-90">{alert.message}</p>
                        <p className="mt-2 text-xs opacity-75">
                          {alertTypeLabel(alert.alert_type)} • {audienceLabel(alert.audience)} • Created {formatDate(alert.created_at)}
                        </p>
                        <p className="mt-1 text-xs opacity-75">
                          Window: {formatDateTime(alert.starts_at)} to {formatDateTime(alert.ends_at)}
                        </p>
                        {alert.read_more_url ? (
                          <p className="mt-2 text-xs font-semibold underline">
                            {alert.read_more_label || "Read more"}: {alert.read_more_url}
                          </p>
                        ) : null}
                      </div>

                      <form action={setPlatformBroadcastAlertActiveAction}>
                        <input type="hidden" name="alertId" value={alert.id} />
                        <input type="hidden" name="active" value={alert.active ? "false" : "true"} />
                        <button type="submit" className="rounded-xl bg-white/80 px-3 py-2 text-xs font-semibold text-slate-800 ring-1 ring-black/10 hover:bg-white">
                          {alert.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
            <p className="text-sm text-slate-500">Event Registration Value</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatMoney(grossRegistrationVolume, "USD")}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Based on registrations marked paid or partially paid. Actual collected payments are shown in Gross Payment Volume.
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
                {billingIssues.slice(0, 8).map(({ studio, subscription, status, workspaceType }) => {
                  const planName = getEffectivePlanName({ studio, subscription });

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
                            {workspaceType} • Plan: {planName} • {getWorkspaceStatusLabel(studio)}
                          </p>
                        </div>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            status
                          )}`}
                        >
                          {statusLabel(status)}
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
  
      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">Workspace activity</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Last access tracking</h2>
            <p className="mt-1 text-sm text-slate-500">
              Use this to spot abandoned trials, paid accounts that are not adopting the workspace, and billing/access mismatches.
            </p>
          </div>
          <Link href="/platform/studios" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Open studio directory
          </Link>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-600">Never accessed</p>
            <p className="mt-1 text-3xl font-semibold text-slate-950">{neverAccessedStudios.length}</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-700">No access in 30+ days</p>
            <p className="mt-1 text-3xl font-semibold text-amber-950">{staleAccessStudios.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm text-emerald-700">Recently active</p>
            <p className="mt-1 text-3xl font-semibold text-emerald-950">
              {Math.max(0, studioWorkspaces.length - neverAccessedStudios.length - staleAccessStudios.length)}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900">Never accessed workspaces</h3>
            <div className="mt-3 space-y-2">
              {neverAccessedStudios.slice(0, 5).map((studio) => (
                <Link key={studio.id} href={`/platform/studios/${studio.id}`} className="block rounded-xl border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                  <span className="font-medium text-slate-900">{studio.name}</span>
                  <span className="ml-2 text-slate-500">Created {formatDate(studio.created_at)}</span>
                </Link>
              ))}
              {neverAccessedStudios.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">No never-accessed studios.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900">Oldest recent access</h3>
            <div className="mt-3 space-y-2">
              {staleAccessStudios.slice(0, 5).map((studio) => (
                <Link key={studio.id} href={`/platform/studios/${studio.id}`} className="block rounded-xl border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                  <span className="font-medium text-slate-900">{studio.name}</span>
                  <span className="ml-2 text-slate-500">Last access {formatLastWorkspaceAccess(studio.last_workspace_access_at)}</span>
                </Link>
              ))}
              {staleAccessStudios.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">No stale studio access older than 30 days.</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

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
                      const planName = getEffectivePlanName({ studio, subscription });
                      const billingStatus = getEffectiveBillingStatus({ studio, subscription });
                      const effectiveTrialEndsAt = getEffectiveTrialEndsAt({ studio, subscription });

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
                              <p className="mt-1 text-xs font-medium text-slate-500">
                                Last workspace access: {formatLastWorkspaceAccess(studio.last_workspace_access_at)}
                              </p>
                            </div>

                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                billingStatus
                              )}`}
                            >
                              {billingStatus === "trialing"
  ? trialStatusLabel(effectiveTrialEndsAt)
  : statusLabel(billingStatus)}
                            </span>
                          </div>

                          <p className="mt-2 text-sm text-slate-600">
  {planName} • {getWorkspaceStatusLabel(studio)} • {eventsByStudioId.get(studio.id) ?? 0} events •{" "}
  {registrationsByStudioId.get(studio.id) ?? 0} registrations
</p>

{billingStatus === "trialing" ? (
  <p className="mt-1 text-xs font-medium text-sky-700">
    {trialStatusDetail(effectiveTrialEndsAt)}
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
                      const planName = getEffectivePlanName({ studio, subscription });
                      const billingStatus = getEffectiveBillingStatus({ studio, subscription });
                      const effectiveTrialEndsAt = getEffectiveTrialEndsAt({ studio, subscription });

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
                              <p className="mt-1 text-xs font-medium text-slate-500">
                                Last workspace access: {formatLastWorkspaceAccess(studio.last_workspace_access_at)}
                              </p>
                            </div>

                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                billingStatus
                              )}`}
                            >
                              {billingStatus === "trialing"
  ? trialStatusLabel(effectiveTrialEndsAt)
  : statusLabel(billingStatus)}
                            </span>
                          </div>

                          <p className="mt-2 text-sm text-slate-600">
  {planName} • {getWorkspaceStatusLabel(studio)} • {organizersByStudioId.get(studio.id) ?? 0} organizer accounts •{" "}
  {publicEventsByStudioId.get(studio.id) ?? 0} public events
</p>

{billingStatus === "trialing" ? (
  <p className="mt-1 text-xs font-medium text-sky-700">
    {trialStatusDetail(effectiveTrialEndsAt)}
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
                  Event registration value {formatMoney(grossRegistrationVolume, "USD")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}