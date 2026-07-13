import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  CheckCircle2,
  Clock3,
  ClipboardList,
  CreditCard,
  Package,
  Sparkles,
  Target,
  Users,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, isOrganizerRole } from "@/lib/auth/studio";
import AriaAvatar from "@/components/app/AriaAvatar";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import {
  assignAutomationActionOwnerAction,
  executeAriaApprovedActionsAction,
  generateAriaOperationalActionsAction,
  saveAriaActionPolicyAction,
  saveAriaDigestPreferencesAction,
  updateAutomationActionStatusAction,
} from "@/app/app/automations/actions";

type PriorityTone = "urgent" | "warning" | "info" | "success";

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  created_at: string;
};

type AppointmentRow = {
  id: string;
  client_id: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
  payment_status: string | null;
};

type ClientPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  expiration_date: string | null;
  purchase_date: string | null;
  created_at: string;
  client_package_items?:
    | {
        quantity_remaining: number | string | null;
        is_unlimited: boolean | null;
      }[]
    | null;
};

type ClientMembershipRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  created_at: string;
};

type BookingRequestRow = {
  id: string;
  status: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  requested_starts_at: string | null;
  created_at: string;
};

type PaymentRow = {
  id: string;
  amount: number | string | null;
  status: string | null;
  payment_type: string | null;
  payment_channel: string | null;
  source: string | null;
  created_at: string;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

type AutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string | null;
  priority: string | null;
  related_table: string | null;
  related_id: string | null;
  client_id: string | null;
  created_at: string;
  due_at?: string | null;
  reviewed_at?: string | null;
  approved_at?: string | null;
  completed_at?: string | null;
  dismissed_at?: string | null;
  skipped_at?: string | null;
  snoozed_until?: string | null;
  review_note?: string | null;
  assigned_to?: string | null;
};

type AssignableTeamMember = {
  userId: string;
  name: string;
  email: string | null;
  role: string | null;
};

type AriaActionPolicyRow = {
  rule_key: string;
  enabled: boolean | null;
  auto_approve: boolean | null;
  max_auto_approve_priority: string | null;
  default_assigned_to: string | null;
  require_assignment: boolean | null;
  updated_at: string | null;
};

type AriaDigestPreferencesRow = {
  studio_id: string;
  morning_digest_enabled: boolean | null;
  end_of_day_digest_enabled: boolean | null;
  delivery_channel: string | null;
  default_recipient_user_id: string | null;
  morning_digest_time: string | null;
  end_of_day_digest_time: string | null;
  updated_at: string | null;
};

type AriaDigestRunRow = {
  id: string;
  digest_type: string | null;
  digest_date: string | null;
  delivery_channel: string | null;
  recipient_email: string | null;
  status: string | null;
  summary: Record<string, unknown> | null;
  processed_at: string | null;
  created_at: string;
};

type AriaPolicyDefinition = {
  ruleKey: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
};

type WorkspaceUserRoleRow = {
  user_id: string;
  role: string | null;
};

type OrganizerUserRoleRow = {
  user_id: string;
  role: string | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
};

type OrganizerEventRow = {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
  start_date: string;
  end_date: string | null;
};

type OrganizerRegistrationRow = {
  id: string;
  event_id: string | null;
  status: string | null;
  payment_status: string | null;
  quantity: number | string | null;
};

type OrganizerTicketRow = {
  id: string;
  event_id: string | null;
  checked_in_at: string | null;
};

type OrganizerProfitabilityRow = {
  event_id: string | null;
  net_ticket_revenue: number | string | null;
  event_profit_loss: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
};

type OperationItem = {
  key: string;
  title: string;
  metric: string;
  detail: string;
  href: string;
  actionLabel: string;
  tone: PriorityTone;
  icon: typeof Sparkles;
};

function asNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function daysBetween(start: Date, end: Date) {
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatCurrency(value: number | string | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(asNumber(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value.includes("T") ? value : `${value}T00:00:00`));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameLocalDay(value: string | null | undefined, compareTo: Date) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return (
    startOfLocalDay(date).getTime() === startOfLocalDay(compareTo).getTime()
  );
}

function isBeforeLocalDay(value: string | null | undefined, compareTo: Date) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return startOfLocalDay(date).getTime() < startOfLocalDay(compareTo).getTime();
}

function formatRole(value: string | null | undefined) {
  if (!value) return "Team";
  return value.replaceAll("_", " ");
}

function teamMemberLabel(member: AssignableTeamMember | null | undefined) {
  if (!member) return "Unassigned";
  return member.name || member.email || "Team member";
}

function ariaDigestTypeLabel(value: string | null | undefined) {
  if (value === "end_of_day") return "End-of-day";
  if (value === "morning") return "Morning";
  return "Digest";
}

function ariaDigestStatusLabel(value: string | null | undefined) {
  if (value === "sent") return "Email sent";
  if (value === "queued") return "Email queued";
  if (value === "prepared") return "Prepared";
  if (value === "skipped") return "Skipped";
  if (value === "failed") return "Failed";
  if (value === "processing") return "Processing";
  return value || "Pending";
}

async function getAssignableTeamMembers(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  includeOrganizerUsers: boolean;
  currentUserId: string;
  currentUserEmail: string | null;
}) {
  const {
    supabase,
    studioId,
    includeOrganizerUsers,
    currentUserId,
    currentUserEmail,
  } = params;
  const [{ data: studioRoles }, { data: organizers }] = await Promise.all([
    supabase
      .from("user_studio_roles")
      .select("user_id, role")
      .eq("studio_id", studioId)
      .eq("active", true),
    includeOrganizerUsers
      ? supabase
          .from("organizers")
          .select("id")
          .eq("studio_id", studioId)
          .limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  const roleRows = (studioRoles ?? []) as WorkspaceUserRoleRow[];
  const organizerIds = ((organizers ?? []) as { id: string }[]).map(
    (organizer) => organizer.id,
  );
  let organizerRows: OrganizerUserRoleRow[] = [];

  if (organizerIds.length > 0) {
    const { data } = await supabase
      .from("organizer_users")
      .select("user_id, role")
      .in("organizer_id", organizerIds)
      .eq("active", true);

    organizerRows = (data ?? []) as OrganizerUserRoleRow[];
  }

  const roleByUserId = new Map<string, string | null>();
  for (const row of [...roleRows, ...organizerRows]) {
    if (!row.user_id) continue;
    if (!roleByUserId.has(row.user_id)) {
      roleByUserId.set(row.user_id, row.role ?? null);
    }
  }

  if (!roleByUserId.has(currentUserId)) {
    roleByUserId.set(currentUserId, "current_user");
  }

  const userIds = Array.from(roleByUserId.keys());
  const { data: profiles } =
    userIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", userIds)
      : { data: [] };

  const profileById = new Map(
    ((profiles ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]),
  );

  return userIds
    .map((userId) => {
      const profile = profileById.get(userId);
      const role = roleByUserId.get(userId) ?? null;
      return {
        userId,
        name:
          profile?.full_name?.trim() ||
          profile?.email ||
          (userId === currentUserId ? currentUserEmail : null) ||
          "Team member",
        email:
          profile?.email ??
          (userId === currentUserId ? currentUserEmail : null),
        role,
      } satisfies AssignableTeamMember;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getClientName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return (
    [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim() ||
    "Client"
  );
}

function personName(
  firstName: string | null,
  lastName: string | null,
  fallback = "Client",
) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || fallback;
}

function lowestRemainingPackageCredit(pkg: ClientPackageRow) {
  const finiteItems = (pkg.client_package_items ?? [])
    .filter((item) => !item.is_unlimited)
    .map((item) => asNumber(item.quantity_remaining))
    .filter((value) => Number.isFinite(value));

  if (!finiteItems.length) return null;
  return Math.min(...finiteItems);
}

function isCanceledStatus(status: string | null | undefined) {
  const normalized = `${status ?? ""}`.toLowerCase();
  return (
    normalized.includes("cancel") ||
    normalized.includes("declin") ||
    normalized.includes("no_show")
  );
}

function isCompletedStatus(status: string | null | undefined) {
  const normalized = `${status ?? ""}`.toLowerCase();
  return (
    normalized.includes("attend") ||
    normalized.includes("complete") ||
    normalized.includes("done")
  );
}

function isIntroAppointmentType(value: string | null | undefined) {
  const normalized = `${value ?? ""}`.toLowerCase();
  return normalized.includes("intro") || normalized.includes("consult");
}

function toneClass(tone: PriorityTone) {
  if (tone === "urgent") return "border-red-200 bg-red-50 text-red-700";
  if (tone === "warning") return "border-amber-200 bg-amber-50 text-amber-700";
  if (tone === "success")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-violet-200 bg-violet-50 text-violet-700";
}

function OperationCard({ item }: { item: OperationItem }) {
  const Icon = item.icon;

  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div
          className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl border ${toneClass(item.tone)}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {item.metric}
        </span>
      </div>
      <h2 className="mt-4 text-lg font-semibold text-slate-950">
        {item.title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{item.detail}</p>
      <Link
        href={item.href}
        className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#BE185D] hover:underline"
      >
        {item.actionLabel}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </article>
  );
}

function CollapsibleOperationsBlock({
  title,
  eyebrow,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6"
    >
      <summary className="flex cursor-pointer list-none flex-col gap-3 marker:hidden md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            {eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            {title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            {description}
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          Expand / collapse
        </span>
      </summary>
      <div className="mt-5 space-y-4">{children}</div>
    </details>
  );
}

function MiniList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ label: string; detail: string; href: string }>;
}) {
  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
      <div className="mt-4 divide-y divide-slate-100">
        {items.length ? (
          items.map((item) => (
            <Link
              key={`${item.href}:${item.label}`}
              href={item.href}
              className="block py-3 first:pt-0 last:pb-0 hover:bg-slate-50"
            >
              <p className="text-sm font-semibold text-slate-900">
                {item.label}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {item.detail}
              </p>
            </Link>
          ))
        ) : (
          <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
            {empty}
          </p>
        )}
      </div>
    </section>
  );
}

function automationStatusLabel(value: string | null | undefined) {
  if (value === "suggested") return "Suggested";
  if (value === "drafted") return "Drafted";
  if (value === "approved") return "Approved";
  if (value === "queued") return "Queued";
  if (value === "completed") return "Completed";
  if (value === "dismissed") return "Dismissed";
  if (value === "skipped") return "Skipped";
  if (value === "snoozed") return "Snoozed";
  return value || "Action";
}

function automationPriorityTone(
  priority: string | null | undefined,
): PriorityTone {
  if (priority === "urgent") return "urgent";
  if (priority === "high") return "warning";
  return "info";
}

