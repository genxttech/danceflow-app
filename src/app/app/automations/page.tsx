import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  Clock3,
  Mail,
  PauseCircle,
  PlayCircle,
  Settings2,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  completeAutomationAction,
  createAutomationEmailDraftAction,
  dismissAutomationAction,
  evaluateAutomationRuleAction,
  getAutomationDefinitions,
  queueAutomationEmailDraftAction,
  saveAutomationEmailDraftAction,
  saveAutomationEmailTemplateAction,
  updateAutomationRuleAction,
  getAutomationTemplateDefaults,
} from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
  created?: string;
  candidates?: string;
}>;

type AutomationRuleRow = {
  id: string;
  rule_key: string;
  enabled: boolean;
  mode: string;
  last_evaluated_at: string | null;
  updated_at: string | null;
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
  due_at: string | null;
  created_at: string;
};

type AutomationDraftRow = {
  id: string;
  status: string;
  subject: string | null;
  body_text: string | null;
  recipient_email: string | null;
  related_id: string | null;
  created_at: string;
  updated_at: string | null;
  sent_at: string | null;
  error_message: string | null;
};

type AutomationActionSummaryRow = {
  status: string;
  priority: string | null;
  created_at: string;
};

type AutomationDeliverySummaryRow = {
  status: string;
  related_id: string | null;
  sent_at: string | null;
  error_message: string | null;
  created_at: string;
};

type AutomationRunRow = {
  id: string;
  rule_key: string;
  status: string;
  candidates_count: number;
  actions_created_count: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
};

type AutomationTemplateRow = {
  rule_key: string;
  subject: string | null;
  body_text: string | null;
  updated_at: string | null;
};

type AutomationTemplateDefault = {
  ruleKey: string;
  subject: string;
  bodyText: string;
  variables: string[];
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not run yet";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function modeLabel(mode: string) {
  if (mode === "draft") return "Draft before send";
  if (mode === "auto_send") return "Send automatically";
  return "Suggestion only";
}

function ruleBadge(ruleKey: string) {
  if (ruleKey === "low_package_balance") return "Packages";
  if (ruleKey === "no_upcoming_lesson") return "Scheduling";
  if (ruleKey === "unsigned_document") return "Documents";
  if (ruleKey === "pending_booking_request") return "Booking";
  if (ruleKey === "first_lesson_follow_up") return "Retention";
  return "Automation";
}

function priorityClasses(priority: string) {
  if (priority === "urgent") return "border-red-200 bg-red-50 text-red-700";
  if (priority === "high") return "border-amber-200 bg-amber-50 text-amber-700";
  if (priority === "low") return "border-slate-200 bg-slate-50 text-slate-500";
  return "border-violet-200 bg-violet-50 text-violet-700";
}

function deliveryStatusLabel(status: string | null | undefined) {
  if (status === "draft") return "Draft";
  if (status === "queued") return "Queued for send";
  if (status === "sent") return "Sent";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return status || "Not drafted";
}

function deliveryStatusClasses(status: string | null | undefined) {
  if (status === "sent") return "bg-emerald-50 text-emerald-700";
  if (status === "queued") return "bg-blue-50 text-blue-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "skipped") return "bg-slate-100 text-slate-600";
  return "bg-pink-50 text-[#BE185D]";
}

const AUTOMATION_TEMPLATE_SAMPLE_VALUES: Record<string, string> = {
  client_first_name: "Chris",
  client_name: "Chris Sheppard",
  studio_name: "Michael Curtis Studio",
  package_name: "Beginner Package",
  remaining_credits: "1",
  portal_link: "https://www.idanceflow.com/portal/your-studio",
  schedule_link: "https://www.idanceflow.com/portal/your-studio/schedule",
  documents_link: "https://www.idanceflow.com/portal/your-studio/documents",
  document_name: "Liability Waiver",
  requested_time: "Friday, June 12 at 6:00 PM",
  lesson_time: "Tuesday at 6:00 PM",
};

