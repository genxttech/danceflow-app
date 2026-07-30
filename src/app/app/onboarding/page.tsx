import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CalendarDays,
  AlertTriangle,
  Bot,
  FileUp,
  Layers3,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  dismissWorkspaceOnboardingAction,
  saveOnboardingPathAction,
} from "@/app/app/onboarding-actions";
import { OnboardingCompletionRecorder } from "@/app/app/OnboardingCompletionRecorder";
import { OnboardingProjectSyncRecorder } from "@/app/app/OnboardingProjectSyncRecorder";
import { OnboardingPilotReadiness } from "@/app/app/onboarding/OnboardingPilotReadiness";
import { OnboardingFirst30DaysHealth } from "@/app/app/onboarding/OnboardingFirst30DaysHealth";

type ChecklistType = "studio" | "organizer";

type OnboardingProjectRow = {
  id: string;
  source_system: string | null;
  onboarding_mode: string;
  status: string;
  current_phase: string;
  started_at: string;
  target_go_live_date: string;
  readiness_score: number;
};

type OnboardingExceptionRow = { id: string; title: string; severity: string; status: string };
type OnboardingDecisionRow = { id: string; title: string; status: string; due_at: string | null };

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function daysRemaining(value: string | null | undefined) {
  if (!value) return 30;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400000));
}

function labelize(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Not selected";
}

type WorkspaceRow = {
  id: string;
  name: string | null;
  stripe_connected_account_id: string | null;
};

type WorkspaceOnboardingPreferenceRow = {
  id: string;
  dismissed_at: string | null;
  completed_at: string | null;
};

type LaunchGroupKey =
  | "essentials"
  | "revenue"
  | "student_experience"
  | "public_growth";

type LaunchTask = {
  key: string;
  title: string;
  description: string;
  href: string;
  complete: boolean;
  group: LaunchGroupKey;
};


const STUDIO_STAGE_LABELS: Record<LaunchGroupKey, string> = {
  essentials: "Essentials",
  revenue: "Revenue setup",
  student_experience: "Student access",
  public_growth: "Public launch",
};

function isOrganizerRole(role: string | null | undefined) {
  const normalized = (role ?? "").trim().toLowerCase();
  return normalized.startsWith("organizer_");
}

function taskStateLabel(task: LaunchTask, nextTaskKey: string | null) {
  if (task.complete) return "Complete";
  if (task.key === nextTaskKey) return "Next";
  return "Later";
}

const STUDIO_LAUNCH_BLOCKER_KEYS = new Set([
  "settings",
  "instructors",
  "clients",
  "schedule",
  "payouts",
]);

const ORGANIZER_LAUNCH_BLOCKER_KEYS = new Set([
  "organizer-profile",
  "create-event",
  "payouts",
  "publish-event",
]);

function isLaunchBlocker(taskKey: string, checklistType: ChecklistType) {
  return checklistType === "organizer"
    ? ORGANIZER_LAUNCH_BLOCKER_KEYS.has(taskKey)
    : STUDIO_LAUNCH_BLOCKER_KEYS.has(taskKey);
}

