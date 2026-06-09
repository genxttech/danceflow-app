import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FileSignature,
  Package,
  Sparkles,
  Target,
  WandSparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import AriaAvatar from "@/components/app/AriaAvatar";
import AriaInsightCard from "@/components/app/AriaInsightCard";

type ClientPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  client_package_items?: {
    quantity_remaining: number | string | null;
    is_unlimited: boolean | null;
  }[] | null;
};

type BookingRequestRow = {
  id: string;
  status: string | null;
  source: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  requested_starts_at: string | null;
  created_at: string;
};

type AutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  related_table: string | null;
  related_id: string | null;
  client_id: string | null;
  created_at: string;
};

type AutomationRuleRow = {
  id: string;
  rule_key: string;
  enabled: boolean;
  mode: string;
  last_evaluated_at: string | null;
};

type AppointmentRow = {
  id: string;
  client_id: string | null;
  starts_at: string;
  status: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  created_at: string;
};

type AriaGoalRow = {
  id: string;
  title: string;
  status: string;
  target_value: number | string | null;
  current_value: number | string | null;
  target_unit: string;
  target_date: string | null;
  updated_at: string;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not scheduled";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatGoalTarget(value: number | string | null, unit: string) {
  if (value === null || value === undefined || value === "") return "Target not set";
  const numericValue = typeof value === "number" ? value : Number(value);
  const formattedValue = Number.isFinite(numericValue)
    ? numericValue.toLocaleString("en-US")
    : String(value);

  if (unit === "dollars") return `$${formattedValue}`;
  if (unit === "percent") return `${formattedValue}%`;
  return `${formattedValue} ${unit}`;
}

function personName(firstName?: string | null, lastName?: string | null, fallback = "Client") {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || fallback;
}

function asNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function packageLowestRemaining(row: ClientPackageRow) {
  const finiteItems = (row.client_package_items ?? [])
    .filter((item) => !item.is_unlimited)
    .map((item) => asNumber(item.quantity_remaining))
    .filter((value): value is number => typeof value === "number");

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems);
}

function priorityClass(priority: string) {
  if (priority === "urgent") return "border-red-200 bg-red-50 text-red-700";
  if (priority === "high") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-violet-200 bg-violet-50 text-violet-700";
}

function ruleLabel(ruleKey: string) {
  if (ruleKey === "low_package_balance") return "Low balance";
  if (ruleKey === "no_upcoming_lesson") return "Rebooking";
  if (ruleKey === "pending_booking_request") return "Booking request";
  if (ruleKey === "unsigned_document") return "Documents";
  if (ruleKey === "first_lesson_follow_up") return "First lesson";
  return "Automation";
}

