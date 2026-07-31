"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  REWARD_RULE_TEMPLATES,
  REWARD_TYPES,
  type RewardType,
} from "@/lib/rewards/catalog";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function redirectWithResult(kind: "success" | "error", code: string): never {
  redirect(`/app/rewards?${kind}=${encodeURIComponent(code)}`);
}

async function getRewardsManageContext() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (
    !context.isPlatformAdmin &&
    role !== "studio_owner" &&
    role !== "studio_admin"
  ) {
    redirect("/app");
  }

  return {
    supabase,
    studioId: context.studioId,
  };
}

function parseRewardValue(type: RewardType, raw: string) {
  const needsValue = [
    "points",
    "account_credit",
    "fixed_discount",
    "percent_discount",
  ].includes(type);

  if (!needsValue) return null;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("reward_value_required");
  }

  if (type === "percent_discount" && parsed > 100) {
    throw new Error("reward_percent_invalid");
  }

  return Math.round(parsed * 100) / 100;
}

export async function createRewardRuleAction(formData: FormData) {
  const { supabase, studioId } = await getRewardsManageContext();

  const templateKey = getString(formData, "templateKey");
  const rewardName = getString(formData, "rewardName");
  const rewardDescription = getString(formData, "rewardDescription");
  const rewardType = getString(formData, "rewardType") as RewardType;
  const rewardValueRaw = getString(formData, "rewardValue");
  const ruleName = getString(formData, "ruleName");
  const active = getString(formData, "active") === "on";

  const template = REWARD_RULE_TEMPLATES.find((item) => item.key === templateKey);

  if (!template) redirectWithResult("error", "template_not_found");
  if (!rewardName || !ruleName) redirectWithResult("error", "missing_fields");
  if (!REWARD_TYPES.includes(rewardType)) {
    redirectWithResult("error", "reward_type_invalid");
  }

  let rewardValue: number | null = null;

  try {
    rewardValue = parseRewardValue(rewardType, rewardValueRaw);
  } catch (error) {
    redirectWithResult(
      "error",
      error instanceof Error ? error.message : "reward_value_invalid",
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: reward, error: rewardError } = await supabase
    .from("studio_rewards")
    .insert({
      studio_id: studioId,
      name: rewardName,
      description: rewardDescription || null,
      reward_type: rewardType,
      reward_value: rewardValue,
      reward_config: {},
      active: true,
      created_by: user?.id ?? null,
      updated_by: user?.id ?? null,
    })
    .select("id")
    .single();

  if (rewardError || !reward) {
    redirectWithResult("error", "reward_create_failed");
  }

  const { error: ruleError } = await supabase.from("reward_rules").insert({
    studio_id: studioId,
    reward_id: reward.id,
    name: ruleName,
    description: template.description,
    trigger_type: template.triggerType,
    threshold_value: template.thresholdValue,
    threshold_unit: template.thresholdUnit,
    evaluation_window: template.evaluationWindow,
    eligibility_config: {
      template_key: template.key,
    },
    repeatable: template.repeatable,
    active,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  });

  if (ruleError) {
    await supabase
      .from("studio_rewards")
      .delete()
      .eq("id", reward.id)
      .eq("studio_id", studioId);

    redirectWithResult("error", "rule_create_failed");
  }

  revalidatePath("/app/rewards");
  redirectWithResult("success", active ? "reward_activated" : "reward_created");
}

export async function toggleRewardRuleAction(formData: FormData) {
  const { supabase, studioId } = await getRewardsManageContext();
  const ruleId = getString(formData, "ruleId");
  const nextActive = getString(formData, "nextActive") === "true";

  if (!ruleId) redirectWithResult("error", "rule_missing");

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("reward_rules")
    .update({
      active: nextActive,
      updated_by: user?.id ?? null,
    })
    .eq("id", ruleId)
    .eq("studio_id", studioId);

  if (error) redirectWithResult("error", "rule_update_failed");

  revalidatePath("/app/rewards");
  redirectWithResult("success", nextActive ? "rule_activated" : "rule_paused");
}


export async function recordRewardEventAction(formData: FormData) {
  const { supabase, studioId } = await getRewardsManageContext();
  const clientId = getString(formData, "clientId");
  const triggerType = getString(formData, "triggerType");
  const note = getString(formData, "note");

  if (!clientId || !triggerType) {
    redirectWithResult("error", "reward_event_missing_fields");
  }

  if (!["referral_converted", "review_or_feedback_completed"].includes(triggerType)) {
    redirectWithResult("error", "reward_event_invalid_type");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (clientError || !client) {
    redirectWithResult("error", "reward_event_client_not_found");
  }

  const idempotencyKey = `manual-${triggerType}-${clientId}-${Date.now()}`;

  const { error } = await supabase.rpc("record_reward_event", {
    target_studio_id: studioId,
    target_client_id: clientId,
    target_trigger_type: triggerType,
    target_event_value: 1,
    target_source_type: "studio_confirmation",
    target_source_id: null,
    target_idempotency_key: idempotencyKey,
    target_metadata: note ? { note } : {},
    target_occurred_at: new Date().toISOString(),
  });

  if (error) {
    redirectWithResult("error", "reward_event_failed");
  }

  revalidatePath("/app/rewards");
  redirectWithResult("success", "reward_event_recorded");
}

export async function redeemClientRewardAction(formData: FormData) {
  const { supabase } = await getRewardsManageContext();
  const clientRewardId = getString(formData, "clientRewardId");
  const note = getString(formData, "note");

  if (!clientRewardId) {
    redirectWithResult("error", "reward_redemption_missing");
  }

  const { data, error } = await supabase.rpc("redeem_client_reward", {
    target_client_reward_id: clientRewardId,
    redemption_note: note || null,
  });

  if (error || data !== true) {
    redirectWithResult("error", "reward_redemption_failed");
  }

  revalidatePath("/app/rewards");
  revalidatePath("/app/clients");
  redirectWithResult("success", "reward_redeemed");
}
