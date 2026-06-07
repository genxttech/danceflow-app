"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type AutomationDefinition = {
  key: string;
  name: string;
  description: string;
  triggerKey: string;
  actionKey: string;
  defaultTriggerConfig: Record<string, unknown>;
  defaultActionConfig: Record<string, unknown>;
};

const AUTOMATION_DEFINITIONS: AutomationDefinition[] = [
  {
    key: "low_package_balance",
    name: "Low package balance renewal",
    description:
      "Find clients with low lesson balances and prepare a renewal recommendation before they run out.",
    triggerKey: "package_balance_below_threshold",
    actionKey: "suggest_package_renewal",
    defaultTriggerConfig: { threshold: 2 },
    defaultActionConfig: { channel: "email", approval_required: true },
  },
  {
    key: "no_upcoming_lesson",
    name: "No upcoming lesson rebooking",
    description:
      "Find active clients without a future lesson and suggest a rebooking prompt with their portal schedule link.",
    triggerKey: "client_has_no_future_appointment",
    actionKey: "suggest_rebooking_request",
    defaultTriggerConfig: { lookback_days: 90 },
    defaultActionConfig: { suggest_usual_time: true, approval_required: true },
  },
  {
    key: "unsigned_document",
    name: "Unsigned document reminder",
    description:
      "Find clients or event attendees with required documents still unsigned and create a reminder action.",
    triggerKey: "required_document_unsigned",
    actionKey: "suggest_document_reminder",
    defaultTriggerConfig: { due_within_days: 7 },
    defaultActionConfig: { approval_required: true },
  },
  {
    key: "pending_booking_request",
    name: "Pending booking request reminder",
    description:
      "Alert staff when a public or portal booking request has not been reviewed quickly enough.",
    triggerKey: "booking_request_pending_too_long",
    actionKey: "create_staff_review_reminder",
    defaultTriggerConfig: { pending_hours: 24 },
    defaultActionConfig: { priority: "high" },
  },
  {
    key: "first_lesson_follow_up",
    name: "First lesson follow-up",
    description:
      "Create a follow-up suggestion after a client completes their first lesson.",
    triggerKey: "first_lesson_completed",
    actionKey: "suggest_first_lesson_follow_up",
    defaultTriggerConfig: { after_hours: 24 },
    defaultActionConfig: { approval_required: true },
  },
];

function getDefinition(ruleKey: string) {
  return AUTOMATION_DEFINITIONS.find((definition) => definition.key === ruleKey);
}

