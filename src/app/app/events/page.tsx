import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  Sparkles,
  Ticket,
  Globe2,
  Star,
  MapPin,
  TrendingDown,
  TrendingUp,
  Wallet,
  Users,
  ArrowRight,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseServiceClient } from "@supabase/supabase-js";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { planHasFeature } from "@/lib/billing/plans";
import CopyCalendarFeedButton from "@/components/app/CopyCalendarFeedButton";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import { duplicateEventAction } from "./actions";
import { updateOrganizerAriaActionStatusAction } from "./aria-actions";

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) return null;

  return createSupabaseServiceClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

type EventRow = {
  id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  event_type: string;
  city: string | null;
  state: string | null;
  timezone: string | null;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  visibility: string;
  featured: boolean;
  status: string;
  registration_required: boolean;
  beginner_friendly: boolean;
  public_directory_enabled: boolean;
  organizers:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null;
};

type RegistrationSummaryRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  quantity?: number | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
};

type AttendanceSummaryRow = {
  id: string;
  event_registration_id: string;
  status: string;
};

type EventTicketCheckInRow = {
  id: string;
  event_id: string | null;
  registration_id: string | null;
  checked_in_at: string | null;
};

type EventProfitabilityRow = {
  event_id: string | null;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
};

type EventSettlementSummaryRow = {
  event_id: string | null;
  status: string | null;
  settled_at: string | null;
};

type PersistedAriaActionItemRow = {
  id: string;
  action_key: string;
  status: string;
  snoozed_until: string | null;
  updated_at?: string | null;
};

type OrganizerEventDashboardRow = {
  event: EventRow;
  grossTicketRevenue: number;
  refunds: number;
  fees: number;
  netTicketRevenue: number;
  eventExpenses: number;
  eventLaborCosts: number;
  totalEventCosts: number;
  eventProfitLoss: number;
  marginPercent: number | null;
  registrations: number;
  paidRegistrations: number;
  unpaidRegistrations: number;
  pendingRegistrations: number;
  refundedRegistrations: number;
  ticketsIssued: number;
  ticketsCheckedIn: number;
  checkInRate: number | null;
  settlementStatus: string;
  settledAt: string | null;
  hasSettlementRecord: boolean;
  isCompletedOrPast: boolean;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  public_name: string | null;
  slug: string | null;
  billing_plan: string | null;
  subscription_status: string | null;
};

type SubscriptionRow = {
  status: string | null;
  subscription_plan_id: string | null;
};

type SubscriptionPlanRow = {
  code: string | null;
};

function isOrganizerWorkspaceRole(role: string | null | undefined) {
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageEvents(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin"
  );
}

function canManageOrganizerProfile(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageBilling(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "organizer_owner";
}

function isActiveOrTrialing(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "active" || normalized === "trialing";
}

function getEffectiveBillingPlan(
  workspace: WorkspaceRow | null | undefined,
  subscriptionPlan: SubscriptionPlanRow | null | undefined,
) {
  return (
    subscriptionPlan?.code?.trim().toLowerCase() ||
    workspace?.billing_plan?.trim().toLowerCase() ||
    ""
  );
}

function getEffectiveSubscriptionStatus(
  workspace: WorkspaceRow | null | undefined,
  subscription: SubscriptionRow | null | undefined,
) {
  return (
    subscription?.status?.trim().toLowerCase() ||
    workspace?.subscription_status?.trim().toLowerCase() ||
    ""
  );
}

function canUseStudioHostedEvents(params: {
  workspace: WorkspaceRow | null | undefined;
  subscription: SubscriptionRow | null | undefined;
  subscriptionPlan: SubscriptionPlanRow | null | undefined;
}) {
  const planCode = getEffectiveBillingPlan(
    params.workspace,
    params.subscriptionPlan,
  );
  const status = getEffectiveSubscriptionStatus(
    params.workspace,
    params.subscription,
  );

  return isActiveOrTrialing(status) && planHasFeature(planCode, "ticketing");
}

function statusBadgeClass(status: string) {
  if (status === "published" || status === "open") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (status === "draft") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  if (status === "cancelled") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }
  if (status === "completed") {
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  if (value === "other") return "Other";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function eventTypeBadgeClass(value: string) {
  if (value === "group_class") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  }
  if (value === "practice_party") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  if (value === "workshop") {
    return "bg-violet-50 text-violet-700 ring-1 ring-violet-200";
  }
  if (value === "social_dance") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (value === "competition") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }
  if (value === "showcase") {
    return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200";
  }
  if (value === "festival") {
    return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200";
  }
  if (value === "special_event") {
    return "bg-orange-50 text-orange-700 ring-1 ring-orange-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function visibilityLabel(value: string) {
  if (value === "public") return "Public";
  if (value === "unlisted") return "Unlisted";
  if (value === "private") return "Private";
  return value;
}

function visibilityBadgeClass(value: string) {
  if (value === "public") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (value === "unlisted") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  if (value === "private") {
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function formatDateRange(startDate: string, endDate: string | null) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate ?? startDate}T00:00:00`);

  const startText = start.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const endText = end.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return !endDate || startDate === endDate
    ? startText
    : `${startText} - ${endText}`;
}

function formatTimeRange(startTime: string | null, endTime: string | null) {
  if (!startTime && !endTime) return "Time not set";
  if (!startTime || !endTime) return startTime || endTime || "Time not set";

  const start = new Date(`2000-01-01T${startTime}`);
  const end = new Date(`2000-01-01T${endTime}`);

  const startText = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const endText = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${startText} - ${endText}`;
}

function formatTimeZoneLabel(timeZone?: string | null) {
  if (!timeZone) return "Event timezone";

  return timeZone.replaceAll("_", " ");
}

function weekdayPlural(startDate: string) {
  const date = new Date(`${startDate}T00:00:00`);
  return `${date.toLocaleDateString([], { weekday: "long" })}s`;
}

function seriesWeekCount(startDate: string, endDate: string | null) {
  if (!endDate) return null;

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end < start
  ) {
    return null;
  }

  const days = Math.round(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );

  return Math.floor(days / 7) + 1;
}

