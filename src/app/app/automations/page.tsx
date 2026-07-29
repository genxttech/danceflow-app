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
  saveAriaOperationalPackPreferenceAction,
  saveAriaRecommendedSetupAction,
  saveAutomationEmailDraftAction,
  saveAutomationEmailTemplateAction,
  updateAutomationRuleAction,
  getAutomationTemplateDefaults,
} from "./actions";
import {
  ARIA_AUTOMATION_PACKS,
  getAriaAutomationCatalogItem,
} from "@/lib/aria/automation-catalog";
import { getAriaOperationalPack } from "@/lib/aria/operational-default-packs";

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
  action_config: Record<string, unknown> | null;
  last_evaluated_at: string | null;
  updated_at: string | null;
};

type AriaPackPreferenceRow = {
  pack_key: string;
  enabled: boolean | null;
  settings: Record<string, unknown> | null;
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
  if (mode === "auto_send") return "Handle automatically";
  if (mode === "draft") return "Prepare for my review";
  return "Notify me only";
}

function packTone(packKey: string) {
  if (packKey === "front_desk") return "border-orange-200 bg-orange-50";
  if (packKey === "client_relations") return "border-pink-200 bg-pink-50";
  if (packKey === "scheduling") return "border-blue-200 bg-blue-50";
  if (packKey === "sales_retention") return "border-emerald-200 bg-emerald-50";
  if (packKey === "marketing") return "border-fuchsia-200 bg-fuchsia-50";
  if (packKey === "billing_payments") return "border-amber-200 bg-amber-50";
  if (packKey === "documents") return "border-violet-200 bg-violet-50";
  if (packKey === "events") return "border-cyan-200 bg-cyan-50";
  return "border-slate-200 bg-slate-50";
}

function packModeLabel(mode: string) {
  if (mode === "handle_automatically") return "Handle automatically";
  if (mode === "prepare_for_review") return "Prepare for my review";
  if (mode === "off") return "Off";
  return "Notify me only";
}

function packAutonomyMode(
  packKey: string,
  preference: AriaPackPreferenceRow | undefined,
) {
  if (preference?.enabled === false) return "off";

  const settings = preference?.settings as
    | Record<string, unknown>
    | null
    | undefined;
  const savedMode = settings?.autonomy_mode ?? settings?.recommended_setup_choice;

  if (
    savedMode === "handle_automatically" ||
    savedMode === "prepare_for_review" ||
    savedMode === "notify_only" ||
    savedMode === "off"
  ) {
    return savedMode;
  }

  return getAriaOperationalPack(packKey as never)?.recommendedMode ?? "notify_only";
}


function ruleOverrideMode(
  actionConfig: Record<string, unknown> | null | undefined,
) {
  const value =
    actionConfig?.aria_autonomy_override ??
    actionConfig?.aria_pack_mode_override;

  if (value === "prepare_for_review" || value === "draft") {
    return "prepare_for_review";
  }
  if (value === "notify_only" || value === "suggestion") {
    return "notify_only";
  }
  if (value === "off") return "off";
  return null;
}

