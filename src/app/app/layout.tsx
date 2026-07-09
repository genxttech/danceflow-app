import Link from "next/link";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform";
import {
  getAccessibleStudios,
  getCurrentStudioContext,
  getCurrentWorkspaceAccessState,
  isOrganizerRole,
  recordWorkspaceAccess,
} from "@/lib/auth/studio";
import { clearStudioContextAction } from "@/app/platform/actions";
import { getCurrentWorkspaceCapabilitiesForUser } from "@/lib/billing/access";
import AppSidebarShell from "./AppSidebarShell";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  client_id: string | null;
  appointment_id: string | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
};

type StudioRow = {
  id: string;
  name: string | null;
  slug: string | null;
};

type NavItem = {
  label: string;
  href: string;
  icon: string;
  badge?: number;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

function buildDisplayName(
  profile: ProfileRow | null,
  fallbackEmail: string | null,
) {
  const fullName = profile?.full_name?.trim();
  if (fullName) return fullName;

  return fallbackEmail ?? "Unknown User";
}

function formatRoleLabel(role: string | null | undefined) {
  if (!role) return "";

  if (role === "studio_admin") return "Studio Manager";

  return role.replaceAll("_", " ").trim();
}

function getBillingLockMessage(status: string | null | undefined) {
  switch (status) {
    case "canceled":
      return "This workspace is canceled. Update billing to restore access.";
    case "unpaid":
      return "This workspace is unpaid. Resolve billing to restore access.";
    case "incomplete":
    case "incomplete_expired":
      return "This workspace setup is incomplete. Complete billing to continue.";
    case "past_due":
      return "This workspace is past due. Resolve billing to regain access.";
    case "inactive":
      return "This workspace is inactive. Billing must be resolved before access is restored.";
    case "suspended":
      return "This workspace is suspended. Billing must be resolved before access is restored.";
    default:
      return "This workspace is paused until billing is resolved.";
  }
}

function compactSections(sections: NavSection[]) {
  return sections.filter((section) => section.items.length > 0);
}

function safeNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
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

function isHiddenAriaActionState(
  status: string | null | undefined,
  snoozedUntil?: string | null,
) {
  const normalized = (status ?? "open").trim().toLowerCase();

  if (normalized === "dismissed" || normalized === "completed") return true;

  if (normalized === "snoozed" && snoozedUntil) {
    const snoozedUntilMs = new Date(snoozedUntil).getTime();
    return Number.isFinite(snoozedUntilMs) && snoozedUntilMs > Date.now();
  }

  return false;
}

async function getOrganizerAriaSidebarCounts({
  supabase,
  userId,
  studioId,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  studioId: string;
}) {
  const emptyCounts = { activeCount: 0, highPriorityCount: 0 };

  const { data: organizerRole } = await supabase
    .from("organizer_users")
    .select("organizer_id, organizers!inner(studio_id)")
    .eq("user_id", userId)
    .eq("active", true)
    .eq("organizers.studio_id", studioId)
    .limit(1)
    .maybeSingle();

  const organizerId = (organizerRole as { organizer_id?: string | null } | null)
    ?.organizer_id;

  if (!organizerId) return emptyCounts;

  const { data: events } = await supabase
    .from("events")
    .select("id, name, status, start_date, end_date")
    .eq("organizer_id", organizerId)
    .order("start_date", { ascending: false })
    .limit(200);

  const eventRows = (
    (events ?? []) as Array<{
      id: string;
      name: string | null;
      status: string | null;
      start_date: string | null;
      end_date: string | null;
    }>
  ).filter((event) => event.id);

  if (eventRows.length === 0) return emptyCounts;

  const eventIds = eventRows.map((event) => event.id);

  const [
    { data: profitabilityRows },
    { data: settlementRows },
    { data: registrationRows },
  ] = await Promise.all([
    supabase
      .from("v_event_profit_loss")
      .select(
        "event_id, net_ticket_revenue, refunds, event_expenses, event_labor_costs, total_event_costs, event_profit_loss",
      )
      .in("event_id", eventIds),
    supabase
      .from("event_settlements")
      .select("event_id, status")
      .in("event_id", eventIds),
    supabase
      .from("event_registrations")
      .select("event_id, status, payment_status, quantity")
      .in("event_id", eventIds)
      .limit(5000),
  ]);

  const profitabilityByEventId = new Map(
    (
      (profitabilityRows ?? []) as Array<{
        event_id: string | null;
        net_ticket_revenue: number | string | null;
        refunds: number | string | null;
        event_expenses: number | string | null;
        event_labor_costs: number | string | null;
        total_event_costs: number | string | null;
        event_profit_loss: number | string | null;
      }>
    )
      .filter((row) => row.event_id)
      .map((row) => [row.event_id as string, row]),
  );

  const settlementByEventId = new Map(
    (
      (settlementRows ?? []) as Array<{
        event_id: string | null;
        status: string | null;
      }>
    )
      .filter((row) => row.event_id)
      .map((row) => [row.event_id as string, row]),
  );

  const registrationsByEventId = new Map<
    string,
    Array<{
      status: string | null;
      payment_status: string | null;
      quantity: number | null;
    }>
  >();

  for (const registration of (registrationRows ?? []) as Array<{
    event_id: string | null;
    status: string | null;
    payment_status: string | null;
    quantity: number | null;
  }>) {
    if (!registration.event_id) continue;
    const existing = registrationsByEventId.get(registration.event_id) ?? [];
    existing.push(registration);
    registrationsByEventId.set(registration.event_id, existing);
  }

  const todayStartMs = new Date(
    new Date().toISOString().slice(0, 10),
  ).getTime();
  const lowMarginThreshold = 15;

  const generatedActions: Array<{
    id: string;
    priority: "High" | "Medium" | "Low";
  }> = [];

  const dashboardRows = eventRows.map((event) => {
    const financials = profitabilityByEventId.get(event.id);
    const settlement = settlementByEventId.get(event.id);
    const registrations = registrationsByEventId.get(event.id) ?? [];

    const netTicketRevenue = safeNumber(financials?.net_ticket_revenue);
    const refunds = safeNumber(financials?.refunds);
    const eventExpenses = safeNumber(financials?.event_expenses);
    const eventLaborCosts = safeNumber(financials?.event_labor_costs);
    const totalEventCosts = safeNumber(financials?.total_event_costs);
    const eventProfitLoss = safeNumber(financials?.event_profit_loss);
    const marginPercent =
      netTicketRevenue > 0 ? (eventProfitLoss / netTicketRevenue) * 100 : null;

    const unpaidRegistrations = registrations.filter((registration) => {
      const paymentStatus = (registration.payment_status ?? "").toLowerCase();
      return paymentStatus === "unpaid" || paymentStatus === "failed";
    }).length;
    const pendingRegistrations = registrations.filter((registration) => {
      const paymentStatus = (registration.payment_status ?? "").toLowerCase();
      const status = (registration.status ?? "").toLowerCase();
      return paymentStatus === "pending" || status === "pending";
    }).length;
    const refundedRegistrations = registrations.filter((registration) => {
      const paymentStatus = (registration.payment_status ?? "").toLowerCase();
      const status = (registration.status ?? "").toLowerCase();
      return paymentStatus === "refunded" || status === "refunded";
    }).length;

    const endDate = event.end_date || event.start_date;
    const eventEndMs = endDate
      ? new Date(`${endDate}T00:00:00`).getTime()
      : NaN;
    const isCompletedOrPast =
      (event.status ?? "").toLowerCase() === "completed" ||
      (Number.isFinite(eventEndMs) && eventEndMs < todayStartMs);

    return {
      event,
      netTicketRevenue,
      refunds,
      eventExpenses,
      eventLaborCosts,
      totalEventCosts,
      eventProfitLoss,
      marginPercent,
      unpaidRegistrations,
      pendingRegistrations,
      refundedRegistrations,
      settlementStatus: settlement?.status ?? "open",
      hasSettlementRecord: Boolean(settlement),
      isCompletedOrPast,
    };
  });

  const eventsNeedingAttention = dashboardRows
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

      const hasCritical = issues.some((issue) => issue.severity === "critical");

      return { row, issues, severity: hasCritical ? "critical" : "warning" };
    })
    .filter((item) => item.issues.length > 0);

  for (const item of eventsNeedingAttention.slice(0, 5)) {
    const firstIssue = item.issues[0]?.label ?? "Review event details";
    generatedActions.push({
      id: ariaActionKey("attention", item.row.event.id, firstIssue),
      priority: item.severity === "critical" ? "High" : "Medium",
    });
  }

  for (const row of dashboardRows
    .filter(
      (row) =>
        row.isCompletedOrPast &&
        row.settlementStatus !== "settled" &&
        row.unpaidRegistrations === 0 &&
        row.pendingRegistrations === 0 &&
        row.eventProfitLoss >= 0,
    )
    .slice(0, 3)) {
    if (generatedActions.some((action) => action.id.includes(row.event.id)))
      continue;
    generatedActions.push({
      id: ariaActionKey("ready", row.event.id, "closeout"),
      priority: "Medium",
    });
  }

  for (const row of dashboardRows
    .filter(
      (row) =>
        row.netTicketRevenue > 0 &&
        (row.eventLaborCosts <= 0 || row.eventExpenses <= 0),
    )
    .slice(0, 3)) {
    if (generatedActions.some((action) => action.id.includes(row.event.id)))
      continue;
    generatedActions.push({
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
    });
  }

  const repeatCandidate = [...dashboardRows]
    .filter(
      (row) =>
        row.netTicketRevenue > 0 &&
        row.eventProfitLoss > 0 &&
        (row.marginPercent ?? 0) >= 25,
    )
    .sort((a, b) => b.eventProfitLoss - a.eventProfitLoss)[0];

  if (repeatCandidate) {
    generatedActions.push({
      id: ariaActionKey("repeat", repeatCandidate.event.id, "strong-margin"),
      priority: "Low",
    });
  }

  const actionKeys = Array.from(
    new Set(generatedActions.map((action) => action.id)),
  );
  if (actionKeys.length === 0) return emptyCounts;

  const { data: persistedRows } = await supabase
    .from("aria_action_items")
    .select("action_key, status, snoozed_until")
    .eq("organizer_id", organizerId)
    .in("action_key", actionKeys);

  const persistedByKey = new Map(
    (
      (persistedRows ?? []) as Array<{
        action_key: string;
        status: string | null;
        snoozed_until: string | null;
      }>
    ).map((row) => [row.action_key, row]),
  );

  const activeActions = generatedActions.filter((action) => {
    const persisted = persistedByKey.get(action.id);
    return (
      !persisted ||
      !isHiddenAriaActionState(persisted.status, persisted.snoozed_until)
    );
  });

  return {
    activeCount: activeActions.length,
    highPriorityCount: activeActions.filter(
      (action) => action.priority === "High",
    ).length,
  };
}