function formatEventSchedule(event: EventRow) {
  const timeRange =
    event.start_time || event.end_time
      ? formatTimeRange(event.start_time, event.end_time)
      : "";
  const timeZoneLabel = timeRange ? formatTimeZoneLabel(event.timezone) : "";

  if (event.event_type !== "group_class") {
    return [
      formatDateRange(event.start_date, event.end_date),
      timeRange,
      timeZoneLabel,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (event.end_date) {
    const weeks = seriesWeekCount(event.start_date, event.end_date);

    return [
      weekdayPlural(event.start_date),
      formatDateRange(event.start_date, event.end_date),
      timeRange,
      timeZoneLabel,
      weeks ? `${weeks}-week series` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return [
    weekdayPlural(event.start_date),
    `Starts ${formatDateRange(event.start_date, event.start_date)}`,
    timeRange,
    timeZoneLabel,
    "Ongoing weekly class",
  ]
    .filter(Boolean)
    .join(" · ");
}

function getOrganizer(
  value:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null,
) {
  return Array.isArray(value) ? value[0] : value;
}

function hasPublicDiscoveryBasics(event: EventRow) {
  return (
    event.public_directory_enabled &&
    event.visibility === "public" &&
    (event.status === "published" || event.status === "open")
  );
}

function getEventHostLabel(params: {
  organizer: { id?: string; name: string; slug: string } | null | undefined;
  studioHostedEvents: boolean;
  workspaceName: string;
}) {
  if (params.organizer?.name?.trim()) {
    return params.organizer.name;
  }

  if (params.studioHostedEvents) {
    return params.workspaceName;
  }

  return "Unknown";
}

function isEventDiscoveryReady(params: {
  event: EventRow;
  organizer: { id?: string; name: string; slug: string } | null | undefined;
  studioHostedEvents: boolean;
}) {
  return (
    hasPublicDiscoveryBasics(params.event) &&
    (Boolean(params.event.organizer_id) ||
      Boolean(params.organizer) ||
      params.studioHostedEvents)
  );
}

function eventListingHint(eventType: string, visibility: string) {
  const publicHint =
    visibility === "public"
      ? "Shown in public offerings."
      : visibility === "unlisted"
        ? "Available by direct link only."
        : "Internal/private only.";

  if (eventType === "group_class") {
    return `Class offering managed as an event. ${publicHint}`;
  }

  if (eventType === "practice_party") {
    return `Practice party managed as an event. ${publicHint}`;
  }

  return publicHint;
}

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function safeNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function fmtPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return `${value.toFixed(1)}%`;
}

function ariaActionKey(...parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) =>
      String(part ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("-");
}

function ariaActionStatusLabel(status: string | null | undefined) {
  const normalized = (status ?? "open").trim().toLowerCase();

  if (normalized === "completed") return "Completed";
  if (normalized === "dismissed") return "Dismissed";
  if (normalized === "snoozed") return "Snoozed";

  return "Open";
}

function settlementStatusLabel(status: string | null | undefined) {
  const normalized = (status ?? "open").trim().toLowerCase();
  if (normalized === "ready_to_settle") return "Ready to Settle";
  if (normalized === "settled") return "Settled";
  if (normalized === "reopened") return "Reopened";
  return "Open";
}

function settlementBadgeClass(status: string | null | undefined) {
  const normalized = (status ?? "open").trim().toLowerCase();
  if (normalized === "settled") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (normalized === "ready_to_settle") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  }
  if (normalized === "reopened") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

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

function ComparisonCard({
  title,
  subtitle,
  rows,
  metricLabel,
  getMetric,
  getDetail,
  positiveIsGood = true,
}: {
  title: string;
  subtitle: string;
  rows: OrganizerEventDashboardRow[];
  metricLabel: string;
  getMetric: (row: OrganizerEventDashboardRow) => string;
  getDetail?: (row: OrganizerEventDashboardRow) => string;
  positiveIsGood?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <h3 className="font-semibold text-slate-950">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-slate-500">{subtitle}</p>
      </div>

      <div className="mt-4 space-y-3">
        {rows.length > 0 ? (
          rows.map((row, index) => {
            const isPositive = row.eventProfitLoss >= 0;
            const metricClass = positiveIsGood
              ? isPositive
                ? "text-emerald-700"
                : "text-rose-700"
              : "text-slate-950";

            return (
              <div
                key={row.event.id}
                className="rounded-xl border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                        {index + 1}
                      </span>
                      <Link
                        href={`/app/events/${row.event.id}`}
                        className="truncate font-semibold text-slate-950 hover:text-[var(--brand-primary)]"
                      >
                        {row.event.name}
                      </Link>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {formatDateRange(
                        row.event.start_date,
                        row.event.end_date,
                      )}{" "}
                      • {settlementStatusLabel(row.settlementStatus)}
                    </p>
                    {getDetail ? (
                      <p className="mt-1 text-xs text-slate-500">
                        {getDetail(row)}
                      </p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-xs text-slate-500">{metricLabel}</p>
                    <p className={`mt-1 font-semibold ${metricClass}`}>
                      {getMetric(row)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
            Not enough event data yet.
          </div>
        )}
      </div>
    </div>
  );
}

export default async function EventsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: workspace, error: workspaceError },
    { data: events, error: eventsError },
    { data: subscriptionRows, error: subscriptionsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, public_name, slug, billing_plan, subscription_status")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("events")
      .select(
        `
        id,
        organizer_id,
        name,
        slug,
        event_type,
        city,
        state,
        timezone,
        start_date,
        end_date,
        start_time,
        end_time,
        visibility,
        featured,
        status,
        registration_required,
        beginner_friendly,
        public_directory_enabled,
        organizers ( id, name, slug )
      `,
      )
      .eq("studio_id", studioId)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("studio_subscriptions")
      .select("status, subscription_plan_id")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  if (subscriptionsError) {
    throw new Error(
      `Failed to load subscription: ${subscriptionsError.message}`,
    );
  }

  const latestSubscription =
    ((subscriptionRows ?? []) as SubscriptionRow[])[0] ?? null;
  let subscriptionPlan: SubscriptionPlanRow | null = null;

  if (latestSubscription?.subscription_plan_id) {
    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("code")
      .eq("id", latestSubscription.subscription_plan_id)
      .maybeSingle<SubscriptionPlanRow>();

    if (planError) {
      throw new Error(`Failed to load subscription plan: ${planError.message}`);
    }

    subscriptionPlan = plan;
  }

  const workspaceName =
    workspace?.public_name?.trim() || workspace?.name?.trim() || "Workspace";

  const organizerWorkspace = isOrganizerWorkspaceRole(context.studioRole);

  /**
   * Existing studio-created events should display as studio-hosted when
   * organizer_id is null. Billing/plan checks can control creation/publishing,
   * but the event list should not show "Unknown" for valid live studio events.
   */
  const studioHostedEvents = !organizerWorkspace;
  const showCreateEvent = canManageEvents(
    context.studioRole,
    context.isPlatformAdmin,
  );
  const showOrganizerProfile = canManageOrganizerProfile(
    context.studioRole,
    context.isPlatformAdmin,
  );
  const showBilling = canManageBilling(
    context.studioRole,
    context.isPlatformAdmin,
  );

  const typedEvents = (events ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  const siteUrl = "https://www.idanceflow.com";
  const organizerFeedSlug =
    typedEvents
      .map((event) => getOrganizer(event.organizers)?.slug)
      .find((slug) => Boolean(slug)) ?? null;

  const studioFeedSlug = workspace?.slug ?? null;

  const calendarFeedUrl = organizerWorkspace
    ? organizerFeedSlug
      ? `${siteUrl}/api/public-calendars/organizers/${organizerFeedSlug}/events.ics`
      : null
    : studioFeedSlug
      ? `${siteUrl}/api/public-calendars/studios/${studioFeedSlug}/events.ics`
      : null;

  let typedRegistrations: RegistrationSummaryRow[] = [];
  let typedAttendance: AttendanceSummaryRow[] = [];
  let typedTicketCheckIns: EventTicketCheckInRow[] = [];
  let typedProfitabilityRows: EventProfitabilityRow[] = [];
  let typedSettlementRows: EventSettlementSummaryRow[] = [];

  if (eventIds.length > 0) {
    const [
      { data: registrationRows, error: registrationsError },
      { data: attendanceRows, error: attendanceError },
      { data: ticketCheckInRows, error: ticketCheckInsError },
      { data: profitabilityRows, error: profitabilityError },
      { data: settlementRows, error: settlementsError },
    ] = await Promise.all([
      supabase
        .from("event_registrations")
        .select(
          `
          id,
          event_id,
          status,
          payment_status,
          quantity,
          total_price,
          total_amount,
          currency
        `,
        )
        .in("event_id", eventIds),

      supabase.from("attendance_records").select(`
          id,
          event_registration_id,
          status
        `),

      supabase
        .from("event_registration_attendees")
        .select("id,event_id,registration_id,checked_in_at")
        .in("event_id", eventIds)
        .limit(10000),

      supabase
        .from("v_event_profit_loss")
        .select(
          "event_id,gross_ticket_revenue,refunds,processing_and_platform_fees,net_ticket_revenue,event_expenses,event_labor_costs,total_event_costs,event_profit_loss",
        )
        .in("event_id", eventIds),

      supabase
        .from("event_settlements")
        .select("event_id,status,settled_at")
        .in("event_id", eventIds),
    ]);

    if (registrationsError) {
      throw new Error(
        `Failed to load event reporting: ${registrationsError.message}`,
      );
    }

    if (attendanceError) {
      throw new Error(
        `Failed to load attendance reporting: ${attendanceError.message}`,
      );
    }

    if (ticketCheckInsError) {
      console.warn(
        "Failed to load ticket check-in reporting:",
        ticketCheckInsError.message,
      );
    }

    if (profitabilityError) {
      console.warn(
        "Failed to load organizer event profitability reporting:",
        profitabilityError.message,
      );
    }

    if (settlementsError) {
      console.warn(
        "Failed to load organizer settlement reporting:",
        settlementsError.message,
      );
    }

    typedRegistrations = (registrationRows ?? []) as RegistrationSummaryRow[];
    typedAttendance = (attendanceRows ?? []) as AttendanceSummaryRow[];
    typedTicketCheckIns = ticketCheckInsError
      ? []
      : ((ticketCheckInRows ?? []) as EventTicketCheckInRow[]);
    typedProfitabilityRows = profitabilityError
      ? []
      : ((profitabilityRows ?? []) as EventProfitabilityRow[]);
    typedSettlementRows = settlementsError
      ? []
      : ((settlementRows ?? []) as EventSettlementSummaryRow[]);
  }

  const attendanceByRegistrationId = new Map(
    typedAttendance.map((row) => [row.event_registration_id, row]),
  );

  const registrationsByEventId = new Map<string, RegistrationSummaryRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);
  }

  const ticketCheckInsByEventId = new Map<string, EventTicketCheckInRow[]>();
  for (const row of typedTicketCheckIns) {
    if (!row.event_id) continue;
    const current = ticketCheckInsByEventId.get(row.event_id) ?? [];
    current.push(row);
    ticketCheckInsByEventId.set(row.event_id, current);
  }

  const profitabilityByEventId = new Map<string, EventProfitabilityRow>();
  for (const row of typedProfitabilityRows) {
    if (row.event_id) {
      profitabilityByEventId.set(row.event_id, row);
    }
  }

  const settlementByEventId = new Map<string, EventSettlementSummaryRow>();
  for (const row of typedSettlementRows) {
    if (row.event_id) {
      settlementByEventId.set(row.event_id, row);
    }
  }

  const todayStart = new Date(new Date().toDateString());

  const organizerEventRows: OrganizerEventDashboardRow[] = typedEvents.map(
    (event) => {
      const registrations = registrationsByEventId.get(event.id) ?? [];
      const ticketRows = ticketCheckInsByEventId.get(event.id) ?? [];
      const checkedInTickets = ticketRows.filter(
        (row) => row.checked_in_at,
      ).length;
      const legacyCheckedIn = registrations.filter((row) => {
        const attendance = attendanceByRegistrationId.get(row.id);
        return (
          attendance?.status === "checked_in" ||
          attendance?.status === "attended"
        );
      }).length;
      const ticketsIssued =
        ticketRows.length > 0
          ? ticketRows.length
          : registrations.reduce(
              (sum, row) => sum + Number(row.quantity ?? 1),
              0,
            );
      const ticketsCheckedIn =
        ticketRows.length > 0 ? checkedInTickets : legacyCheckedIn;
      const profitability = profitabilityByEventId.get(event.id);
      const settlement = settlementByEventId.get(event.id);
      const netTicketRevenue = safeNumber(profitability?.net_ticket_revenue);
      const eventProfitLoss = safeNumber(profitability?.event_profit_loss);
      const eventStartDate = new Date(`${event.start_date}T00:00:00`);
      const isPastEvent =
        !Number.isNaN(eventStartDate.getTime()) && eventStartDate < todayStart;
      const isCompletedOrPast = event.status === "completed" || isPastEvent;

      return {
        event,
        grossTicketRevenue: safeNumber(profitability?.gross_ticket_revenue),
        refunds: safeNumber(profitability?.refunds),
        fees: safeNumber(profitability?.processing_and_platform_fees),
        netTicketRevenue,
        eventExpenses: safeNumber(profitability?.event_expenses),
        eventLaborCosts: safeNumber(profitability?.event_labor_costs),
        totalEventCosts: safeNumber(profitability?.total_event_costs),
        eventProfitLoss,
        marginPercent: netTicketRevenue
          ? (eventProfitLoss / netTicketRevenue) * 100
          : null,
        registrations: registrations.length,
        paidRegistrations: registrations.filter(
          (row) => row.payment_status === "paid",
        ).length,
        unpaidRegistrations: registrations.filter(
          (row) => row.payment_status === "unpaid",
        ).length,
        pendingRegistrations: registrations.filter(
          (row) => row.payment_status === "pending",
        ).length,
        refundedRegistrations: registrations.filter(
          (row) =>
            row.payment_status === "refunded" ||
            row.status === "refunded" ||
            row.status === "cancelled",
        ).length,
        ticketsIssued,
        ticketsCheckedIn,
        checkInRate: ticketsIssued
          ? (ticketsCheckedIn / ticketsIssued) * 100
          : null,
        settlementStatus: settlement?.status ?? "open",
        settledAt: settlement?.settled_at ?? null,
        hasSettlementRecord: Boolean(settlement),
        isCompletedOrPast,
      };
    },
  );

  const groupClasses = typedEvents.filter(
    (event) => event.event_type === "group_class",
  );
  const publishedCount = typedEvents.filter(
    (event) => event.status === "published" || event.status === "open",
  ).length;
  const featuredCount = typedEvents.filter((event) => event.featured).length;
  const publicOfferingsCount = typedEvents.filter(
    (event) =>
      (event.status === "published" || event.status === "open") &&
      event.visibility === "public",
  ).length;
  const publicGroupClassesCount = groupClasses.filter(
    (event) =>
      (event.status === "published" || event.status === "open") &&
      event.visibility === "public",
  ).length;
  const publicDirectoryCount = typedEvents.filter(
    (event) => event.public_directory_enabled,
  ).length;
  const discoveryReadyCount = typedEvents.filter((event) => {
    const organizer = getOrganizer(event.organizers);

    return isEventDiscoveryReady({
      event,
      organizer,
      studioHostedEvents,
    });
  }).length;

  const totalRegistrations = typedRegistrations.length;
  const totalCheckedIn = organizerEventRows.reduce(
    (sum, row) => sum + row.ticketsCheckedIn,
    0,
  );
  const totalTicketsIssued = organizerEventRows.reduce(
    (sum, row) => sum + row.ticketsIssued,
    0,
  );
  const totalGrossRevenue = organizerEventRows.reduce(
    (sum, row) => sum + row.grossTicketRevenue,
    0,
  );
  const totalRefunds = organizerEventRows.reduce(
    (sum, row) => sum + row.refunds,
    0,
  );
  const totalFees = organizerEventRows.reduce((sum, row) => sum + row.fees, 0);
  const totalNetTicketRevenue = organizerEventRows.reduce(
    (sum, row) => sum + row.netTicketRevenue,
    0,
  );
  const totalEventExpenses = organizerEventRows.reduce(
    (sum, row) => sum + row.eventExpenses,
    0,
  );
  const totalLaborCosts = organizerEventRows.reduce(
    (sum, row) => sum + row.eventLaborCosts,
    0,
  );
  const totalEventCosts = organizerEventRows.reduce(
    (sum, row) => sum + row.totalEventCosts,
    0,
  );
  const totalProfitLoss = organizerEventRows.reduce(
    (sum, row) => sum + row.eventProfitLoss,
    0,
  );
  const totalCheckInRate = totalTicketsIssued
    ? (totalCheckedIn / totalTicketsIssued) * 100
    : null;
  const upcomingEventsCount = typedEvents.filter(
    (event) => new Date(`${event.start_date}T00:00:00`) >= todayStart,
  ).length;
  const completedEventsCount = typedEvents.filter(
    (event) => event.status === "completed",
  ).length;
  const settlementStatusCounts = organizerEventRows.reduce<
    Record<string, number>
  >((counts, row) => {
    const key = row.settlementStatus || "open";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const topProfitableEvents = [...organizerEventRows]
    .sort((a, b) => b.eventProfitLoss - a.eventProfitLoss)
    .slice(0, 3);
  const losingMoneyEvents = organizerEventRows
    .filter((row) => row.eventProfitLoss < 0)
    .sort((a, b) => a.eventProfitLoss - b.eventProfitLoss)
    .slice(0, 3);

  const lowMarginThreshold = 15;
  const eventsNeedingAttention = organizerEventRows
    .map((row) => {
      const issues: { label: string; severity: "critical" | "warning" }[] = [];
      const settlementStatus = row.settlementStatus.trim().toLowerCase();
      const isSettled = settlementStatus === "settled";

      if (row.isCompletedOrPast && !isSettled) {
        issues.push({
          label: "Completed/past event is not settled",
          severity: "critical",
        });
      }

      if (!row.hasSettlementRecord) {
        issues.push({ label: "No settlement record yet", severity: "warning" });
      }

      if (row.eventProfitLoss < 0) {
        issues.push({ label: "Event is losing money", severity: "critical" });
      } else if (
        row.marginPercent !== null &&
        row.marginPercent < lowMarginThreshold
      ) {
        issues.push({
          label: `Margin below ${lowMarginThreshold}%`,
          severity: "warning",
        });
      }

      if (row.unpaidRegistrations > 0) {
        issues.push({
          label: `${row.unpaidRegistrations} unpaid registration${row.unpaidRegistrations === 1 ? "" : "s"}`,
          severity: "critical",
        });
      }

      if (row.pendingRegistrations > 0) {
        issues.push({
          label: `${row.pendingRegistrations} pending registration${row.pendingRegistrations === 1 ? "" : "s"}`,
          severity: "warning",
        });
      }

      if (row.refunds > 0 || row.refundedRegistrations > 0) {
        issues.push({
          label: "Refund activity to review",
          severity: "warning",
        });
      }

      if (row.netTicketRevenue > 0 && row.eventLaborCosts <= 0) {
        issues.push({
          label: "No labor/staff costs linked",
          severity: "warning",
        });
      }

      if (row.netTicketRevenue > 0 && row.eventExpenses <= 0) {
        issues.push({ label: "No event expenses linked", severity: "warning" });
      }

      if (
        row.isCompletedOrPast &&
        row.ticketsIssued > 0 &&
        row.checkInRate !== null &&
        row.checkInRate < 75
      ) {
        issues.push({ label: "Low check-in rate", severity: "warning" });
      }

      const hasCritical = issues.some((issue) => issue.severity === "critical");

      return {
        row,
        issues,
        severity: hasCritical ? "critical" : "warning",
      };
    })
    .filter((item) => item.issues.length > 0)
    .sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "critical" ? -1 : 1;
      }

      return a.row.event.start_date.localeCompare(b.row.event.start_date);
    })
    .slice(0, 8);

  const eventsWithFinancialActivity = organizerEventRows.filter(
    (row) =>
      row.netTicketRevenue > 0 ||
      row.totalEventCosts > 0 ||
      row.eventProfitLoss !== 0 ||
      row.ticketsIssued > 0,
  );

  const highestRevenueEvents = [...eventsWithFinancialActivity]
    .sort((a, b) => b.netTicketRevenue - a.netTicketRevenue)
    .slice(0, 5);

  const bestMarginEvents = eventsWithFinancialActivity
    .filter((row) => row.marginPercent !== null && row.netTicketRevenue > 0)
    .sort(
      (a, b) => (b.marginPercent ?? -Infinity) - (a.marginPercent ?? -Infinity),
    )
    .slice(0, 5);

  const worstMarginEvents = eventsWithFinancialActivity
    .filter((row) => row.marginPercent !== null && row.netTicketRevenue > 0)
    .sort(
      (a, b) => (a.marginPercent ?? Infinity) - (b.marginPercent ?? Infinity),
    )
    .slice(0, 5);

  const bestCheckInRateEvents = eventsWithFinancialActivity
    .filter((row) => row.ticketsIssued > 0 && row.checkInRate !== null)
    .sort((a, b) => (b.checkInRate ?? -Infinity) - (a.checkInRate ?? -Infinity))
    .slice(0, 5);

  const bestProfitPerCheckedInTicketEvents = eventsWithFinancialActivity
    .filter((row) => row.ticketsCheckedIn > 0)
    .sort(
      (a, b) =>
        b.eventProfitLoss / b.ticketsCheckedIn -
        a.eventProfitLoss / a.ticketsCheckedIn,
    )
    .slice(0, 5);

  const bestRevenuePerIssuedTicketEvents = eventsWithFinancialActivity
    .filter((row) => row.ticketsIssued > 0)
    .sort(
      (a, b) =>
        b.netTicketRevenue / b.ticketsIssued -
        a.netTicketRevenue / a.ticketsIssued,
    )
    .slice(0, 5);

  const readyToSettleEvents = organizerEventRows.filter(
    (row) =>
      row.isCompletedOrPast &&
      row.settlementStatus !== "settled" &&
      row.unpaidRegistrations === 0 &&
      row.pendingRegistrations === 0 &&
      row.eventProfitLoss >= 0,
  );
  const missingCostEvents = organizerEventRows.filter(
    (row) =>
      row.netTicketRevenue > 0 &&
      (row.eventLaborCosts <= 0 || row.eventExpenses <= 0),
  );
  const organizerAriaRepeatCandidate = [...organizerEventRows]
    .filter(
      (row) =>
        row.netTicketRevenue > 0 &&
        row.eventProfitLoss > 0 &&
        (row.marginPercent ?? 0) >= 25 &&
        (row.checkInRate ?? 0) >= 75,
    )
    .sort((a, b) => b.eventProfitLoss - a.eventProfitLoss)[0];
  const organizerAriaRiskEvent = eventsNeedingAttention[0]?.row ?? null;

  const organizerAriaInsight = organizerAriaRiskEvent
    ? {
        title: "ARIA sees events that need operator attention.",
        insight: `${eventsNeedingAttention.length} event${eventsNeedingAttention.length === 1 ? " is" : "s are"} flagged for review. The highest-priority item is ${organizerAriaRiskEvent.event.name}.`,
        recommendation:
          organizerAriaRiskEvent.isCompletedOrPast &&
          organizerAriaRiskEvent.settlementStatus !== "settled"
            ? "Open the event dashboard, review the closeout checklist, and settle or reopen the event before reviewing lower-priority events."
            : "Open the event dashboard and review the finance, check-in, and settlement signals before making pricing or repeat-event decisions.",
        metric: `${eventsNeedingAttention.length} flagged`,
        href: `/app/events/${organizerAriaRiskEvent.event.id}`,
        label: "Review event",
      }
    : organizerAriaRepeatCandidate
      ? {
          title: "ARIA found an event worth repeating.",
          insight: `${organizerAriaRepeatCandidate.event.name} produced ${fmtCurrency(organizerAriaRepeatCandidate.eventProfitLoss)} profit with a ${fmtPercent(organizerAriaRepeatCandidate.marginPercent)} margin and ${fmtPercent(organizerAriaRepeatCandidate.checkInRate)} check-in rate.`,
          recommendation:
            "Use this event as a repeat-event template. Review pricing, ticket mix, and promotion timing before duplicating it for the next date.",
          metric: "Repeat candidate",
          href: `/app/events/${organizerAriaRepeatCandidate.event.id}`,
          label: "Open event",
        }
      : readyToSettleEvents.length > 0
        ? {
            title: "ARIA sees events ready for closeout.",
            insight: `${readyToSettleEvents.length} completed event${readyToSettleEvents.length === 1 ? " looks" : "s look"} ready to settle with no unpaid or pending registration blockers.`,
            recommendation:
              "Start with the oldest completed event, confirm labor and expenses are complete, then mark the settlement ready or settled.",
            metric: `${readyToSettleEvents.length} ready`,
            href: `/app/events/${readyToSettleEvents[0].event.id}`,
            label: "Start closeout",
          }
        : {
            title: "ARIA is monitoring organizer performance.",
            insight:
              "No urgent organizer event issues are currently standing out from the dashboard data.",
            recommendation:
              "Keep event labor, expenses, and settlement notes current so ARIA can surface stronger recommendations as registrations and check-ins come in.",
            metric: "Monitoring",
            href: "/app/events",
            label: "Review events",
          };


  const ariaActionQueue: {
    id: string;
    priority: "High" | "Medium" | "Low";
    title: string;
    reason: string;
    nextStep: string;
    href: string;
  }[] = [];

  for (const item of eventsNeedingAttention.slice(0, 5)) {
    const row = item.row;
    const issueLabels = item.issues.map((issue) => issue.label);
    const firstIssue = issueLabels[0] ?? "Review event details";

    let title = `Review ${row.event.name}`;
    let nextStep = "Open event dashboard";

    if (issueLabels.some((label) => label.includes("not settled"))) {
      title = `Close out ${row.event.name}`;
      nextStep = "Review closeout checklist";
    } else if (issueLabels.some((label) => label.includes("losing money"))) {
      title = `Review margin risk for ${row.event.name}`;
      nextStep = "Review financials";
    } else if (issueLabels.some((label) => label.includes("unpaid"))) {
      title = `Follow up on unpaid registrations`;
      nextStep = "Review registrations";
    } else if (
      issueLabels.some(
        (label) =>
          label.includes("labor") || label.includes("expenses"),
      )
    ) {
      title = `Complete cost data for ${row.event.name}`;
      nextStep = "Add missing costs";
    } else if (issueLabels.some((label) => label.includes("check-in"))) {
      title = `Review check-in performance`;
      nextStep = "Open check-in report";
    }

    ariaActionQueue.push({
      id: ariaActionKey("attention", row.event.id, firstIssue),
      priority: item.severity === "critical" ? "High" : "Medium",
      title,
      reason: `${firstIssue}${issueLabels.length > 1 ? ` + ${issueLabels.length - 1} more` : ""}`,
      nextStep,
      href: `/app/events/${row.event.id}`,
    });
  }

  for (const row of readyToSettleEvents.slice(0, 3)) {
    if (ariaActionQueue.some((action) => action.href === `/app/events/${row.event.id}`)) {
      continue;
    }

    ariaActionQueue.push({
      id: ariaActionKey("ready", row.event.id, "closeout"),
      priority: "Medium",
      title: `Settle ${row.event.name}`,
      reason: "Completed event appears ready for closeout with no unpaid or pending registration blockers.",
      nextStep: "Open closeout",
      href: `/app/events/${row.event.id}`,
    });
  }

  for (const row of missingCostEvents.slice(0, 3)) {
    if (
      ariaActionQueue.some(
        (action) =>
          action.href === `/app/events/${row.event.id}`,
      )
    ) {
      continue;
    }

    ariaActionQueue.push({
      id: ariaActionKey(
        "costs",
        row.event.id,
        row.eventLaborCosts <= 0 && row.eventExpenses <= 0
          ? "missing-labor-and-expenses"
          : row.eventLaborCosts <= 0
            ? "missing-labor"
            : "missing-expenses",
      ),
      priority: "Low",
      title: `Add missing cost detail for ${row.event.name}`,
      reason:
        row.eventLaborCosts <= 0 && row.eventExpenses <= 0
          ? "Revenue exists, but labor and event expenses are both missing."
          : row.eventLaborCosts <= 0
            ? "Revenue exists, but labor/staff costs are missing."
            : "Revenue exists, but event expenses are missing.",
      nextStep: "Open event costs",
      href: `/app/events/${row.event.id}`,
    });
  }

  if (organizerAriaRepeatCandidate) {
    ariaActionQueue.push({
      id: ariaActionKey(
        "repeat",
        organizerAriaRepeatCandidate.event.id,
        "strong-margin",
      ),
      priority: "Low",
      title: `Consider repeating ${organizerAriaRepeatCandidate.event.name}`,
      reason: `${fmtCurrency(organizerAriaRepeatCandidate.eventProfitLoss)} profit with ${fmtPercent(organizerAriaRepeatCandidate.marginPercent)} margin and ${fmtPercent(organizerAriaRepeatCandidate.checkInRate)} check-in rate.`,
      nextStep: "Review repeat signal",
      href: `/app/events/${organizerAriaRepeatCandidate.event.id}`,
    });
  }

  const prioritizedAriaActionQueue = ariaActionQueue
    .sort((a, b) => {
      const priorityRank = { High: 0, Medium: 1, Low: 2 };
      return priorityRank[a.priority] - priorityRank[b.priority];
    })
    .slice(0, 8);

  const actionKeys = prioritizedAriaActionQueue.map((action) => action.id);
  let persistedAriaActionItems: PersistedAriaActionItemRow[] = [];

  if (organizerWorkspace && actionKeys.length > 0) {
    const actionStateSupabase = createServiceRoleClient() ?? supabase;
    const { data: persistedActions, error: persistedActionsError } =
      await actionStateSupabase
        .from("aria_action_items")
        .select("id, action_key, status, snoozed_until, updated_at")
        .eq("studio_id", studioId)
        .in("action_key", actionKeys);

    if (persistedActionsError) {
      console.warn(
        "Failed to load persisted ARIA action items:",
        persistedActionsError.message,
      );
    } else {
      persistedAriaActionItems =
        (persistedActions ?? []) as PersistedAriaActionItemRow[];
    }
  }

  const persistedAriaActionByKey = new Map(
    persistedAriaActionItems.map((item) => [item.action_key, item]),
  );
  const nowMs = Date.now();

  const visiblePrioritizedAriaActionQueue = prioritizedAriaActionQueue.filter(
    (action) => {
      const persistedAction = persistedAriaActionByKey.get(action.id);
      if (!persistedAction) return true;

      if (
        persistedAction.status === "dismissed" ||
        persistedAction.status === "completed"
      ) {
        return false;
      }

      if (
        persistedAction.status === "snoozed" &&
        persistedAction.snoozed_until &&
        new Date(persistedAction.snoozed_until).getTime() > nowMs
      ) {
        return false;
      }

      return true;
    },
  );

  const hiddenAriaActionQueue = prioritizedAriaActionQueue
    .map((action) => ({
      action,
      persistedAction: persistedAriaActionByKey.get(action.id),
    }))
    .filter(({ persistedAction }) => {
      if (!persistedAction) return false;

      if (
        persistedAction.status === "dismissed" ||
        persistedAction.status === "completed"
      ) {
        return true;
      }

      return Boolean(
        persistedAction.status === "snoozed" &&
          persistedAction.snoozed_until &&
          new Date(persistedAction.snoozed_until).getTime() > nowMs,
      );
    });

  const completedAriaActionCount = hiddenAriaActionQueue.filter(
    ({ persistedAction }) => persistedAction?.status === "completed",
  ).length;
  const snoozedAriaActionCount = hiddenAriaActionQueue.filter(
    ({ persistedAction }) => persistedAction?.status === "snoozed",
  ).length;
  const dismissedAriaActionCount = hiddenAriaActionQueue.filter(
    ({ persistedAction }) => persistedAction?.status === "dismissed",
  ).length;
  const highPriorityAriaActionCount = visiblePrioritizedAriaActionQueue.filter(
    (action) => action.priority === "High",
  ).length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {organizerWorkspace
                  ? "DanceFlow Organizer Workspace"
                  : "DanceFlow Events"}
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {organizerWorkspace ? "Organizer Dashboard" : "Events"}
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {organizerWorkspace
                  ? `Manage event publishing, registrations, discovery visibility, and ticketing operations for ${workspaceName}.`
                  : "Manage public and internal offerings like group classes, practice parties, workshops, socials, and special events."}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {organizerWorkspace ? (
                <>
                  {showOrganizerProfile ? (
                    <Link
                      href="/app/organizers"
                      className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                    >
                      Organizer Profile
                    </Link>
                  ) : null}

                  {showBilling ? (
                    <Link
                      href="/app/settings/billing"
                      className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                    >
                      Billing & Payouts
                    </Link>
                  ) : null}
                </>
              ) : (
                <Link
                  href="/app"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                >
                  Back to Dashboard
                </Link>
              )}

              {showCreateEvent ? (
                <Link
                  href="/app/events/new"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  New Event
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                {organizerWorkspace
                  ? "Publishing controls live here"
                  : "Group Classes Live Here"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                {organizerWorkspace
                  ? "Organizer success depends on getting events public, directory-enabled, and properly linked so dancers can actually find and register."
                  : "Group classes are managed as events, not standard appointments. Use visibility settings to control whether a class is public, unlisted, or private."}
              </p>
            </div>

            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
              <h2 className="text-lg font-semibold text-orange-950">
                {organizerWorkspace
                  ? "Discovery readiness matters"
                  : "Discovery and organizer publishing"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-orange-900">
                Discovery-ready events should be public, directory-enabled, and
                have a clear host. Studio-hosted events can use your workspace
                name; organizer-hosted events should be linked to an organizer
                profile.
              </p>
            </div>
          </div>
        </div>
      </section>

      {organizerWorkspace ? (
        <AriaInsightCard
          eyebrow="ARIA Organizer Insight"
          title={organizerAriaInsight.title}
          insight={organizerAriaInsight.insight}
          recommendation={organizerAriaInsight.recommendation}
          metric={organizerAriaInsight.metric}
          primaryAction={{
            href: organizerAriaInsight.href,
            label: organizerAriaInsight.label,
          }}
          secondaryAction={{ href: "/app/aria", label: "Consult with ARIA" }}
        />
      ) : null}

      {organizerWorkspace ? (
        <section className="rounded-[28px] border border-purple-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-purple-600">
                ARIA Action Queue
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Recommended organizer actions
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                ARIA turns event reporting signals into next-best actions. This
                queue is advisory for now; it does not make changes for you.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex w-fit rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700 ring-1 ring-purple-200">
                {visiblePrioritizedAriaActionQueue.length} active
              </span>
              {highPriorityAriaActionCount > 0 ? (
                <span className="inline-flex w-fit rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
                  {highPriorityAriaActionCount} high priority
                </span>
              ) : null}
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <div className="rounded-2xl border border-purple-100 bg-purple-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-purple-600">
                Active
              </p>
              <p className="mt-2 text-2xl font-semibold text-purple-950">
                {visiblePrioritizedAriaActionQueue.length}
              </p>
            </div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-600">
                Completed
              </p>
              <p className="mt-2 text-2xl font-semibold text-emerald-950">
                {completedAriaActionCount}
              </p>
            </div>
            <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-600">
                Snoozed
              </p>
              <p className="mt-2 text-2xl font-semibold text-amber-950">
                {snoozedAriaActionCount}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Dismissed
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {dismissedAriaActionCount}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {visiblePrioritizedAriaActionQueue.length > 0 ? (
              visiblePrioritizedAriaActionQueue.map((action) => (
                <div
                  key={action.id}
                  className={`rounded-2xl border p-4 ${
                    action.priority === "High"
                      ? "border-rose-200 bg-rose-50/60"
                      : action.priority === "Medium"
                        ? "border-amber-200 bg-amber-50/60"
                        : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                            action.priority === "High"
                              ? "bg-rose-100 text-rose-800 ring-1 ring-rose-200"
                              : action.priority === "Medium"
                                ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
                                : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                          }`}
                        >
                          {action.priority} priority
                        </span>
                        <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                          Open
                        </span>
                        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                          Suggested by ARIA
                        </span>
                      </div>
                      <h3 className="mt-2 font-semibold text-slate-950">
                        {action.title}
                      </h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        {action.reason}
                      </p>
                    </div>
                    <Link
                      href={action.href}
                      className="inline-flex items-center gap-2 text-sm font-semibold text-purple-700 hover:text-purple-800"
                    >
                      {action.nextStep}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
                    {(["completed", "snoozed", "dismissed"] as const).map(
                      (status) => (
                        <form
                          key={status}
                          action={updateOrganizerAriaActionStatusAction}
                        >
                          <input type="hidden" name="actionKey" value={action.id} />
                          <input
                            type="hidden"
                            name="actionType"
                            value={action.id.split("-")[0] ?? "organizer_action"}
                          />
                          <input
                            type="hidden"
                            name="priority"
                            value={action.priority}
                          />
                          <input type="hidden" name="title" value={action.title} />
                          <input type="hidden" name="reason" value={action.reason} />
                          <input
                            type="hidden"
                            name="recommendedNextStep"
                            value={action.nextStep}
                          />
                          <input type="hidden" name="targetUrl" value={action.href} />
                          <input
                            type="hidden"
                            name="eventId"
                            value={action.href.startsWith("/app/events/")
                              ? action.href.replace("/app/events/", "").split("/")[0]
                              : ""}
                          />
                          <input type="hidden" name="status" value={status} />
                          <button
                            type="submit"
                            className={`rounded-xl px-3 py-2 text-xs font-semibold ${
                              status === "completed"
                                ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                                : status === "snoozed"
                                  ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100"
                                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                            }`}
                          >
                            {status === "completed"
                              ? "Mark complete"
                              : status === "snoozed"
                                ? "Snooze 7 days"
                                : "Dismiss"}
                          </button>
                        </form>
                      ),
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-900">
                <p className="font-semibold">No active ARIA actions right now.</p>
                <p className="mt-1">
                  ARIA is not seeing organizer event actions that need attention.
                  Completed, dismissed, or snoozed items are counted below. Keep
                  settlement, labor, expense, and check-in data current so the
                  queue stays useful.
                </p>
              </div>
            )}
          </div>

          {hiddenAriaActionQueue.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="font-semibold text-slate-950">
                    Recently handled ARIA actions
                  </h3>
                  <p className="text-sm text-slate-600">
                    These recommendations are hidden from the active queue because
                    they were completed, dismissed, or snoozed.
                  </p>
                </div>
                <span className="inline-flex w-fit rounded-full bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  {hiddenAriaActionQueue.length} hidden
                </span>
              </div>

              <div className="mt-3 divide-y divide-slate-100">
                {hiddenAriaActionQueue.slice(0, 5).map(({ action, persistedAction }) => (
                  <div
                    key={`${action.id}-${persistedAction?.status ?? "hidden"}`}
                    className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {action.title}
                      </p>
                      <p className="text-xs text-slate-500">
                        {ariaActionStatusLabel(persistedAction?.status)}
                        {persistedAction?.status === "snoozed" &&
                        persistedAction.snoozed_until
                          ? ` until ${new Date(
                              persistedAction.snoozed_until,
                            ).toLocaleDateString("en-US")}`
                          : ""}
                      </p>
                    </div>
                    <Link
                      href={action.href}
                      className="text-xs font-semibold text-purple-700 hover:text-purple-800"
                    >
                      Review event
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total Events"
          value={typedEvents.length}
          icon={CalendarDays}
        />
        <StatCard
          label="Published / Open"
          value={publishedCount}
          icon={Ticket}
        />
        <StatCard
          label="Public Offerings"
          value={publicOfferingsCount}
          icon={Globe2}
        />
        <StatCard
          label="Discovery Ready"
          value={discoveryReadyCount}
          icon={Star}
        />
        <StatCard
          label="Registrations"
          value={totalRegistrations}
          icon={Users}
        />
        <StatCard label="Checked In" value={totalCheckedIn} icon={Sparkles} />
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Organizer Event Reporting
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Financial and settlement summary
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
              This summary uses the event profitability ledger, ticket
              check-ins, and settlement status so organizers can see revenue,
              costs, and event outcomes in one place.
            </p>
          </div>

          <div className="flex flex-col gap-3 lg:items-end">
            <div className="flex flex-wrap gap-2">
              <Link
                href="/app/events/export/financial-summary"
                className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
              >
                Export Financial CSV
              </Link>
              <Link
                href="/app/events/export/attention"
                className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 shadow-sm hover:border-amber-300 hover:bg-amber-100"
              >
                Export Attention CSV
              </Link>
            </div>

            <div className="flex flex-wrap gap-2 lg:justify-end">
              {Object.entries(settlementStatusCounts).length > 0 ? (
                Object.entries(settlementStatusCounts).map(
                  ([status, count]) => (
                    <span
                      key={status}
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${settlementBadgeClass(status)}`}
                    >
                      {settlementStatusLabel(status)}: {count}
                    </span>
                  ),
                )
              ) : (
                <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                  No settlements yet
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
              Event Count
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {typedEvents.length}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {upcomingEventsCount} upcoming • {completedEventsCount} completed
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
              Net Revenue
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {fmtCurrency(totalNetTicketRevenue)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {fmtCurrency(totalGrossRevenue)} gross •{" "}
              {fmtCurrency(totalRefunds)} refunds • {fmtCurrency(totalFees)}{" "}
              fees
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
              Event Costs
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {fmtCurrency(totalEventCosts)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {fmtCurrency(totalEventExpenses)} expenses •{" "}
              {fmtCurrency(totalLaborCosts)} labor
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
              Profit / Loss
            </p>
            <p
              className={`mt-2 text-2xl font-semibold ${totalProfitLoss >= 0 ? "text-emerald-700" : "text-rose-700"}`}
            >
              {fmtCurrency(totalProfitLoss)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {totalTicketsIssued} tickets issued •{" "}
              {fmtPercent(totalCheckInRate)} checked in
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-emerald-700" />
              <h3 className="font-semibold text-emerald-950">
                Top profitable events
              </h3>
            </div>
            <div className="mt-4 space-y-3">
              {topProfitableEvents.length > 0 ? (
                topProfitableEvents.map((row) => (
                  <div
                    key={row.event.id}
                    className="rounded-xl border border-emerald-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Link
                          href={`/app/events/${row.event.id}`}
                          className="font-semibold text-slate-950 hover:text-[var(--brand-primary)]"
                        >
                          {row.event.name}
                        </Link>
                        <p className="mt-1 text-xs text-slate-500">
                          {settlementStatusLabel(row.settlementStatus)} •{" "}
                          {row.ticketsCheckedIn}/{row.ticketsIssued} checked in
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-emerald-700">
                          {fmtCurrency(row.eventProfitLoss)}
                        </p>
                        <p className="text-xs text-slate-500">
                          {fmtPercent(row.marginPercent)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-emerald-900">
                  No profitability data yet.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-rose-700" />
              <h3 className="font-semibold text-rose-950">
                Events losing money
              </h3>
            </div>
            <div className="mt-4 space-y-3">
              {losingMoneyEvents.length > 0 ? (
                losingMoneyEvents.map((row) => (
                  <div
                    key={row.event.id}
                    className="rounded-xl border border-rose-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Link
                          href={`/app/events/${row.event.id}`}
                          className="font-semibold text-slate-950 hover:text-[var(--brand-primary)]"
                        >
                          {row.event.name}
                        </Link>
                        <p className="mt-1 text-xs text-slate-500">
                          Costs {fmtCurrency(row.totalEventCosts)} • Net revenue{" "}
                          {fmtCurrency(row.netTicketRevenue)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-rose-700">
                          {fmtCurrency(row.eventProfitLoss)}
                        </p>
                        <p className="text-xs text-slate-500">
                          {fmtPercent(row.marginPercent)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-rose-900">
                  No events are currently showing a loss.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="font-semibold text-amber-950">
                Events needing attention
              </h3>
              <p className="mt-1 text-sm leading-6 text-amber-900">
                These are the organizer events most likely to need operational
                or financial review before closeout.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full bg-white px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
              {eventsNeedingAttention.length} flagged
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {eventsNeedingAttention.length > 0 ? (
              eventsNeedingAttention.map((item) => (
                <div
                  key={item.row.event.id}
                  className="rounded-xl border border-amber-200 bg-white p-4"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/app/events/${item.row.event.id}`}
                          className="font-semibold text-slate-950 hover:text-[var(--brand-primary)]"
                        >
                          {item.row.event.name}
                        </Link>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                            item.severity === "critical"
                              ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                          }`}
                        >
                          {item.severity === "critical"
                            ? "Needs review"
                            : "Check"}
                        </span>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${settlementBadgeClass(item.row.settlementStatus)}`}
                        >
                          {settlementStatusLabel(item.row.settlementStatus)}
                        </span>
                      </div>

                      <p className="mt-1 text-xs text-slate-500">
                        {formatDateRange(
                          item.row.event.start_date,
                          item.row.event.end_date,
                        )}{" "}
                        • {item.row.ticketsCheckedIn}/{item.row.ticketsIssued}{" "}
                        checked in • {fmtPercent(item.row.checkInRate)} check-in
                        rate
                      </p>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.issues.map((issue) => (
                          <span
                            key={issue.label}
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                              issue.severity === "critical"
                                ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                                : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                            }`}
                          >
                            {issue.label}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-2 text-right text-sm sm:grid-cols-3 lg:min-w-[360px]">
                      <div>
                        <p className="text-xs text-slate-500">Net revenue</p>
                        <p className="font-semibold text-slate-950">
                          {fmtCurrency(item.row.netTicketRevenue)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Total costs</p>
                        <p className="font-semibold text-slate-950">
                          {fmtCurrency(item.row.totalEventCosts)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Profit/loss</p>
                        <p
                          className={`font-semibold ${item.row.eventProfitLoss >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                        >
                          {fmtCurrency(item.row.eventProfitLoss)}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                No organizer events are currently flagged for attention.
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="font-semibold text-indigo-950">
                Event drilldown and comparison
              </h3>
              <p className="mt-1 text-sm leading-6 text-indigo-900">
                Compare organizer events by revenue, margin, attendance quality,
                and per-ticket performance to identify which events are worth
                repeating or improving.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-800 ring-1 ring-indigo-200">
              {eventsWithFinancialActivity.length} events with activity
            </span>
          </div>

          <div className="mt-5 grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            <ComparisonCard
              title="Highest revenue events"
              subtitle="Events ranked by net ticket revenue after refunds and fees."
              rows={highestRevenueEvents}
              metricLabel="Net revenue"
              getMetric={(row) => fmtCurrency(row.netTicketRevenue)}
              getDetail={(row) =>
                `${row.ticketsIssued} tickets issued • ${fmtPercent(row.checkInRate)} checked in`
              }
              positiveIsGood={false}
            />

            <ComparisonCard
              title="Best margin events"
              subtitle="Events producing the strongest profit relative to net revenue."
              rows={bestMarginEvents}
              metricLabel="Margin"
              getMetric={(row) => fmtPercent(row.marginPercent)}
              getDetail={(row) =>
                `${fmtCurrency(row.eventProfitLoss)} profit/loss • ${fmtCurrency(row.totalEventCosts)} costs`
              }
            />

            <ComparisonCard
              title="Worst margin events"
              subtitle="Events most likely to need pricing, labor, or expense review."
              rows={worstMarginEvents}
              metricLabel="Margin"
              getMetric={(row) => fmtPercent(row.marginPercent)}
              getDetail={(row) =>
                `${fmtCurrency(row.eventProfitLoss)} profit/loss • ${fmtCurrency(row.netTicketRevenue)} net revenue`
              }
            />

            <ComparisonCard
              title="Best check-in rate"
              subtitle="Events with the strongest ticket-to-attendance conversion."
              rows={bestCheckInRateEvents}
              metricLabel="Check-in rate"
              getMetric={(row) => fmtPercent(row.checkInRate)}
              getDetail={(row) =>
                `${row.ticketsCheckedIn}/${row.ticketsIssued} checked in • ${row.paidRegistrations} paid registrations`
              }
              positiveIsGood={false}
            />

            <ComparisonCard
              title="Profit per checked-in ticket"
              subtitle="Shows how much profit each attended ticket produced."
              rows={bestProfitPerCheckedInTicketEvents}
              metricLabel="Per checked-in"
              getMetric={(row) =>
                fmtCurrency(
                  row.eventProfitLoss / Math.max(row.ticketsCheckedIn, 1),
                )
              }
              getDetail={(row) =>
                `${fmtCurrency(row.eventProfitLoss)} total profit/loss • ${row.ticketsCheckedIn} checked in`
              }
            />

            <ComparisonCard
              title="Revenue per issued ticket"
              subtitle="Shows average net revenue per issued ticket."
              rows={bestRevenuePerIssuedTicketEvents}
              metricLabel="Per issued"
              getMetric={(row) =>
                fmtCurrency(
                  row.netTicketRevenue / Math.max(row.ticketsIssued, 1),
                )
              }
              getDetail={(row) =>
                `${fmtCurrency(row.netTicketRevenue)} net revenue • ${row.ticketsIssued} tickets issued`
              }
              positiveIsGood={false}
            />
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
        <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr] lg:items-center">
          <div>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-white p-3 text-emerald-700">
                <CalendarDays className="h-5 w-5" />
              </div>

              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  Website Calendar Feed
                </p>
                <h2 className="mt-1 text-xl font-semibold text-emerald-950">
                  Add DanceFlow events to your website calendar
                </h2>
              </div>
            </div>

            <p className="mt-4 text-sm leading-7 text-emerald-900">
              Create and update events once in DanceFlow, then subscribe to this
              read-only calendar feed from your website calendar, Google
              Calendar, Apple Calendar, Outlook, or supported calendar plugins.
            </p>
          </div>

          <div>
            {calendarFeedUrl ? (
              <CopyCalendarFeedButton feedUrl={calendarFeedUrl} />
            ) : (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                Calendar feed link is not available yet. Make sure this
                workspace has a public slug. Organizer workspaces also need an
                organizer profile connected to at least one event.
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Group Classes</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {groupClasses.length}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Featured Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {featuredCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Gross Revenue</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {fmtCurrency(totalGrossRevenue)}
          </p>
        </div>
      </div>

      {organizerWorkspace ? (
        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Globe2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Visibility
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Push more events public
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Public, directory-enabled events are the ones dancers can
                  actually find through discovery and public listings.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Wallet className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Revenue
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Track registrations and money
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Use this page as the organizer home for ticketing performance,
                  payment status, and event-by-event revenue.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <MapPin className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Next Action
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Finish organizer setup
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Make sure billing, organizer profile, and public discovery
                  settings are complete before launch.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Event Listings
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {organizerWorkspace
              ? "All organizer-managed event offerings in one operational view."
              : "All organizer and public-facing event offerings in one branded workspace."}
          </p>
        </div>

        {typedEvents.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-medium text-slate-900">
              No events yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Create your first event offering to start publishing classes,
              socials, and special events.
            </p>

            {showCreateEvent ? (
              <div className="mt-6">
                <Link
                  href="/app/events/new"
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-white hover:opacity-95"
                >
                  <span>Create Event</span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {typedEvents.map((event) => {
              const organizer = getOrganizer(event.organizers);
              const hostLabel = getEventHostLabel({
                organizer,
                studioHostedEvents,
                workspaceName,
              });
              const discoveryReady = isEventDiscoveryReady({
                event,
                organizer,
                studioHostedEvents,
              });

              const eventRegistrations =
                registrationsByEventId.get(event.id) ?? [];
              const defaultCurrency =
                eventRegistrations.find((row) => row.currency)?.currency ??
                "USD";

              const totalRegistrationsForEvent = eventRegistrations.length;
              const paidCount = eventRegistrations.filter(
                (row) => row.payment_status === "paid",
              ).length;
              const pendingPaymentCount = eventRegistrations.filter(
                (row) => row.payment_status === "pending",
              ).length;
              const checkedInCount = eventRegistrations.filter((row) => {
                const attendance = attendanceByRegistrationId.get(row.id);
                return (
                  attendance?.status === "checked_in" ||
                  attendance?.status === "attended"
                );
              }).length;
              const grossRevenue = eventRegistrations.reduce((sum, row) => {
                if (
                  row.payment_status !== "paid" &&
                  row.payment_status !== "partial"
                ) {
                  return sum;
                }
                return sum + Number(row.total_amount ?? row.total_price ?? 0);
              }, 0);

              const eventProfitability = profitabilityByEventId.get(event.id);
              const netRevenue = safeNumber(
                eventProfitability?.net_ticket_revenue,
              );
              const profitLoss = safeNumber(
                eventProfitability?.event_profit_loss,
              );

              return (
                <div key={event.id} className="px-6 py-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xl font-semibold text-slate-950">
                          {event.name}
                        </h3>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            event.status,
                          )}`}
                        >
                          {event.status}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${eventTypeBadgeClass(
                            event.event_type,
                          )}`}
                        >
                          {eventTypeLabel(event.event_type)}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
                            event.visibility,
                          )}`}
                        >
                          {visibilityLabel(event.visibility)}
                        </span>

                        {event.featured ? (
                          <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
                            Featured
                          </span>
                        ) : null}

                        {event.registration_required ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            Registration Required
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {event.public_directory_enabled ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Public Directory On
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            Public Directory Off
                          </span>
                        )}

                        {event.beginner_friendly ? (
                          <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                            Beginner Friendly
                          </span>
                        ) : null}

                        {organizer ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Organizer Linked
                          </span>
                        ) : studioHostedEvents ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Studio Hosted
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                            Host Not Set
                          </span>
                        )}

                        {discoveryReady ? (
                          <span className="inline-flex rounded-full bg-[var(--brand-primary-soft)] px-2.5 py-1 text-xs font-medium text-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/15">
                            Discovery Ready
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                            Needs Discovery Setup
                          </span>
                        )}
                      </div>

                      <p className="mt-3 text-sm text-slate-500">
                        Host: {hostLabel} • /events/{event.slug}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>{formatEventSchedule(event)}</span>
                        <span>
                          {[event.city, event.state]
                            .filter(Boolean)
                            .join(", ") || "No location"}
                        </span>
                      </div>

                      <p className="mt-3 text-sm leading-7 text-slate-600">
                        {eventListingHint(event.event_type, event.visibility)}
                      </p>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">
                            Registrations
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {totalRegistrationsForEvent}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Paid</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {paidCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Pending Pay</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {pendingPaymentCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Checked In</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {checkedInCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">
                            Gross Revenue
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {fmtCurrency(grossRevenue, defaultCurrency)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Net Revenue</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {fmtCurrency(netRevenue, defaultCurrency)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">
                            Profit / Loss
                          </p>
                          <p
                            className={`mt-1 text-lg font-semibold ${profitLoss >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                          >
                            {fmtCurrency(profitLoss, defaultCurrency)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid shrink-0 gap-2 sm:min-w-48">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
                      >
                        Event Dashboard
                      </Link>

                      <div className="grid grid-cols-2 gap-2">
                        <Link
                          href={`/app/events/${event.id}/edit`}
                          className="inline-flex items-center justify-center rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Edit
                        </Link>

                        <Link
                          href={`/app/events/${event.id}/tickets`}
                          className="inline-flex items-center justify-center rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Tickets
                        </Link>
                      </div>

                      <Link
                        href={`/app/events/${event.id}/private-lessons`}
                        className="inline-flex items-center justify-center rounded-xl border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-800 hover:bg-purple-100"
                      >
                        Manage Coach Slots
                      </Link>

                      <div className="grid grid-cols-2 gap-2">
                        <Link
                          href={`/app/events/${event.id}/registrations`}
                          className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Registrations
                        </Link>

                        <Link
                          href={`/app/events/${event.id}/check-in`}
                          className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Check-In
                        </Link>
                      </div>

                      <form action={duplicateEventAction}>
                        <input type="hidden" name="eventId" value={event.id} />
                        <button
                          type="submit"
                          className="inline-flex w-full items-center justify-center rounded-xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-medium text-orange-800 hover:bg-orange-100"
                        >
                          Duplicate Event
                        </button>
                      </form>

                      <Link
                        href={`/events/${event.slug}`}
                        className="inline-flex items-center justify-center rounded-xl border border-[var(--brand-primary)]/20 bg-[var(--brand-primary-soft)] px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]/80"
                      >
                        View Public Page
                      </Link>
                    </div>
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
