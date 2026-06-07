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

export async function getAutomationDefinitions() {
  return AUTOMATION_DEFINITIONS;
}