function relatedAutomationHref(action: AutomationActionRow) {
  if (action.related_table === "clients" && action.related_id) {
    return `/app/clients/${action.related_id}`;
  }

  if (action.related_table === "client_packages") {
    return action.client_id
      ? `/app/clients/${action.client_id}`
      : "/app/packages/client-balances";
  }

  if (action.related_table === "client_memberships") {
    return action.client_id
      ? `/app/clients/${action.client_id}`
      : "/app/memberships";
  }

  if (action.related_table === "payments") {
    return "/app/payments?status=pending";
  }

  if (action.related_table === "booking_requests") {
    return "/app/schedule/requests?status=pending";
  }

  if (action.related_table === "document_assignments") {
    return "/app/documents";
  }

  if (action.related_table === "appointments") {
    return action.client_id
      ? `/app/clients/${action.client_id}`
      : "/app/schedule";
  }

  if (action.related_table === "events" && action.related_id) {
    return `/app/events/${action.related_id}`;
  }

  if (action.related_table === "event_registrations" && action.related_id) {
    return "/app/events/registrations";
  }

  return action.client_id
    ? `/app/clients/${action.client_id}`
    : "/app/automations";
}

const ARIA_POLICY_DEFINITIONS: AriaPolicyDefinition[] = [
  {
    ruleKey: "aria_booking_request_aging",
    label: "Aging booking requests",
    description:
      "Public or portal requests waiting long enough to need staff review.",
    risk: "medium",
  },
  {
    ruleKey: "aria_low_package_balance",
    label: "Low package balances",
    description: "Clients with two or fewer package credits remaining.",
    risk: "medium",
  },
  {
    ruleKey: "aria_package_expiring",
    label: "Expiring packages",
    description: "Active packages approaching expiration.",
    risk: "medium",
  },
  {
    ruleKey: "aria_stale_active_student",
    label: "Stale active students",
    description:
      "Active students with recent lesson history and no future booking.",
    risk: "medium",
  },
  {
    ruleKey: "aria_intro_no_purchase",
    label: "Intro without purchase",
    description:
      "Completed intro/consult clients without a package or membership purchase.",
    risk: "medium",
  },
  {
    ruleKey: "aria_payment_exception",
    label: "Payment exceptions",
    description:
      "Pending or failed payments that should not be auto-cleared casually.",
    risk: "high",
  },
  {
    ruleKey: "aria_membership_past_due",
    label: "Past-due memberships",
    description: "Past-due or unpaid memberships that need billing follow-up.",
    risk: "high",
  },
  {
    ruleKey: "aria_membership_canceling",
    label: "Canceling memberships",
    description: "Memberships set to cancel at period end.",
    risk: "high",
  },
  {
    ruleKey: "aria_event_unpaid_registration",
    label: "Event registration payments",
    description:
      "Organizer registrations with pending, unpaid, or failed payment status.",
    risk: "high",
  },
  {
    ruleKey: "aria_event_missing_costs",
    label: "Missing event costs",
    description: "Revenue events missing labor or expense attribution.",
    risk: "high",
  },
  {
    ruleKey: "aria_event_loss",
    label: "Event losses",
    description: "Events currently below break-even.",
    risk: "high",
  },
  {
    ruleKey: "aria_event_low_checkin",
    label: "Low event check-in quality",
    description: "Completed events with low ticket check-in rates.",
    risk: "medium",
  },
];

function policyStatusLabel(policy: AriaActionPolicyRow | undefined) {
  if (policy?.enabled === false) return "Disabled";
  if (policy?.auto_approve) return "Auto-approve";
  return "Manual review";
}

