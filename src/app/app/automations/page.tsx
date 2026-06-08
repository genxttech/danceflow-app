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
  updateAutomationRuleAction,
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
  if (mode === "auto_send") return "Auto-send later";
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

  const [{ data: rules }, { data: actions }, { data: runs }] = await Promise.all([
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
  const typedRuns = (runs ?? []) as AutomationRunRow[];

  const enabledCount = automationDefinitions.filter(
    (definition) => ruleByKey.get(definition.key)?.enabled
  ).length;
  const suggestionCount = typedActions.filter((action) =>
    ["suggested", "drafted"].includes(action.status)
  ).length;
  const latestRun = typedRuns[0];

  return (
    <main className="min-h-screen bg-[#F8F5FF] px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[32px] border border-white/70 bg-gradient-to-br from-[#2D0A46] via-[#6B21A8] to-[#DB2777] p-6 text-white shadow-xl sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[1.4fr_0.8fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-pink-100">
                <WandSparkles className="h-3.5 w-3.5" />
                Automation foundation
              </div>
              <h1 className="mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
                Let DanceFlow handle more of the everyday follow-up.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-pink-50 sm:text-base">
                Start with studio-controlled automation rules that create suggested actions.
                Auto-send is intentionally held for later so your team can review templates,
                consent, and timing first.
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
              Run enabled rules manually now. Scheduled evaluations can be added later.
            </p>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Rules
              </p>
              <h2 className="mt-2 text-2xl font-semibold">Available automations</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                Turn on the workflows your studio wants DanceFlow to watch. V1 creates
                controlled suggestions; auto-send is shown as a future mode.
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
                        <option value="auto_send" disabled>
                          Auto-send later
                        </option>
                      </select>
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

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                  Suggested actions
                </p>
                <h2 className="mt-2 text-2xl font-semibold">Automation activity</h2>
              </div>
              <Sparkles className="h-6 w-6 text-[#DB2777]" />
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
                                  <input type="hidden" name="draftId" value={draft.id} />
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
            <h2 className="mt-2 text-2xl font-semibold">Recent evaluations</h2>

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