function buildStudioSections(params: {
  unreadNotificationsCount: number;
  leadsBadgeCount: number;
  role: string | null | undefined;
  isPlatformAdmin: boolean;
  portalHref: string | null;
  publicProfileHref: string | null;
}) {
  const {
    unreadNotificationsCount,
    leadsBadgeCount,
    role,
    isPlatformAdmin,
    portalHref,
    publicProfileHref,
  } = params;

  const isOwner = isPlatformAdmin || role === "studio_owner";
  const isStudioAdmin = isOwner || role === "studio_admin";
  const isFrontDesk = isStudioAdmin || role === "front_desk";
  const isInstructor = role === "instructor";
  const isIndependentInstructor = role === "independent_instructor";
  const isAnyInstructor = isInstructor || isIndependentInstructor;

  if (isIndependentInstructor) {
    return compactSections([
      {
        title: "My Work",
        items: [
          { label: "Dashboard", href: "/app", icon: "dashboard" },
          { label: "My Schedule", href: "/app/schedule", icon: "schedule" },
          ...(portalHref
            ? [
                {
                  label: "My Studio Portal",
                  href: portalHref,
                  icon: "clients" as const,
                },
              ]
            : []),
          {
            label: "Notifications",
            href: "/app/notifications",
            icon: "notifications",
            badge: unreadNotificationsCount,
          },
        ],
      },
      {
        title: "Floor Rental",
        items: [
          { label: "Pay Floor Fees", href: "/app/payments", icon: "payments" },
          { label: "Expenses", href: "/app/expenses", icon: "payments" },
          { label: "Rooms / Floor Space", href: "/app/rooms", icon: "rooms" },
        ],
      },
      {
        title: "Public Site",
        items: [
          { label: "Discovery Home", href: "/discover", icon: "dashboard" },
          { label: "Find Studios", href: "/discover/studios", icon: "clients" },
          { label: "Find Events", href: "/discover/events", icon: "events" },
          { label: "My Public Account", href: "/account", icon: "clients" },
        ],
      },
      {
        title: "Support",
        items: [
          { label: "Help", href: "/app/help", icon: "settings" },
          { label: "Knowledgebase", href: "/knowledgebase", icon: "settings" },
        ],
      },
    ]);
  }

  return compactSections([
    {
      title: "Start Here",
      items: [
        { label: "Dashboard", href: "/app", icon: "dashboard" },
        { label: "Today’s Schedule", href: "/app/schedule", icon: "schedule" },
        {
          label: "Notifications",
          href: "/app/notifications",
          icon: "notifications",
          badge: unreadNotificationsCount,
        },
      ],
    },
    {
      title: "Clients & Leads",
      items: [
        ...(isFrontDesk || isStudioAdmin || isOwner
          ? [
              {
                label: "Client List",
                href: "/app/clients",
                icon: "clients" as const,
              },
              {
                label: "Add New Client",
                href: "/app/clients/new",
                icon: "clients" as const,
              },
              {
                label: "New Leads",
                href: "/app/leads",
                icon: "leads" as const,
                badge: leadsBadgeCount,
              },
            ]
          : []),
      ],
    },
    {
      title: "Marketing",
      items: [
        ...(isFrontDesk || isStudioAdmin || isOwner
          ? [
              {
                label: "Campaigns",
                href: "/app/marketing/campaigns",
                icon: "marketing" as const,
              },
            ]
          : []),
      ],
    },
    {
      title: "Schedule & Space",
      items: [
        ...(isAnyInstructor
          ? [
              {
                label: "My Schedule",
                href: "/app/schedule",
                icon: "schedule" as const,
              },
            ]
          : []),
        ...(isStudioAdmin || isOwner
          ? [
              {
                label: "Instructors",
                href: "/app/instructors",
                icon: "instructors" as const,
              },
              {
                label: "Rooms / Floor Space",
                href: "/app/rooms",
                icon: "rooms" as const,
              },
            ]
          : []),
      ],
    },
    {
      title: "Sales & Payments",
      items: [
        ...(isFrontDesk || isStudioAdmin || isOwner
          ? [
              {
                label: "Take Payment / Payouts",
                href: "/app/payments",
                icon: "payments" as const,
              },
              {
                label: "Expenses",
                href: "/app/expenses",
                icon: "payments" as const,
              },
              {
                label: "Sell to Client",
                href: "/app/sales/new",
                icon: "payments" as const,
              },
              {
                label: "Client Balances",
                href: "/app/packages/client-balances",
                icon: "balances" as const,
              },
            ]
          : []),
        ...(isStudioAdmin || isOwner
          ? [
              {
                label: "Package Setup",
                href: "/app/packages",
                icon: "packages" as const,
              },
              {
                label: "Membership Setup",
                href: "/app/memberships",
                icon: "memberships" as const,
              },
              {
                label: "Studio Analytics",
                href: "/app/analytics",
                icon: "reports" as const,
              },
              {
                label: "Reports",
                href: "/app/reports",
                icon: "reports" as const,
              },
            ]
          : []),
      ],
    },
    {
      title: "Public Growth",
      items: [
        ...(isStudioAdmin || isOwner
          ? [
              {
                label: "Public Profile Setup",
                href: "/app/settings/public-profile",
                icon: "settings" as const,
              },
              {
                label: "View Public Profile",
                href: publicProfileHref ?? "/discover/studios",
                icon: "clients" as const,
              },
              { label: "Events", href: "/app/events", icon: "events" as const },
              {
                label: "Create Event",
                href: "/app/events/new",
                icon: "events" as const,
              },
            ]
          : []),
        { label: "Discovery Home", href: "/discover", icon: "dashboard" },
        { label: "Find Studios", href: "/discover/studios", icon: "clients" },
        { label: "Find Events", href: "/discover/events", icon: "events" },
        { label: "My Public Account", href: "/account", icon: "clients" },
      ],
    },
    {
      title: "Admin",
      items: [
        ...(isStudioAdmin || isOwner
          ? [
              {
                label: "Studio Settings",
                href: "/app/settings",
                icon: "settings" as const,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                label: "Team & Permissions",
                href: "/app/settings/team",
                icon: "settings" as const,
              },
              {
                label: "Billing & Payouts",
                href: "/app/settings/billing",
                icon: "payments" as const,
              },
            ]
          : []),
      ],
    },
    {
      title: "Support",
      items: [
        { label: "Help", href: "/app/help", icon: "settings" },
        { label: "Knowledgebase", href: "/knowledgebase", icon: "settings" },
      ],
    },
  ]);
}