function renderTemplatePreview(template: string, variables: string[]) {
  const knownVariables = new Set([
    ...variables,
    ...Object.keys(AUTOMATION_TEMPLATE_SAMPLE_VALUES),
  ]);

  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, variableName) => {
    if (!knownVariables.has(variableName)) {
      return match;
    }

    return AUTOMATION_TEMPLATE_SAMPLE_VALUES[variableName] ?? match;
  });
}

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context.studioId) {
    redirect("/app");
  }

  const canManage = canManageSettings(context.studioRole ?? "");
  const automationDefinitions = await getAutomationDefinitions();
  const templateDefaults = (await getAutomationTemplateDefaults()) as AutomationTemplateDefault[];

  const [
    { data: rules },
    { data: actions },
    { data: runs },
    { data: templates },
    { data: actionSummary },
    { data: deliverySummary },
  ] = await Promise.all([
    supabase
      .from("automation_rules")
      .select("id, rule_key, enabled, mode, last_evaluated_at, updated_at")
      .eq("studio_id", context.studioId),
    supabase
      .from("automation_actions")
      .select(
        "id, rule_key, title, body, status, priority, related_table, related_id, client_id, due_at, created_at"
      )
      .eq("studio_id", context.studioId)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("automation_runs")
      .select(
        "id, rule_key, status, candidates_count, actions_created_count, started_at, finished_at, error_message"
      )
      .eq("studio_id", context.studioId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("automation_email_templates")
      .select("rule_key, subject, body_text, updated_at")
      .eq("studio_id", context.studioId),
    supabase
      .from("automation_actions")
      .select("status, priority, created_at")
      .eq("studio_id", context.studioId),
    supabase
      .from("outbound_deliveries")
      .select("status, related_id, sent_at, error_message, created_at")
      .eq("studio_id", context.studioId)
      .eq("related_table", "automation_actions"),
  ]);

  const typedActions = (actions ?? []) as AutomationActionRow[];
  const actionIds = typedActions.map((action) => action.id);
  const { data: drafts } =
    actionIds.length > 0
      ? await supabase
          .from("outbound_deliveries")
          .select("id, status, subject, body_text, recipient_email, related_id, created_at, updated_at, sent_at, error_message")
          .eq("studio_id", context.studioId)
          .eq("related_table", "automation_actions")
          .in("related_id", actionIds)
          .order("created_at", { ascending: false })
      : { data: [] };

  const draftByActionId = new Map(
    ((drafts ?? []) as AutomationDraftRow[]).map((draft) => [String(draft.related_id), draft])
  );

  const ruleByKey = new Map(
    ((rules ?? []) as AutomationRuleRow[]).map((rule) => [rule.rule_key, rule])
  );
  const templateByRuleKey = new Map(
    ((templates ?? []) as AutomationTemplateRow[]).map((template) => [template.rule_key, template])
  );
  const defaultTemplateByRuleKey = new Map(
    templateDefaults.map((template) => [template.ruleKey, template])
  );
  const typedRuns = (runs ?? []) as AutomationRunRow[];

  const enabledCount = automationDefinitions.filter(
    (definition) => ruleByKey.get(definition.key)?.enabled
  ).length;
  const suggestionCount = typedActions.filter((action) =>
    ["suggested", "drafted"].includes(action.status)
  ).length;
  const latestRun = typedRuns[0];
  const typedActionSummary = (actionSummary ?? []) as AutomationActionSummaryRow[];
  const typedDeliverySummary = (deliverySummary ?? []) as AutomationDeliverySummaryRow[];
  const summarySuggestedCount = typedActionSummary.filter(
    (action) => action.status === "suggested"
  ).length;
  const summaryDraftedCount = typedActionSummary.filter(
    (action) => action.status === "drafted"
  ).length;
  const summaryQueuedCount = typedDeliverySummary.filter(
    (delivery) => delivery.status === "queued"
  ).length;
  const summarySentCount = typedDeliverySummary.filter(
    (delivery) => delivery.status === "sent"
  ).length;
  const summaryFailedCount = typedDeliverySummary.filter(
    (delivery) => delivery.status === "failed"
  ).length;
  const summaryCompletedCount = typedActionSummary.filter(
    (action) => action.status === "completed"
  ).length;
  const summaryDismissedCount = typedActionSummary.filter(
    (action) => action.status === "dismissed"
  ).length;

  return (
    <main className="min-h-screen bg-[#F8F5FF] px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[32px] border border-white/70 bg-gradient-to-br from-[#2D0A46] via-[#6B21A8] to-[#DB2777] p-6 text-white shadow-xl sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[1.4fr_0.8fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-pink-100">
                <WandSparkles className="h-3.5 w-3.5" />
                Studio follow-up
              </div>
              <h1 className="mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
                Let DanceFlow handle more of the everyday follow-up.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-pink-50 sm:text-base">
                Choose how DanceFlow handles routine follow-up: flag it for review, prepare an editable draft, or send the approved message automatically.
              </p>
            </div>

            <div className="rounded-3xl border border-white/20 bg-white/10 p-5 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-100">
                ARIA-ready
              </p>
              <p className="mt-2 text-2xl font-semibold">{enabledCount} enabled</p>
              <p className="mt-1 text-sm text-pink-50">
                {suggestionCount} suggested actions waiting for review.
              </p>
              <Link
                href="/app/notifications?category=automation"
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-white underline decoration-white/40 underline-offset-4"
              >
                View automation alerts
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          {[
            {
              step: "1",
              title: "Choose the follow-up",
              detail: "Turn on only the client situations your studio wants DanceFlow to watch.",
            },
            {
              step: "2",
              title: "Choose the level of control",
              detail: "Keep a suggestion, prepare a draft, or send your approved template automatically.",
            },
            {
              step: "3",
              title: "Review the outcome",
              detail: "Use the activity and delivery sections to catch failures and see what was completed.",
            },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-3xl border border-violet-100 bg-white p-5 shadow-sm"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#6B21A8] text-sm font-bold text-white">
                {item.step}
              </span>
              <h2 className="mt-3 text-base font-semibold text-slate-950">
                {item.title}
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {item.detail}
              </p>
            </div>
          ))}
        </section>

        {query.success === "updated" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            Automation settings saved.
          </div>
        ) : null}

        {query.success === "evaluated" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            Automation evaluated. {query.created ?? "0"} new suggested action(s) created from {query.candidates ?? "0"} candidate(s).
          </div>
        ) : null}

        {query.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            Could not update automation: {query.error}
          </div>
        ) : null}

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Enabled rules
            </p>
            <p className="mt-2 text-3xl font-semibold">{enabledCount}</p>
            <p className="mt-1 text-sm text-slate-600">Studio-controlled automations.</p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Suggested actions
            </p>
            <p className="mt-2 text-3xl font-semibold">{suggestionCount}</p>
            <p className="mt-1 text-sm text-slate-600">Review before sending or completing.</p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Last evaluated
            </p>
            <p className="mt-2 text-xl font-semibold">{formatDateTime(latestRun?.started_at)}</p>
            <p className="mt-1 text-sm text-slate-600">
              See when DanceFlow last checked your enabled follow-up rules.
            </p>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Automation summary
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Workflow health
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                Track how automation opportunities are moving from ARIA suggestions into
                reviewed drafts, queued email, completed follow-up, or failed delivery that needs attention.
              </p>
            </div>
            <Link
              href="/app/automations/drafts"
              className="inline-flex w-fit items-center gap-2 rounded-full border border-[#F9A8D4] bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] shadow-sm hover:bg-pink-50"
            >
              Review drafts
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                Suggested
              </p>
              <p className="mt-2 text-2xl font-semibold text-violet-950">
                {summarySuggestedCount}
              </p>
              <p className="mt-1 text-xs leading-5 text-violet-700">
                New recommendations awaiting review.
              </p>
            </div>
            <div className="rounded-2xl border border-pink-100 bg-pink-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#BE185D]">
                Drafted
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {summaryDraftedCount}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Emails prepared but not queued yet.
              </p>
            </div>
            <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                Queued
              </p>
              <p className="mt-2 text-2xl font-semibold text-blue-950">
                {summaryQueuedCount}
              </p>
              <p className="mt-1 text-xs leading-5 text-blue-700">
                Approved and waiting for outbound sending.
              </p>
            </div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                Sent
              </p>
              <p className="mt-2 text-2xl font-semibold text-emerald-950">
                {summarySentCount}
              </p>
              <p className="mt-1 text-xs leading-5 text-emerald-700">
                Automation emails delivered to the send pipeline.
              </p>
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Completed
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {summaryCompletedCount}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Staff marked the automation follow-up complete.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Dismissed
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {summaryDismissedCount}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Recommendations intentionally cleared.
              </p>
            </div>
            <div className={`rounded-2xl border p-4 ${
              summaryFailedCount > 0
                ? "border-red-200 bg-red-50"
                : "border-slate-200 bg-slate-50"
            }`}>
              <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${
                summaryFailedCount > 0 ? "text-red-700" : "text-slate-500"
              }`}>
                Failed
              </p>
              <p className={`mt-2 text-2xl font-semibold ${
                summaryFailedCount > 0 ? "text-red-950" : "text-slate-950"
              }`}>
                {summaryFailedCount}
              </p>
              <p className={`mt-1 text-xs leading-5 ${
                summaryFailedCount > 0 ? "text-red-700" : "text-slate-600"
              }`}>
                Delivery failures that may need review.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Rules
              </p>
              <h2 className="mt-2 text-2xl font-semibold">Choose what DanceFlow should handle</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                Turn on the client follow-ups your studio wants DanceFlow to watch, then choose how much review each one needs.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {automationDefinitions.map((definition) => {
              const existing = ruleByKey.get(definition.key);
              const enabled = existing?.enabled ?? false;
              const mode = existing?.mode ?? "suggestion";

              return (
                <form
                  key={definition.key}
                  action={updateAutomationRuleAction}
                  className="rounded-3xl border border-slate-200 bg-slate-50/70 p-5"
                >
                  <input type="hidden" name="ruleKey" value={definition.key} />
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <span className="inline-flex rounded-full border border-pink-100 bg-pink-50 px-3 py-1 text-xs font-semibold text-[#BE185D]">
                        {ruleBadge(definition.key)}
                      </span>
                      <h3 className="mt-3 text-lg font-semibold text-slate-950">
                        {definition.name}
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {definition.description}
                      </p>
                    </div>
                    <div
                      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                        enabled
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {enabled ? (
                        <PlayCircle className="h-3.5 w-3.5" />
                      ) : (
                        <PauseCircle className="h-3.5 w-3.5" />
                      )}
                      {enabled ? "Enabled" : "Off"}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                      <span className="block font-semibold text-slate-800">Mode</span>
                      <select
                        name="mode"
                        defaultValue={mode}
                        disabled={!canManage}
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="suggestion">Suggestion only</option>
                        <option value="draft">Draft before send</option>
                        <option value="auto_send">Send automatically</option>
                      </select>
                      <span className="mt-2 block text-xs leading-5 text-slate-500">
                        Automatic sends use the saved template and only run when
                        a valid recipient email is available.
                      </span>
                    </label>

                    <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={enabled}
                        disabled={!canManage}
                        className="h-4 w-4 rounded border-slate-300 text-[#DB2777]"
                      />
                      <span>
                        <span className="block font-semibold text-slate-800">Enable rule</span>
                        <span className="text-xs text-slate-500">
                          {existing?.last_evaluated_at
                            ? `Last evaluated ${formatDateTime(existing.last_evaluated_at)}`
                            : "Not evaluated yet"}
                        </span>
                      </span>
                    </label>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-slate-500">
                      Current mode: {modeLabel(mode)}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {["low_package_balance", "no_upcoming_lesson", "pending_booking_request", "unsigned_document", "first_lesson_follow_up"].includes(definition.key) ? (
                        <button
                          type="submit"
                          formAction={evaluateAutomationRuleAction}
                          disabled={!canManage || !enabled}
                          className="inline-flex items-center gap-2 rounded-full border border-[#F9A8D4] bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] shadow-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                        >
                          Evaluate now
                          <Sparkles className="h-4 w-4" />
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        disabled={!canManage}
                        className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        Save rule
                        <Settings2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </form>
              );
            })}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Email templates
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Customize automation draft language
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                These messages are used for editable drafts and automatic sends. Review the wording before enabling automatic delivery.
              </p>
            </div>
            <Mail className="h-6 w-6 text-[#DB2777]" />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {automationDefinitions.map((definition) => {
              const savedTemplate = templateByRuleKey.get(definition.key);
              const defaultTemplate = defaultTemplateByRuleKey.get(definition.key);
              const subject = savedTemplate?.subject || defaultTemplate?.subject || "";
              const bodyText = savedTemplate?.body_text || defaultTemplate?.bodyText || "";
              const variables = defaultTemplate?.variables ?? [];
              const previewSubject = renderTemplatePreview(subject, variables);
              const previewBody = renderTemplatePreview(bodyText, variables);

              return (
                <form
                  key={`${definition.key}-template`}
                  action={saveAutomationEmailTemplateAction}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <input type="hidden" name="ruleKey" value={definition.key} />
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[#BE185D] ring-1 ring-pink-100">
                        {ruleBadge(definition.key)}
                      </span>
                      <h3 className="mt-2 text-base font-semibold text-slate-950">
                        {definition.name}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        Used when creating a draft from this automation.
                      </p>
                    </div>
                    {savedTemplate?.updated_at ? (
                      <span className="text-xs text-slate-500">
                        Updated {formatDateTime(savedTemplate.updated_at)}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">Using default</span>
                    )}
                  </div>

                  <label className="mt-4 block text-sm font-semibold text-slate-800">
                    Subject
                    <input
                      name="subject"
                      defaultValue={subject}
                      disabled={!canManage}
                      className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm"
                    />
                  </label>

                  <label className="mt-4 block text-sm font-semibold text-slate-800">
                    Body
                    <textarea
                      name="bodyText"
                      defaultValue={bodyText}
                      rows={8}
                      disabled={!canManage}
                      className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm"
                    />
                  </label>

                  {variables.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Available variables
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {variables.map((variable) => (
                          <code
                            key={`${definition.key}-${variable}`}
                            className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200"
                          >
                            {"{{"}{variable}{"}}"}
                          </code>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 rounded-2xl border border-pink-100 bg-white p-4">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#BE185D]">
                        Sample preview
                      </p>
                      <p className="text-xs text-slate-500">
                        Uses sample values so you can check variable placement before saving.
                      </p>
                    </div>
                    <div className="mt-3 space-y-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                          Subject preview
                        </p>
                        <p className="mt-1 rounded-xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800">
                          {previewSubject || "Add a subject to preview it here."}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                          Body preview
                        </p>
                        <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                          {previewBody || "Add body text to preview it here."}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button
                      type="submit"
                      disabled={!canManage}
                      className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      Save template
                      <Settings2 className="h-4 w-4" />
                    </button>
                  </div>
                </form>
              );
            })}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                  Suggested actions
                </p>
                <h2 className="mt-2 text-2xl font-semibold">3. Review and results</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Review suggested actions here, or use the draft inbox for a focused send-review workflow.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/app/automations/drafts"
                  className="inline-flex items-center gap-2 rounded-full border border-[#F9A8D4] bg-white px-3 py-1.5 text-xs font-semibold text-[#BE185D] shadow-sm hover:bg-pink-50"
                >
                  Review email drafts
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Sparkles className="h-6 w-6 text-[#DB2777]" />
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {typedActions.length > 0 ? (
                typedActions.map((action) => (
                  <div
                    key={action.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    {(() => {
                      const draft = draftByActionId.get(action.id);
                      return (
                        <div className="space-y-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${priorityClasses(
                                    action.priority
                                  )}`}
                                >
                                  {action.priority}
                                </span>
                                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500">
                                  {ruleBadge(action.rule_key)}
                                </span>
                                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">
                                  {draft?.status ?? action.status}
                                </span>
                              </div>
                              <h3 className="mt-3 font-semibold text-slate-950">{action.title}</h3>
                              {action.body ? (
                                <p className="mt-1 text-sm leading-6 text-slate-600">
                                  {action.body}
                                </p>
                              ) : null}
                              <p className="mt-2 text-xs text-slate-500">
                                Created {formatDateTime(action.created_at)}
                              </p>
                            </div>

                            {["suggested", "drafted"].includes(action.status) ? (
                              <div className="flex flex-wrap gap-2">
                                {!draft ? (
                                  <form action={createAutomationEmailDraftAction}>
                                    <input type="hidden" name="actionId" value={action.id} />
                                    <button
                                      type="submit"
                                      className="inline-flex items-center gap-2 rounded-full bg-[#DB2777] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#BE185D]"
                                    >
                                      <Mail className="h-3.5 w-3.5" />
                                      Create email draft
                                    </button>
                                  </form>
                                ) : null}
                                <form action={dismissAutomationAction}>
                                  <input type="hidden" name="actionId" value={action.id} />
                                  <button
                                    type="submit"
                                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                                  >
                                    Dismiss
                                  </button>
                                </form>
                              </div>
                            ) : (
                              <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500">
                                {action.status}
                              </span>
                            )}
                          </div>

                          {draft ? (
                            <div className="rounded-2xl border border-pink-100 bg-white p-4">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#DB2777]">
                                    Email draft
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    To: {draft.recipient_email ?? "Missing recipient"}
                                  </p>
                                  {draft.status === "draft" ? (
                                    <p className="mt-1 text-xs text-slate-500">
                                      Review and edit this email before queueing it for send.
                                    </p>
                                  ) : null}
                                  {draft.status === "queued" ? (
                                    <p className="mt-1 text-xs text-blue-700">
                                      Queued {formatDateTime(draft.updated_at)}. The normal outbound sender will process it.
                                    </p>
                                  ) : null}
                                  {draft.status === "sent" ? (
                                    <p className="mt-1 text-xs text-emerald-700">
                                      Sent {formatDateTime(draft.sent_at ?? draft.updated_at)}.
                                    </p>
                                  ) : null}
                                  {draft.status === "failed" ? (
                                    <p className="mt-1 text-xs text-red-700">
                                      Failed{draft.error_message ? `: ${draft.error_message}` : "."}
                                    </p>
                                  ) : null}
                                </div>
                                <span
                                  className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${deliveryStatusClasses(
                                    draft.status
                                  )}`}
                                >
                                  {deliveryStatusLabel(draft.status)}
                                </span>
                              </div>

                              {draft.status === "draft" ? (
                                <form action={saveAutomationEmailDraftAction} className="mt-4 space-y-3">
                                  <input type="hidden" name="actionId" value={action.id} />
                                  <input type="hidden" name="deliveryId" value={draft.id} />
                                  <input type="hidden" name="returnTo" value="/app/automations" />
                                  <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                    Subject
                                    <input
                                      name="subject"
                                      defaultValue={draft.subject ?? ""}
                                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal tracking-normal text-slate-900 outline-none focus:border-[#DB2777] focus:ring-2 focus:ring-pink-100"
                                    />
                                  </label>
                                  <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                    Body
                                    <textarea
                                      name="bodyText"
                                      defaultValue={draft.body_text ?? ""}
                                      rows={7}
                                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal leading-6 tracking-normal text-slate-900 outline-none focus:border-[#DB2777] focus:ring-2 focus:ring-pink-100"
                                    />
                                  </label>
                                  <div className="flex flex-wrap gap-2">
                                    <button
                                      type="submit"
                                      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                    >
                                      Save draft
                                    </button>
                                    <button
                                      type="submit"
                                      formAction={queueAutomationEmailDraftAction}
                                      className="rounded-full bg-[#6B21A8] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#581C87]"
                                    >
                                      Queue for send
                                    </button>
                                  </div>
                                </form>
                              ) : (
                                <div className="mt-4 space-y-2">
                                  <p className="text-sm font-semibold text-slate-900">
                                    {draft.subject ?? "No subject"}
                                  </p>
                                  <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-600">
                                    {draft.body_text ?? "No body text saved."}
                                  </p>
                                  {draft.status === "sent" ? (
                                    <form action={completeAutomationAction} className="pt-2">
                                      <input type="hidden" name="actionId" value={action.id} />
                                      <button
                                        type="submit"
                                        className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
                                      >
                                        Mark action complete
                                      </button>
                                    </form>
                                  ) : null}
                                  {draft.status === "queued" ? (
                                    <p className="rounded-2xl bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">
                                      This draft is queued and waiting for the outbound sender. You can monitor delivery here after it is processed.
                                    </p>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                  <Bell className="mx-auto h-7 w-7 text-slate-400" />
                  <h3 className="mt-3 font-semibold text-slate-900">
                    No automation actions yet
                  </h3>
                  <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-600">
                    Enable an automation rule, then click Evaluate now to create reviewable
                    recommendations here.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              Run history
            </p>
            <h2 className="mt-2 text-2xl font-semibold">Recent checks</h2>

            <div className="mt-5 space-y-3">
              {typedRuns.length > 0 ? (
                typedRuns.map((run) => (
                  <div key={run.id} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                        {ruleBadge(run.rule_key)}
                      </span>
                      <span className="text-xs font-semibold text-slate-500">{run.status}</span>
                    </div>
                    <p className="mt-3 text-sm text-slate-600">
                      {run.candidates_count} candidates · {run.actions_created_count} actions
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Started {formatDateTime(run.started_at)}
                    </p>
                    {run.error_message ? (
                      <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
                        {run.error_message}
                      </p>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                  <Clock3 className="mx-auto h-7 w-7 text-slate-400" />
                  <p className="mt-3 text-sm font-semibold text-slate-900">
                    No evaluations yet
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Rule evaluation will be added after the foundation is in place.
                  </p>
                </div>
              )}
            </div>

            <div className="mt-5 rounded-2xl bg-[#FFF7ED] p-4 text-sm leading-6 text-orange-800">
              <div className="flex items-start gap-2">
                <Mail className="mt-0.5 h-4 w-4" />
                <p>
                  Email/SMS sending is intentionally disabled in this foundation. Automations
                  create suggestions first, then sending rules can be added safely.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
