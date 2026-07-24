import Link from "next/link";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import TodayWorkspaceHeader from "@/components/app/today/TodayWorkspaceHeader";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bell,
  Cake,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  CreditCard,
  Download,
  Layers3,
  Sparkles,
  Star,
  Ticket,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { syncStudioNotifications } from "@/lib/notifications/sync";
import { dismissPlatformBroadcastAlertAction } from "@/app/platform/actions";
import { dismissWorkspaceOnboardingAction } from "@/app/app/onboarding-actions";
import { OnboardingCompletionRecorder } from "@/app/app/OnboardingCompletionRecorder";
import type { SuggestedFollowUpItem } from "./SuggestedFollowUpsCard";
import TodayActionQueue from "@/components/app/today/TodayActionQueue";
import { loadStudioLifecycleSnapshot } from "@/lib/clients/lifecycle";
import {
  getAccessibleStudios,
  getCurrentStudioContext,
} from "@/lib/auth/studio";

type WorkspaceRow = {
  id: string;
  name: string | null;
  billing_plan: string | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  stripe_connected_account_id: string | null;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  subscription_plan_id: string | null;
  status: string | null;
  billing_interval: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  updated_at: string;
};

type SubscriptionPlanRow = {
  id: string;
  code: string;
  name: string;
};

type ClientRow = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  birthday?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

type InstructorRow = {
  id: string;
};

type WorkspaceOnboardingPreferenceRow = {
  id: string;
  dismissed_at: string | null;
  completed_at: string | null;
};

type DashboardAriaGoalRow = {
  id: string;
  title: string;
  goal_type: string;
  focus_area: string;
  target_value: number | string | null;
  current_value: number | string | null;
  target_unit: string | null;
  timeline_days: number | null;
  starts_at: string | null;
  target_date: string | null;
  status: string | null;
  plan_summary: string | null;
  updated_at: string | null;
};

type HostStudioPortalLink = {
  client_id: string;
  studio_id: string;
  studio_name: string;
  studio_slug: string;
};

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string | null;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  starts_at: string;
  status: string | null;
};

type AppointmentClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type AppointmentInstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type AppointmentRoomRow = {
  id: string;
  name: string | null;
};

type MembershipRow = {
  id: string;
  status: string | null;
};

type PackageRow = {
  id: string;
  active: boolean | null;
};

type FollowUpClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  referral_source: string | null;
  created_at: string;
};

type FollowUpAppointmentRow = {
  id: string;
  client_id: string | null;
  starts_at: string;
};

type FollowUpLeadActivityRow = {
  id: string;
  client_id: string | null;
  follow_up_due_at: string | null;
  completed_at: string | null;
};

type FollowUpPackageItemRow = {
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

type FollowUpPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  client_package_items?: FollowUpPackageItemRow[] | null;
};

type FollowUpEventRegistrationRow = {
  id: string;
  event_id: string | null;
  client_id: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  payment_status: string | null;
  created_at: string;
  events?: { name?: string | null } | { name?: string | null }[] | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  start_date: string;
  end_date: string;
  visibility: string;
  status: string;
  featured: boolean;
  public_directory_enabled: boolean;
};

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
};

type RegistrationRow = {
  id: string;
  payment_status: string | null;
};

type AttendanceRow = {
  id: string;
  event_registration_id: string;
  status: string;
};

type PlatformBroadcastAlertRow = {
  id: string;
  title: string;
  message: string;
  alert_type: string;
  audience: string;
  dismissible: boolean;
  read_more_url: string | null;
  read_more_label: string | null;
};

type WorkspaceOnboardingTask = {
  key: string;
  title: string;
  description: string;
  href: string;
  complete: boolean;
};

