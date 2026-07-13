import Link from "next/link";
import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CreditCard,
  Globe2,
  Layers3,
  Sparkles,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { dismissWorkspaceOnboardingAction } from "@/app/app/onboarding-actions";
import { OnboardingCompletionRecorder } from "@/app/app/OnboardingCompletionRecorder";

type ChecklistType = "studio" | "organizer";

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

type LaunchGroup = {
  key: LaunchGroupKey;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
};

const LAUNCH_GROUPS: LaunchGroup[] = [
  {
    key: "essentials",
    title: "Essentials",
    description: "The minimum setup needed to operate the workspace.",
    icon: Layers3,
  },
  {
    key: "revenue",
    title: "Revenue Setup",
    description: "Payment and sales steps that make revenue trackable.",
    icon: CreditCard,
  },
  {
    key: "student_experience",
    title: "Student Experience",
    description: "Access and self-service pieces that reduce front-desk work.",
    icon: Users,
  },
  {
    key: "public_growth",
    title: "Public Growth",
    description: "Discovery settings that help new dancers find you.",
    icon: Globe2,
  },
];

const STUDIO_LAUNCH_GOALS = [
  {
    title: "Start scheduling",
    description: "Get instructors, clients, and the calendar working first.",
  },
  {
    title: "Collect payments",
    description: "Prioritize packages, billing, payouts, and paid activity.",
  },
  {
    title: "Enable student self-service",
    description: "Invite students and reduce manual booking work.",
  },
  {
    title: "Grow publicly",
    description: "Prepare public profile, discovery, classes, and events.",
  },
];

const ORGANIZER_LAUNCH_GOALS = [
  {
    title: "Publish first event",
    description: "Create the event, open registration, and verify visibility.",
  },
  {
    title: "Sell tickets",
    description: "Connect payouts and confirm the paid registration path.",
  },
  {
    title: "Prepare check-in",
    description: "Make attendee, ticket, and door operations measurable.",
  },
  {
    title: "Promote publicly",
    description: "Turn on discovery and make the event easy to find.",
  },
];

function isOrganizerRole(role: string | null | undefined) {
  const normalized = (role ?? "").trim().toLowerCase();
  return normalized.startsWith("organizer_");
}

function launchTaskStatusClass(complete: boolean) {
  return complete
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-slate-200 bg-white text-slate-900";
}

function LaunchTaskCard({ task }: { task: LaunchTask }) {
  return (
    <Link
      href={task.href}
      className={`group block rounded-2xl border p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-[#D8B4FE] hover:shadow-md ${launchTaskStatusClass(
        task.complete,
      )}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 rounded-full p-1 ${
            task.complete
              ? "bg-emerald-100 text-emerald-700"
              : "bg-slate-50 text-slate-400 ring-1 ring-slate-200"
          }`}
        >
          {task.complete ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Circle className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold">{task.title}</h3>
            {!task.complete ? (
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-[#6B21A8]" />
            ) : null}
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {task.description}
          </p>
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-[#7C2D92]">
            {task.complete ? "Ready" : "Needs setup"}
          </p>
        </div>
      </div>
    </Link>
  );
}

function LaunchGroupSection({
  group,
  tasks,
}: {
  group: LaunchGroup;
  tasks: LaunchTask[];
}) {
  const completedCount = tasks.filter((task) => task.complete).length;
  const Icon = group.icon;

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-white shadow-sm">
      <div className="border-b border-[#F3E8FF] bg-gradient-to-r from-[#FCF8FF] to-white p-5">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl bg-[#F3E8FF] p-3 text-[#6B21A8]">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-950">
                {group.title}
              </h2>
              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-[#E9D5FF]">
                {completedCount} of {tasks.length} ready
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {group.description}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-5 md:grid-cols-2">
        {tasks.map((task) => (
          <LaunchTaskCard key={task.key} task={task} />
        ))}
      </div>
    </section>
  );
}

function GoalCards({ checklistType }: { checklistType: ChecklistType }) {
  const goals =
    checklistType === "organizer" ? ORGANIZER_LAUNCH_GOALS : STUDIO_LAUNCH_GOALS;

  return (
    <section className="rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
            Launch Goal
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            What do you want working first?
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            These goals are here to make setup feel directional. The checklist
            below still updates automatically from real workspace activity.
          </p>
        </div>
        <Sparkles className="hidden h-6 w-6 text-[#F97316] md:block" />
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {goals.map((goal, index) => (
          <div
            key={goal.title}
            className={`rounded-2xl border p-4 ${
              index === 0
                ? "border-[#D8B4FE] bg-[#FCF8FF]"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            <p className="text-sm font-semibold text-slate-950">
              {goal.title}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {goal.description}
            </p>
            {index === 0 ? (
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-[#7C2D92]">
                Recommended
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
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
  const allComplete = totalCount > 0 && completedCount === totalCount;
  const shouldRecordComplete =
    allComplete && !onboardingPreference?.completed_at;
  const nextTask = tasks.find((task) => !task.complete) ?? null;

  return (
    <main className="space-y-8 p-6 md:p-8">
      {shouldRecordComplete ? (
        <OnboardingCompletionRecorder checklistType={checklistType} />
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-white shadow-sm">
        <div className="bg-gradient-to-br from-[#4C1D95] via-[#6B21A8] to-[#F97316] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Launch Setup
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {checklistType === "organizer"
                  ? "Launch your event workspace"
                  : "Launch your studio workspace"}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Setup should feel fast, useful, and easy to leave. Finish what
                matters now, skip the rest until the workspace needs it.
              </p>
            </div>

            <div className="rounded-2xl bg-white/10 p-4 text-sm text-white ring-1 ring-white/15">
              <span className="text-2xl font-semibold">
                {completedCount} of {totalCount}
              </span>
              <p className="mt-1 text-white/75">ready for launch</p>
            </div>
          </div>

          <div className="mt-6 h-2 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-white transition-all"
              style={{ width: `${percentComplete}%` }}
            />
          </div>
        </div>

        <div className="grid gap-4 bg-[#FCF8FF] p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {nextTask
                ? `Recommended next: ${nextTask.title}`
                : "Your launch basics are ready."}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {nextTask
                ? nextTask.description
                : "The setup panel will stop appearing once completion is recorded."}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {nextTask ? (
              <Link
                href={nextTask.href}
                className="inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4B1465]"
              >
                Open next step
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
            <Link
              href="/app"
              className="inline-flex items-center rounded-xl border border-[#E9D5FF] bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:border-[#D8B4FE] hover:bg-white"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </section>

      <GoalCards checklistType={checklistType} />

      <div className="space-y-6">
        {LAUNCH_GROUPS.map((group) => {
          const groupTasks = tasks.filter((task) => task.group === group.key);
          if (groupTasks.length === 0) return null;

          return (
            <LaunchGroupSection
              key={group.key}
              group={group}
              tasks={groupTasks}
            />
          );
        })}
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-slate-50 p-5">
        <form
          action={dismissWorkspaceOnboardingAction}
          className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
        >
          <input type="hidden" name="checklistType" value={checklistType} />
          <div>
            <p className="text-sm font-semibold text-slate-950">
              Not ready to finish setup?
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Hide the dashboard reminder for now. You can still return to
              Launch Setup from this page link.
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
    </main>
  );
}