function policyRiskClass(risk: AriaPolicyDefinition["risk"]) {
  if (risk === "high") return "border-red-200 bg-red-50 text-red-700";
  if (risk === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function AriaActionPolicyPanel({
  policies,
  teamMembers,
  currentUserId,
  organizerWorkspace,
}: {
  policies: AriaActionPolicyRow[];
  teamMembers: AssignableTeamMember[];
  currentUserId: string;
  organizerWorkspace: boolean;
}) {
  const policyByRuleKey = new Map(
    policies.map((policy) => [policy.rule_key, policy]),
  );
  const visibleDefinitions = ARIA_POLICY_DEFINITIONS.filter((definition) =>
    organizerWorkspace
      ? definition.ruleKey.startsWith("aria_event_")
      : !definition.ruleKey.startsWith("aria_event_"),
  );

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            ARIA auto-approval policies
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Decide what ARIA can approve automatically
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Keep risky billing and finance work in manual review, or let
            low-risk operational reminders enter the queue already approved and
            assigned.
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {visibleDefinitions.length} policies
        </span>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {visibleDefinitions.map((definition) => {
          const policy = policyByRuleKey.get(definition.ruleKey);
          const policyMode =
            policy?.enabled === false
              ? "disabled"
              : policy?.auto_approve
                ? "auto_approve"
                : "manual";

          return (
            <form
              key={definition.ruleKey}
              action={saveAriaActionPolicyAction}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <input type="hidden" name="ruleKey" value={definition.ruleKey} />
              <input
                type="hidden"
                name="returnTo"
                value="/app/aria/operations"
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${policyRiskClass(definition.risk)}`}
                    >
                      {definition.risk} risk
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                      {policyStatusLabel(policy)}
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-slate-950">
                    {definition.label}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    {definition.description}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Policy
                  <select
                    name="policyMode"
                    defaultValue={policyMode}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
                  >
                    <option value="manual">Manual review</option>
                    <option value="auto_approve">Auto-approve</option>
                    <option value="disabled">Do not generate</option>
                  </select>
                </label>

                <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Auto-approve through
                  <select
                    name="maxAutoApprovePriority"
                    defaultValue={policy?.max_auto_approve_priority ?? "normal"}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
                  >
                    <option value="low">Low only</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>

                <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Default owner
                  <select
                    name="defaultAssignedTo"
                    defaultValue={policy?.default_assigned_to ?? "unassigned"}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
                  >
                    <option value="unassigned">Unassigned</option>
                    <option value="__me">Assign to me</option>
                    {teamMembers.map((member) => (
                      <option
                        key={`${definition.ruleKey}-${member.userId}`}
                        value={member.userId}
                      >
                        {member.name} • {formatRole(member.role)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    name="requireAssignment"
                    defaultChecked={Boolean(policy?.require_assignment)}
                    className="h-4 w-4 rounded border-slate-300 text-[#BE185D]"
                  />
                  Require owner before generation
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  type="submit"
                  className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  Save policy
                </button>
              </div>
            </form>
          );
        })}
      </div>
    </section>
  );
}

type AriaRecommendationExplanation = {
  sourceSignal: string;
  trigger: string;
  evidence: string;
  policyDecision: string;
  executionReadiness: string;
  staffGuardrail: string;
};

const ARIA_RECOMMENDATION_DETAILS: Record<
  string,
  {
    sourceSignal: string;
    trigger: string;
    staffGuardrail: string;
    emailExecutable: boolean;
  }
> = {
  aria_booking_request_aging: {
    sourceSignal: "Booking request aging",
    trigger:
      "A pending request stayed open long enough to risk losing dancer momentum.",
    staffGuardrail:
      "ARIA does not approve or decline booking requests automatically. Staff should review the requested time and contact the dancer.",
    emailExecutable: false,
  },
  aria_low_package_balance: {
    sourceSignal: "Package balance / expiration",
    trigger:
      "An active package is low on usable credits or approaching expiration.",
    staffGuardrail:
      "ARIA can queue a renewal follow-up, but staff should still review package details before marking the action complete.",
    emailExecutable: true,
  },
  aria_package_expiring: {
    sourceSignal: "Package expiration",
    trigger: "An active package is approaching its expiration window.",
    staffGuardrail:
      "ARIA prepares renewal work only; package terms and balances should remain staff-reviewed.",
    emailExecutable: true,
  },
  aria_stale_active_student: {
    sourceSignal: "Student momentum / rebooking",
    trigger:
      "An active student has recent lesson history but no future appointment scheduled.",
    staffGuardrail:
      "ARIA can queue a rebooking follow-up, but staff should use judgment for students who may be paused intentionally.",
    emailExecutable: true,
  },
  aria_intro_no_purchase: {
    sourceSignal: "Intro conversion gap",
    trigger:
      "A client completed an intro or consultation but has no package or membership on file.",
    staffGuardrail:
      "ARIA can queue a next-step follow-up, but staff should personalize the conversation when possible.",
    emailExecutable: true,
  },
  aria_payment_exception: {
    sourceSignal: "Payment exception",
    trigger:
      "A payment is pending or failed and may affect revenue, closeout, or client access.",
    staffGuardrail:
      "ARIA never retries, charges, refunds, or clears payments automatically in this version. Staff must review billing actions.",
    emailExecutable: false,
  },
  aria_membership_past_due: {
    sourceSignal: "Membership billing state",
    trigger: "A membership is marked past due or unpaid.",
    staffGuardrail:
      "ARIA can queue a billing follow-up email, but it does not retry payment or change membership access automatically.",
    emailExecutable: true,
  },
  aria_membership_canceling: {
    sourceSignal: "Membership cancellation risk",
    trigger: "A membership is set to cancel at the end of the current period.",
    staffGuardrail:
      "ARIA can queue a retention follow-up, but staff owns any plan changes, saves, or billing adjustments.",
    emailExecutable: true,
  },
  aria_event_unpaid_registration: {
    sourceSignal: "Event registration payment status",
    trigger:
      "An event registration has pending, unpaid, or failed payment status.",
    staffGuardrail:
      "ARIA does not charge, cancel, or modify event registrations automatically. Organizer staff must review the registration.",
    emailExecutable: false,
  },
  aria_event_missing_costs: {
    sourceSignal: "Event profitability completeness",
    trigger:
      "An event has ticket revenue but missing labor or expense attribution.",
    staffGuardrail:
      "ARIA does not create expenses or labor costs automatically. Staff should verify accounting details.",
    emailExecutable: false,
  },
  aria_event_loss: {
    sourceSignal: "Event profitability exception",
    trigger:
      "An event is currently below break-even based on available event P&L data.",
    staffGuardrail:
      "ARIA does not change pricing or accounting automatically. Organizer staff should review the event financials.",
    emailExecutable: false,
  },
  aria_event_low_checkin: {
    sourceSignal: "Event check-in quality",
    trigger: "A completed event has a low ticket check-in rate.",
    staffGuardrail:
      "ARIA does not edit attendance automatically. Staff should verify scans, no-shows, and registration data.",
    emailExecutable: false,
  },
};

function getAriaRecommendationExplanation(
  action: AutomationActionRow,
): AriaRecommendationExplanation {
  const details = ARIA_RECOMMENDATION_DETAILS[action.rule_key] ?? null;
  const autoApproved =
    action.status === "approved" &&
    action.review_note?.toLowerCase().includes("auto-approved");
  const queued = action.status === "queued";
  const dueText = action.due_at ? ` Due ${formatDateTime(action.due_at)}.` : "";
  const priorityText = `${action.priority ?? "normal"} priority`;
  const relatedText = action.related_table
    ? `Related to ${action.related_table.replaceAll("_", " ")}${action.related_id ? ` record ${action.related_id.slice(0, 8)}` : ""}.`
    : "Related source record was not attached.";

  const policyDecision = autoApproved
    ? "Your studio settings approved this item automatically."
    : action.status === "approved"
      ? "This item has been approved by a team member."
      : action.status === "suggested" || action.status === "drafted"
        ? "A team member needs to review this item before anything is sent."
        : queued
          ? "The approved follow-up has been queued."
          : `Policy result: current lifecycle status is ${automationStatusLabel(action.status)}.`;

  const executionReadiness = details?.emailExecutable
    ? queued
      ? "The approved follow-up is queued to send."
      : action.status === "approved"
        ? "The approved follow-up is ready to be queued."
        : "The follow-up can be sent after approval."
    : "This item requires a staff decision and will not be handled automatically.";

  return {
    sourceSignal: details?.sourceSignal ?? action.rule_key.replaceAll("_", " "),
    trigger:
      details?.trigger ??
      "ARIA created this from an operations signal that matched the rule conditions.",
    evidence:
      `${priorityText}. ${relatedText}${dueText} ${action.body ? `Signal detail: ${action.body}` : ""}`.trim(),
    policyDecision,
    executionReadiness,
    staffGuardrail:
      details?.staffGuardrail ??
      "Staff should review the source record before making operational or billing changes.",
  };
}

function AriaRecommendationExplanationBox({
  action,
}: {
  action: AutomationActionRow;
}) {
  const explanation = getAriaRecommendationExplanation(action);

  return (
    <details className="mt-3 rounded-2xl border border-violet-100 bg-white px-3 py-2 text-xs text-slate-600 open:bg-violet-50">
      <summary className="cursor-pointer select-none font-semibold text-violet-700">
        Why ARIA recommended this
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-violet-100">
          <p className="font-semibold text-slate-950">Source signal</p>
          <p className="mt-1 leading-5">{explanation.sourceSignal}</p>
        </div>
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-violet-100">
          <p className="font-semibold text-slate-950">Trigger</p>
          <p className="mt-1 leading-5">{explanation.trigger}</p>
        </div>
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-violet-100 sm:col-span-2">
          <p className="font-semibold text-slate-950">Evidence</p>
          <p className="mt-1 leading-5">{explanation.evidence}</p>
        </div>
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-violet-100">
          <p className="font-semibold text-slate-950">Policy applied</p>
          <p className="mt-1 leading-5">{explanation.policyDecision}</p>
        </div>
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-violet-100">
          <p className="font-semibold text-slate-950">What happens next</p>
          <p className="mt-1 leading-5">{explanation.executionReadiness}</p>
        </div>
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-violet-100 sm:col-span-2">
          <p className="font-semibold text-slate-950">Safety guardrail</p>
          <p className="mt-1 leading-5">{explanation.staffGuardrail}</p>
        </div>
      </div>
    </details>
  );
}

function AriaActionReviewQueue({
  actions,
  teamMembers,
  currentUserId,
}: {
  actions: AutomationActionRow[];
  teamMembers: AssignableTeamMember[];
  currentUserId: string;
}) {
  const now = new Date();
  const activeActions = actions.filter((action) => {
    const status = action.status ?? "";

    if (["suggested", "drafted", "approved", "queued"].includes(status)) {
      return true;
    }

    if (status === "snoozed") {
      if (!action.snoozed_until) return true;
      return new Date(action.snoozed_until) <= now;
    }

    return false;
  });
  const snoozedActions = actions.filter(
    (action) =>
      action.status === "snoozed" &&
      action.snoozed_until &&
      new Date(action.snoozed_until) > now,
  );
  const teamMemberById = new Map(
    teamMembers.map((member) => [member.userId, member]),
  );
  const currentUser = teamMemberById.get(currentUserId);

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            ARIA review queue
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Review suggested actions
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Approve, complete, snooze, skip, or dismiss ARIA-created automation
            actions without leaving the Operations Center.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Link
            href="/app/automations"
            className="inline-flex items-center justify-center rounded-2xl border border-[#F9A8D4] bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] hover:bg-[#FDF2F8]"
          >
            Automation settings
          </Link>
          {snoozedActions.length ? (
            <span className="text-xs font-medium text-slate-500">
              {snoozedActions.length} snoozed until later
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {activeActions.length ? (
          activeActions.map((action) => (
            <article
              key={action.id}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClass(automationPriorityTone(action.priority))}`}
                    >
                      {action.priority ?? "normal"}
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                      {automationStatusLabel(action.status)}
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                      {action.rule_key.replaceAll("_", " ")}
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                      Assigned:{" "}
                      {teamMemberLabel(
                        teamMemberById.get(action.assigned_to ?? ""),
                      )}
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-slate-950">
                    {action.title}
                  </h3>
                  {action.body ? (
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {action.body}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-slate-500">
                    Created {formatDate(action.created_at)}
                  </p>
                  {action.snoozed_until ? (
                    <p className="mt-1 text-xs font-medium text-amber-700">
                      Snoozed until {formatDate(action.snoozed_until)}
                    </p>
                  ) : null}
                  {action.review_note ? (
                    <p className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-600">
                      Review note: {action.review_note}
                    </p>
                  ) : null}
                  <AriaRecommendationExplanationBox action={action} />
                </div>

                <div className="flex flex-col gap-3 lg:items-end">
                  <form
                    action={assignAutomationActionOwnerAction}
                    className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2"
                  >
                    <input type="hidden" name="actionId" value={action.id} />
                    <input
                      type="hidden"
                      name="returnTo"
                      value="/app/aria/operations"
                    />
                    <select
                      name="assignedTo"
                      defaultValue={action.assigned_to ?? "unassigned"}
                      className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700"
                    >
                      <option value="unassigned">Unassigned</option>
                      <option value="__me">
                        Assign to me
                        {currentUser ? ` (${currentUser.name})` : ""}
                      </option>
                      {teamMembers.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name} • {formatRole(member.role)}
                        </option>
                      ))}
                    </select>
                    <input
                      name="reviewNote"
                      placeholder="Optional note"
                      className="min-w-0 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400"
                    />
                    <button
                      type="submit"
                      className="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      Assign
                    </button>
                  </form>

                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <Link
                      href={relatedAutomationHref(action)}
                      className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      Open
                    </Link>
                    {action.status !== "approved" ? (
                      <form action={updateAutomationActionStatusAction}>
                        <input
                          type="hidden"
                          name="actionId"
                          value={action.id}
                        />
                        <input type="hidden" name="status" value="approved" />
                        <input
                          type="hidden"
                          name="returnTo"
                          value="/app/aria/operations"
                        />
                        <button
                          type="submit"
                          className="rounded-full bg-[#BE185D] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#9D174D]"
                        >
                          Approve
                        </button>
                      </form>
                    ) : null}
                    <form action={updateAutomationActionStatusAction}>
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="status" value="completed" />
                      <input
                        type="hidden"
                        name="returnTo"
                        value="/app/aria/operations"
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                      >
                        Mark done
                      </button>
                    </form>
                    <form
                      action={updateAutomationActionStatusAction}
                      className="flex flex-wrap items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-1"
                    >
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="status" value="snoozed" />
                      <input
                        type="hidden"
                        name="returnTo"
                        value="/app/aria/operations"
                      />
                      <select
                        name="snoozePreset"
                        defaultValue="tomorrow"
                        className="rounded-full border border-amber-200 bg-white px-2 py-1 text-xs font-semibold text-amber-800"
                      >
                        <option value="tomorrow">Tomorrow</option>
                        <option value="three_days">3 days</option>
                        <option value="next_week">Next week</option>
                      </select>
                      <button
                        type="submit"
                        className="rounded-full px-2 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                      >
                        Snooze
                      </button>
                    </form>
                    <form action={updateAutomationActionStatusAction}>
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="status" value="skipped" />
                      <input
                        type="hidden"
                        name="returnTo"
                        value="/app/aria/operations"
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        Skip
                      </button>
                    </form>
                    <form action={updateAutomationActionStatusAction}>
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="status" value="dismissed" />
                      <input
                        type="hidden"
                        name="returnTo"
                        value="/app/aria/operations"
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100"
                      >
                        Dismiss
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            </article>
          ))
        ) : (
          <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
            No ARIA automation actions are waiting for review.
          </p>
        )}
      </div>

      {snoozedActions.length ? (
        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Snoozed for later
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {snoozedActions.slice(0, 4).map((action) => (
              <div
                key={`snoozed-${action.id}`}
                className="rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-amber-100"
              >
                <span className="font-semibold text-slate-900">
                  {action.title}
                </span>
                <span className="block mt-1">
                  Returns {formatDate(action.snoozed_until)}
                </span>
                <span className="block mt-1">
                  Assigned:{" "}
                  {teamMemberLabel(
                    teamMemberById.get(action.assigned_to ?? ""),
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function isActiveAutomationAction(action: AutomationActionRow, now: Date) {
  const status = action.status ?? "";

  if (["suggested", "drafted", "approved", "queued"].includes(status)) {
    return true;
  }

  if (status === "snoozed") {
    if (!action.snoozed_until) return true;
    return new Date(action.snoozed_until) <= now;
  }

  return false;
}

function getActionResolvedAt(action: AutomationActionRow) {
  if (action.status === "completed")
    return action.completed_at ?? action.reviewed_at ?? action.created_at;
  if (action.status === "dismissed")
    return action.dismissed_at ?? action.reviewed_at ?? action.created_at;
  if (action.status === "skipped")
    return action.skipped_at ?? action.reviewed_at ?? action.created_at;
  if (action.status === "approved")
    return action.approved_at ?? action.reviewed_at ?? action.created_at;
  return action.reviewed_at ?? action.created_at;
}

function AriaActionSourceExpansionPanel({
  signalCount,
}: {
  signalCount: number;
}) {
  return (
    <section className="rounded-[28px] border border-[#F9A8D4] bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            Refresh ARIA recommendations
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Turn live operations signals into reviewable work
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            ARIA can now create persistent action records from payment
            exceptions, membership risk, booking request aging, package renewal
            risk, stale students, intro follow-up gaps, and organizer event
            issues. Existing open actions are deduped so repeated clicks do not
            flood the queue.
          </p>
        </div>
        <form
          action={generateAriaOperationalActionsAction}
          className="flex flex-col gap-2 sm:items-end"
        >
          <input type="hidden" name="returnTo" value="/app/aria/operations" />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#BE185D] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#9D174D]"
          >
            Generate ARIA actions
            <Sparkles className="h-4 w-4" />
          </button>
          <span className="text-xs text-slate-500">
            {signalCount} live signal{signalCount === 1 ? "" : "s"} visible
            before dedupe.
          </span>
        </form>
      </div>
    </section>
  );
}

const ARIA_EMAIL_EXECUTABLE_RULE_KEYS = new Set([
  "aria_low_package_balance",
  "aria_stale_active_student",
  "aria_intro_no_purchase",
  "aria_membership_past_due",
  "aria_membership_canceling",
]);

function AriaExecutionPanel({ actions }: { actions: AutomationActionRow[] }) {
  const approvedActions = actions.filter(
    (action) => action.status === "approved",
  );
  const executableApproved = approvedActions.filter((action) =>
    ARIA_EMAIL_EXECUTABLE_RULE_KEYS.has(action.rule_key),
  );
  const staffReviewApproved =
    approvedActions.length - executableApproved.length;

  return (
    <section className="rounded-[28px] border border-emerald-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Send approved follow-ups
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Execute approved safe actions
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            ARIA can now queue approved email-safe follow-ups. Payment, booking,
            finance, and event operations stay approved for staff review instead
            of being executed automatically.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
              {executableApproved.length} executable
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
              {staffReviewApproved} staff-review only
            </span>
          </div>
        </div>
        <form
          action={executeAriaApprovedActionsAction}
          className="flex flex-col gap-2 sm:items-end"
        >
          <input type="hidden" name="returnTo" value="/app/aria/operations" />
          <button
            type="submit"
            disabled={executableApproved.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Execute approved actions
            <Sparkles className="h-4 w-4" />
          </button>
          <span className="text-xs text-slate-500">
            Queues outbound emails for approved safe actions only.
          </span>
        </form>
      </div>
    </section>
  );
}

function AriaDigestPreferencesPanel({
  preferences,
  actions,
  teamMembers,
  currentUserId,
  recentRuns,
}: {
  preferences: AriaDigestPreferencesRow | null;
  actions: AutomationActionRow[];
  teamMembers: AssignableTeamMember[];
  currentUserId: string;
  recentRuns: AriaDigestRunRow[];
}) {
  const now = new Date();
  const activeActions = actions.filter((action) =>
    isActiveAutomationAction(action, now),
  );
  const overdueActions = activeActions.filter((action) =>
    isBeforeLocalDay(action.due_at ?? action.created_at, now),
  );
  const assignedToMe = activeActions.filter(
    (action) => action.assigned_to === currentUserId,
  );
  const queuedActions = activeActions.filter(
    (action) => action.status === "queued",
  );
  const digestRecipient =
    teamMembers.find(
      (member) => member.userId === preferences?.default_recipient_user_id,
    ) ?? null;
  const defaultRecipientValue =
    preferences?.default_recipient_user_id ?? "unassigned";
  const morningEnabled = preferences?.morning_digest_enabled ?? true;
  const endOfDayEnabled = preferences?.end_of_day_digest_enabled ?? true;
  const deliveryChannel =
    preferences?.delivery_channel === "email" ? "email" : "in_app";

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            ARIA digest preferences
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Schedule daily ARIA briefing delivery
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Choose when ARIA sends the morning briefing and end-of-day
            carryover. Email digests are generated in your studio timezone,
            queued automatically, and tracked through delivery.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <span className="font-semibold text-slate-950">Recipient:</span>{" "}
          {digestRecipient ? teamMemberLabel(digestRecipient) : "Unassigned"}
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <form
          action={saveAriaDigestPreferencesAction}
          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
        >
          <input type="hidden" name="returnTo" value="/app/aria/operations" />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
              <input
                type="checkbox"
                name="morningDigestEnabled"
                defaultChecked={morningEnabled}
                className="h-4 w-4 rounded border-slate-300 text-[#BE185D]"
              />
              Morning briefing
            </label>
            <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
              <input
                type="checkbox"
                name="endOfDayDigestEnabled"
                defaultChecked={endOfDayEnabled}
                className="h-4 w-4 rounded border-slate-300 text-[#BE185D]"
              />
              End-of-day carryover
            </label>
            <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Morning time
              <input
                type="time"
                name="morningDigestTime"
                defaultValue={preferences?.morning_digest_time ?? "08:00"}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
              />
            </label>
            <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              End-of-day time
              <input
                type="time"
                name="endOfDayDigestTime"
                defaultValue={preferences?.end_of_day_digest_time ?? "17:00"}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
              />
            </label>
            <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Delivery channel
              <select
                name="deliveryChannel"
                defaultValue={deliveryChannel}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
              >
                <option value="in_app">In-app digest summary</option>
                <option value="email">Email digest</option>
              </select>
            </label>
            <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Default recipient
              <select
                name="defaultRecipientUserId"
                defaultValue={defaultRecipientValue}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-800"
              >
                <option value="unassigned">Unassigned</option>
                <option value="__me">Assign to me</option>
                {teamMembers.map((member) => (
                  <option key={`digest-${member.userId}`} value={member.userId}>
                    {member.name} • {formatRole(member.role)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="submit"
              className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Save digest preferences
            </button>
          </div>
        </form>

        <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
            Digest preview
          </p>
          <h3 className="mt-2 text-lg font-semibold text-slate-950">
            What ARIA would summarize right now
          </h3>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl bg-white px-3 py-3 ring-1 ring-violet-100">
              <p className="text-xs font-semibold text-slate-500">
                Open actions
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">
                {activeActions.length}
              </p>
            </div>
            <div className="rounded-xl bg-white px-3 py-3 ring-1 ring-violet-100">
              <p className="text-xs font-semibold text-slate-500">Overdue</p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">
                {overdueActions.length}
              </p>
            </div>
            <div className="rounded-xl bg-white px-3 py-3 ring-1 ring-violet-100">
              <p className="text-xs font-semibold text-slate-500">
                Assigned to me
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">
                {assignedToMe.length}
              </p>
            </div>
            <div className="rounded-xl bg-white px-3 py-3 ring-1 ring-violet-100">
              <p className="text-xs font-semibold text-slate-500">
                Queued follow-ups
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">
                {queuedActions.length}
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-violet-800">
            Morning digest:{" "}
            {morningEnabled
              ? (preferences?.morning_digest_time ?? "08:00")
              : "off"}
            . End-of-day digest:{" "}
            {endOfDayEnabled
              ? (preferences?.end_of_day_digest_time ?? "17:00")
              : "off"}
            . Delivery: {deliveryChannel === "email" ? "email" : "in-app"}.
          </p>
          <div className="mt-4 rounded-2xl border border-violet-100 bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Recent digest delivery runs
            </p>
            <div className="mt-3 space-y-2">
              {recentRuns.length ? (
                recentRuns.slice(0, 4).map((run) => (
                  <div
                    key={run.id}
                    className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200"
                  >
                    <span className="font-semibold text-slate-900">
                      {ariaDigestTypeLabel(run.digest_type)} •{" "}
                      {ariaDigestStatusLabel(run.status)}
                    </span>
                    <span className="mt-1 block">
                      {run.digest_date ?? "No date"} •{" "}
                      {run.delivery_channel === "email" ? "email" : "in-app"}
                      {run.recipient_email ? ` • ${run.recipient_email}` : ""}
                    </span>
                    <span className="mt-1 block">
                      Processed{" "}
                      {formatDateTime(run.processed_at ?? run.created_at)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-violet-100 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                  No scheduled digest delivery runs have been created yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


function AriaStaffOwnershipDashboard({
  actions,
  teamMembers,
  currentUserId,
}: {
  actions: AutomationActionRow[];
  teamMembers: AssignableTeamMember[];
  currentUserId: string;
}) {
  const now = new Date();
  const activeActions = actions.filter((action) =>
    isActiveAutomationAction(action, now),
  );
  const unassignedActions = activeActions.filter((action) => !action.assigned_to);
  const queuedActions = activeActions.filter((action) => action.status === "queued");
  const snoozedReturningSoon = actions.filter((action) => {
    if (action.status !== "snoozed" || !action.snoozed_until) return false;
    const snoozedUntil = new Date(action.snoozed_until);
    if (Number.isNaN(snoozedUntil.getTime())) return false;
    return snoozedUntil <= addDays(now, 3) && snoozedUntil > now;
  });
  const completedToday = actions.filter(
    (action) =>
      action.status === "completed" &&
      isSameLocalDay(getActionResolvedAt(action), now),
  );
  const teamMemberById = new Map(
    teamMembers.map((member) => [member.userId, member]),
  );
  const ownerIds = Array.from(
    new Set([
      currentUserId,
      ...teamMembers.map((member) => member.userId),
      ...activeActions
        .map((action) => action.assigned_to)
        .filter((value): value is string => Boolean(value)),
    ]),
  );
  const ownerRows = ownerIds
    .map((ownerId) => {
      const member = teamMemberById.get(ownerId);
      const ownedOpen = activeActions.filter(
        (action) => action.assigned_to === ownerId,
      );
      const overdue = ownedOpen.filter((action) =>
        isBeforeLocalDay(action.due_at ?? action.created_at, now),
      );
      const completed = completedToday.filter(
        (action) => action.assigned_to === ownerId,
      );
      const queued = queuedActions.filter((action) => action.assigned_to === ownerId);

      return {
        ownerId,
        name:
          teamMemberLabel(member) + (ownerId === currentUserId ? " (you)" : ""),
        role: formatRole(member?.role),
        openCount: ownedOpen.length,
        overdueCount: overdue.length,
        completedTodayCount: completed.length,
        queuedCount: queued.length,
      };
    })
    .filter(
      (row) =>
        row.openCount > 0 ||
        row.overdueCount > 0 ||
        row.completedTodayCount > 0 ||
        row.queuedCount > 0,
    )
    .sort((a, b) => {
      if (b.overdueCount !== a.overdueCount) return b.overdueCount - a.overdueCount;
      if (b.openCount !== a.openCount) return b.openCount - a.openCount;
      return a.name.localeCompare(b.name);
    });

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            ARIA staff ownership dashboard
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Who owns today’s ARIA work
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Track open work by owner, overdue responsibility, completed work today, queued follow-ups, unassigned actions, and snoozed work returning soon.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs font-semibold sm:grid-cols-3">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
            {activeActions.length} open
          </span>
          <span className="rounded-full bg-red-50 px-3 py-1 text-red-700">
            {activeActions.filter((action) => isBeforeLocalDay(action.due_at ?? action.created_at, now)).length} overdue
          </span>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
            {completedToday.length} done today
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)]">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="grid grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,0.65fr))] gap-2 border-b border-slate-200 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            <span>Owner</span>
            <span className="text-right">Open</span>
            <span className="text-right">Overdue</span>
            <span className="text-right">Queued</span>
            <span className="text-right">Done</span>
          </div>
          <div className="mt-2 divide-y divide-slate-200">
            {ownerRows.length ? (
              ownerRows.map((row) => (
                <div
                  key={`owner-${row.ownerId}`}
                  className="grid grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,0.65fr))] gap-2 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-950">{row.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{row.role}</p>
                  </div>
                  <span className="text-right font-semibold text-slate-800">{row.openCount}</span>
                  <span className="text-right font-semibold text-red-700">{row.overdueCount}</span>
                  <span className="text-right font-semibold text-emerald-700">{row.queuedCount}</span>
                  <span className="text-right font-semibold text-slate-800">{row.completedTodayCount}</span>
                </div>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-4 text-sm text-slate-500">
                No owned ARIA actions are currently active.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">
              Unassigned actions
            </p>
            <p className="mt-2 text-3xl font-semibold text-amber-950">
              {unassignedActions.length}
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-800">
              Assign these before the team assumes someone else owns them.
            </p>
          </div>
          <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
              Snoozed returning soon
            </p>
            <p className="mt-2 text-3xl font-semibold text-violet-950">
              {snoozedReturningSoon.length}
            </p>
            <p className="mt-1 text-xs leading-5 text-violet-800">
              Actions scheduled to re-enter the queue within the next three days.
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Queued follow-ups
            </p>
            <p className="mt-2 text-3xl font-semibold text-emerald-950">
              {queuedActions.length}
            </p>
            <p className="mt-1 text-xs leading-5 text-emerald-800">
              ARIA-approved follow-ups now waiting in the outbound delivery queue.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function AriaDailyOpsReview({
  actions,
  teamMembers,
  currentUserId,
  urgentCount,
  warningCount,
  revenueRecoveryCount,
  retentionRiskCount,
}: {
  actions: AutomationActionRow[];
  teamMembers: AssignableTeamMember[];
  currentUserId: string;
  urgentCount: number;
  warningCount: number;
  revenueRecoveryCount: number;
  retentionRiskCount: number;
}) {
  const now = new Date();
  const activeActions = actions.filter((action) =>
    isActiveAutomationAction(action, now),
  );
  const assignedToMe = activeActions.filter(
    (action) => action.assigned_to === currentUserId,
  );
  const overdueActions = activeActions.filter((action) =>
    isBeforeLocalDay(action.due_at ?? action.created_at, now),
  );
  const returningToday = actions.filter(
    (action) =>
      action.status === "snoozed" && isSameLocalDay(action.snoozed_until, now),
  );
  const completedToday = actions.filter(
    (action) =>
      action.status === "completed" &&
      isSameLocalDay(getActionResolvedAt(action), now),
  );
  const clearedToday = actions.filter(
    (action) =>
      ["dismissed", "skipped"].includes(action.status ?? "") &&
      isSameLocalDay(getActionResolvedAt(action), now),
  );
  const carryoverActions = activeActions
    .filter((action) => action.status !== "snoozed")
    .slice(0, 5);
  const teamMemberById = new Map(
    teamMembers.map((member) => [member.userId, member]),
  );
  const topRevenueAction = activeActions.find((action) =>
    [
      "low_package_balance",
      "payment_exception",
      "membership_past_due",
      "membership_canceling",
    ].some((key) => action.rule_key.includes(key)),
  );
  const topRetentionAction = activeActions.find((action) =>
    [
      "no_upcoming_lesson",
      "first_lesson_follow_up",
      "intro_no_purchase",
      "stale_active_student",
    ].some((key) => action.rule_key.includes(key)),
  );

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
            ARIA daily ops review
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Today’s briefing and end-of-day carryover
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            ARIA turns the action lifecycle into a working daily review: what is
            overdue, what belongs to you, what returned from snooze, what got
            cleared today, and what should roll into tomorrow.
          </p>
        </div>
        <Link
          href="/app/aria/operations"
          className="inline-flex w-fit items-center justify-center gap-2 rounded-2xl border border-[#F9A8D4] bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] hover:bg-[#FDF2F8]"
        >
          Refresh briefing
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-xs font-semibold uppercase tracking-[0.14em]">
              Overdue
            </p>
          </div>
          <p className="mt-2 text-2xl font-semibold text-red-950">
            {overdueActions.length}
          </p>
          <p className="mt-1 text-xs leading-5 text-red-700">
            Open ARIA actions older than their due date.
          </p>
        </div>
        <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <div className="flex items-center gap-2 text-violet-700">
            <Users className="h-4 w-4" />
            <p className="text-xs font-semibold uppercase tracking-[0.14em]">
              Assigned to me
            </p>
          </div>
          <p className="mt-2 text-2xl font-semibold text-violet-950">
            {assignedToMe.length}
          </p>
          <p className="mt-1 text-xs leading-5 text-violet-700">
            Your owned open actions for today.
          </p>
        </div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-amber-700">
            <Clock3 className="h-4 w-4" />
            <p className="text-xs font-semibold uppercase tracking-[0.14em]">
              Returning today
            </p>
          </div>
          <p className="mt-2 text-2xl font-semibold text-amber-950">
            {returningToday.length}
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-700">
            Snoozed actions back on the radar.
          </p>
        </div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            <p className="text-xs font-semibold uppercase tracking-[0.14em]">
              Cleared today
            </p>
          </div>
          <p className="mt-2 text-2xl font-semibold text-emerald-950">
            {completedToday.length + clearedToday.length}
          </p>
          <p className="mt-1 text-xs leading-5 text-emerald-700">
            Completed, skipped, or dismissed actions.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Top revenue recovery
          </p>
          <h3 className="mt-2 text-base font-semibold text-slate-950">
            {topRevenueAction?.title ??
              (revenueRecoveryCount
                ? "Review revenue recovery cards."
                : "No revenue action is standing out.")}
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {topRevenueAction?.body ??
              `${revenueRecoveryCount} revenue recovery signal${revenueRecoveryCount === 1 ? "" : "s"} are currently visible in the operations cards.`}
          </p>
          <Link
            href={
              topRevenueAction
                ? relatedAutomationHref(topRevenueAction)
                : "/app/packages/client-balances"
            }
            className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#BE185D] hover:underline"
          >
            Open revenue work
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Top retention item
          </p>
          <h3 className="mt-2 text-base font-semibold text-slate-950">
            {topRetentionAction?.title ??
              (retentionRiskCount
                ? "Review retention risk cards."
                : "Student momentum looks covered.")}
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {topRetentionAction?.body ??
              `${retentionRiskCount} retention signal${retentionRiskCount === 1 ? "" : "s"} are currently visible from recent lessons, future bookings, and intro follow-up.`}
          </p>
          <Link
            href={
              topRetentionAction
                ? relatedAutomationHref(topRetentionAction)
                : "/app/analytics?range=90"
            }
            className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#BE185D] hover:underline"
          >
            Open retention work
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            End-of-day carryover
          </p>
          <div className="mt-3 space-y-2">
            {carryoverActions.length ? (
              carryoverActions.map((action) => (
                <Link
                  key={`carry-${action.id}`}
                  href={relatedAutomationHref(action)}
                  className="block rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  <span className="font-semibold text-slate-900">
                    {action.title}
                  </span>
                  <span className="mt-1 block">
                    {automationStatusLabel(action.status)} • Assigned:{" "}
                    {teamMemberLabel(
                      teamMemberById.get(action.assigned_to ?? ""),
                    )}
                  </span>
                  <span className="mt-1 block">
                    Due {formatDateTime(action.due_at ?? action.created_at)}
                  </span>
                </Link>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-4 text-sm text-slate-500">
                No open ARIA actions need to roll into tomorrow.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
          Today’s operational load
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          ARIA sees {urgentCount} urgent signal{urgentCount === 1 ? "" : "s"},{" "}
          {warningCount} follow-up signal{warningCount === 1 ? "" : "s"},{" "}
          {activeActions.length} open action
          {activeActions.length === 1 ? "" : "s"}, and {completedToday.length}{" "}
          completed action{completedToday.length === 1 ? "" : "s"} today.
        </p>
      </div>
    </section>
  );
}

export default async function AriaOperationsCenterPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const organizerWorkspace = isOrganizerRole(context.studioRole);
  const now = new Date();
  const nowIso = now.toISOString();
  const ninetyDaysAgoIso = addDays(now, -90).toISOString();
  const nextFourteenDaysIso = addDays(now, 14).toISOString();
  const teamMembers = await getAssignableTeamMembers({
    supabase,
    studioId,
    includeOrganizerUsers: organizerWorkspace,
    currentUserId: context.userId,
    currentUserEmail: context.email ?? null,
  });
  const [
    ariaPoliciesResult,
    ariaDigestPreferencesResult,
    ariaDigestRunsResult,
  ] = await Promise.all([
    supabase
      .from("aria_action_policies")
      .select(
        "rule_key, enabled, auto_approve, max_auto_approve_priority, default_assigned_to, require_assignment, updated_at",
      )
      .eq("studio_id", studioId),
    supabase
      .from("aria_digest_preferences")
      .select(
        "studio_id, morning_digest_enabled, end_of_day_digest_enabled, delivery_channel, default_recipient_user_id, morning_digest_time, end_of_day_digest_time, updated_at",
      )
      .eq("studio_id", studioId)
      .maybeSingle(),
    supabase
      .from("aria_digest_runs")
      .select(
        "id, digest_type, digest_date, delivery_channel, recipient_email, status, summary, processed_at, created_at",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  if (ariaPoliciesResult.error) {
    throw new Error(
      `Failed to load ARIA action policies: ${ariaPoliciesResult.error.message}`,
    );
  }

  if (ariaDigestPreferencesResult.error) {
    throw new Error(
      `Failed to load ARIA digest preferences: ${ariaDigestPreferencesResult.error.message}`,
    );
  }

  if (ariaDigestRunsResult.error) {
    throw new Error(
      `Failed to load ARIA digest runs: ${ariaDigestRunsResult.error.message}`,
    );
  }

  const ariaActionPolicies = (ariaPoliciesResult.data ??
    []) as AriaActionPolicyRow[];
  const ariaDigestPreferences = (ariaDigestPreferencesResult.data ??
    null) as AriaDigestPreferencesRow | null;
  const ariaDigestRuns = (ariaDigestRunsResult.data ??
    []) as AriaDigestRunRow[];

  if (organizerWorkspace) {
    const { data: eventsData, error: eventsError } = await supabase
      .from("events")
      .select("id, name, slug, status, start_date, end_date")
      .eq("studio_id", studioId)
      .order("start_date", { ascending: true })
      .limit(250);

    if (eventsError)
      throw new Error(
        `Failed to load ARIA operations events: ${eventsError.message}`,
      );

    const events = (eventsData ?? []) as OrganizerEventRow[];
    const eventIds = events.map((event) => event.id);

    let registrations: OrganizerRegistrationRow[] = [];
    let tickets: OrganizerTicketRow[] = [];
    let profitability: OrganizerProfitabilityRow[] = [];

    if (eventIds.length > 0) {
      const [registrationsResult, ticketsResult, profitabilityResult] =
        await Promise.all([
          supabase
            .from("event_registrations")
            .select("id,event_id,status,payment_status,quantity")
            .in("event_id", eventIds),
          supabase
            .from("event_registration_attendees")
            .select("id,event_id,checked_in_at")
            .in("event_id", eventIds)
            .limit(10000),
          supabase
            .from("v_event_profit_loss")
            .select(
              "event_id,net_ticket_revenue,event_profit_loss,event_expenses,event_labor_costs",
            )
            .in("event_id", eventIds),
        ]);

      if (registrationsResult.error)
        throw new Error(
          `Failed to load event registrations: ${registrationsResult.error.message}`,
        );
      registrations = (registrationsResult.data ??
        []) as OrganizerRegistrationRow[];
      tickets = ticketsResult.error
        ? []
        : ((ticketsResult.data ?? []) as OrganizerTicketRow[]);
      profitability = profitabilityResult.error
        ? []
        : ((profitabilityResult.data ?? []) as OrganizerProfitabilityRow[]);
    }

    const registrationsByEventId = new Map<
      string,
      OrganizerRegistrationRow[]
    >();
    for (const registration of registrations) {
      if (!registration.event_id) continue;
      const current = registrationsByEventId.get(registration.event_id) ?? [];
      current.push(registration);
      registrationsByEventId.set(registration.event_id, current);
    }

    const ticketsByEventId = new Map<string, OrganizerTicketRow[]>();
    for (const ticket of tickets) {
      if (!ticket.event_id) continue;
      const current = ticketsByEventId.get(ticket.event_id) ?? [];
      current.push(ticket);
      ticketsByEventId.set(ticket.event_id, current);
    }

    const profitByEventId = new Map<string, OrganizerProfitabilityRow>();
    for (const row of profitability) {
      if (row.event_id) profitByEventId.set(row.event_id, row);
    }

    const eventHealth = events.map((event) => {
      const eventRegistrations = registrationsByEventId.get(event.id) ?? [];
      const eventTickets = ticketsByEventId.get(event.id) ?? [];
      const profit = profitByEventId.get(event.id);
      const ticketsIssued =
        eventTickets.length ||
        eventRegistrations.reduce(
          (sum, registration) =>
            sum + Math.max(1, asNumber(registration.quantity ?? 1)),
          0,
        );
      const checkedIn = eventTickets.filter(
        (ticket) => ticket.checked_in_at,
      ).length;
      const startDate = new Date(`${event.start_date}T00:00:00`);
      const isPast = !Number.isNaN(startDate.getTime()) && startDate < now;

      return {
        event,
        registrations: eventRegistrations.length,
        unpaid: eventRegistrations.filter((row) =>
          ["pending", "unpaid", "failed"].includes(row.payment_status ?? ""),
        ).length,
        ticketsIssued,
        checkedIn,
        checkInRate: ticketsIssued ? checkedIn / ticketsIssued : null,
        isPast,
        netRevenue: asNumber(profit?.net_ticket_revenue),
        profitLoss: asNumber(profit?.event_profit_loss),
        missingCosts:
          asNumber(profit?.net_ticket_revenue) > 0 &&
          (asNumber(profit?.event_expenses) <= 0 ||
            asNumber(profit?.event_labor_costs) <= 0),
      };
    });

    const unpaidEvents = eventHealth.filter((row) => row.unpaid > 0);
    const pastLowCheckInEvents = eventHealth.filter(
      (row) =>
        row.isPast && row.ticketsIssued > 0 && (row.checkInRate ?? 1) < 0.75,
    );
    const lossEvents = eventHealth.filter((row) => row.profitLoss < 0);
    const missingCostEvents = eventHealth.filter((row) => row.missingCosts);
    const upcomingEvents = eventHealth.filter((row) => !row.isPast).slice(0, 5);

    const operations: OperationItem[] = [
      {
        key: "event-payments",
        title: "Registration payments need review",
        metric: `${unpaidEvents.length}`,
        detail: unpaidEvents.length
          ? "Some events have pending, unpaid, or failed registrations that should be cleaned up before event day."
          : "No registration payment exceptions are standing out right now.",
        href: unpaidEvents[0]
          ? `/app/events/${unpaidEvents[0].event.id}/registrations`
          : "/app/events/registrations",
        actionLabel: "Review registrations",
        tone: unpaidEvents.length ? "urgent" : "success",
        icon: CreditCard,
      },
      {
        key: "event-checkin",
        title: "Check-in quality",
        metric: `${pastLowCheckInEvents.length}`,
        detail: pastLowCheckInEvents.length
          ? "Completed events with low check-in rates may need attendance cleanup or no-show follow-up."
          : "Completed event check-in rates look clean based on available ticket scans.",
        href: pastLowCheckInEvents[0]
          ? `/app/events/${pastLowCheckInEvents[0].event.id}/check-in`
          : "/app/events/checkin",
        actionLabel: "Review check-in",
        tone: pastLowCheckInEvents.length ? "warning" : "success",
        icon: CheckCircle2,
      },
      {
        key: "event-profitability",
        title: "Profitability exceptions",
        metric: `${lossEvents.length}`,
        detail: lossEvents.length
          ? "ARIA found events below break-even. Review pricing, labor, expenses, refunds, and fees before repeating those formats."
          : "No event losses are standing out in the available event profitability data.",
        href: lossEvents[0]
          ? `/app/events/${lossEvents[0].event.id}`
          : "/app/reports",
        actionLabel: "Review event finance",
        tone: lossEvents.length ? "urgent" : "success",
        icon: Wallet,
      },
      {
        key: "event-costs",
        title: "Missing event costs",
        metric: `${missingCostEvents.length}`,
        detail: missingCostEvents.length
          ? "Some revenue-generating events have missing expenses or labor costs. Add them before trusting final profit."
          : "Event cost attribution looks ready for stronger profit/loss reporting.",
        href: missingCostEvents[0]
          ? `/app/events/${missingCostEvents[0].event.id}`
          : "/app/expenses",
        actionLabel: "Add or review costs",
        tone: missingCostEvents.length ? "warning" : "success",
        icon: ClipboardList,
      },
    ];

    const nextBest = unpaidEvents[0]
      ? {
          title: "Clean up registration payment exceptions first.",
          insight: `${unpaidEvents.length} event${unpaidEvents.length === 1 ? " has" : "s have"} unpaid or pending registrations.`,
          recommendation:
            "Start with the closest upcoming event, confirm payment status, and resolve failed or pending registrations before check-in opens.",
          metric: `${unpaidEvents.length} exception${unpaidEvents.length === 1 ? "" : "s"}`,
          href: `/app/events/${unpaidEvents[0].event.id}/registrations`,
          label: "Open registrations",
        }
      : lossEvents[0]
        ? {
            title: "Review event losses before repeating them.",
            insight: `${lossEvents.length} event${lossEvents.length === 1 ? " is" : "s are"} currently below break-even.`,
            recommendation:
              "Check the event P&L details, especially labor, refunds, and expenses, before using the same pricing again.",
            metric: `${lossEvents.length} loss event${lossEvents.length === 1 ? "" : "s"}`,
            href: `/app/events/${lossEvents[0].event.id}`,
            label: "Open event",
          }
        : {
            title: "Organizer operations are stable.",
            insight:
              "ARIA did not find an urgent organizer operations issue in the current event data.",
            recommendation:
              "Keep check-in, settlement, expenses, and registration payment status current so ARIA can keep surfacing better next moves.",
            metric: "Stable",
            href: "/app/events",
            label: "Open events",
          };

    const {
      data: organizerAutomationActionsData,
      error: organizerAutomationActionsError,
    } = await supabase
      .from("automation_actions")
      .select(
        "id, rule_key, title, body, status, priority, related_table, related_id, client_id, due_at, created_at, reviewed_at, approved_at, completed_at, dismissed_at, skipped_at, snoozed_until, review_note, assigned_to",
      )
      .eq("studio_id", studioId)
      .in("status", [
        "suggested",
        "drafted",
        "approved",
        "queued",
        "snoozed",
        "completed",
        "dismissed",
        "skipped",
      ])
      .order("created_at", { ascending: false })
      .limit(100);

    if (organizerAutomationActionsError) {
      throw new Error(
        `Failed to load organizer ARIA actions: ${organizerAutomationActionsError.message}`,
      );
    }

    const organizerAutomationActions = (organizerAutomationActionsData ??
      []) as AutomationActionRow[];
    const organizerSignalCount =
      unpaidEvents.length +
      pastLowCheckInEvents.length +
      lossEvents.length +
      missingCostEvents.length;
    const organizerUrgentCount = unpaidEvents.length + lossEvents.length;
    const organizerWarningCount =
      pastLowCheckInEvents.length + missingCostEvents.length;

    return (
      <main className="space-y-8 p-6 md:p-8">
        <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
          <div className="relative p-6 md:p-8">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
            <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
              <AriaAvatar size="lg" />
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#BE185D]">
                  ARIA Operations Center
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                  Organizer action center
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                  ARIA reviews registrations, check-ins, event costs, and event
                  profitability so your team knows what needs attention before
                  and after event day.
                </p>
              </div>
              <Link
                href="/app/aria"
                className="inline-flex items-center justify-center rounded-2xl border border-[#F9A8D4] bg-white px-4 py-3 text-sm font-semibold text-[#BE185D] hover:bg-[#FDF2F8]"
              >
                Back to ARIA
              </Link>
            </div>
          </div>
        </section>

        <AriaInsightCard
          eyebrow="ARIA's operations priority"
          title={nextBest.title}
          insight={nextBest.insight}
          recommendation={nextBest.recommendation}
          metric={nextBest.metric}
          primaryAction={{ href: nextBest.href, label: nextBest.label }}
          secondaryAction={{ href: "/app/reports", label: "Open reports" }}
        />

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {operations.map((item) => (
            <OperationCard key={item.key} item={item} />
          ))}
        </section>

        <AriaDailyOpsReview
          actions={organizerAutomationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
          urgentCount={organizerUrgentCount}
          warningCount={organizerWarningCount}
          revenueRecoveryCount={organizerSignalCount}
          retentionRiskCount={pastLowCheckInEvents.length}
        />

        <AriaStaffOwnershipDashboard
          actions={organizerAutomationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
        />

        <AriaActionReviewQueue
          actions={organizerAutomationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
        />

        <AriaExecutionPanel actions={organizerAutomationActions} />

        <MiniList
          title="Upcoming organizer events"
          empty="No upcoming organizer events found."
          items={upcomingEvents.map((row) => ({
            label: row.event.name,
            detail: `${formatDate(row.event.start_date)} • ${row.registrations} registrations • ${row.unpaid} payment exceptions`,
            href: `/app/events/${row.event.id}`,
          }))}
        />

        <CollapsibleOperationsBlock
          eyebrow="4. Preferences and safeguards"
          title="Choose what ARIA may handle and how you receive updates"
          description="Adjust recommendation policies, team ownership, approval limits, and daily summaries. These settings stay out of the way of your day-to-day action list."
        >
          <AriaActionSourceExpansionPanel signalCount={organizerSignalCount} />

          <AriaDigestPreferencesPanel
            preferences={ariaDigestPreferences}
            actions={organizerAutomationActions}
            teamMembers={teamMembers}
            currentUserId={context.userId}
            recentRuns={ariaDigestRuns}
          />

          <AriaActionPolicyPanel
            policies={ariaActionPolicies}
            teamMembers={teamMembers}
            currentUserId={context.userId}
            organizerWorkspace={organizerWorkspace}
          />
        </CollapsibleOperationsBlock>
      </main>
    );
  }

  const [
    clientsResult,
    recentAppointmentsResult,
    futureAppointmentsResult,
    packagesResult,
    membershipsResult,
    bookingRequestsResult,
    paymentsResult,
    automationActionsResult,
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, status, created_at")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead"])
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("appointments")
      .select(
        "id, client_id, appointment_type, status, starts_at, payment_status",
      )
      .eq("studio_id", studioId)
      .gte("starts_at", ninetyDaysAgoIso)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1000),
    supabase
      .from("appointments")
      .select(
        "id, client_id, appointment_type, status, starts_at, payment_status",
      )
      .eq("studio_id", studioId)
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(1000),
    supabase
      .from("client_packages")
      .select(
        "id, client_id, name_snapshot, active, expiration_date, purchase_date, created_at, client_package_items ( quantity_remaining, is_unlimited )",
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(1000),
    supabase
      .from("client_memberships")
      .select(
        "id, client_id, name_snapshot, status, current_period_end, cancel_at_period_end, created_at",
      )
      .eq("studio_id", studioId)
      .in("status", ["active", "pending", "past_due", "unpaid"])
      .limit(1000),
    supabase
      .from("booking_requests")
      .select(
        "id, status, customer_first_name, customer_last_name, customer_email, requested_starts_at, created_at",
      )
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50),
    supabase
      .from("payments")
      .select(
        "id, amount, status, payment_type, payment_channel, source, created_at, clients ( first_name, last_name )",
      )
      .eq("studio_id", studioId)
      .in("status", ["pending", "failed"])
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("automation_actions")
      .select(
        "id, rule_key, title, body, status, priority, related_table, related_id, client_id, due_at, created_at, reviewed_at, approved_at, completed_at, dismissed_at, skipped_at, snoozed_until, review_note, assigned_to",
      )
      .eq("studio_id", studioId)
      .in("status", [
        "suggested",
        "drafted",
        "approved",
        "queued",
        "snoozed",
        "completed",
        "dismissed",
        "skipped",
      ])
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (clientsResult.error)
    throw new Error(
      `Failed to load ARIA clients: ${clientsResult.error.message}`,
    );
  if (recentAppointmentsResult.error)
    throw new Error(
      `Failed to load recent appointments: ${recentAppointmentsResult.error.message}`,
    );
  if (futureAppointmentsResult.error)
    throw new Error(
      `Failed to load future appointments: ${futureAppointmentsResult.error.message}`,
    );
  if (packagesResult.error)
    throw new Error(`Failed to load packages: ${packagesResult.error.message}`);
  if (membershipsResult.error)
    throw new Error(
      `Failed to load memberships: ${membershipsResult.error.message}`,
    );
  if (bookingRequestsResult.error)
    throw new Error(
      `Failed to load booking requests: ${bookingRequestsResult.error.message}`,
    );
  if (paymentsResult.error)
    throw new Error(`Failed to load payments: ${paymentsResult.error.message}`);
  if (automationActionsResult.error)
    throw new Error(
      `Failed to load automation actions: ${automationActionsResult.error.message}`,
    );

  const clients = (clientsResult.data ?? []) as ClientRow[];
  const recentAppointments = (recentAppointmentsResult.data ??
    []) as AppointmentRow[];
  const futureAppointments = (futureAppointmentsResult.data ??
    []) as AppointmentRow[];
  const packages = (packagesResult.data ?? []) as ClientPackageRow[];
  const memberships = (membershipsResult.data ?? []) as ClientMembershipRow[];
  const bookingRequests = (bookingRequestsResult.data ??
    []) as BookingRequestRow[];
  const paymentExceptions = (paymentsResult.data ?? []) as PaymentRow[];
  const automationActions = (automationActionsResult.data ??
    []) as AutomationActionRow[];

  const clientById = new Map(clients.map((client) => [client.id, client]));
  const activeClients = clients.filter((client) => client.status === "active");
  const leadClients = clients.filter((client) => client.status === "lead");

  const validRecentAppointments = recentAppointments.filter(
    (appointment) => !isCanceledStatus(appointment.status),
  );
  const validFutureAppointments = futureAppointments.filter(
    (appointment) => !isCanceledStatus(appointment.status),
  );
  const futureClientIds = new Set(
    validFutureAppointments
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );
  const recentClientIds = new Set(
    validRecentAppointments
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );

  const rebookingClients = activeClients.filter(
    (client) =>
      recentClientIds.has(client.id) && !futureClientIds.has(client.id),
  );
  const staleActiveClients = activeClients.filter((client) => {
    const clientAppointments = validRecentAppointments.filter(
      (appointment) => appointment.client_id === client.id,
    );
    if (!clientAppointments.length) return false;
    const latest = clientAppointments[0];
    return (
      daysBetween(new Date(latest.starts_at), now) >= 14 &&
      !futureClientIds.has(client.id)
    );
  });

  const lowBalancePackages = packages.filter((pkg) => {
    const remaining = lowestRemainingPackageCredit(pkg);
    return typeof remaining === "number" && remaining <= 2;
  });
  const expiringPackages = packages.filter((pkg) => {
    if (!pkg.expiration_date) return false;
    const expiration = new Date(`${pkg.expiration_date}T00:00:00`);
    return expiration >= now && expiration <= new Date(nextFourteenDaysIso);
  });
  const pastDueMemberships = memberships.filter(
    (membership) =>
      membership.status === "past_due" || membership.status === "unpaid",
  );
  const cancelingMemberships = memberships.filter(
    (membership) => membership.cancel_at_period_end,
  );
  const membershipsEndingSoon = memberships.filter((membership) => {
    if (!membership.current_period_end) return false;
    const end = new Date(`${membership.current_period_end}T00:00:00`);
    return end >= now && end <= new Date(nextFourteenDaysIso);
  });

  const completedIntroClientIds = new Set(
    validRecentAppointments
      .filter(
        (appointment) =>
          appointment.client_id &&
          isIntroAppointmentType(appointment.appointment_type) &&
          isCompletedStatus(appointment.status),
      )
      .map((appointment) => appointment.client_id as string),
  );
  const packageClientIds = new Set(
    packages
      .map((pkg) => pkg.client_id)
      .filter((id): id is string => Boolean(id)),
  );
  const membershipClientIds = new Set(
    memberships
      .map((membership) => membership.client_id)
      .filter((id): id is string => Boolean(id)),
  );
  const introNoPurchaseClients = activeClients.filter(
    (client) =>
      completedIntroClientIds.has(client.id) &&
      !packageClientIds.has(client.id) &&
      !membershipClientIds.has(client.id),
  );
  const staleLeads = leadClients.filter(
    (client) =>
      daysBetween(new Date(client.created_at), now) >= 3 &&
      !futureClientIds.has(client.id),
  );

  const urgentCount = paymentExceptions.length + pastDueMemberships.length;
  const warningCount =
    bookingRequests.length +
    lowBalancePackages.length +
    staleActiveClients.length +
    staleLeads.length;
  const revenueRecoveryCount =
    paymentExceptions.length +
    lowBalancePackages.length +
    expiringPackages.length +
    pastDueMemberships.length +
    cancelingMemberships.length +
    membershipsEndingSoon.length;
  const retentionRiskCount =
    staleActiveClients.length +
    rebookingClients.length +
    introNoPurchaseClients.length;

  const operations: OperationItem[] = [
    {
      key: "booking-requests",
      title: "Booking requests",
      metric: `${bookingRequests.length}`,
      detail: bookingRequests.length
        ? "Pending booking requests should be handled before interested dancers lose momentum."
        : "No pending booking requests are waiting for review.",
      href: "/app/schedule/requests?status=pending",
      actionLabel: "Review requests",
      tone: bookingRequests.length ? "urgent" : "success",
      icon: ClipboardList,
    },
    {
      key: "payment-exceptions",
      title: "Payment exceptions",
      metric: `${paymentExceptions.length}`,
      detail: paymentExceptions.length
        ? "Pending and failed payments need follow-up before closeout and revenue reporting are trusted."
        : "No pending or failed payment exceptions are standing out right now.",
      href: "/app/payments?status=pending",
      actionLabel: "Review payments",
      tone: paymentExceptions.length ? "urgent" : "success",
      icon: CreditCard,
    },
    {
      key: "package-renewals",
      title: "Package renewal risk",
      metric: `${lowBalancePackages.length}`,
      detail: lowBalancePackages.length
        ? "Clients with two or fewer credits remaining are prime renewal opportunities."
        : "Package balances look healthy based on available credit rows.",
      href: "/app/packages/client-balances",
      actionLabel: "Review balances",
      tone: lowBalancePackages.length ? "warning" : "success",
      icon: Package,
    },
    {
      key: "retention-risk",
      title: "Rebooking risk",
      metric: `${retentionRiskCount}`,
      detail: retentionRiskCount
        ? "ARIA found active students or completed intros that need a next-step conversation."
        : "Recent student activity has future booking coverage.",
      href: "/app/analytics?range=90",
      actionLabel: "Review retention",
      tone: retentionRiskCount ? "warning" : "success",
      icon: Users,
    },
    {
      key: "memberships",
      title: "Membership attention",
      metric: `${pastDueMemberships.length + cancelingMemberships.length}`,
      detail:
        pastDueMemberships.length || cancelingMemberships.length
          ? "Past-due, unpaid, or canceling memberships deserve quick follow-up."
          : "Membership billing and cancellation states look stable.",
      href: pastDueMemberships.length
        ? "/app/memberships?status=past_due"
        : "/app/memberships?status=canceling",
      actionLabel: "Review memberships",
      tone: pastDueMemberships.length
        ? "urgent"
        : cancelingMemberships.length
          ? "warning"
          : "success",
      icon: Wallet,
    },
    {
      key: "automation-actions",
      title: "Drafted ARIA actions",
      metric: `${automationActions.length}`,
      detail: automationActions.length
        ? "ARIA has suggested or drafted automation actions ready for staff review."
        : "No drafted automation actions are waiting. Enable rules to let ARIA prepare more follow-ups.",
      href: "/app/automations",
      actionLabel: "Open automations",
      tone: automationActions.length ? "info" : "success",
      icon: BellRing,
    },
  ];

  const nextBest = bookingRequests[0]
    ? {
        title: "Handle booking requests first.",
        insight: `${bookingRequests.length} request${bookingRequests.length === 1 ? " is" : "s are"} waiting for staff review.`,
        recommendation:
          "Approve, decline, or contact the requester while their intent is fresh.",
        metric: `${bookingRequests.length} pending`,
        href: "/app/schedule/requests?status=pending",
        label: "Review requests",
      }
    : paymentExceptions[0]
      ? {
          title: "Clean up payment exceptions.",
          insight: `${paymentExceptions.length} payment${paymentExceptions.length === 1 ? " needs" : "s need"} follow-up.`,
          recommendation:
            "Resolve pending or failed payments before relying on closeout and revenue reporting.",
          metric: `${paymentExceptions.length} exception${paymentExceptions.length === 1 ? "" : "s"}`,
          href: "/app/payments?status=pending",
          label: "Review payments",
        }
      : lowBalancePackages[0]
        ? {
            title: "Start package renewal conversations.",
            insight: `${lowBalancePackages.length} package${lowBalancePackages.length === 1 ? " has" : "s have"} two or fewer credits remaining.`,
            recommendation:
              "Reach out before the next lesson so renewal feels like a natural next step instead of an emergency. ",
            metric: `${lowBalancePackages.length} renewal lead${lowBalancePackages.length === 1 ? "" : "s"}`,
            href: "/app/packages/client-balances",
            label: "Review balances",
          }
        : retentionRiskCount
          ? {
              title: "Protect student momentum.",
              insight: `${retentionRiskCount} student follow-up${retentionRiskCount === 1 ? " is" : "s are"} worth reviewing.`,
              recommendation:
                "Prioritize students who recently attended but do not have a future booking, then review completed intros without a first purchase.",
              metric: `${retentionRiskCount} at risk`,
              href: "/app/analytics?range=90",
              label: "Review analytics",
            }
          : {
              title: "Operations are steady today.",
              insight:
                "ARIA did not find an urgent booking, payment, package, or retention issue in the current live data.",
              recommendation:
                "Use automations to keep this rhythm consistent, then check reports for longer-term growth opportunities.",
              metric: "Stable",
              href: "/app/automations",
              label: "Review automations",
            };

  const paymentList = paymentExceptions.slice(0, 5).map((payment) => ({
    label: `${getClientName(payment.clients)} • ${formatCurrency(payment.amount)}`,
    detail: `${payment.status ?? "pending"} • ${payment.payment_type ?? "payment"} • ${formatDate(payment.created_at)}`,
    href: "/app/payments?status=pending",
  }));

  const packageList = lowBalancePackages.slice(0, 5).map((pkg) => {
    const client = pkg.client_id ? clientById.get(pkg.client_id) : null;
    const remaining = lowestRemainingPackageCredit(pkg);
    return {
      label: `${personName(client?.first_name ?? null, client?.last_name ?? null)} • ${pkg.name_snapshot ?? "Package"}`,
      detail: `${remaining ?? "Unlimited"} credits remaining${pkg.expiration_date ? ` • expires ${formatDate(pkg.expiration_date)}` : ""}`,
      href: "/app/packages/client-balances",
    };
  });

  const retentionList = staleActiveClients.slice(0, 5).map((client) => ({
    label: personName(client.first_name, client.last_name),
    detail: "Recent lesson history, but no future appointment found.",
    href: `/app/clients/${client.id}`,
  }));

  return (
    <main className="space-y-8 p-6 md:p-8">
      <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
        <div className="relative p-6 md:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
          <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
            <AriaAvatar size="lg" />
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#BE185D]">
                ARIA Operations Center
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Today’s studio action center
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                ARIA reviews bookings, payment exceptions, package balances,
                memberships, and student momentum so the team knows what needs
                attention today.
              </p>
            </div>
            <Link
              href="/app/aria"
              className="inline-flex items-center justify-center rounded-2xl border border-[#F9A8D4] bg-white px-4 py-3 text-sm font-semibold text-[#BE185D] hover:bg-[#FDF2F8]"
            >
              Back to ARIA
            </Link>
          </div>
        </div>
      </section>

      <AriaInsightCard
        eyebrow="ARIA's operations priority"
        title={nextBest.title}
        insight={nextBest.insight}
        recommendation={nextBest.recommendation}
        metric={nextBest.metric}
        primaryAction={{ href: nextBest.href, label: nextBest.label }}
        secondaryAction={{ href: "/app/reports", label: "Open reports" }}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OperationCard
          item={{
            key: "urgent",
            title: "Urgent today",
            metric: `${urgentCount}`,
            detail:
              "Payment exceptions and past-due membership issues that can affect revenue and closeout.",
            href: urgentCount
              ? "/app/payments?status=pending"
              : "/app/payments",
            actionLabel: "Review urgent work",
            tone: urgentCount ? "urgent" : "success",
            icon: AlertTriangle,
          }}
        />
        <OperationCard
          item={{
            key: "warnings",
            title: "Follow-ups",
            metric: `${warningCount}`,
            detail:
              "Booking, package, lead, and rebooking opportunities where speed matters.",
            href: "/app/analytics?range=90",
            actionLabel: "Review follow-ups",
            tone: warningCount ? "warning" : "success",
            icon: Target,
          }}
        />
        <OperationCard
          item={{
            key: "revenue",
            title: "Revenue recovery",
            metric: `${revenueRecoveryCount}`,
            detail:
              "Low balances, expiring packages, membership risks, and payment issues that deserve attention.",
            href: "/app/packages/client-balances",
            actionLabel: "Recover revenue",
            tone: revenueRecoveryCount ? "warning" : "success",
            icon: Wallet,
          }}
        />
        <OperationCard
          item={{
            key: "automations",
            title: "ARIA drafts",
            metric: `${automationActions.length}`,
            detail:
              "Suggested, approved, queued, and drafted ARIA actions prepared for staff review.",
            href: "/app/automations",
            actionLabel: "Open automations",
            tone: automationActions.length ? "info" : "success",
            icon: Sparkles,
          }}
        />
      </section>

      <CollapsibleOperationsBlock
        eyebrow="1. Today’s work"
        title="Review and handle what needs attention"
        description="Start here each day. Review ARIA’s prioritized work, approve the right next step, and clear or snooze anything that does not need action yet."
        defaultOpen
      >
        <AriaDailyOpsReview
          actions={automationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
          urgentCount={urgentCount}
          warningCount={warningCount}
          revenueRecoveryCount={revenueRecoveryCount}
          retentionRiskCount={retentionRiskCount}
        />

        <AriaActionReviewQueue
          actions={automationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
        />
      </CollapsibleOperationsBlock>

      <CollapsibleOperationsBlock
        eyebrow="2. Team follow-through"
        title="Assign work and send approved follow-ups"
        description="Give each action a clear owner, then queue the client follow-ups your team has approved."
      >
        <AriaStaffOwnershipDashboard
          actions={automationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
        />

        <AriaExecutionPanel actions={automationActions} />
      </CollapsibleOperationsBlock>

      <CollapsibleOperationsBlock
        eyebrow="3. Business details"
        title="Explore the issues behind today’s priorities"
        description="Open this section when you need the underlying payment, package, membership, booking, or retention details."
      >
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {operations.map((item) => (
            <OperationCard key={item.key} item={item} />
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <MiniList
            title="Payment exceptions"
            empty="No pending or failed payments found."
            items={paymentList}
          />
          <MiniList
            title="Package renewal list"
            empty="No low-balance packages found."
            items={packageList}
          />
          <MiniList
            title="Rebooking list"
            empty="No rebooking risks found."
            items={retentionList}
          />
        </section>
      </CollapsibleOperationsBlock>

      <CollapsibleOperationsBlock
        eyebrow="4. Preferences and safeguards"
        title="Choose what ARIA may handle and how you receive updates"
        description="Adjust recommendation policies, team ownership, approval limits, and daily summaries. These settings stay out of the way of your day-to-day action list."
      >
        <AriaActionSourceExpansionPanel
          signalCount={
            urgentCount + warningCount + revenueRecoveryCount + retentionRiskCount
          }
        />

        <AriaDigestPreferencesPanel
          preferences={ariaDigestPreferences}
          actions={automationActions}
          teamMembers={teamMembers}
          currentUserId={context.userId}
          recentRuns={ariaDigestRuns}
        />

        <AriaActionPolicyPanel
          policies={ariaActionPolicies}
          teamMembers={teamMembers}
          currentUserId={context.userId}
          organizerWorkspace={organizerWorkspace}
        />
      </CollapsibleOperationsBlock>

      <section className="rounded-[28px] border border-violet-200 bg-violet-50/70 p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              Studio follow-up
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Set recurring follow-up once, then monitor the results
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Use Automations to choose which routine client follow-ups should
              remain suggestions, become editable drafts, or send automatically
              using your studio’s approved message templates.
            </p>
          </div>
          <Link
            href="/app/automations"
            className="inline-flex items-center justify-center rounded-2xl bg-[#6B21A8] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#581C87]"
          >
            Manage automations
          </Link>
        </div>
      </section>
    </main>
  );
}