type OrganizerAriaAction = {
  key: string;
  priority: "High" | "Medium" | "Low";
  title: string;
  reason: string;
  nextStep: string;
  href: string;
  whyItMatters: string;
  metricPreview: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

type PersistedAriaActionItemRow = {
  id: string;
  action_key: string;
  status: string;
  snoozed_until: string | null;
  updated_at: string | null;
};

function isOrganizerRole(role: string | null | undefined) {
  const normalized = (role ?? "").trim().toLowerCase();
  return normalized.startsWith("organizer_");
}

const WORKSPACE_DEFAULT_TIME_ZONE = "America/New_York";

function fmtDateTime(value: string, timeZone = WORKSPACE_DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function appointmentTypeLabel(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized === "private_lesson") return "Private Lesson";
  if (normalized === "intro_lesson") return "Intro Lesson";
  if (normalized === "coaching") return "Coaching";
  if (normalized === "group_class") return "Group Class";
  if (normalized === "practice_party") return "Practice Party";
  if (normalized === "floor_space_rental") return "Floor Space Rental";
  if (normalized === "room_unavailable") return "Room Unavailable";
  if (normalized === "event") return "Event";

  if (!normalized) return "Appointment";

  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function fullName(
  row?: { first_name: string | null; last_name: string | null } | null,
) {
  const name = [row?.first_name, row?.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  return name || null;
}

function compactList(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" • ");
}

function followUpName(
  row?: {
    first_name: string | null;
    last_name: string | null;
    email?: string | null;
  } | null,
) {
  const name = fullName(row ?? null);
  return name || row?.email || "Contact";
}

function todayUtcDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function parseBirthdayParts(value: string | null | undefined) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  return {
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getDaysUntilBirthday(value: string | null | undefined) {
  const parts = parseBirthdayParts(value);
  if (!parts) return null;

  const today = todayUtcDateOnly();
  const year = today.getUTCFullYear();
  let nextBirthday = new Date(Date.UTC(year, parts.month - 1, parts.day));

  if (nextBirthday < today) {
    nextBirthday = new Date(Date.UTC(year + 1, parts.month - 1, parts.day));
  }

  return Math.round(
    (nextBirthday.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
}

function hasMailingAddress(client: ClientRow) {
  return Boolean(
    [
      client.address_line1,
      client.city,
      client.state,
      client.postal_code,
      client.country,
    ]
      .map((part) => part?.trim())
      .filter(Boolean).length,
  );
}

function toNumericValue(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatAriaGoalValue(
  value: number | string | null | undefined,
  unit: string | null | undefined,
) {
  const numericValue = toNumericValue(value);

  if (numericValue === null) return "Not set";

  const normalizedUnit = (unit ?? "").trim().toLowerCase();

  if (normalizedUnit === "dollars" || normalizedUnit === "dollar") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(numericValue);
  }

  if (normalizedUnit === "percent" || normalizedUnit === "percentage") {
    return `${numericValue}%`;
  }

  return `${numericValue.toLocaleString()} ${normalizedUnit || "target"}`;
}

function getAriaGoalProgressPercent(
  currentValue: number | string | null | undefined,
  targetValue: number | string | null | undefined,
) {
  const current = toNumericValue(currentValue);
  const target = toNumericValue(targetValue);

  if (current === null || target === null || target <= 0) return null;

  return Math.min(100, Math.max(0, Math.round((current / target) * 100)));
}

function getAriaGoalTimelinePercent(
  startsAt: string | null | undefined,
  targetDate: string | null | undefined,
) {
  if (!startsAt || !targetDate) return null;

  const start = new Date(startsAt).getTime();
  const target = new Date(targetDate).getTime();
  const now = Date.now();

  if (!Number.isFinite(start) || !Number.isFinite(target) || target <= start) {
    return null;
  }

  return Math.min(
    100,
    Math.max(0, Math.round(((now - start) / (target - start)) * 100)),
  );
}

function getEventRelationName(
  relation: FollowUpEventRegistrationRow["events"],
) {
  const eventRow = Array.isArray(relation) ? relation[0] : relation;
  return eventRow?.name?.trim() || "event";
}

function fmtDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

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

  return startDate === endDate ? startText : `${startText} - ${endText}`;
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
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function platformBroadcastAlertClass(type: string) {
  if (type === "success")
    return "border-emerald-200 bg-emerald-50 text-emerald-950";
  if (type === "warning") return "border-amber-200 bg-amber-50 text-amber-950";
  if (type === "maintenance")
    return "border-violet-200 bg-violet-50 text-violet-950";
  if (type === "critical") return "border-rose-200 bg-rose-50 text-rose-950";
  return "border-sky-200 bg-sky-50 text-sky-950";
}

function platformBroadcastAlertLabel(type: string) {
  if (type === "success") return "Feature Update";
  if (type === "warning") return "Important Notice";
  if (type === "maintenance") return "Maintenance";
  if (type === "critical") return "Critical Alert";
  return "DanceFlow Notice";
}

function audienceMatchesWorkspace(params: {
  audience: string;
  studioRole: string | null | undefined;
  organizerWorkspace: boolean;
}) {
  const audience = params.audience.trim().toLowerCase();
  const role = (params.studioRole ?? "").trim().toLowerCase();

  if (audience === "all_users" || audience === "all_workspace_users")
    return true;
  if (audience === "studio_owners")
    return role === "studio_owner" || role === "owner";
  if (audience === "organizers")
    return params.organizerWorkspace || role.startsWith("organizer_");
  if (audience === "instructors")
    return role.includes("instructor") || role === "studio_owner";
  if (audience === "independent_instructors")
    return role.includes("independent_instructor");
  return false;
}

function PlatformBroadcastAlerts({
  alerts,
}: {
  alerts: PlatformBroadcastAlertRow[];
}) {
  if (alerts.length === 0) return null;

  return (
    <section className="space-y-3">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`rounded-[28px] border p-5 shadow-sm ${platformBroadcastAlertClass(
            alert.alert_type,
          )}`}
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-75">
                {platformBroadcastAlertLabel(alert.alert_type)}
              </p>
              <h2 className="mt-2 text-lg font-semibold">{alert.title}</h2>
              <p className="mt-2 text-sm leading-6 opacity-90">
                {alert.message}
              </p>
              {alert.read_more_url ? (
                <Link
                  href={alert.read_more_url}
                  className="mt-3 inline-flex text-sm font-semibold underline underline-offset-4"
                >
                  {alert.read_more_label || "Read more"}
                </Link>
              ) : null}
            </div>

            {alert.dismissible ? (
              <form
                action={dismissPlatformBroadcastAlertAction}
                className="shrink-0"
              >
                <input type="hidden" name="alertId" value={alert.id} />
                <button
                  type="submit"
                  className="rounded-xl bg-white/80 px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-black/10 hover:bg-white"
                >
                  Dismiss
                </button>
              </form>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}

function WorkspaceOnboardingChecklist({
  checklistType,
  tasks,
}: {
  checklistType: "studio" | "organizer";
  tasks: WorkspaceOnboardingTask[];
}) {
  const completedCount = tasks.filter((task) => task.complete).length;
  const totalCount = tasks.length;
  const percentComplete =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const nextTask = tasks.find((task) => !task.complete) ?? null;
  const previewTasks = tasks.slice(0, 4);

  if (totalCount === 0 || completedCount === totalCount) return null;

  const title =
    checklistType === "organizer"
      ? "Launch your event workspace"
      : "Launch your studio workspace";

  const subtitle =
    checklistType === "organizer"
      ? "A few focused steps to publish events, accept registrations, and run the door smoothly."
      : "A few focused steps to get scheduling, clients, payments, and student access ready.";

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-white shadow-sm">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="bg-gradient-to-r from-[#FCF8FF] via-white to-[#FFF7ED] p-6 md:p-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7C2D92]">
                Launch Setup
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                {title}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                {subtitle}
              </p>
            </div>

            <div className="shrink-0 rounded-2xl border border-[#E9D5FF] bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
              <span className="font-semibold text-slate-950">
                {completedCount} of {totalCount}
              </span>{" "}
              ready
            </div>
          </div>

          <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#F3E8FF]">
            <div
              className="h-full rounded-full bg-[#7C2D92] transition-all"
              style={{ width: `${percentComplete}%` }}
            />
          </div>

          {nextTask ? (
            <div className="mt-5 rounded-2xl border border-white bg-white/80 p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7C2D92]">
                Recommended next
              </p>
              <h3 className="mt-2 text-base font-semibold text-slate-950">
                {nextTask.title}
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {nextTask.description}
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href="/app/onboarding"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4B1465]"
                >
                  Continue setup
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href={nextTask.href}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#E9D5FF] bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:border-[#D8B4FE] hover:bg-[#FCF8FF]"
                >
                  Open this step
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-[#F3E8FF] bg-slate-50/80 p-6 lg:border-l lg:border-t-0">
          <div className="space-y-3">
            {previewTasks.map((task) => (
              <div key={task.key} className="flex items-start gap-3">
                <div
                  className={`mt-0.5 rounded-full p-1 ${
                    task.complete
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-white text-slate-400 ring-1 ring-slate-200"
                  }`}
                >
                  {task.complete ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Circle className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-950">
                    {task.title}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500">
                    {task.complete ? "Ready" : "Not set yet"}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <form action={dismissWorkspaceOnboardingAction} className="mt-5">
            <input type="hidden" name="checklistType" value={checklistType} />
            <button
              type="submit"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-[#D8B4FE] hover:text-[#6B21A8]"
            >
              Hide for now
            </button>
          </form>
        </div>
      </div>
    </section>
  );
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
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function ariaActionPriorityClass(priority: OrganizerAriaAction["priority"]) {
  if (priority === "High") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }

  if (priority === "Medium") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }

  return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
}

const PLAN_LABELS: Record<string, string> = {
  organizer: "Organizer",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
};

function getPlanLabelFromCode(value: string | null | undefined) {
  const code = (value ?? "").trim().toLowerCase();
  if (!code) return null;

  return (
    PLAN_LABELS[code] ??
    code
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

function planBadgeClass(planCode: string) {
  if (planCode === "pro") {
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  }
  if (planCode === "growth") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function formatTrialEndDate(value: string | null) {
  if (!value) return null;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getTrialDaysLeft(value: string | null) {
  if (!value) return null;

  const now = new Date();
  const trialEnd = new Date(value);
  const diffMs = trialEnd.getTime() - now.getTime();

  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function getTrialDisplay(
  status: string | null | undefined,
  trialEndsAt: string | null,
) {
  if (status !== "trialing") return null;

  const daysLeft = getTrialDaysLeft(trialEndsAt);
  const endDate = formatTrialEndDate(trialEndsAt);

  if (daysLeft === null) {
    return {
      label: "Trial",
      detail: "Trial active",
    };
  }

  if (daysLeft < 0) {
    return {
      label: "Trial expired",
      detail: endDate ? `Ended ${endDate}` : "Trial active",
    };
  }

  if (daysLeft === 0) {
    return {
      label: "Trial ends today",
      detail: endDate ? `Ends ${endDate}` : "Trial active",
    };
  }

  return {
    label: `Trial — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
    detail: endDate ? `Ends ${endDate}` : "Trial active",
  };
}

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-white shadow-sm">
      <div className="border-b border-[#F3E8FF] bg-gradient-to-r from-[#FCF8FF] to-white px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              DanceFlow Workspace
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                {subtitle}
              </p>
            ) : null}
          </div>

          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>

      <div className="p-6">{children}</div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  subtext,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  subtext?: string;
}) {
  return (
    <div className="group rounded-3xl border border-[#E9D5FF] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#D8B4FE] hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            {value}
          </p>
          {subtext ? (
            <p className="mt-2 text-sm leading-5 text-slate-500">{subtext}</p>
          ) : null}
        </div>

        <div className="rounded-2xl bg-[#F3E8FF] p-3 text-[#6B21A8] transition group-hover:bg-[#E9D5FF]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function QuickActionCard({
  href,
  title,
  description,
  icon: Icon,
  primary = false,
}: {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group rounded-3xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
        primary
          ? "border-[#5B197A] bg-gradient-to-br from-[#5B197A] to-[#7C2D92] text-white"
          : "border-[#E9D5FF] bg-white text-slate-950 hover:border-[#D8B4FE] hover:bg-[#FCF8FF]"
      }`}
    >
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
          primary
            ? "bg-white/15 text-white"
            : "bg-[#F3E8FF] text-[#6B21A8] group-hover:bg-[#E9D5FF]"
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>

      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p
        className={`mt-1 text-sm leading-6 ${
          primary ? "text-white/80" : "text-slate-600"
        }`}
      >
        {description}
      </p>

      <div
        className={`mt-4 inline-flex items-center gap-2 text-sm font-semibold ${
          primary ? "text-white" : "text-[#6B21A8]"
        }`}
      >
        Open
        <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
      {children}
    </div>
  );
}

export default async function AppDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const acceptedInviteCountRaw =
    typeof resolvedSearchParams.team_invite_accepted === "string"
      ? resolvedSearchParams.team_invite_accepted
      : null;

  const acceptedInviteCount = acceptedInviteCountRaw
    ? Number.parseInt(acceptedInviteCountRaw, 10)
    : 0;

  const showInviteAcceptedBanner =
    Number.isFinite(acceptedInviteCount) && acceptedInviteCount > 0;

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const organizerWorkspace = isOrganizerRole(context.studioRole);
  const accessibleStudios = await getAccessibleStudios();

  const currentWorkspace =
    accessibleStudios.find((workspace) => workspace.studioId === studioId) ??
    accessibleStudios.find((workspace) => workspace.isSelected) ??
    null;

  const { data: studioTimeZoneRow } = await supabase
    .from("studios")
    .select("timezone")
    .eq("id", studioId)
    .maybeSingle();

  const studioTimeZone =
    typeof studioTimeZoneRow?.timezone === "string" && studioTimeZoneRow.timezone.trim()
      ? studioTimeZoneRow.timezone.trim()
      : WORKSPACE_DEFAULT_TIME_ZONE;

  let hostStudioPortalLinks: HostStudioPortalLink[] = [];

  const { data: hostAccountLinks, error: hostStudioPortalError } = await supabase
    .from("client_account_links")
    .select("client_id")
    .eq("user_id", user.id)
    .eq("status", "linked")
    .neq("studio_id", studioId);

  const hostClientIds = Array.from(
    new Set((hostAccountLinks ?? []).map((row) => String(row.client_id))),
  );

  const { data: hostStudioPortalRows } = hostClientIds.length
    ? await supabase
      .from("clients")
      .select(
        `
      id,
      studio_id,
      studios (
        id,
        name,
        slug
      )
    `,
      )
      .in("id", hostClientIds)
      .eq("is_independent_instructor", true)
      .neq("studio_id", studioId)
    : { data: [] };

  if (hostStudioPortalError) {
    throw new Error(
      `Failed to load host studio portal links: ${hostStudioPortalError.message}`,
    );
  }

  hostStudioPortalLinks = (hostStudioPortalRows ?? [])
    .map((row) => {
      const typedRow = row as {
        id: string;
        studio_id: string;
        studios?:
          | { id?: string | null; name?: string | null; slug?: string | null }
          | { id?: string | null; name?: string | null; slug?: string | null }[]
          | null;
      };

      const studioRelation = Array.isArray(typedRow.studios)
        ? typedRow.studios[0]
        : typedRow.studios;

      if (!studioRelation?.slug) return null;

      return {
        client_id: typedRow.id,
        studio_id: typedRow.studio_id,
        studio_name: studioRelation.name ?? "Host Studio",
        studio_slug: studioRelation.slug,
      };
    })
    .filter((row): row is HostStudioPortalLink => Boolean(row));

  await syncStudioNotifications(studioId);

  const [
    { data: workspace, error: workspaceError },
    { data: notifications, error: notificationsError },
    { data: subscription, error: subscriptionError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select(
        "id, name, billing_plan, subscription_status, trial_ends_at, stripe_connected_account_id",
      )
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(6),

    supabase
      .from("studio_subscriptions")
      .select(
        "id, subscription_plan_id, status, billing_interval, trial_ends_at, current_period_end, updated_at",
      )
      .eq("studio_id", studioId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<SubscriptionRow>(),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (notificationsError) {
    throw new Error(
      `Failed to load dashboard notifications: ${notificationsError.message}`,
    );
  }

  if (subscriptionError) {
    throw new Error(
      `Failed to load current subscription: ${subscriptionError.message}`,
    );
  }

  let currentPlan: SubscriptionPlanRow | null = null;
  if (subscription?.subscription_plan_id) {
    const { data: planRow, error: planError } = await supabase
      .from("subscription_plans")
      .select("id, code, name")
      .eq("id", subscription.subscription_plan_id)
      .maybeSingle<SubscriptionPlanRow>();

    if (planError) {
      throw new Error(`Failed to load current plan: ${planError.message}`);
    }

    currentPlan = planRow ?? null;
  }

  const studioBillingPlan =
    workspace?.billing_plan?.trim().toLowerCase() ?? null;
  const planCode = organizerWorkspace
    ? "organizer"
    : currentPlan?.code?.trim().toLowerCase() || studioBillingPlan || "starter";
  const planLabel = organizerWorkspace
    ? "Organizer"
    : currentPlan?.name || getPlanLabelFromCode(studioBillingPlan) || "Starter";

  const effectiveSubscriptionStatus =
    subscription?.status ?? workspace?.subscription_status ?? null;

  const effectiveTrialEndsAt =
    subscription?.trial_ends_at ??
    workspace?.trial_ends_at ??
    subscription?.current_period_end ??
    null;

  const subscriptionTrialInfo = getTrialDisplay(
    effectiveSubscriptionStatus,
    effectiveTrialEndsAt,
  );

  const unreadCount = ((notifications ?? []) as NotificationRow[]).filter(
    (item) => !item.read_at,
  ).length;
  const payoutsReady = Boolean(workspace?.stripe_connected_account_id);

  const typedNotifications = (notifications ?? []) as NotificationRow[];

  const { data: platformAlertRows, error: platformAlertsError } = await supabase
    .from("platform_alerts")
    .select(
      "id, title, message, alert_type, audience, dismissible, read_more_url, read_more_label",
    )
    .eq("active", true)
    .or(`starts_at.is.null,starts_at.lte.${new Date().toISOString()}`)
    .or(`ends_at.is.null,ends_at.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false });

  if (platformAlertsError) {
    throw new Error(
      `Failed to load platform broadcasts: ${platformAlertsError.message}`,
    );
  }

  const typedPlatformAlerts = (platformAlertRows ??
    []) as PlatformBroadcastAlertRow[];
  const platformAlertIds = typedPlatformAlerts.map((alert) => alert.id);
  let dismissedPlatformAlertIds = new Set<string>();

  if (platformAlertIds.length > 0) {
    const { data: dismissalRows, error: dismissalError } = await supabase
      .from("platform_alert_dismissals")
      .select("alert_id")
      .eq("user_id", user.id)
      .in("alert_id", platformAlertIds);

    if (dismissalError) {
      throw new Error(
        `Failed to load dismissed platform broadcasts: ${dismissalError.message}`,
      );
    }

    dismissedPlatformAlertIds = new Set(
      (dismissalRows ?? [])
        .map((row) => (row as { alert_id?: string | null }).alert_id)
        .filter((id): id is string => Boolean(id)),
    );
  }

  const visiblePlatformAlerts = typedPlatformAlerts.filter((alert) => {
    if (alert.dismissible && dismissedPlatformAlertIds.has(alert.id))
      return false;
    return audienceMatchesWorkspace({
      audience: alert.audience,
      studioRole: context.studioRole,
      organizerWorkspace,
    });
  });

  const checklistType = organizerWorkspace ? "organizer" : "studio";

  const { data: onboardingPreference, error: onboardingPreferenceError } =
    await supabase
      .from("workspace_onboarding_preferences")
      .select("id, dismissed_at, completed_at")
      .eq("studio_id", studioId)
      .eq("user_id", user.id)
      .eq("checklist_type", checklistType)
      .maybeSingle<WorkspaceOnboardingPreferenceRow>();

  if (onboardingPreferenceError) {
    throw new Error(
      `Failed to load onboarding checklist preferences: ${onboardingPreferenceError.message}`,
    );
  }

  const onboardingDismissed = Boolean(onboardingPreference?.dismissed_at);
  const onboardingCompleted = Boolean(onboardingPreference?.completed_at);
  if (organizerWorkspace) {
    const [
      { data: events, error: eventsError },
      { data: organizers, error: organizersError },
      { data: registrations, error: registrationsError },
    ] = await Promise.all([
      supabase
        .from("events")
        .select(
          "id, name, slug, event_type, start_date, end_date, visibility, status, featured, public_directory_enabled",
        )
        .eq("studio_id", studioId)
        .order("start_date", { ascending: true })
        .limit(8),

      supabase
        .from("organizers")
        .select("id, name, slug, active")
        .eq("studio_id", studioId)
        .order("name", { ascending: true }),

      supabase
        .from("event_registrations")
        .select("id, payment_status")
        .eq("studio_id", studioId),
    ]);

    if (eventsError) {
      throw new Error(
        `Failed to load dashboard events: ${eventsError.message}`,
      );
    }
    if (organizersError) {
      throw new Error(
        `Failed to load dashboard organizers: ${organizersError.message}`,
      );
    }
    if (registrationsError) {
      throw new Error(
        `Failed to load dashboard registrations: ${registrationsError.message}`,
      );
    }

    const typedEvents = (events ?? []) as EventRow[];
    const typedOrganizers = (organizers ?? []) as OrganizerRow[];
    const typedRegistrations = (registrations ?? []) as RegistrationRow[];

    const registrationIds = typedRegistrations.map((row) => row.id);

    let typedAttendance: AttendanceRow[] = [];
    if (registrationIds.length > 0) {
      const { data: attendanceRows, error: attendanceError } = await supabase
        .from("attendance_records")
        .select("id, event_registration_id, status")
        .in("event_registration_id", registrationIds);

      if (attendanceError) {
        throw new Error(
          `Failed to load dashboard attendance: ${attendanceError.message}`,
        );
      }

      typedAttendance = (attendanceRows ?? []) as AttendanceRow[];
    }

    const publishedCount = typedEvents.filter(
      (event) => event.status === "published" || event.status === "open",
    ).length;
    const discoveryReadyCount = typedEvents.filter(
      (event) =>
        event.public_directory_enabled &&
        event.visibility === "public" &&
        (event.status === "published" || event.status === "open"),
    ).length;
    const paidRegistrationsCount = typedRegistrations.filter(
      (row) =>
        row.payment_status === "paid" || row.payment_status === "partial",
    ).length;
    const checkedInCount = typedAttendance.filter(
      (row) => row.status === "attended",
    ).length;
    const primaryOrganizer = typedOrganizers[0] ?? null;

    const organizerOnboardingTasks: WorkspaceOnboardingTask[] = [
      {
        key: "organizer-profile",
        title: "Create organizer profile",
        description:
          "Confirm the organizer name and workspace details are ready.",
        href: "/app/settings",
        complete: Boolean(primaryOrganizer),
      },
      {
        key: "payouts",
        title: "Connect payouts",
        description: "Enable Stripe payouts before taking paid registrations.",
        href: "/app/payments",
        complete: payoutsReady,
      },
      {
        key: "create-event",
        title: "Create your first event",
        description:
          "Add an event, group class, workshop, competition, or showcase.",
        href: "/app/events/new",
        complete: typedEvents.length > 0,
      },
      {
        key: "publish-event",
        title: "Publish an event",
        description: "Make an event public or open so dancers can register.",
        href: "/app/events",
        complete: publishedCount > 0,
      },
      {
        key: "discovery-ready",
        title: "Turn on public discovery",
        description:
          "List at least one event in discovery so dancers can find it.",
        href: "/app/events",
        complete: discoveryReadyCount > 0,
      },
      {
        key: "registration-test",
        title: "Confirm registration flow",
        description:
          "Record at least one paid or partial registration to confirm the event flow.",
        href: "/app/events/registrations",
        complete: paidRegistrationsCount > 0,
      },
    ];

    const organizerOnboardingComplete =
      organizerOnboardingTasks.length > 0 &&
      organizerOnboardingTasks.every((task) => task.complete);

    const showOrganizerOnboarding =
      !onboardingDismissed &&
      !onboardingCompleted &&
      !organizerOnboardingComplete &&
      organizerOnboardingTasks.some((task) => !task.complete);

    const recordOrganizerOnboardingCompletion =
      !onboardingDismissed &&
      !onboardingCompleted &&
      organizerOnboardingComplete;

    const organizerAriaInsight =
      typedEvents.length === 0
        ? {
            title: "ARIA is ready to help build your first event.",
            insight:
              "No organizer events are active yet, so ARIA's first recommendation is to create one event and make the registration path measurable from day one.",
            recommendation:
              "Create the event, add ticket types, confirm public visibility, and then return here so ARIA can watch sales, check-ins, costs, and closeout readiness.",
            metric: "0 events",
            primaryAction: { href: "/app/events/new", label: "Create event" },
            secondaryAction: { href: "/app/aria", label: "Consult with ARIA" },
          }
        : !payoutsReady
          ? {
              title:
                "Connect payouts before leaning on paid registration data.",
              insight:
                "ARIA found organizer events, but Stripe payouts are not connected yet. That limits reliable ticket revenue, refunds, fees, and closeout tracking.",
              recommendation:
                "Connect payouts, then use the organizer event dashboard to review revenue, labor, expenses, and settlement readiness.",
              metric: "Payouts not connected",
              primaryAction: {
                href: "/app/payments",
                label: "Connect payouts",
              },
              secondaryAction: { href: "/app/events", label: "Review events" },
            }
          : publishedCount === 0
            ? {
                title:
                  "Your events exist, but none are open for registration yet.",
                insight:
                  "ARIA found draft or unpublished events. The next organizer move is to publish at least one event and turn on public discovery if it should be found by dancers.",
                recommendation:
                  "Open your events list, confirm the public details, then publish or open registration for the next event you want to sell.",
                metric: `${typedEvents.length} event${typedEvents.length === 1 ? "" : "s"} created`,
                primaryAction: { href: "/app/events", label: "Open events" },
                secondaryAction: {
                  href: "/app/aria",
                  label: "Ask ARIA what to fix",
                },
              }
            : discoveryReadyCount === 0
              ? {
                  title: "Published events are not fully discovery-ready.",
                  insight:
                    "ARIA found published or open events, but none are currently enabled for public directory discovery.",
                  recommendation:
                    "Review visibility and public directory settings so dancers can find your event without needing a direct link.",
                  metric: `${publishedCount} open / published`,
                  primaryAction: {
                    href: "/app/events",
                    label: "Review discovery",
                  },
                  secondaryAction: {
                    href: "/app/aria",
                    label: "Consult with ARIA",
                  },
                }
              : paidRegistrationsCount === 0
                ? {
                    title: "Your next ARIA focus is ticket conversion.",
                    insight:
                      "ARIA found discovery-ready events, but no paid registrations in this workspace summary yet.",
                    recommendation:
                      "Review the public event page, ticket pricing, campaign links, and registration path so you can turn discovery into paid attendance.",
                    metric: "0 paid registrations",
                    primaryAction: {
                      href: "/app/events",
                      label: "Review event funnel",
                    },
                    secondaryAction: {
                      href: "/app/organizer-campaigns",
                      label: "Review campaigns",
                    },
                  }
                : checkedInCount === 0
                  ? {
                      title: "Ticket sales are active. Prepare check-in next.",
                      insight:
                        "ARIA found paid registrations but no attended check-ins in the dashboard summary yet.",
                      recommendation:
                        "Before the next event starts, test the check-in flow and confirm ticket codes or QR scanning are ready.",
                      metric: `${paidRegistrationsCount} paid`,
                      primaryAction: {
                        href: "/app/events/check-in",
                        label: "Open check-in",
                      },
                      secondaryAction: {
                        href: "/app/events",
                        label: "Review events",
                      },
                    }
                  : {
                      title: "ARIA is monitoring organizer performance.",
                      insight:
                        "ARIA sees active event operations with paid registrations and check-in activity. The next priority is watching closeout readiness, margins, costs, and repeat-event signals.",
                      recommendation:
                        "Open the organizer event dashboard to review events needing attention, profitability rankings, settlement status, and exports.",
                      metric: `${checkedInCount} checked in`,
                      primaryAction: {
                        href: "/app/events",
                        label: "Open event dashboard",
                      },
                      secondaryAction: {
                        href: "/app/aria",
                        label: "Consult with ARIA",
                      },
                    };

    const organizerAriaActions: OrganizerAriaAction[] = [];

    if (typedEvents.length === 0) {
      organizerAriaActions.push({
        key: "create-event",
        priority: "High",
        title: "Create your first organizer event",
        reason:
          "ARIA cannot monitor ticket sales, check-in, or closeout readiness until an event exists.",
        nextStep:
          "Create one event and add ticket types so the registration funnel can be measured.",
        href: "/app/events/new",
        whyItMatters:
          "ARIA needs an event record before it can monitor ticket sales, registrations, check-in, profitability, or closeout readiness.",
        metricPreview: "0 organizer events",
        secondaryHref: "/app/aria",
        secondaryLabel: "Plan with ARIA",
      });
    }

    if (!payoutsReady) {
      organizerAriaActions.push({
        key: "connect-payouts",
        priority: "High",
        title: "Connect payouts before relying on revenue closeout",
        reason:
          "Stripe payouts are not connected, so paid registration, fee, refund, and settlement reporting may be incomplete.",
        nextStep:
          "Connect payouts, then review organizer event profitability again.",
        href: "/app/payments",
        whyItMatters:
          "Settlement and profit reporting are strongest when payment processing, fees, and payout readiness are connected before registrations scale.",
        metricPreview: "Payouts not connected",
        secondaryHref: "/app/events",
        secondaryLabel: "Review event revenue",
      });
    }

    if (typedEvents.length > 0 && publishedCount === 0) {
      organizerAriaActions.push({
        key: "publish-event",
        priority: "High",
        title: "Publish or open an event for registration",
        reason:
          "Events exist, but none are currently published or open for dancers to register.",
        nextStep:
          "Open the event dashboard, confirm details, and publish the next event you want to sell.",
        href: "/app/events",
        whyItMatters:
          "Draft events do not create ticket revenue. Publishing or opening the next event is the first step toward measurable organizer performance.",
        metricPreview: `${typedEvents.length} events • 0 published/open`,
        secondaryHref: "/app/events/new",
        secondaryLabel: "Create another event",
      });
    }

    if (publishedCount > 0 && discoveryReadyCount === 0) {
      organizerAriaActions.push({
        key: "discovery-ready",
        priority: "Medium",
        title: "Make at least one event discovery-ready",
        reason:
          "Published events are not currently enabled for public directory discovery in the dashboard summary.",
        nextStep:
          "Review event visibility and public directory settings so dancers can find the event.",
        href: "/app/events",
        whyItMatters:
          "A published event still needs discovery visibility so dancers can find it, share it, and register without a direct invite.",
        metricPreview: `${publishedCount} published/open • 0 discovery-ready`,
        secondaryHref: "/app/organizer-campaigns",
        secondaryLabel: "Review campaigns",
      });
    }

    if (discoveryReadyCount > 0 && paidRegistrationsCount === 0) {
      organizerAriaActions.push({
        key: "registration-funnel",
        priority: "Medium",
        title: "Review the registration funnel",
        reason:
          "ARIA found discovery-ready events, but no paid registrations in this workspace summary yet.",
        nextStep:
          "Review public event links, ticket pricing, and campaign traffic paths.",
        href: "/app/events",
        whyItMatters:
          "Discovery without paid registrations can point to a pricing, call-to-action, trust, or registration path issue before the event gets close.",
        metricPreview: `${discoveryReadyCount} discovery-ready • 0 paid registrations`,
        secondaryHref: "/app/organizer-campaigns",
        secondaryLabel: "Review campaign funnel",
      });
    }

    if (paidRegistrationsCount > 0 && checkedInCount === 0) {
      organizerAriaActions.push({
        key: "prepare-check-in",
        priority: "Medium",
        title: "Prepare event check-in",
        reason:
          "Paid registrations exist, but no attended check-ins are visible in the dashboard summary yet.",
        nextStep:
          "Open check-in and test QR/manual code flow before the event starts.",
        href: "/app/events/check-in",
        whyItMatters:
          "Paid registrations create attendance expectations. Testing check-in early reduces front-door delays and protects attendance data quality.",
        metricPreview: `${paidRegistrationsCount} paid • 0 checked in`,
        secondaryHref: "/app/events",
        secondaryLabel: "Review event operations",
      });
    }

    if (typedEvents.length > 0) {
      organizerAriaActions.push({
        key: "review-action-queue",
        priority: paidRegistrationsCount > 0 ? "High" : "Low",
        title: "Review the full ARIA action queue",
        reason:
          "The Events dashboard now ranks closeout, margin, missing cost data, registration, and repeat-event opportunities.",
        nextStep:
          "Open the event dashboard to review ARIA's event-specific recommendations.",
        href: "/app/events",
        whyItMatters:
          "The full queue ties each recommendation to event-specific closeout, margin, registration, check-in, and repeat-event signals.",
        metricPreview: `${typedEvents.length} events • ${paidRegistrationsCount} paid registrations`,
        secondaryHref: "/app/aria",
        secondaryLabel: "Consult with ARIA",
      });
    }

    const organizerAriaActionKeys = organizerAriaActions.map(
      (action) => action.key,
    );
    let persistedOrganizerAriaActions: PersistedAriaActionItemRow[] = [];

    if (organizerAriaActionKeys.length > 0) {
      const { data: persistedActions, error: persistedActionsError } =
        await supabase
          .from("aria_action_items")
          .select("id, action_key, status, snoozed_until, updated_at")
          .eq("studio_id", studioId)
          .in("action_key", organizerAriaActionKeys);

      if (persistedActionsError) {
        console.warn(
          "Failed to load persisted ARIA action items:",
          persistedActionsError.message,
        );
      } else {
        persistedOrganizerAriaActions =
          (persistedActions ?? []) as PersistedAriaActionItemRow[];
      }
    }

    const persistedOrganizerAriaActionByKey = new Map(
      persistedOrganizerAriaActions.map((item) => [item.action_key, item]),
    );
    const nowMs = Date.now();

    const visibleOrganizerAriaActions = organizerAriaActions.filter((action) => {
      const persistedAction = persistedOrganizerAriaActionByKey.get(action.key);
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
    });

    const topOrganizerAriaActions = visibleOrganizerAriaActions.slice(0, 3);
    const activeOrganizerAriaActionCount = visibleOrganizerAriaActions.length;
    const highPriorityOrganizerAriaActionCount =
      visibleOrganizerAriaActions.filter(
        (action) => action.priority === "High",
      ).length;
    const completedOrganizerAriaActionCount = persistedOrganizerAriaActions.filter(
      (action) => action.status === "completed",
    ).length;
    const dismissedOrganizerAriaActionCount = persistedOrganizerAriaActions.filter(
      (action) => action.status === "dismissed",
    ).length;
    const snoozedOrganizerAriaActionCount = persistedOrganizerAriaActions.filter(
      (action) =>
        action.status === "snoozed" &&
        action.snoozed_until &&
        new Date(action.snoozed_until).getTime() > nowMs,
    ).length;
    const recentlyHandledOrganizerAriaActionCount =
      completedOrganizerAriaActionCount +
      dismissedOrganizerAriaActionCount +
      snoozedOrganizerAriaActionCount;

    return (
      <main className="space-y-8 p-6 md:p-8">
        <PlatformBroadcastAlerts alerts={visiblePlatformAlerts} />
        {recordOrganizerOnboardingCompletion ? (
          <OnboardingCompletionRecorder checklistType="organizer" />
        ) : null}

        {showInviteAcceptedBanner ? (
          <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Access added
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Your team invitation was accepted
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-700">
              {acceptedInviteCount === 1
                ? "You now have access to a workspace through your invitation."
                : `You now have access to ${acceptedInviteCount} workspaces through your invitations.`}
            </p>
          </section>
        ) : null}

        {showOrganizerOnboarding ? (
          <WorkspaceOnboardingChecklist
            checklistType="organizer"
            tasks={organizerOnboardingTasks}
          />
        ) : null}

        <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  DanceFlow Organizer Dashboard
                </p>

                <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                  Organizer Dashboard
                </h1>

                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  Run your organizer operations from one place, including
                  events, registrations, check-in, profile readiness, and recent
                  alerts.
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-white/80">
                  <span>
                    Current workspace:{" "}
                    <span className="font-medium text-white">
                      {currentWorkspace?.studioName ||
                        workspace?.name ||
                        "Organizer Workspace"}
                    </span>
                  </span>
                  <span className="inline-flex rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium ring-1 ring-white/15">
                    {planLabel}
                  </span>
                  {subscriptionTrialInfo ? (
                    <span className="inline-flex flex-col rounded-2xl bg-white/10 px-3 py-2 text-xs font-medium text-white ring-1 ring-white/15">
                      <span>{subscriptionTrialInfo.label}</span>
                      <span className="mt-0.5 text-white/70">
                        {subscriptionTrialInfo.detail}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/app/events/new"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                >
                  Create Event
                </Link>
                <Link
                  href="/app/events/registrations"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  View Registrations
                </Link>
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Events"
                value={typedEvents.length}
                icon={CalendarDays}
              />
              <StatCard
                label="Published / Open"
                value={publishedCount}
                icon={Ticket}
              />
              <StatCard
                label="Discovery Ready"
                value={discoveryReadyCount}
                icon={Star}
              />
              <StatCard
                label="Paid Registrations"
                value={paidRegistrationsCount}
                icon={ClipboardList}
              />
              <StatCard
                label="Unread Notifications"
                value={unreadCount}
                icon={Bell}
              />
            </div>
          </div>
        </section>

        <AriaInsightCard
          eyebrow="ARIA Organizer Insights"
          title={organizerAriaInsight.title}
          insight={organizerAriaInsight.insight}
          recommendation={organizerAriaInsight.recommendation}
          metric={organizerAriaInsight.metric}
          primaryAction={organizerAriaInsight.primaryAction}
          secondaryAction={organizerAriaInsight.secondaryAction}
        />

        <section className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-white shadow-sm">
          <div className="border-b border-[#F3E8FF] bg-gradient-to-r from-[#FCF8FF] to-white px-6 py-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                  ARIA Action Queue
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Top organizer recommendations
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                  ARIA is prioritizing the next operational moves for this
                  organizer workspace. Open the full Events dashboard for the
                  detailed event-by-event queue.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex rounded-full bg-[#F5F3FF] px-3 py-1.5 text-xs font-semibold text-[#6B21A8] ring-1 ring-[#DDD6FE]">
                  {activeOrganizerAriaActionCount} active
                </span>
                <span className="inline-flex rounded-full bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
                  {highPriorityOrganizerAriaActionCount} high priority
                </span>
                <span className="inline-flex rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                  {recentlyHandledOrganizerAriaActionCount} handled
                </span>
                {snoozedOrganizerAriaActionCount > 0 ? (
                  <span className="inline-flex rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
                    {snoozedOrganizerAriaActionCount} snoozed
                  </span>
                ) : null}
                <Link
                  href="/app/events"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4B1465]"
                >
                  View full queue
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/app/aria"
                  className="inline-flex items-center gap-2 rounded-xl border border-[#E9D5FF] bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:border-[#D8B4FE] hover:bg-[#FCF8FF]"
                >
                  Consult with ARIA
                  <Sparkles className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-6 lg:grid-cols-3">
            {topOrganizerAriaActions.length > 0 ? (
              topOrganizerAriaActions.map((action) => (
                <Link
                  key={action.key}
                  href={action.href}
                  className="group rounded-3xl border border-slate-200 bg-slate-50 p-5 transition hover:-translate-y-0.5 hover:border-[#D8B4FE] hover:bg-[#FCF8FF] hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${ariaActionPriorityClass(
                        action.priority,
                      )}`}
                    >
                      {action.priority}
                    </span>
                    <ArrowRight className="mt-1 h-4 w-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-[#6B21A8]" />
                  </div>

                  <h3 className="mt-4 text-base font-semibold text-slate-950">
                    {action.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {action.reason}
                  </p>
                  <div className="mt-4 rounded-2xl border border-white bg-white/80 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7C2D92]">
                      Why this matters
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {action.whyItMatters}
                    </p>
                    <p className="mt-3 rounded-xl bg-[#F5F3FF] px-3 py-2 text-xs font-semibold text-[#6B21A8] ring-1 ring-[#DDD6FE]">
                      {action.metricPreview}
                    </p>
                  </div>

                  <p className="mt-3 text-sm font-medium leading-6 text-[#6B21A8]">
                    {action.nextStep}
                  </p>

                  {action.secondaryHref ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="inline-flex rounded-xl bg-[#5B197A] px-3 py-2 text-xs font-semibold text-white">
                        Open recommended action
                      </span>
                      <span className="inline-flex rounded-xl border border-[#E9D5FF] bg-white px-3 py-2 text-xs font-semibold text-[#6B21A8]">
                        {action.secondaryLabel ?? "Review with ARIA"}
                      </span>
                    </div>
                  ) : null}
                </Link>
              ))
            ) : (
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 lg:col-span-3">
                <p className="text-sm font-semibold text-emerald-900">
                  No active organizer actions right now.
                </p>
                <p className="mt-2 text-sm leading-6 text-emerald-800">
                  ARIA does not see urgent organizer actions on the main
                  dashboard. Completed, dismissed, or snoozed recommendations
                  are being respected. Continue monitoring the full Events
                  dashboard for closeout, margin, ticket, and check-in changes.
                </p>
                {recentlyHandledOrganizerAriaActionCount > 0 ? (
                  <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                    {recentlyHandledOrganizerAriaActionCount} recently handled
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
          <SectionCard
            title="Event Snapshot"
            subtitle="A quick organizer-first summary of publishing and readiness."
            action={
              <Link
                href="/app/events"
                className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
              >
                Open Events
              </Link>
            }
          >
            {typedEvents.length === 0 ? (
              <EmptyState>
                No events yet. Create your first event to begin publishing.
              </EmptyState>
            ) : (
              <div className="space-y-4">
                {typedEvents.slice(0, 5).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-slate-900">
                            {event.name}
                          </h3>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                              event.status,
                            )}`}
                          >
                            {event.status}
                          </span>
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            {eventTypeLabel(event.event_type)}
                          </span>
                        </div>

                        <p className="mt-2 text-sm text-slate-500">
                          {fmtDateRange(event.start_date, event.end_date)}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-2">
                          {event.visibility === "public" ? (
                            <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                              Public
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                              {event.visibility}
                            </span>
                          )}

                          {event.public_directory_enabled ? (
                            <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                              Directory On
                            </span>
                          ) : null}

                          {event.featured ? (
                            <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
                              Featured
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <Link
                        href={`/app/events/${event.id}/edit`}
                        className="inline-flex items-center gap-2 text-sm font-medium text-[var(--brand-primary)] hover:underline"
                      >
                        Edit Event
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <div className="space-y-8">
            <SectionCard
              title="Organizer Profile"
              subtitle="Your organizer identity and public presence."
              action={
                <Link
                  href="/app/organizer"
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  Open Organizer
                </Link>
              }
            >
              {primaryOrganizer ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">
                        {primaryOrganizer.name}
                      </h3>
                      <p className="mt-1 text-sm text-slate-500">
                        /{primaryOrganizer.slug}
                      </p>
                    </div>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                        primaryOrganizer.active
                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                          : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                      }`}
                    >
                      {primaryOrganizer.active ? "Active" : "Needs Attention"}
                    </span>
                  </div>
                </div>
              ) : (
                <EmptyState>
                  No organizer profile yet. Create one to publish events
                  publicly.
                </EmptyState>
              )}
            </SectionCard>

            <SectionCard
              title="Recent Alerts"
              subtitle="Latest notifications for this workspace."
              action={
                <Link
                  href="/app/notifications"
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  View All
                </Link>
              }
            >
              {typedNotifications.length === 0 ? (
                <EmptyState>No notifications yet.</EmptyState>
              ) : (
                <div className="space-y-3">
                  {typedNotifications.slice(0, 4).map((notification) => (
                    <div
                      key={notification.id}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-900">
                            {notification.title}
                          </h3>
                          {notification.body ? (
                            <p className="mt-1 text-sm text-slate-600">
                              {notification.body}
                            </p>
                          ) : null}
                        </div>
                        {!notification.read_at ? (
                          <span className="rounded-full bg-[#F97316]/10 px-2 py-1 text-xs font-semibold text-[#C2410C]">
                            New
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <QuickActionCard
            href="/app/events/new"
            title="Create Event"
            description="Build a new class, workshop, competition, showcase, or special event."
            icon={CalendarDays}
            primary
          />
          <QuickActionCard
            href="/app/events"
            title="Manage Events"
            description="Edit event details, publish visibility, and manage event operations."
            icon={Ticket}
          />
          <QuickActionCard
            href="/app/events/registrations"
            title="Registrations"
            description="Review attendees, payment status, and registration activity."
            icon={ClipboardList}
          />
          <QuickActionCard
            href="/app/events/check-in"
            title="Check-In"
            description="Run event check-in and attendance tracking."
            icon={CheckCircle2}
          />
        </section>

        {!payoutsReady ? (
          <section className="rounded-[32px] border border-amber-200 bg-amber-50 p-6 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">
                  Payments Setup
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Connect payouts before taking paid registrations
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-700">
                  Organizer workspaces need Stripe payouts connected before
                  relying on paid ticket sales, registration revenue, or
                  refunds.
                </p>
              </div>
              <Link
                href="/app/payments"
                className="inline-flex items-center justify-center rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
              >
                Open Billing & Payments
              </Link>
            </div>
          </section>
        ) : null}
      </main>
    );
  }

  const isGrowthOrHigher = planCode === "growth" || planCode === "pro";

  const [
    { data: clients, error: clientsError },
    { data: appointments, error: appointmentsError },
    { data: memberships, error: membershipsError },
    { data: packages, error: packagesError },
    { data: instructors, error: instructorsError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(
        "id, first_name, last_name, email, phone, birthday, address_line1, address_line2, city, state, postal_code, country",
      )
      .eq("studio_id", studioId),
    supabase
      .from("appointments")
      .select(
        "id, title, appointment_type, client_id, instructor_id, room_id, starts_at, status",
      )
      .eq("studio_id", studioId)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(8),
    supabase
      .from("client_memberships")
      .select("id, status")
      .eq("studio_id", studioId),
    isGrowthOrHigher
      ? supabase
          .from("client_packages")
          .select("id, active")
          .eq("studio_id", studioId)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("instructors").select("id").eq("studio_id", studioId),
  ]);

  if (clientsError) {
    throw new Error(
      `Failed to load dashboard clients: ${clientsError.message}`,
    );
  }

  if (appointmentsError) {
    throw new Error(
      `Failed to load dashboard appointments: ${appointmentsError.message}`,
    );
  }

  if (membershipsError) {
    throw new Error(
      `Failed to load dashboard memberships: ${membershipsError.message}`,
    );
  }

  if (packagesError) {
    throw new Error(
      `Failed to load dashboard packages: ${packagesError.message}`,
    );
  }

  if (instructorsError) {
    throw new Error(
      `Failed to load dashboard instructors: ${instructorsError.message}`,
    );
  }

  const {
    count: pendingBookingRequestCount,
    error: pendingBookingRequestCountError,
  } = await supabase
    .from("booking_requests")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .in("status", ["pending", "new", "in_review"]);

  if (pendingBookingRequestCountError) {
    throw new Error(
      `Failed to load booking request count: ${pendingBookingRequestCountError.message}`,
    );
  }

  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedMemberships = (memberships ?? []) as MembershipRow[];
  const typedPackages = (packages ?? []) as PackageRow[];
  const typedInstructors = (instructors ?? []) as InstructorRow[];

  const followUpNowIso = new Date().toISOString();
  const followUpThirtyDaysAgoIso = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [
    followUpClientsResult,
    followUpAppointmentsResult,
    followUpLeadActivitiesResult,
    followUpPackagesResult,
    followUpEventRegistrationsResult,
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(
        "id, first_name, last_name, email, status, referral_source, created_at",
      )
      .eq("studio_id", studioId)
      .in("status", ["active", "lead", "contacted", "consultation_booked"])
      .order("created_at", { ascending: false })
      .limit(150),

    supabase
      .from("appointments")
      .select("id, client_id, starts_at")
      .eq("studio_id", studioId)
      .not("client_id", "is", null)
      .gte("starts_at", followUpNowIso)
      .order("starts_at", { ascending: true })
      .limit(300),

    supabase
      .from("lead_activities")
      .select("id, client_id, follow_up_due_at, completed_at")
      .eq("studio_id", studioId)
      .not("follow_up_due_at", "is", null)
      .is("completed_at", null)
      .lte("follow_up_due_at", followUpNowIso)
      .order("follow_up_due_at", { ascending: true })
      .limit(75),

    supabase
      .from("client_packages")
      .select(
        `
          id,
          client_id,
          name_snapshot,
          active,
          client_package_items (
            quantity_remaining,
            is_unlimited
          )
        `,
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(150),

    supabase
      .from("event_registrations")
      .select(
        `
          id,
          event_id,
          client_id,
          attendee_first_name,
          attendee_last_name,
          attendee_email,
          payment_status,
          created_at,
          events ( name )
        `,
      )
      .eq("studio_id", studioId)
      .not("client_id", "is", null)
      .gte("created_at", followUpThirtyDaysAgoIso)
      .order("created_at", { ascending: false })
      .limit(75),
  ]);

  if (followUpClientsResult.error) {
    throw new Error(
      `Failed to load follow-up clients: ${followUpClientsResult.error.message}`,
    );
  }

  if (followUpAppointmentsResult.error) {
    throw new Error(
      `Failed to load follow-up appointments: ${followUpAppointmentsResult.error.message}`,
    );
  }

  if (followUpLeadActivitiesResult.error) {
    throw new Error(
      `Failed to load follow-up reminders: ${followUpLeadActivitiesResult.error.message}`,
    );
  }

  if (followUpPackagesResult.error) {
    throw new Error(
      `Failed to load follow-up packages: ${followUpPackagesResult.error.message}`,
    );
  }

  if (followUpEventRegistrationsResult.error) {
    throw new Error(
      `Failed to load follow-up event registrations: ${followUpEventRegistrationsResult.error.message}`,
    );
  }

  const followUpClients = (followUpClientsResult.data ??
    []) as FollowUpClientRow[];
  const followUpAppointments = (followUpAppointmentsResult.data ??
    []) as FollowUpAppointmentRow[];
  const followUpLeadActivities = (followUpLeadActivitiesResult.data ??
    []) as FollowUpLeadActivityRow[];
  const followUpPackages = (followUpPackagesResult.data ??
    []) as FollowUpPackageRow[];
  const followUpEventRegistrations = (followUpEventRegistrationsResult.data ??
    []) as FollowUpEventRegistrationRow[];

  const followUpClientMap = new Map(
    followUpClients.map((client) => [client.id, client]),
  );
  const clientIdsWithUpcomingAppointments = new Set(
    followUpAppointments
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );

  const lifecycleSnapshot = await loadStudioLifecycleSnapshot({
    supabase,
    studioId,
  });

  const suggestedFollowUps: SuggestedFollowUpItem[] = [];
  const suggestedFollowUpKeys = new Set<string>();

  function addSuggestedFollowUp(item: SuggestedFollowUpItem) {
    if (suggestedFollowUpKeys.has(item.id)) return;
    suggestedFollowUpKeys.add(item.id);
    suggestedFollowUps.push(item);
  }

  for (const activity of followUpLeadActivities) {
    if (!activity.client_id) continue;
    const client = followUpClientMap.get(activity.client_id);
    if (!client) continue;

    addSuggestedFollowUp({
      id: `lead-follow-up-${activity.id}`,
      personName: followUpName(client),
      reason: "A lead follow-up is due or overdue.",
      suggestedAction:
        "Reach out, update the lead status, or schedule the next follow-up.",
      context: compactList([
        client.referral_source ? `Source: ${client.referral_source}` : null,
        activity.follow_up_due_at
          ? `Follow-up due: ${fmtDateTime(activity.follow_up_due_at, studioTimeZone)}`
          : null,
      ]),
      href: `/app/leads?focus=${client.id}`,
      priority: "high",
      type: "lead",
    });
  }

  for (const pkg of followUpPackages) {
    if (!pkg.client_id) continue;
    const finiteRemaining = (pkg.client_package_items ?? [])
      .filter((item) => !item.is_unlimited)
      .map((item) => toNumericValue(item.quantity_remaining))
      .filter((value): value is number => value !== null);

    if (finiteRemaining.length === 0) continue;

    const lowestRemaining = Math.min(...finiteRemaining);
    if (lowestRemaining > 2) continue;

    const client = followUpClientMap.get(pkg.client_id);
    if (!client) continue;

    addSuggestedFollowUp({
      id: `low-package-${pkg.id}`,
      personName: followUpName(client),
      reason: `${pkg.name_snapshot || "Package"} is running low with ${lowestRemaining} credit${lowestRemaining === 1 ? "" : "s"} remaining.`,
      suggestedAction:
        "Send a package renewal reminder before the client runs out of credits.",
      context: compactList([
        pkg.name_snapshot ? `Package: ${pkg.name_snapshot}` : null,
        `Credits remaining: ${lowestRemaining}`,
      ]),
      href: `/app/clients/${pkg.client_id}`,
      priority: lowestRemaining === 0 ? "high" : "medium",
      type: "package",
    });
  }

  for (const client of followUpClients) {
    if (client.status !== "active") continue;
    if (clientIdsWithUpcomingAppointments.has(client.id)) continue;

    addSuggestedFollowUp({
      id: `no-upcoming-${client.id}`,
      personName: followUpName(client),
      reason: "Active client has no upcoming appointment on the schedule.",
      suggestedAction:
        "Invite them to book their next lesson or check whether they need help scheduling.",
      context: client.referral_source
        ? `Source: ${client.referral_source}`
        : undefined,
      href: `/app/clients/${client.id}`,
      priority: "medium",
      type: "client",
    });
  }

  for (const registration of followUpEventRegistrations) {
    if (!registration.client_id) continue;
    if (clientIdsWithUpcomingAppointments.has(registration.client_id)) continue;

    const client = followUpClientMap.get(registration.client_id);
    const personName =
      followUpName(client) ||
      [registration.attendee_first_name, registration.attendee_last_name]
        .filter(Boolean)
        .join(" ") ||
      registration.attendee_email ||
      "Event attendee";
    const eventName = getEventRelationName(registration.events);

    addSuggestedFollowUp({
      id: `event-attendee-${registration.id}`,
      personName,
      reason: `Recent event attendee from ${eventName} has no upcoming appointment scheduled.`,
      suggestedAction:
        "Follow up after the event and invite them into the next class, lesson, or offer.",
      context: compactList([
        `Event: ${eventName}`,
        registration.payment_status
          ? `Payment: ${registration.payment_status}`
          : null,
      ]),
      href: registration.client_id
        ? `/app/clients/${registration.client_id}`
        : "/app/events/registrations",
      priority: "low",
      type: "event_attendee",
    });
  }

  for (const lifecycleItem of lifecycleSnapshot.queue.slice(0, 25)) {
    if (
      ![
        "retention_risk",
        "conversion_pending",
        "needs_rebooking",
        "new_lead",
        "contacted",
        "inactive",
      ].includes(lifecycleItem.stage)
    ) {
      continue;
    }

    addSuggestedFollowUp({
      id: `lifecycle-${lifecycleItem.clientId}-${lifecycleItem.stage}`,
      personName: lifecycleItem.clientName,
      reason: lifecycleItem.riskReason ?? lifecycleItem.description,
      suggestedAction: lifecycleItem.nextExpectedStep,
      context: `Journey: ${lifecycleItem.label}`,
      href: lifecycleItem.action.href ?? `/app/clients/${lifecycleItem.clientId}`,
      priority:
        lifecycleItem.risk === "high"
          ? "high"
          : lifecycleItem.risk === "watch"
            ? "medium"
            : "low",
      type: "client",
    });
  }

  const priorityRank: Record<SuggestedFollowUpItem["priority"], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  suggestedFollowUps.sort(
    (a, b) => priorityRank[a.priority] - priorityRank[b.priority],
  );

  const clientIds = Array.from(
    new Set(
      typedAppointments
        .map((item) => item.client_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const instructorIds = Array.from(
    new Set(
      typedAppointments
        .map((item) => item.instructor_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const roomIds = Array.from(
    new Set(
      typedAppointments
        .map((item) => item.room_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const [clientRowsResult, instructorRowsResult, roomRowsResult] =
    await Promise.all([
      clientIds.length > 0
        ? supabase
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", clientIds)
        : Promise.resolve({ data: [], error: null }),
      instructorIds.length > 0
        ? supabase
            .from("instructors")
            .select("id, first_name, last_name")
            .in("id", instructorIds)
        : Promise.resolve({ data: [], error: null }),
      roomIds.length > 0
        ? supabase.from("rooms").select("id, name").in("id", roomIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

  if (clientRowsResult.error) {
    throw new Error(
      `Failed to load appointment clients: ${clientRowsResult.error.message}`,
    );
  }

  if (instructorRowsResult.error) {
    throw new Error(
      `Failed to load appointment instructors: ${instructorRowsResult.error.message}`,
    );
  }

  if (roomRowsResult.error) {
    throw new Error(
      `Failed to load appointment rooms: ${roomRowsResult.error.message}`,
    );
  }

  const clientMap = new Map(
    ((clientRowsResult.data ?? []) as AppointmentClientRow[]).map((client) => [
      client.id,
      client,
    ]),
  );
  const instructorMap = new Map(
    ((instructorRowsResult.data ?? []) as AppointmentInstructorRow[]).map(
      (instructor) => [instructor.id, instructor],
    ),
  );
  const roomMap = new Map(
    ((roomRowsResult.data ?? []) as AppointmentRoomRow[]).map((room) => [
      room.id,
      room,
    ]),
  );

  const activeMembershipsCount = typedMemberships.filter(
    (item) => item.status === "active",
  ).length;
  const activePackagesCount = typedPackages.filter((item) =>
    Boolean(item.active),
  ).length;
  const { data: linkedDashboardAccounts } = await supabase
    .from("client_account_links")
    .select("client_id")
    .eq("studio_id", studioId)
    .eq("status", "linked");

  const linkedDashboardClientIds = new Set(
    (linkedDashboardAccounts ?? []).map((row) => String(row.client_id)),
  );
  const invitedPortalUsersCount = typedClients.filter((client) =>
    linkedDashboardClientIds.has(client.id),
  ).length;
  const clientsWithBirthdayTiming = typedClients.map((client) => ({
    ...client,
    daysUntilBirthday: getDaysUntilBirthday(client.birthday),
    hasMailingAddress: hasMailingAddress(client),
  }));
  const upcomingBirthdays7Count = clientsWithBirthdayTiming.filter(
    (client) =>
      client.daysUntilBirthday !== null && client.daysUntilBirthday <= 7,
  ).length;
  const upcomingBirthdays30Count = clientsWithBirthdayTiming.filter(
    (client) =>
      client.daysUntilBirthday !== null && client.daysUntilBirthday <= 30,
  ).length;
  const birthdayCardReadyCount = clientsWithBirthdayTiming.filter(
    (client) =>
      client.daysUntilBirthday !== null &&
      client.daysUntilBirthday <= 30 &&
      client.hasMailingAddress,
  ).length;
  const missingBirthdayCount = typedClients.filter(
    (client) => !client.birthday,
  ).length;
  const missingMailingAddressCount = typedClients.filter(
    (client) => !hasMailingAddress(client),
  ).length;

  const studioOnboardingTasks: WorkspaceOnboardingTask[] = [
    {
      key: "settings",
      title: "Review studio settings",
      description:
        "Confirm your studio profile, public details, and basic workspace settings.",
      href: "/app/settings",
      complete: Boolean(workspace?.name),
    },
    {
      key: "instructors",
      title: "Add instructors",
      description:
        "Add at least one instructor so schedules and lessons can be assigned.",
      href: "/app/instructors",
      complete: typedInstructors.length > 0,
    },
    {
      key: "clients",
      title: "Add or import clients",
      description:
        "Add your first student/client record or import your client list.",
      href: "/app/clients",
      complete: typedClients.length > 0,
    },
    {
      key: "packages",
      title: "Create or sell packages",
      description:
        "Set up lesson package activity so balances and attendance can be tracked.",
      href: "/app/packages",
      complete: activePackagesCount > 0,
    },
    {
      key: "schedule",
      title: "Add your first schedule item",
      description:
        "Create a lesson, class, or room activity so the calendar starts working for your team.",
      href: "/app/schedule",
      complete: typedAppointments.length > 0,
    },
    {
      key: "payouts",
      title: "Connect billing and payouts",
      description:
        "Enable billing and payouts before relying on paid packages, memberships, or events.",
      href: "/app/settings/billing",
      complete: payoutsReady,
    },
    {
      key: "portal-invites",
      title: "Invite students to the portal",
      description:
        "Send at least one portal invite so students can access their schedule and account details.",
      href: "/app/clients",
      complete: invitedPortalUsersCount > 0,
    },
  ];

  const studioOnboardingComplete =
    studioOnboardingTasks.length > 0 &&
    studioOnboardingTasks.every((task) => task.complete);

  const showStudioOnboarding =
    !onboardingDismissed &&
    !onboardingCompleted &&
    !studioOnboardingComplete &&
    studioOnboardingTasks.some((task) => !task.complete);

  const recordStudioOnboardingCompletion =
    !onboardingDismissed && !onboardingCompleted && studioOnboardingComplete;

  const upcomingAppointments = typedAppointments.filter((item) => {
    const normalizedStatus = (item.status ?? "").trim().toLowerCase();
    return normalizedStatus !== "cancelled" && normalizedStatus !== "completed";
  });

  const { data: activeAriaGoalRows, error: activeAriaGoalError } =
    await supabase
      .from("aria_goals")
      .select(
        "id, title, goal_type, focus_area, target_value, current_value, target_unit, timeline_days, starts_at, target_date, status, plan_summary, updated_at",
      )
      .eq("studio_id", studioId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1);

  if (activeAriaGoalError) {
    throw new Error(
      `Failed to load dashboard ARIA goal: ${activeAriaGoalError.message}`,
    );
  }

  const activeAriaGoal =
    ((activeAriaGoalRows ?? []) as DashboardAriaGoalRow[])[0] ?? null;

  const activeAriaGoalProgress = activeAriaGoal
    ? getAriaGoalProgressPercent(
        activeAriaGoal.current_value,
        activeAriaGoal.target_value,
      )
    : null;

  const activeAriaGoalTimeline = activeAriaGoal
    ? getAriaGoalTimelinePercent(
        activeAriaGoal.starts_at,
        activeAriaGoal.target_date,
      )
    : null;

  const activeAriaGoalTarget = activeAriaGoal
    ? formatAriaGoalValue(
        activeAriaGoal.target_value,
        activeAriaGoal.target_unit,
      )
    : null;

  const activeAriaGoalCurrent =
    activeAriaGoal && activeAriaGoal.current_value !== null
      ? formatAriaGoalValue(
          activeAriaGoal.current_value,
          activeAriaGoal.target_unit,
        )
      : null;

  const activeAriaGoalMetric = activeAriaGoal
    ? [
        activeAriaGoalCurrent
          ? `${activeAriaGoalCurrent} current`
          : activeAriaGoalProgress !== null
            ? `${activeAriaGoalProgress}% progress`
            : null,
        activeAriaGoalTimeline !== null
          ? `${activeAriaGoalTimeline}% timeline`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const planBadge = planLabel;

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.08),transparent_26%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.08),transparent_24%),linear-gradient(180deg,var(--brand-surface)_0%,#ffffff_100%)]">
      <TodayWorkspaceHeader
        workspaceName={
          currentWorkspace?.studioName || workspace?.name || "Studio Workspace"
        }
        planLabel={planBadge}
        trialLabel={subscriptionTrialInfo?.label ?? null}
        clientCount={typedClients.length}
        upcomingCount={upcomingAppointments.length}
        membershipCount={activeMembershipsCount}
        bookingRequestCount={pendingBookingRequestCount ?? 0}
        unreadCount={unreadCount}
      />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <PlatformBroadcastAlerts alerts={visiblePlatformAlerts} />
      {recordStudioOnboardingCompletion ? (
        <OnboardingCompletionRecorder checklistType="studio" />
      ) : null}

      {showInviteAcceptedBanner ? (
        <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Access added
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Your team invitation was accepted
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-700">
            {acceptedInviteCount === 1
              ? "You now have access to a workspace through your invitation."
              : `You now have access to ${acceptedInviteCount} workspaces through your invitations.`}
          </p>
        </section>
      ) : null}

      {showStudioOnboarding ? (
        <WorkspaceOnboardingChecklist
          checklistType="studio"
          tasks={studioOnboardingTasks}
        />
      ) : null}

      {hostStudioPortalLinks.length > 0 ? (
        <section className="rounded-[32px] border border-[#E9D5FF] bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
            Independent Instructor Portal Access
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Host studio portals are available
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
            You have independent instructor portal access at another studio. Use
            these links to review your floor-rental schedule, payments, and
            related host-studio activity.
          </p>

          <div className="mt-5 flex flex-wrap gap-3">
            {hostStudioPortalLinks.map((link) => (
              <Link
                key={link.client_id}
                href={`/portal/${link.studio_slug}`}
                className="inline-flex items-center justify-center rounded-xl bg-[#6B21A8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#581C87]"
              >
                Open {link.studio_name} Portal
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {activeAriaGoal ? (
        <AriaInsightCard
          eyebrow="ARIA Goal"
          title={`Active goal: ${activeAriaGoal.title}`}
          insight={`ARIA is tracking this ${activeAriaGoal.goal_type.replaceAll("_", " ")} goal toward ${activeAriaGoalTarget}. Keep the goal visible while your team reviews opportunities, drafts follow-ups, and updates progress.`}
          recommendation={
            activeAriaGoalProgress === null
              ? "Open the goal plan and add a current progress value so ARIA can show how close you are to the target."
              : "Review your goal plan, automation recommendations, and open follow-up work so ARIA can keep momentum toward the target."
          }
          metric={activeAriaGoalMetric || undefined}
          primaryAction={{
            href: `/app/aria/goals/${activeAriaGoal.id}`,
            label: "Open goal",
          }}
          secondaryAction={{
            href: "/app/aria",
            label: "Open ARIA hub",
          }}
        />
      ) : (
        <AriaInsightCard
          eyebrow="ARIA Goal"
          title="Set a goal for ARIA to track"
          insight="Give ARIA a revenue, retention, membership, or booking goal so she can organize your studio opportunities around a clear target."
          recommendation="Create your first ARIA goal, then use the plan to connect package renewals, rebooking, follow-ups, and automations to measurable growth."
          primaryAction={{
            href: "/app/aria/goals#new-goal",
            label: "Create ARIA goal",
          }}
          secondaryAction={{
            href: "/app/aria",
            label: "Open ARIA hub",
          }}
        />
      )}

      <TodayActionQueue
        bookingRequestCount={pendingBookingRequestCount ?? 0}
        unreadCount={unreadCount}
        payoutsReady={payoutsReady}
        followUps={suggestedFollowUps}
        appointments={upcomingAppointments.map((appointment) => {
          const client = appointment.client_id
            ? clientMap.get(appointment.client_id)
            : null;
          const instructor = appointment.instructor_id
            ? instructorMap.get(appointment.instructor_id)
            : null;
          const room = appointment.room_id
            ? roomMap.get(appointment.room_id)
            : null;

          return {
            id: appointment.id,
            title:
              appointment.title?.trim() ||
              appointmentTypeLabel(appointment.appointment_type),
            typeLabel: appointmentTypeLabel(appointment.appointment_type),
            dateTime: fmtDateTime(appointment.starts_at, studioTimeZone),
            detail:
              compactList([
                fullName(client) ? `Client: ${fullName(client)}` : null,
                fullName(instructor)
                  ? `Instructor: ${fullName(instructor)}`
                  : null,
                room?.name ? `Room: ${room.name}` : null,
              ]) || "No client, instructor, or room assigned yet.",
            href: `/app/schedule/${appointment.id}`,
          };
        })}
        notifications={typedNotifications.map((notification) => ({
          id: notification.id,
          title: notification.title,
          body: notification.body,
          unread: !notification.read_at,
        }))}
        birthdays={{
          next7: upcomingBirthdays7Count,
          next30: upcomingBirthdays30Count,
          cardReady: birthdayCardReadyCount,
          missingBirthday: missingBirthdayCount,
          missingAddress: missingMailingAddressCount,
        }}
        planLabel={planBadge}
        lifecycle={{
          conversionPending: lifecycleSnapshot.counts.conversion_pending,
          needsRebooking: lifecycleSnapshot.counts.needs_rebooking,
          retentionRisk: lifecycleSnapshot.counts.retention_risk,
          inactive: lifecycleSnapshot.counts.inactive,
        }}
      />
      </div>
    </main>
  );
}