function autonomyExceptionOptions(packMode: string) {
  if (packMode === "handle_automatically") {
    return [
      ["prepare_for_review", "Prepare for my review"],
      ["notify_only", "Notify me only"],
      ["off", "Off"],
    ] as const;
  }

  if (packMode === "prepare_for_review") {
    return [
      ["notify_only", "Notify me only"],
      ["off", "Off"],
    ] as const;
  }

  if (packMode === "notify_only") {
    return [["off", "Off"]] as const;
  }

  return [] as const;
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
    { data: packPreferences },
  ] = await Promise.all([
    supabase
      .from("automation_rules")
      .select("id, rule_key, enabled, mode, action_config, last_evaluated_at, updated_at")
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
    supabase
      .from("aria_automation_pack_preferences")
      .select("pack_key, enabled, settings, updated_at")
      .eq("studio_id", context.studioId),
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
  const packPreferenceByKey = new Map(
    ((packPreferences ?? []) as AriaPackPreferenceRow[]).map((preference) => [
      preference.pack_key,
      preference,
    ]),
  );
  const definitionsByPack = new Map(
    ARIA_AUTOMATION_PACKS.map((pack) => [
      pack.key,
      automationDefinitions.filter((definition) => {
        const catalogItem = getAriaAutomationCatalogItem(definition.key);
        return catalogItem?.packKey === pack.key;
      }),
    ]),
  );
  const recommendedSetupKeys = [
    "front_desk",
    "marketing",
    "billing_payments",
  ] as const;
  const recommendedSetupComplete = recommendedSetupKeys.every((packKey) =>
    Boolean(
      (
        packPreferenceByKey.get(packKey)?.settings as
          | Record<string, unknown>
          | null
          | undefined
      )?.setup_reviewed_at,
    ),
  );

  const setupChoice = (
    packKey: (typeof recommendedSetupKeys)[number],
    fallback: string,
  ) => {
    const settings = packPreferenceByKey.get(packKey)?.settings as
      | Record<string, unknown>
      | null
      | undefined;
    const preference = packPreferenceByKey.get(packKey);
    const mode = packAutonomyMode(packKey, preference);
    return mode || fallback;
  };

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
        <section className="overflow-hidden rounded-[34px] border border-[#C4B5FD] bg-gradient-to-br from-[#201033] via-[#5B21B6] to-[#C026D3] text-white shadow-xl">
          <div className="grid gap-6 p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-violet-100">
                <WandSparkles className="h-3.5 w-3.5" />
                ARIA Automation Center
              </div>
              <h1 className="mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
                ARIA is ready to help run the studio.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-violet-50 sm:text-base">
                Choose how ARIA should work for your studio here. Then use ARIA Operations to see what ARIA is handling, what needs a decision, and what failed.
              </p>
            </div>

            <div className="rounded-3xl border border-white/20 bg-white/10 p-5 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-100">
                Current coverage
              </p>
              <p className="mt-2 text-3xl font-semibold">
                {ARIA_AUTOMATION_PACKS.filter(
                  (pack) => packPreferenceByKey.get(pack.key)?.enabled !== false,
                ).length}
              </p>
              <p className="mt-1 text-sm text-violet-50">
                operational packs active
              </p>
              <Link
                href="/app/aria/operations"
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-white underline decoration-white/40 underline-offset-4"
              >
                Open ARIA Operations
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        {query.success === "updated" ||
        query.success === "aria_pack_saved" ||
        query.success === "aria_recommended_setup_saved" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            ARIA automation preferences saved.
          </div>
        ) : null}

        {query.success === "evaluated" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            Automation evaluated. {query.created ?? "0"} new suggested action(s) created from {query.candidates ?? "0"} candidate(s).
          </div>
        ) : null}

        {query.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            Could not update ARIA setup: {query.error}
          </div>
        ) : null}

        <section className="rounded-[30px] border border-violet-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
                Recommended setup
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                {recommendedSetupComplete
                  ? "Your ARIA setup is ready"
                  : "Review three studio preferences"}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                {recommendedSetupComplete
                  ? "These choices control how ARIA prepares routine front-desk, marketing, and payment work. You can change them at any time."
                  : "DanceFlow already applied safe defaults. Confirm these three choices once, then let ARIA work from them."}
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
              recommendedSetupComplete
                ? "bg-emerald-100 text-emerald-700"
                : "bg-violet-100 text-violet-700"
            }`}>
              {recommendedSetupComplete ? "Setup complete" : "One-time review"}
            </span>
          </div>

          <form action={saveAriaRecommendedSetupAction} className="mt-5">
            <input type="hidden" name="returnTo" value="/app/automations" />

            <div className="grid gap-4 lg:grid-cols-3">
              <label className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">
                  Front Desk
                </span>
                <span className="mt-2 block text-sm font-semibold text-slate-950">
                  How should ARIA handle routine front-desk follow-up?
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-600">
                  Booking, confirmation, and cancellation work stays reviewable; schedule changes never happen automatically.
                </span>
                <span className="mt-2 block text-[11px] leading-4 text-slate-500">
                  Automatic mode only applies to front-desk actions whose underlying rule explicitly allows automation.
                </span>
                <select
                  name="frontDeskPreference"
                  defaultValue={setupChoice("front_desk", "prepare_for_review")}
                  disabled={!canManage}
                  className="mt-4 w-full rounded-xl border border-orange-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                >
                  <option value="handle_automatically">
                    Handle automatically where safe
                  </option>
                  <option value="prepare_for_review">
                    Prepare routine follow-up for review
                  </option>
                  <option value="notify_only">
                    Notify me only
                  </option>
                  <option value="off">
                    Turn this area off
                  </option>
                </select>
                <span className="mt-2 block text-xs font-semibold text-orange-800">
                  Recommended: Prepare for review
                </span>
              </label>

              <label className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50 p-4">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-fuchsia-700">
                  Marketing
                </span>
                <span className="mt-2 block text-sm font-semibold text-slate-950">
                  How should ARIA handle marketing opportunities?
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-600">
                  ARIA can identify and prepare opportunities automatically, but campaign delivery still follows the underlying rule&apos;s approval and send permissions.
                </span>
                <span className="mt-2 block text-[11px] leading-4 text-slate-500">
                  Automatic mode does not grant blanket marketing send permission.
                </span>
                <select
                  name="marketingPreference"
                  defaultValue={setupChoice("marketing", "prepare_for_review")}
                  disabled={!canManage}
                  className="mt-4 w-full rounded-xl border border-fuchsia-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                >
                  <option value="handle_automatically">
                    Handle automatically where safe
                  </option>
                  <option value="prepare_for_review">
                    Prepare opportunities for review
                  </option>
                  <option value="notify_only">
                    Suggest opportunities only
                  </option>
                  <option value="off">
                    Turn this area off
                  </option>
                </select>
                <span className="mt-2 block text-xs font-semibold text-fuchsia-800">
                  Recommended: Prepare for review
                </span>
              </label>

              <label className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">
                  Billing & Payments
                </span>
                <span className="mt-2 block text-sm font-semibold text-slate-950">
                  How should ARIA handle payment follow-up?
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-600">
                  Financial decisions are always staff-controlled. ARIA can never automatically charge, retry, refund, waive a balance, mark a payment paid, create a payment transaction, or change financial access/status.
                </span>
                <span className="mt-2 block text-[11px] leading-4 text-slate-500">
                  Automatic mode can handle only safe communication or internal work already permitted by the underlying rule.
                </span>
                <select
                  name="billingPreference"
                  defaultValue={setupChoice("billing_payments", "notify_only")}
                  disabled={!canManage}
                  className="mt-4 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                >
                  <option value="handle_automatically">
                    Handle automatically where safe
                  </option>
                  <option value="prepare_for_review">
                    Prepare follow-up for review
                  </option>
                  <option value="notify_only">
                    Notify me about payment exceptions
                  </option>
                  <option value="off">
                    Turn this area off
                  </option>
                </select>
                <span className="mt-2 block text-xs font-semibold text-amber-800">
                  Recommended: Notify me
                </span>
              </label>
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-violet-100 bg-[#FBF9FF] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-950">
                  These preferences set ARIA&apos;s working boundaries.
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  “Handle automatically” means maximum safe autonomy for this area. Higher-risk actions and communications that still require review remain review-only, and a preference can never override a rule that is not allowed to send.
                </p>
              </div>
              <button
                type="submit"
                disabled={!canManage}
                className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {recommendedSetupComplete ? "Save changes" : "Save ARIA setup"}
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Operational packs
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Choose where ARIA should help
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                Turn entire areas on or off here. This controls what ARIA watches; use ARIA Operations to review the work it creates.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {ARIA_AUTOMATION_PACKS.map((pack) => {
              const preference = packPreferenceByKey.get(pack.key);
              const packMode = packAutonomyMode(pack.key, preference);
              const enabled = packMode !== "off";
              const packDefinitions = definitionsByPack.get(pack.key) ?? [];
              const enabledRules = packDefinitions.filter(
                (definition) => ruleByKey.get(definition.key)?.enabled,
              ).length;

              return (
                <article
                  key={pack.key}
                  className={`rounded-3xl border p-5 ${packTone(pack.key)}`}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          enabled
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-slate-200 text-slate-600"
                        }`}>
                          {enabled ? "Active" : "Off"}
                        </span>
                        <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold text-slate-600">
                          {packDefinitions.length
                            ? `${enabledRules}/${packDefinitions.length} current rules active`
                            : "Coverage expanding"}
                        </span>
                      </div>
                      <h3 className="mt-3 text-lg font-semibold text-slate-950">{pack.label}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{pack.description}</p>
                      <p className="mt-3 text-xs font-semibold text-slate-700">
                        ARIA autonomy: {packModeLabel(packMode)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Recommended: {packModeLabel(
                          getAriaOperationalPack(pack.key as never)?.recommendedMode ??
                            "notify_only",
                        )}
                      </p>
                    </div>

                    {canManage ? (
                      <form action={saveAriaOperationalPackPreferenceAction} className="min-w-[12rem]">
                        <input type="hidden" name="packKey" value={pack.key} />
                        <input type="hidden" name="returnTo" value="/app/automations" />
                        <label className="text-xs font-semibold text-slate-700">
                          Autonomy
                          <select
                            name="autonomyMode"
                            defaultValue={packMode}
                            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 shadow-sm"
                          >
                            <option value="handle_automatically">
                              Handle automatically
                            </option>
                            <option value="prepare_for_review">
                              Prepare for my review
                            </option>
                            <option value="notify_only">Notify me only</option>
                            <option value="off">Off</option>
                          </select>
                        </label>
                        <button
                          type="submit"
                          className="mt-2 w-full rounded-full bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          Save pack
                        </button>
                      </form>
                    ) : null}
                  </div>

                  {packDefinitions.length ? (
                    <details className="mt-4 rounded-2xl border border-white/80 bg-white/70 p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-violet-800">
                        Review {packDefinitions.length} rule{packDefinitions.length === 1 ? "" : "s"}
                      </summary>
                      <div className="mt-4 space-y-3">
                        {packDefinitions.map((definition) => {
                          const existing = ruleByKey.get(definition.key);
                          const ruleEnabled = existing?.enabled ?? false;
                          const mode = existing?.mode ?? "suggestion";
                          const overrideMode = ruleOverrideMode(
                            existing?.action_config,
                          );

                          return (
                            <form
                              key={definition.key}
                              action={updateAutomationRuleAction}
                              className="rounded-2xl border border-slate-200 bg-white p-4"
                            >
                              <input type="hidden" name="ruleKey" value={definition.key} />
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <h4 className="text-sm font-semibold text-slate-950">{definition.name}</h4>
                                  <p className="mt-1 text-xs leading-5 text-slate-600">{definition.description}</p>
                                </div>
                                <span className={`w-fit rounded-full px-2.5 py-1 text-xs font-semibold ${
                                  ruleEnabled
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-slate-100 text-slate-500"
                                }`}>
                                  {ruleEnabled ? "Enabled" : "Off"}
                                </span>
                              </div>

                              <input
                                type="hidden"
                                name="enabled"
                                value={ruleEnabled ? "on" : ""}
                              />

                              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                  <div>
                                    <p className="text-xs font-semibold text-slate-800">
                                      {overrideMode
                                        ? `Exception: ${packModeLabel(overrideMode)}`
                                        : `Inherits ${pack.label}: ${packModeLabel(packMode)}`}
                                    </p>
                                    <p className="mt-1 text-xs leading-5 text-slate-500">
                                      {overrideMode
                                        ? `This rule is intentionally more restrictive than the ${pack.label} pack.`
                                        : "No separate autonomy setting is applied to this rule."}
                                    </p>
                                  </div>

                                  {canManage && autonomyExceptionOptions(packMode).length > 0 ? (
                                    <details className="shrink-0">
                                      <summary className="cursor-pointer rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700">
                                        {overrideMode ? "Change exception" : "Set exception"}
                                      </summary>
                                      <div className="mt-2 min-w-[13rem] rounded-2xl border border-slate-200 bg-white p-3 shadow-lg">
                                        <label className="text-xs font-semibold text-slate-700">
                                          More restrictive behavior
                                          <select
                                            name="autonomyOverride"
                                            defaultValue={overrideMode ?? autonomyExceptionOptions(packMode)[0]?.[0]}
                                            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                          >
                                            {autonomyExceptionOptions(packMode).map(([value, label]) => (
                                              <option key={value} value={value}>
                                                {label}
                                              </option>
                                            ))}
                                          </select>
                                        </label>
                                        <button
                                          type="submit"
                                          className="mt-3 w-full rounded-full bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white"
                                        >
                                          Save exception
                                        </button>
                                      </div>
                                    </details>
                                  ) : null}
                                </div>

                                {overrideMode && canManage ? (
                                  <button
                                    type="submit"
                                    name="autonomyOverride"
                                    value="__inherit"
                                    className="mt-3 text-xs font-semibold text-violet-700 underline underline-offset-4"
                                  >
                                    Remove exception
                                  </button>
                                ) : null}
                              </div>

                              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                                <div className="flex flex-wrap gap-2">
                                  {["low_package_balance", "no_upcoming_lesson", "pending_booking_request", "unsigned_document", "first_lesson_follow_up"].includes(definition.key) ? (
                                    <button
                                      type="submit"
                                      formAction={evaluateAutomationRuleAction}
                                      disabled={!canManage || !ruleEnabled}
                                      className="rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 disabled:cursor-not-allowed disabled:text-slate-400"
                                    >
                                      Evaluate now
                                    </button>
                                  ) : null}

                                </div>
                              </div>
                            </form>
                          );
                        })}
                      </div>
                    </details>
                  ) : (
                    <p className="mt-4 rounded-2xl border border-dashed border-white bg-white/60 p-4 text-xs leading-5 text-slate-600">
                      ARIA will use this pack as new operational coverage is added. No individual rule settings are required yet.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <div className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
              Advanced automation settings
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Change individual rules only when your studio needs an exception
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              The operational packs above are the normal control surface. Expand a pack to change a specific rule&apos;s delivery mode or disable only that rule.
            </p>
            <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50 p-4 text-xs leading-5 text-violet-800">
              Advanced settings change how ARIA works. They do not show ARIA&apos;s daily activity.
            </div>
          </div>

          <div className="rounded-[30px] border border-[#C4B5FD] bg-gradient-to-br from-[#2D0A46] via-[#5B21B6] to-[#BE185D] p-5 text-white shadow-sm sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-100">
              ARIA Operations
            </p>
            <h2 className="mt-2 text-xl font-semibold">
              See ARIA working day to day
            </h2>
            <p className="mt-2 text-sm leading-6 text-violet-50">
              Operations shows what ARIA handled, what needs your decision, exceptions, upcoming work, delivery status, and outcomes.
            </p>
            <Link
              href="/app/aria/operations"
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-violet-800 shadow-sm"
            >
              Open ARIA Operations
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

      </div>
    </main>
  );
}