function buildOrganizerSections(params: {
  unreadNotificationsCount: number;
  organizerAriaActionCount: number;
  organizerAriaHighPriorityCount: number;
  role: string | null | undefined;
  isPlatformAdmin: boolean;
}) {
  const {
    unreadNotificationsCount,
    organizerAriaActionCount,
    organizerAriaHighPriorityCount,
    role,
    isPlatformAdmin,
  } = params;

  const isOwner = isPlatformAdmin || role === "organizer_owner";
  const isOrganizerAdmin = isOwner || role === "organizer_admin";

  return compactSections([
    {
      title: "Event Operations",
      items: [
        { label: "Dashboard", href: "/app", icon: "dashboard" },
        ...(isOrganizerAdmin
          ? [
              {
                label: "ARIA",
                href: "/app/aria",
                icon: "aria" as const,
                badge:
                  organizerAriaHighPriorityCount > 0
                    ? organizerAriaHighPriorityCount
                    : organizerAriaActionCount,
              },
            ]
          : []),
        ...(isOrganizerAdmin
          ? [
              { label: "Events", href: "/app/events", icon: "events" as const },
              {
                label: "Create Event",
                href: "/app/events/new",
                icon: "events" as const,
              },
              {
                label: "Registrations",
                href: "/app/events/registrations",
                icon: "clients" as const,
              },
              {
                label: "Event Check-In",
                href: "/app/events/checkin",
                icon: "checkin" as const,
              },
            ]
          : []),
        {
          label: "Notifications",
          href: "/app/notifications",
          icon: "notifications",
          badge: unreadNotificationsCount,
        },
      ],
    },
    {
      title: "Money",
      items: [
        ...(isOrganizerAdmin
          ? [
              {
                label: "Ticket Sales & Payments",
                href: "/app/payments",
                icon: "payments" as const,
              },
              {
                label: "Expenses",
                href: "/app/expenses",
                icon: "payments" as const,
              },
              {
                label: "Reports",
                href: "/app/reports",
                icon: "reports" as const,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                label: "Billing & Payouts",
                href: "/app/settings/billing",
                icon: "payments" as const,
              },
            ]
          : []),
      ],
    },
    {
      title: "Public Presence",
      items: [
        ...(isOrganizerAdmin
          ? [
              {
                label: "Organizer Profile",
                href: "/app/organizers",
                icon: "settings" as const,
              },
            ]
          : []),
        { label: "Discovery Home", href: "/discover", icon: "dashboard" },
        { label: "Find Studios", href: "/discover/studios", icon: "clients" },
        { label: "Find Events", href: "/discover/events", icon: "events" },
        { label: "My Public Account", href: "/account", icon: "clients" },
      ],
    },
    {
      title: "Admin",
      items: [
        ...(isOrganizerAdmin
          ? [
              {
                label: "Workspace Settings",
                href: "/app/settings",
                icon: "settings" as const,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                label: "Team & Permissions",
                href: "/app/settings/team",
                icon: "settings" as const,
              },
            ]
          : []),
      ],
    },
    {
      title: "Support",
      items: [
        { label: "Help", href: "/app/help", icon: "settings" },
        { label: "Knowledgebase", href: "/knowledgebase", icon: "settings" },
      ],
    },
  ]);
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const headerStore = await headers();
  const pathname = headerStore.get("x-pathname") ?? "/app";

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const accessState = await getCurrentWorkspaceAccessState();
  const billingPath = "/app/settings/billing";
  const isBillingRoute = pathname.startsWith(billingPath);

  if (!context.isPlatformAdmin && accessState.blocked && !isBillingRoute) {
    redirect(`${billingPath}?reason=access_paused`);
  }

  if (!context.isPlatformAdmin && !accessState.blocked) {
    await recordWorkspaceAccess({
      studioId: context.studioId,
      userId: context.userId,
      route: pathname,
    });
  }

  async function switchWorkspaceAction(formData: FormData) {
    "use server";

    const studioId = String(formData.get("studioId") ?? "").trim();
    if (!studioId) return;

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      redirect("/login");
    }

    const { data: allowedRole } = await supabase
      .from("user_studio_roles")
      .select("studio_id")
      .eq("user_id", user.id)
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    let hasWorkspaceAccess = Boolean(allowedRole);

    if (!hasWorkspaceAccess) {
      const { data: organizerRole } = await supabase
        .from("organizer_users")
        .select("organizer_id, organizers!inner(studio_id)")
        .eq("user_id", user.id)
        .eq("active", true)
        .eq("organizers.studio_id", studioId)
        .limit(1)
        .maybeSingle();

      hasWorkspaceAccess = Boolean(organizerRole);
    }

    if (!hasWorkspaceAccess) {
      return;
    }

    const cookieStore = await cookies();
    cookieStore.set(APP_SELECTED_STUDIO_COOKIE, studioId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    redirect("/app");
  }

  const [
    { data: studio },
    { data: profile },
    { data: notifications },
    { count: openLeadCount },
    accessibleStudios,
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, slug")
      .eq("id", context.studioId)
      .maybeSingle<StudioRow>(),

    supabase
      .from("profiles")
      .select("id, full_name, email")
      .eq("id", user.id)
      .maybeSingle<ProfileRow>(),

    supabase
      .from("notifications")
      .select(
        "id, type, title, body, read_at, created_at, client_id, appointment_id",
      )
      .eq("studio_id", context.studioId)
      .order("created_at", { ascending: false })
      .limit(8),

    supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", context.studioId)
      .eq("status", "lead"),

    getAccessibleStudios(),
  ]);

  const safeNotifications = ((notifications ?? []) as NotificationItem[]) || [];
  const unreadNotificationsCount = safeNotifications.filter(
    (item) => !item.read_at,
  ).length;
  const leadsBadgeCount = openLeadCount ?? 0;

  const studioName = studio?.name ?? "Workspace";
  const portalHref = studio?.slug ? `/portal/${studio.slug}` : null;
  const publicProfileHref = studio?.slug ? `/studios/${studio.slug}` : null;
  const userName = buildDisplayName(profile ?? null, user.email ?? null);
  const userEmail = profile?.email ?? user.email ?? "";
  const roleLabel = context.isPlatformAdmin
    ? "Platform Admin"
    : formatRoleLabel(context.studioRole);

  const organizerWorkspace = isOrganizerRole(context.studioRole);
  const workspaceCapabilities = organizerWorkspace
    ? null
    : await getCurrentWorkspaceCapabilitiesForUser();
  const hasOrganizerSuite =
    organizerWorkspace ||
    context.isPlatformAdmin ||
    Boolean(workspaceCapabilities?.hasOrganizerSuite);

  const organizerAriaSidebarCounts = organizerWorkspace
    ? await getOrganizerAriaSidebarCounts({
        supabase,
        userId: user.id,
        studioId: context.studioId,
      })
    : { activeCount: 0, highPriorityCount: 0 };

  const sections = organizerWorkspace
    ? buildOrganizerSections({
        unreadNotificationsCount,
        organizerAriaActionCount: organizerAriaSidebarCounts.activeCount,
        organizerAriaHighPriorityCount:
          organizerAriaSidebarCounts.highPriorityCount,
        role: context.studioRole,
        isPlatformAdmin: context.isPlatformAdmin,
      })
    : buildStudioSections({
        unreadNotificationsCount,
        leadsBadgeCount,
        role: context.studioRole,
        isPlatformAdmin: context.isPlatformAdmin,
        portalHref,
        publicProfileHref,
      });

  let studioBanner: React.ReactNode = null;

  if (await isPlatformAdmin()) {
    studioBanner = (
      <div className="border-b border-amber-200 bg-amber-50">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Viewing workspace as platform admin
            </p>
            <p className="text-sm text-amber-800">
              {studioName} • You are in temporary workspace context.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/platform"
              className="rounded-xl border border-amber-300 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
            >
              Back to Platform
            </Link>

            <form action={clearStudioContextAction}>
              <button
                type="submit"
                className="rounded-xl bg-amber-900 px-3 py-2 text-sm text-white hover:bg-amber-800"
              >
                Exit Workspace Context
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (!context.isPlatformAdmin && accessState.blocked && isBillingRoute) {
    return (
      <div className="min-h-screen bg-slate-50">
        {studioBanner}

        <div className="border-b border-rose-200 bg-rose-50">
          <div className="mx-auto max-w-7xl px-6 py-4">
            <p className="text-sm font-semibold text-rose-900">
              Workspace access paused
            </p>
            <p className="mt-1 text-sm text-rose-800">
              {getBillingLockMessage(accessState.status)}
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {studioBanner}

      <AppSidebarShell
        pathname={pathname}
        studioName={studioName}
        userName={userName}
        userEmail={userEmail}
        role={roleLabel}
        sections={sections}
        unreadNotificationsCount={unreadNotificationsCount}
        recentNotifications={safeNotifications}
        workspaces={accessibleStudios}
        currentStudioId={context.studioId}
        switchWorkspaceAction={switchWorkspaceAction}
        hasOrganizerSuite={hasOrganizerSuite}
      >
        {children}
      </AppSidebarShell>
    </div>
  );
}