export async function updateAutomationRuleAction(formData: FormData) {
  const ruleKey = String(formData.get("ruleKey") ?? "");
  const enabled = formData.get("enabled") === "on";
  const modeInput = String(formData.get("mode") ?? "suggestion");
  const mode = ["suggestion", "draft", "auto_send"].includes(modeInput)
    ? modeInput
    : "suggestion";

  const definition = getDefinition(ruleKey);

  if (!definition) {
    redirect("/app/automations?error=unknown-rule");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("automation_rules").upsert(
    {
      studio_id: context.studioId,
      rule_key: definition.key,
      name: definition.name,
      description: definition.description,
      trigger_key: definition.triggerKey,
      action_key: definition.actionKey,
      enabled,
      mode,
      trigger_config: definition.defaultTriggerConfig,
      action_config: definition.defaultActionConfig,
      updated_by: user?.id ?? null,
      created_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "studio_id,rule_key" }
  );

  if (error) {
    redirect(`/app/automations?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app");
  redirect("/app/automations?success=updated");
}

export async function dismissAutomationAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "");

  if (!actionId) {
    return;
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    return;
  }

  const supabase = await createClient();

  await supabase
    .from("automation_actions")
    .update({
      status: "dismissed",
      dismissed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .in("status", ["suggested", "drafted"]);

  revalidatePath("/app/automations");
}


type ClientPackageBalanceRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  expiration_date: string | null;
  clients:
    | { first_name: string | null; last_name: string | null; email: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null }[]
    | null;
  client_package_items: {
    id: string;
    usage_type: string | null;
    quantity_remaining: number | null;
    is_unlimited: boolean | null;
  }[];
};

function asNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getClientDisplayName(
  value:
    | { first_name: string | null; last_name: string | null; email: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  const name = [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim();
  return name || client?.email || "Client";
}

function packageActionStatusForMode(mode: string | null | undefined) {
  return mode === "draft" ? "drafted" : "suggested";
}

export async function evaluateAutomationRuleAction(formData: FormData) {
  const ruleKey = String(formData.get("ruleKey") ?? "");

  if (ruleKey !== "low_package_balance") {
    redirect("/app/automations?error=rule-not-implemented-yet");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();
  const definition = getDefinition(ruleKey);

  if (!definition) {
    redirect("/app/automations?error=unknown-rule");
  }

  const { data: rule, error: ruleError } = await supabase
    .from("automation_rules")
    .select("id, enabled, mode, trigger_config")
    .eq("studio_id", context.studioId)
    .eq("rule_key", ruleKey)
    .maybeSingle();

  if (ruleError) {
    redirect(`/app/automations?error=${encodeURIComponent(ruleError.message)}`);
  }

  if (!rule?.enabled) {
    redirect("/app/automations?error=enable-rule-first");
  }

  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase
    .from("automation_runs")
    .insert({
      studio_id: context.studioId,
      rule_id: rule.id,
      rule_key: ruleKey,
      status: "running",
      started_at: startedAt,
    })
    .select("id")
    .single();

  if (runError) {
    redirect(`/app/automations?error=${encodeURIComponent(runError.message)}`);
  }

  let candidatesCount = 0;
  let createdCount = 0;

  try {
    const threshold = asNumber(
      (rule.trigger_config as Record<string, unknown> | null | undefined)?.threshold,
      asNumber(definition.defaultTriggerConfig.threshold, 2)
    );

    const { data: packages, error: packageError } = await supabase
      .from("client_packages")
      .select(`
        id,
        client_id,
        name_snapshot,
        active,
        expiration_date,
        clients (
          first_name,
          last_name,
          email
        ),
        client_package_items (
          id,
          usage_type,
          quantity_remaining,
          is_unlimited
        )
      `)
      .eq("studio_id", context.studioId)
      .eq("active", true);

    if (packageError) {
      throw new Error(packageError.message);
    }

    const typedPackages = (packages ?? []) as ClientPackageBalanceRow[];
    const candidates = typedPackages
      .map((clientPackage) => {
        const lowItems = (clientPackage.client_package_items ?? []).filter((item) => {
          if (item.is_unlimited) return false;
          if (item.quantity_remaining === null || item.quantity_remaining === undefined) return false;
          return Number(item.quantity_remaining) <= threshold;
        });

        if (lowItems.length === 0) return null;

        const lowestRemaining = Math.min(
          ...lowItems.map((item) => Number(item.quantity_remaining ?? threshold))
        );

        return {
          clientPackage,
          lowItems,
          lowestRemaining,
        };
      })
      .filter(Boolean) as Array<{
      clientPackage: ClientPackageBalanceRow;
      lowItems: ClientPackageBalanceRow["client_package_items"];
      lowestRemaining: number;
    }>;

    candidatesCount = candidates.length;
    const existingRelatedIds = new Set<string>();

    if (candidates.length > 0) {
      const { data: existingActions, error: existingError } = await supabase
        .from("automation_actions")
        .select("related_id")
        .eq("studio_id", context.studioId)
        .eq("rule_key", ruleKey)
        .eq("related_table", "client_packages")
        .in(
          "related_id",
          candidates.map((candidate) => candidate.clientPackage.id)
        )
        .in("status", ["suggested", "drafted", "queued"]);

      if (existingError) {
        throw new Error(existingError.message);
      }

      for (const action of existingActions ?? []) {
        if (action.related_id) existingRelatedIds.add(String(action.related_id));
      }
    }

    const now = new Date();
    const dueAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const actionStatus = packageActionStatusForMode(rule.mode);
    const actionsToCreate = candidates
      .filter((candidate) => !existingRelatedIds.has(candidate.clientPackage.id))
      .map((candidate) => {
        const clientName = getClientDisplayName(candidate.clientPackage.clients);
        const packageName = candidate.clientPackage.name_snapshot || "package";
        const lowItemSummary = candidate.lowItems
          .map((item) => `${item.quantity_remaining ?? 0} ${item.usage_type ?? "credit"}`)
          .join(", ");

        return {
          studio_id: context.studioId,
          rule_id: rule.id,
          rule_key: ruleKey,
          title: `Package renewal suggested: ${clientName}`,
          body: `${clientName} has ${candidate.lowestRemaining} or fewer credits remaining on ${packageName}. Review their balance and send a renewal prompt from the client profile or package sales workflow. Low items: ${lowItemSummary}.`,
          status: actionStatus,
          priority: candidate.lowestRemaining <= 0 ? "urgent" : "high",
          related_table: "client_packages",
          related_id: candidate.clientPackage.id,
          client_id: candidate.clientPackage.client_id,
          due_at: dueAt,
          created_by_run_id: run.id,
        };
      });

    createdCount = actionsToCreate.length;

    if (actionsToCreate.length > 0) {
      const { error: actionError } = await supabase
        .from("automation_actions")
        .insert(actionsToCreate);

      if (actionError) {
        throw new Error(actionError.message);
      }
    }

    const finishedAt = new Date().toISOString();

    await Promise.all([
      supabase
        .from("automation_runs")
        .update({
          status: "completed",
          candidates_count: candidatesCount,
          actions_created_count: createdCount,
          finished_at: finishedAt,
        })
        .eq("id", run.id)
        .eq("studio_id", context.studioId),
      supabase
        .from("automation_rules")
        .update({
          last_evaluated_at: finishedAt,
          updated_at: finishedAt,
        })
        .eq("id", rule.id)
        .eq("studio_id", context.studioId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown automation error";
    const finishedAt = new Date().toISOString();

    await supabase
      .from("automation_runs")
      .update({
        status: "failed",
        error_message: message,
        finished_at: finishedAt,
      })
      .eq("id", run.id)
      .eq("studio_id", context.studioId);

    await supabase
      .from("automation_rules")
      .update({
        last_evaluated_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("id", rule.id)
      .eq("studio_id", context.studioId);

    revalidatePath("/app/automations");
    redirect(`/app/automations?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app");
  revalidatePath("/app/packages/client-balances");
  redirect(
    `/app/automations?success=evaluated&created=${createdCount}&candidates=${candidatesCount}`
  );
}

export async function getAutomationDefinitions() {
  return AUTOMATION_DEFINITIONS;
}