function opportunityToneClass(tone: "revenue" | "booking" | "document" | "automation" | "retention") {
  if (tone === "revenue") return "border-pink-200 bg-pink-50 text-pink-700";
  if (tone === "booking") return "border-violet-200 bg-violet-50 text-violet-700";
  if (tone === "document") return "border-amber-200 bg-amber-50 text-amber-700";
  if (tone === "automation") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function OpportunityCard({
  tone,
  icon: Icon,
  title,
  metric,
  description,
  href,
  actionLabel,
}: {
  tone: "revenue" | "booking" | "document" | "automation" | "retention";
  icon: typeof Sparkles;
  title: string;
  metric: string;
  description: string;
  href: string;
  actionLabel: string;
}) {
  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl border ${opportunityToneClass(tone)}`}>
          <Icon className="h-5 w-5" />
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {metric}
        </span>
      </div>

      <h2 className="mt-4 text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>

      <Link
        href={href}
        className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
      >
        {actionLabel}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </article>
  );
}

export default async function AriaOpportunityHubPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const nowIso = new Date().toISOString();
  const ninetyDaysAgoIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const [
    packagesResult,
    pendingRequestsResult,
    automationActionsResult,
    automationRulesResult,
    recentAppointmentsResult,
    futureAppointmentsResult,
    activeClientsResult,
    ariaGoalsResult,
  ] = await Promise.all([
    supabase
      .from("client_packages")
      .select(`
        id,
        client_id,
        name_snapshot,
        active,
        client_package_items (
          quantity_remaining,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(250),

    supabase
      .from("booking_requests")
      .select("id, status, source, customer_first_name, customer_last_name, customer_email, requested_starts_at, created_at")
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(25),

    supabase
      .from("automation_actions")
      .select("id, rule_key, title, body, status, priority, related_table, related_id, client_id, created_at")
      .eq("studio_id", studioId)
      .in("status", ["suggested", "drafted"])
      .order("created_at", { ascending: false })
      .limit(25),

    supabase
      .from("automation_rules")
      .select("id, rule_key, enabled, mode, last_evaluated_at")
      .eq("studio_id", studioId),

    supabase
      .from("appointments")
      .select("id, client_id, starts_at, status")
      .eq("studio_id", studioId)
      .not("client_id", "is", null)
      .gte("starts_at", ninetyDaysAgoIso)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(300),

    supabase
      .from("appointments")
      .select("id, client_id, starts_at, status")
      .eq("studio_id", studioId)
      .not("client_id", "is", null)
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(300),

    supabase
      .from("clients")
      .select("id, first_name, last_name, status, created_at")
      .eq("studio_id", studioId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(250),

    supabase
      .from("aria_goals")
      .select("id, title, status, target_value, current_value, target_unit, target_date, updated_at")
      .eq("studio_id", studioId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(3),
  ]);

  if (packagesResult.error) {
    throw new Error(`Failed to load ARIA package opportunities: ${packagesResult.error.message}`);
  }

  if (pendingRequestsResult.error) {
    throw new Error(`Failed to load ARIA booking opportunities: ${pendingRequestsResult.error.message}`);
  }

  if (automationActionsResult.error) {
    throw new Error(`Failed to load ARIA automation actions: ${automationActionsResult.error.message}`);
  }

  if (automationRulesResult.error) {
    throw new Error(`Failed to load ARIA automation rules: ${automationRulesResult.error.message}`);
  }

  if (recentAppointmentsResult.error) {
    throw new Error(`Failed to load ARIA recent lessons: ${recentAppointmentsResult.error.message}`);
  }

  if (futureAppointmentsResult.error) {
    throw new Error(`Failed to load ARIA future lessons: ${futureAppointmentsResult.error.message}`);
  }

  if (activeClientsResult.error) {
    throw new Error(`Failed to load ARIA active clients: ${activeClientsResult.error.message}`);
  }

  if (ariaGoalsResult.error) {
    throw new Error(`Failed to load ARIA goals: ${ariaGoalsResult.error.message}`);
  }

  const packages = (packagesResult.data ?? []) as ClientPackageRow[];
  const pendingRequests = (pendingRequestsResult.data ?? []) as BookingRequestRow[];
  const automationActions = (automationActionsResult.data ?? []) as AutomationActionRow[];
  const automationRules = (automationRulesResult.data ?? []) as AutomationRuleRow[];
  const recentAppointments = (recentAppointmentsResult.data ?? []) as AppointmentRow[];
  const futureAppointments = (futureAppointmentsResult.data ?? []) as AppointmentRow[];
  const activeClients = (activeClientsResult.data ?? []) as ClientRow[];
  const activeGoals = (ariaGoalsResult.data ?? []) as AriaGoalRow[];
  const activeGoal = activeGoals[0] ?? null;

  const lowBalancePackages = packages.filter((pkg) => {
    const lowestRemaining = packageLowestRemaining(pkg);
    return typeof lowestRemaining === "number" && lowestRemaining <= 2;
  });

  const depletedPackages = lowBalancePackages.filter((pkg) => packageLowestRemaining(pkg) === 0);

  const futureClientIds = new Set(
    futureAppointments
      .filter((appointment) => (appointment.status ?? "").toLowerCase() !== "cancelled")
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );

  const recentClientIds = new Set(
    recentAppointments
      .filter((appointment) => (appointment.status ?? "").toLowerCase() !== "cancelled")
      .map((appointment) => appointment.client_id)
      .filter((id): id is string => Boolean(id)),
  );

  const rebookingClientIds = activeClients
    .filter((client) => recentClientIds.has(client.id) && !futureClientIds.has(client.id))
    .map((client) => client.id);

  const enabledRuleKeys = new Set(
    automationRules.filter((rule) => rule.enabled).map((rule) => rule.rule_key),
  );

  const recommendedAutomationCount = [
    "low_package_balance",
    "no_upcoming_lesson",
    "pending_booking_request",
    "unsigned_document",
    "first_lesson_follow_up",
  ].filter((key) => !enabledRuleKeys.has(key)).length;

  const nextBestMove =
    lowBalancePackages.length > 0
      ? {
          title: "Package renewals are the fastest revenue opportunity.",
          insight: `${lowBalancePackages.length} active package${lowBalancePackages.length === 1 ? "" : "s"} have 2 or fewer credits remaining, including ${depletedPackages.length} depleted package${depletedPackages.length === 1 ? "" : "s"}.`,
          recommendation:
            "Review low-balance clients first, then use the low package balance automation to prepare renewal follow-ups before the next lesson.",
          href: "/app/packages/client-balances",
          label: "Review balances",
          metric: `${lowBalancePackages.length} renewal lead${lowBalancePackages.length === 1 ? "" : "s"}`,
        }
      : pendingRequests.length > 0
        ? {
            title: "Booking requests need timely follow-up.",
            insight: `${pendingRequests.length} booking request${pendingRequests.length === 1 ? " is" : "s are"} waiting for staff review.`,
            recommendation:
              "Approve, decline, or contact those clients before the request turns into a missed opportunity.",
            href: "/app/schedule/requests?status=pending",
            label: "Review requests",
            metric: `${pendingRequests.length} pending`,
          }
        : rebookingClientIds.length > 0
          ? {
              title: "Rebooking is your next best move.",
              insight: `${rebookingClientIds.length} active client${rebookingClientIds.length === 1 ? "" : "s"} had a recent lesson but no future appointment scheduled.`,
              recommendation:
                "Use the no upcoming lesson automation to prepare rebooking prompts with usual-time suggestions.",
              href: "/app/automations",
              label: "Open automations",
              metric: `${rebookingClientIds.length} rebooking lead${rebookingClientIds.length === 1 ? "" : "s"}`,
            }
          : {
              title: "Your studio is ready for the next growth layer.",
              insight:
                "ARIA did not find an urgent renewal or booking backlog right now.",
              recommendation:
                "Use automations to keep the front desk rhythm consistent, then set a revenue goal when ARIA Goals becomes available.",
              href: "/app/automations",
              label: "Review automations",
              metric: "Stable",
            };

  return (
    <main className="space-y-8 p-6 md:p-8">
      <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
        <div className="relative p-6 md:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
          <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
            <AriaAvatar size="lg" />
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#BE185D]">
                ARIA Opportunity Hub
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Hi, I’m ARIA.
              </h1>
              <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-2xl border border-[#F9A8D4] bg-white/80 px-3 py-2 text-sm font-semibold text-[#831843] shadow-sm">
                <span className="rounded-full bg-[#FCE7F3] px-2.5 py-1 text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">
                  ARIA
                </span>
                <span>AI Revenue Insights Assistant</span>
              </div>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                I’m your AI Revenue Insights Assistant. My job is to help you spot the
                opportunities hiding inside your studio data, turn them into clear next
                steps, and keep you moving toward your goals.
              </p>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                I’ll help you find clients who need follow-up, packages ready for renewal,
                booking requests that need attention, documents that need signatures, and
                automations that can reduce front desk work. Think of me as your studio’s
                growth coach — I’ll help you decide what to focus on next.
              </p>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                    Starter
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    Meet ARIA
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Basic ARIA insights help point you toward the next useful action.
                  </p>
                </div>
                <div className="rounded-2xl border border-violet-200 bg-violet-50/80 p-4 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">
                    Growth
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    Unlock the opportunity hub
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Review revenue opportunities, automation recommendations, and client follow-ups.
                  </p>
                </div>
                <div className="rounded-2xl border border-pink-200 bg-pink-50/80 p-4 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-pink-700">
                    Pro
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">
                    Plan with ARIA
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Future ARIA Goals, growth plans, advanced AI recommendations, and Chat with ARIA.
                  </p>
                </div>
              </div>
            </div>
            <Link
              href="/app/automations"
              className="inline-flex items-center justify-center rounded-2xl bg-[#6B21A8] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#581C87]"
            >
              Open Automations
            </Link>
          </div>
        </div>
      </section>

      <AriaInsightCard
        eyebrow="ARIA's Next Best Move"
        title={nextBestMove.title}
        insight={nextBestMove.insight}
        recommendation={nextBestMove.recommendation}
        metric={nextBestMove.metric}
        primaryAction={{ href: nextBestMove.href, label: nextBestMove.label }}
        secondaryAction={{ href: "/app/aria", label: "Refresh hub" }}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OpportunityCard
          tone="revenue"
          icon={Package}
          title="Package renewal opportunities"
          metric={`${lowBalancePackages.length}`}
          description="Low balances are usually the fastest path to repeat revenue because the client is already active."
          href="/app/packages/client-balances"
          actionLabel="Review balances"
        />
        <OpportunityCard
          tone="retention"
          icon={CalendarDays}
          title="Rebooking opportunities"
          metric={`${rebookingClientIds.length}`}
          description="Active clients with recent lesson history but no future appointment are strong candidates for a rebooking prompt."
          href="/app/automations"
          actionLabel="Evaluate rebooking"
        />
        <OpportunityCard
          tone="booking"
          icon={ClipboardList}
          title="Pending booking requests"
          metric={`${pendingRequests.length}`}
          description="Requests should be handled quickly so interested leads and clients do not lose momentum."
          href="/app/schedule/requests?status=pending"
          actionLabel="Review requests"
        />
        <OpportunityCard
          tone="automation"
          icon={WandSparkles}
          title="Automation recommendations"
          metric={`${recommendedAutomationCount}`}
          description="ARIA recommends enabling the automations that match your current workload and follow-up patterns."
          href="/app/automations"
          actionLabel="Open rules"
        />
      </section>

      <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Active ARIA actions
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Reviewable actions from automations
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                These are suggestions and drafts created by automation evaluations. They are safe to review
                because DanceFlow does not auto-send messages from these V1 automations.
              </p>
            </div>
            <Link
              href="/app/automations"
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-slate-50"
            >
              Manage actions
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {automationActions.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
              No active automation actions yet. Enable a rule, click Evaluate now, and ARIA will surface
              reviewable next steps here.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {automationActions.slice(0, 6).map((action) => (
                <article
                  key={action.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[#6B21A8] ring-1 ring-violet-200">
                          {ruleLabel(action.rule_key)}
                        </span>
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${priorityClass(action.priority)}`}>
                          {action.priority}
                        </span>
                      </div>
                      <h3 className="mt-3 text-base font-semibold text-slate-950">
                        {action.title}
                      </h3>
                      {action.body ? (
                        <p className="mt-1 text-sm leading-6 text-slate-600">{action.body}</p>
                      ) : null}
                    </div>
                    <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                      {action.status}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            Guided workflows
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Where ARIA sends you next
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Operational pages still remain the source of truth. ARIA summarizes the decision and routes
            you into the right workflow.
          </p>

          <div className="mt-5 space-y-3">
            {[
              {
                title: "Renewal review",
                body: "Open package balances when ARIA finds low-credit clients.",
                href: "/app/packages/client-balances",
                icon: Package,
              },
              {
                title: "Booking request review",
                body: "Open the queue when a request needs approval, decline, or follow-up.",
                href: "/app/schedule/requests?status=pending",
                icon: ClipboardList,
              },
              {
                title: "Document follow-up",
                body: "Open Documents when clients still need to sign forms or waivers.",
                href: "/app/documents",
                icon: FileSignature,
              },
              {
                title: "Automation settings",
                body: "Enable and evaluate the rules that let ARIA prepare actions for staff.",
                href: "/app/automations",
                icon: Bell,
              },
            ].map((item) => {
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-[#F9A8D4] hover:bg-white"
                >
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-[#6B21A8] ring-1 ring-violet-200">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-slate-950">{item.title}</span>
                    <span className="mt-1 block text-sm leading-6 text-slate-600">{item.body}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              ARIA Goals
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Turn opportunities into a focused growth plan.
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Give ARIA a revenue, retention, membership, booking, event, or attendance goal with a
              timeline. She will organize the opportunity hub into a practical plan with focus areas,
              suggested automations, weekly milestones, and KPIs to watch.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/app/aria/goals"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#BE185D] to-[#F97316] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
              >
                Open ARIA Goals
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/app/automations"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-[#F9A8D4] hover:text-[#BE185D]"
              >
                Review automations
              </Link>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-[#FCE7F3] px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D] ring-1 ring-[#F9A8D4]">
            <Target className="h-3.5 w-3.5" />
            Goal planning
          </span>
        </div>

        {activeGoal ? (
          <div className="mt-5 rounded-2xl border border-[#F9A8D4] bg-[#FDF2F8] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">
                  Active goal
                </p>
                <h3 className="mt-2 text-base font-semibold text-slate-950">{activeGoal.title}</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Target: {formatGoalTarget(activeGoal.target_value, activeGoal.target_unit)}
                  {activeGoal.target_date ? ` by ${formatDate(activeGoal.target_date)}` : ""}.
                  {activeGoal.current_value !== null && activeGoal.current_value !== undefined
                    ? ` Current progress: ${formatGoalTarget(activeGoal.current_value, activeGoal.target_unit)}.`
                    : " Add progress updates so ARIA can track the plan."}
                </p>
              </div>
              <Link
                href={`/app/aria/goals/${activeGoal.id}`}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] ring-1 ring-[#F9A8D4]"
              >
                Open goal
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