export default async function LaunchSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const checklistType: ChecklistType = isOrganizerRole(context.studioRole)
    ? "organizer"
    : "studio";

  const { data: workspace, error: workspaceError } = await supabase
    .from("studios")
    .select("id, name, stripe_connected_account_id")
    .eq("id", studioId)
    .maybeSingle<WorkspaceRow>();

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

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
      `Failed to load launch setup preferences: ${onboardingPreferenceError.message}`,
    );
  }

  const { data: onboardingProject } = await supabase
    .from("onboarding_projects")
    .select("id, source_system, onboarding_mode, status, current_phase, started_at, target_go_live_date, readiness_score")
    .eq("studio_id", studioId)
    .eq("checklist_type", checklistType)
    .maybeSingle<OnboardingProjectRow>();

  const projectId = onboardingProject?.id ?? null;
  const [{ data: openExceptions }, { data: pendingDecisions }, { data: packPreferences }, { data: importBatches }] = await Promise.all([
    projectId
      ? supabase.from("onboarding_exceptions").select("id, title, severity, status").eq("onboarding_project_id", projectId).in("status", ["open", "in_review"]).order("created_at", { ascending: false }).limit(5)
      : Promise.resolve({ data: [] }),
    projectId
      ? supabase.from("onboarding_decisions").select("id, title, status, due_at").eq("onboarding_project_id", projectId).eq("status", "pending").order("due_at", { ascending: true, nullsFirst: false }).limit(5)
      : Promise.resolve({ data: [] }),
    supabase.from("aria_automation_pack_preferences").select("pack_key, enabled").eq("studio_id", studioId),
    supabase.from("import_batches").select("id, status, import_type, created_at").eq("studio_id", studioId).order("created_at", { ascending: false }).limit(10),
  ]);

  const typedExceptions = (openExceptions ?? []) as OnboardingExceptionRow[];
  const typedDecisions = (pendingDecisions ?? []) as OnboardingDecisionRow[];
  const enabledAriaPacks = (packPreferences ?? []).filter((row) => row.enabled !== false).length;
  const latestImport = (importBatches ?? [])[0] ?? null;

  const payoutsReady = Boolean(workspace?.stripe_connected_account_id);
  let tasks: LaunchTask[] = [];

  if (checklistType === "organizer") {
    const [
      { data: events, error: eventsError },
      { data: organizers, error: organizersError },
      { data: registrations, error: registrationsError },
    ] = await Promise.all([
      supabase
        .from("events")
        .select(
          "id, status, visibility, public_directory_enabled",
        )
        .eq("studio_id", studioId),
      supabase
        .from("organizers")
        .select("id, active")
        .eq("studio_id", studioId),
      supabase
        .from("event_registrations")
        .select("id, payment_status")
        .eq("studio_id", studioId)
        .limit(50),
    ]);

    if (eventsError) {
      throw new Error(`Failed to load launch events: ${eventsError.message}`);
    }
    if (organizersError) {
      throw new Error(
        `Failed to load launch organizers: ${organizersError.message}`,
      );
    }
    if (registrationsError) {
      throw new Error(
        `Failed to load launch registrations: ${registrationsError.message}`,
      );
    }

    const eventRows = (events ?? []) as Array<{
      id: string;
      status: string | null;
      visibility: string | null;
      public_directory_enabled: boolean | null;
    }>;
    const organizerRows = (organizers ?? []) as Array<{
      id: string;
      active: boolean | null;
    }>;
    const registrationRows = (registrations ?? []) as Array<{
      id: string;
      payment_status: string | null;
    }>;

    const publishedCount = eventRows.filter(
      (event) => event.status === "published" || event.status === "open",
    ).length;
    const discoveryReadyCount = eventRows.filter(
      (event) =>
        event.public_directory_enabled &&
        event.visibility === "public" &&
        (event.status === "published" || event.status === "open"),
    ).length;
    const paidRegistrationCount = registrationRows.filter(
      (registration) =>
        registration.payment_status === "paid" ||
        registration.payment_status === "partial",
    ).length;

    tasks = [
      {
        key: "organizer-profile",
        title: "Confirm organizer profile",
        description:
          "Set the organizer identity that appears on event pages and operations.",
        href: "/app/settings",
        complete: organizerRows.some((organizer) => organizer.active),
        group: "essentials",
      },
      {
        key: "create-event",
        title: "Create your first event",
        description:
          "Add the event, class, workshop, competition, or showcase you want to run.",
        href: "/app/events/new",
        complete: eventRows.length > 0,
        group: "essentials",
      },
      {
        key: "payouts",
        title: "Connect payouts",
        description:
          "Enable Stripe payout readiness before relying on paid registration.",
        href: "/app/payments",
        complete: payoutsReady,
        group: "revenue",
      },
      {
        key: "registration-test",
        title: "Confirm registration flow",
        description:
          "Record one paid or partial registration so the ticket flow is proven.",
        href: "/app/events/registrations",
        complete: paidRegistrationCount > 0,
        group: "revenue",
      },
      {
        key: "publish-event",
        title: "Open an event for registration",
        description:
          "Publish or open at least one event so dancers can take action.",
        href: "/app/events",
        complete: publishedCount > 0,
        group: "student_experience",
      },
      {
        key: "discovery-ready",
        title: "Turn on public discovery",
        description:
          "Make at least one public event visible in DanceFlow discovery.",
        href: "/app/events",
        complete: discoveryReadyCount > 0,
        group: "public_growth",
      },
    ];
  } else {
    const [
      { data: clients, error: clientsError },
      { data: instructors, error: instructorsError },
      { data: appointments, error: appointmentsError },
      { data: packages, error: packagesError },
      { data: events, error: eventsError },
    ] = await Promise.all([
      supabase
        .from("clients")
        .select("id")
        .eq("studio_id", studioId)
        .limit(50),
      supabase.from("instructors").select("id").eq("studio_id", studioId),
      supabase
        .from("appointments")
        .select("id")
        .eq("studio_id", studioId)
        .limit(25),
      supabase
        .from("client_packages")
        .select("id, active")
        .eq("studio_id", studioId)
        .limit(25),
      supabase
        .from("events")
        .select("id, visibility, status, public_directory_enabled")
        .eq("studio_id", studioId)
        .limit(25),
    ]);

    if (clientsError) {
      throw new Error(`Failed to load launch clients: ${clientsError.message}`);
    }
    if (instructorsError) {
      throw new Error(
        `Failed to load launch instructors: ${instructorsError.message}`,
      );
    }
    if (appointmentsError) {
      throw new Error(
        `Failed to load launch schedule: ${appointmentsError.message}`,
      );
    }
    if (packagesError) {
      throw new Error(
        `Failed to load launch packages: ${packagesError.message}`,
      );
    }
    if (eventsError) {
      throw new Error(`Failed to load launch events: ${eventsError.message}`);
    }

    const clientRows = (clients ?? []) as Array<{ id: string }>;
    const instructorRows = (instructors ?? []) as Array<{ id: string }>;
    const appointmentRows = (appointments ?? []) as Array<{ id: string }>;
    const packageRows = (packages ?? []) as Array<{
      id: string;
      active: boolean | null;
    }>;
    const eventRows = (events ?? []) as Array<{
      id: string;
      visibility: string | null;
      status: string | null;
      public_directory_enabled: boolean | null;
    }>;

    const activePackageCount = packageRows.filter((row) => row.active).length;
    const { data: linkedAccounts } = await supabase
      .from("client_account_links")
      .select("client_id")
      .eq("studio_id", studioId)
      .eq("status", "linked");

    const linkedClientIds = new Set(
      (linkedAccounts ?? []).map((row) => String(row.client_id)),
    );
    const invitedPortalCount = clientRows.filter((row) =>
      linkedClientIds.has(row.id),
    ).length;
    const publicEventCount = eventRows.filter(
      (event) =>
        event.public_directory_enabled &&
        event.visibility === "public" &&
        (event.status === "published" || event.status === "open"),
    ).length;

    tasks = [
      {
        key: "settings",
        title: "Review studio profile",
        description:
          "Confirm the studio name, public details, and core workspace settings.",
        href: "/app/settings",
        complete: Boolean(workspace?.name),
        group: "essentials",
      },
      {
        key: "instructors",
        title: "Add instructors",
        description:
          "Add at least one instructor so lessons and classes can be assigned.",
        href: "/app/instructors",
        complete: instructorRows.length > 0,
        group: "essentials",
      },
      {
        key: "clients",
        title: "Add or import clients",
        description:
          "Create the first client record or import the student list.",
        href: "/app/clients",
        complete: clientRows.length > 0,
        group: "essentials",
      },
      {
        key: "schedule",
        title: "Add first schedule item",
        description:
          "Put one lesson, class, or room activity on the calendar.",
        href: "/app/schedule",
        complete: appointmentRows.length > 0,
        group: "essentials",
      },
      {
        key: "packages",
        title: "Create or sell packages",
        description:
          "Set up paid lesson activity so balances and usage can be tracked.",
        href: "/app/packages",
        complete: activePackageCount > 0,
        group: "revenue",
      },
      {
        key: "payouts",
        title: "Connect billing and payouts",
        description:
          "Enable payment collection before relying on paid packages, memberships, or events.",
        href: "/app/settings/billing",
        complete: payoutsReady,
        group: "revenue",
      },
      {
        key: "portal-invites",
        title: "Invite students to the portal",
        description:
          "Send at least one invite so students can access their schedule and account.",
        href: "/app/clients",
        complete: invitedPortalCount > 0,
        group: "student_experience",
      },
      {
        key: "public-growth",
        title: "Publish a public class or event",
        description:
          "Make at least one public listing discovery-ready for new dancers.",
        href: "/app/events",
        complete: publicEventCount > 0,
        group: "public_growth",
      },
    ];
  }

  const completedCount = tasks.filter((task) => task.complete).length;
  const totalCount = tasks.length;
  const percentComplete =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const launchBlockers = tasks.filter((task) =>
    isLaunchBlocker(task.key, checklistType),
  );
  const unresolvedLaunchBlockers = launchBlockers.filter(
    (task) => !task.complete,
  );
  const launchReady =
    launchBlockers.length > 0 && unresolvedLaunchBlockers.length === 0;

  const recommendedTasks = tasks.filter(
    (task) => !isLaunchBlocker(task.key, checklistType),
  );
  const incompleteRecommendations = recommendedTasks.filter(
    (task) => !task.complete,
  );

  const shouldRecordComplete =
    launchReady && !onboardingPreference?.completed_at;
  const nextTask =
    unresolvedLaunchBlockers[0] ??
    incompleteRecommendations[0] ??
    null;

  const nextTaskKey = nextTask?.key ?? null;
  const completedTasks = tasks.filter((task) => task.complete);
  const attentionCount = typedDecisions.length + typedExceptions.length;

  return (
    <main className="space-y-6 p-6 md:p-8">
      <OnboardingProjectSyncRecorder
        checklistType={checklistType}
        readinessScore={percentComplete}
        nextMilestoneKey={nextTask?.key ?? null}
        milestones={tasks.map((task, index) => ({
          key: task.key,
          title: task.title,
          domain: task.group,
          complete: task.complete,
          sequence: index + 1,
        }))}
      />

      {shouldRecordComplete ? (
        <OnboardingCompletionRecorder checklistType={checklistType} />
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-white shadow-sm">
        <div className="bg-gradient-to-br from-[#4C1D95] via-[#6B21A8] to-[#F97316] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                30-day guided onboarding
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {launchReady
                  ? "Your workspace is ready to launch"
                  : nextTask
                    ? nextTask.title
                    : "Finish your DanceFlow setup"}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {launchReady
                  ? "Your launch blockers are cleared. Recommendations can be completed before or after go-live."
                  : nextTask?.description ??
                    "DanceFlow will guide you through the next setup step and keep everything else out of the way until it matters."}
              </p>
            </div>

            <div className="min-w-[190px] rounded-2xl bg-white/10 p-4 ring-1 ring-white/15">
              <div className="flex items-end justify-between gap-3">
                <span className="text-3xl font-semibold">{percentComplete}%</span>
                <span className="text-xs font-semibold text-white/70">
                  {completedCount} of {totalCount} complete
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-white transition-all"
                  style={{ width: `${percentComplete}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 bg-[#FCF8FF] p-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7C2D92]">
              One next action
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-950">
              {nextTask
                ? `Continue with ${nextTask.title.toLowerCase()}`
                : "Review final launch readiness"}
            </p>
          </div>
          <Link
            href={nextTask?.href ?? "/app/onboarding"}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#5B197A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#4B1465]"
          >
            {nextTask ? "Continue setup" : "Review readiness"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section className="rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Implementation path
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Tell DanceFlow where you are starting
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Your source determines the migration guidance, mapping, reconciliation, and launch sequence.
            </p>
          </div>
          <span className="self-start rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700 ring-1 ring-orange-200">
            {daysRemaining(onboardingProject?.target_go_live_date)} days remaining
          </span>
        </div>

        <form
          action={saveOnboardingPathAction}
          className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <input type="hidden" name="checklistType" value={checklistType} />
          <select
            name="sourceSystem"
            defaultValue={onboardingProject?.source_system ?? "new_studio"}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800"
          >
            <option value="new_studio">Starting fresh</option>
            <option value="mindbody">Mindbody</option>
            <option value="wellnessliving">WellnessLiving</option>
            <option value="square">Square</option>
            <option value="spreadsheets">Spreadsheets / CSV files</option>
            <option value="pike13" disabled>Pike13 — source-specific support coming soon</option>
            <option value="vagaro" disabled>Vagaro — source-specific support coming soon</option>
            <option value="studio_director" disabled>Studio Director — source-specific support coming soon</option>
            <option value="other">Other system / guided import</option>
          </select>
          <button
            type="submit"
            className="rounded-2xl bg-[#5B197A] px-5 py-3 text-sm font-semibold text-white hover:bg-[#4B1465]"
          >
            Save path
          </button>
        </form>

        <div className="mt-5 flex gap-3 overflow-x-auto pb-1">
          {[
            { label: "Source", value: labelize(onboardingProject?.source_system), icon: FileUp },
            { label: "Current phase", value: labelize(onboardingProject?.current_phase ?? "essentials"), icon: Layers3 },
            { label: "Target launch", value: formatDate(onboardingProject?.target_go_live_date), icon: CalendarDays },
            {
              label: "ARIA defaults",
              value: enabledAriaPacks > 0 ? `${enabledAriaPacks} packs active` : "Activates automatically",
              icon: Bot,
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className="w-60 shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <Icon className="h-5 w-5 text-[#6B21A8]" />
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  {item.label}
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-950">
                  {item.value}
                </p>
              </div>
            );
          })}
        </div>

        {latestImport ? (
          <p className="mt-4 text-xs text-slate-500">
            Latest import: {labelize(String(latestImport.import_type))} · {labelize(String(latestImport.status))}
          </p>
        ) : null}
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div
          className={`rounded-[24px] border p-4 ${
            launchReady
              ? "border-emerald-200 bg-emerald-50"
              : "border-orange-200 bg-orange-50"
          }`}
        >
          <p
            className={`text-xs font-semibold uppercase tracking-[0.16em] ${
              launchReady ? "text-emerald-700" : "text-orange-700"
            }`}
          >
            Go-live blockers
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-950">
            {launchReady
              ? "No blockers remaining"
              : `${unresolvedLaunchBlockers.length} blocker${
                  unresolvedLaunchBlockers.length === 1 ? "" : "s"
                } remaining`}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Only operational requirements can hold launch. Growth and adoption recommendations do not.
          </p>
        </div>

        <div className="rounded-[24px] border border-violet-200 bg-violet-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
            Recommendations
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-950">
            {incompleteRecommendations.length} optional improvement{incompleteRecommendations.length === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            These improve adoption, self-service, or growth but do not prevent the studio from going live.
          </p>
        </div>
      </section>

      {attentionCount > 0 ? (
        <section className="rounded-[28px] border border-orange-200 bg-orange-50/70 p-5 shadow-sm md:p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-orange-100 p-2 text-orange-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
                Needs you
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                {attentionCount} onboarding item{attentionCount === 1 ? "" : "s"} need attention
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                DanceFlow is keeping routine setup out of the way. These are the exceptions or owner decisions that still need judgment.
              </p>

              <div className="mt-4 space-y-2">
                {typedDecisions.map((decision) => (
                  <div
                    key={decision.id}
                    className="rounded-2xl border border-violet-200 bg-white p-4"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                      Owner decision
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-950">
                      {decision.title}
                    </p>
                    {decision.due_at ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Due {formatDate(decision.due_at)}
                      </p>
                    ) : null}
                  </div>
                ))}
                {typedExceptions.map((exception) => (
                  <div
                    key={exception.id}
                    className="rounded-2xl border border-orange-200 bg-white p-4"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">
                      {exception.severity} exception
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-950">
                      {exception.title}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-[24px] border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-700" />
            <div>
              <p className="text-sm font-semibold text-emerald-950">
                No onboarding exceptions need your attention.
              </p>
              <p className="mt-0.5 text-xs text-emerald-800/80">
                Continue with the recommended next action above.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Launch path
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {!launchReady
                ? `${unresolvedLaunchBlockers.length} launch blocker${
                    unresolvedLaunchBlockers.length === 1 ? "" : "s"
                  } remaining`
                : incompleteRecommendations.length > 0
                  ? "Launch ready · recommendations remain"
                  : "Core launch steps complete"}
            </h2>
          </div>
          <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
            {completedTasks.length}/{tasks.length}
          </span>
        </div>

        {nextTask ? (
          <Link
            href={nextTask.href}
            className="mt-5 flex items-start gap-3 rounded-2xl border border-[#D8B4FE] bg-[#FCF8FF] p-4 transition hover:border-[#C084FC]"
          >
            <div className="rounded-full bg-violet-100 p-1 text-violet-700">
              <Circle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                Current step · {STUDIO_STAGE_LABELS[nextTask.group]}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-950">
                {nextTask.title}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {nextTask.description}
              </p>
            </div>
            <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-violet-700" />
          </Link>
        ) : null}

        <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">
            View all launch steps
          </summary>
          <div className="border-t border-slate-200 px-4 py-2">
            {tasks.map((task) => (
              <Link
                key={task.key}
                href={task.href}
                className="flex items-center gap-3 border-b border-slate-200 py-3 last:border-b-0"
              >
                {task.complete ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900">
                    {task.title}
                  </p>
                  <p className="text-xs text-slate-500">
                    {STUDIO_STAGE_LABELS[task.group]} ·{" "}
                    {isLaunchBlocker(task.key, checklistType)
                      ? "Required for launch"
                      : "Recommended"}
                  </p>
                </div>
                <span
                  className={`text-xs font-semibold ${
                    task.complete
                      ? "text-emerald-700"
                      : task.key === nextTaskKey
                        ? "text-violet-700"
                        : "text-slate-400"
                  }`}
                >
                  {taskStateLabel(task, nextTaskKey)}
                </span>
              </Link>
            ))}
          </div>
        </details>
      </section>

      <details className="rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-800 md:px-6">
          Review detailed go-live readiness
        </summary>
        <div className="border-t border-slate-200 p-5 md:p-6">
          <OnboardingPilotReadiness
            studioId={studioId}
            projectId={onboardingProject?.id ?? null}
            targetGoLiveDate={onboardingProject?.target_go_live_date ?? null}
          />
        </div>
      </details>

      <details className="rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-800 md:px-6">
          Review first 30 days monitoring
        </summary>
        <div className="border-t border-slate-200 p-5 md:p-6">
          <OnboardingFirst30DaysHealth
            studioId={studioId}
            projectId={onboardingProject?.id ?? null}
            startedAt={onboardingProject?.started_at ?? null}
          />
        </div>
      </details>

      <section className="rounded-[24px] border border-slate-200 bg-slate-50 p-4">
        <form
          action={dismissWorkspaceOnboardingAction}
          className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
        >
          <input type="hidden" name="checklistType" value={checklistType} />
          <div>
            <p className="text-sm font-semibold text-slate-950">
              Need to leave setup for now?
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Hide the dashboard reminder. Your onboarding progress stays saved.
            </p>
          </div>
          <button
            type="submit"
            className="self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:border-[#D8B4FE] hover:text-[#6B21A8] md:self-auto"
          >
            Hide dashboard reminder
          </button>
        </form>
      </section>

      <Link
        href="/app"
        className="inline-flex text-sm font-semibold text-slate-500 hover:text-[#6B21A8]"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
