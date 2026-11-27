"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { callOpenAiResponses } from "@/lib/ai/providerCall";
import { studioHasFeature } from "@/lib/billing/access";
import { getUsageAllowance, getUsageLimitMessage, recordUsageEvent } from "@/lib/usage/addons";

export type FollowUpMessageState = {
  ok: boolean;
  error?: string;
  message?: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function generateFollowUpMessageAction(
  _previousState: FollowUpMessageState,
  formData: FormData,
): Promise<FollowUpMessageState> {
  const canUseAi = await studioHasFeature("ai_assistant");

  if (!canUseAi) {
    return {
      ok: false,
      error: "AI follow-up suggestions are available on Growth and Pro plans.",
    };
  }

  const allowance = await getUsageAllowance({ featureKey: "ai_action" });

  if (!allowance.allowed) {
    return {
      ok: false,
      error: getUsageLimitMessage(allowance, "AI action"),
    };
  }

  const personName = getString(formData, "personName") || "this contact";
  const reason = getString(formData, "reason");
  const suggestedAction = getString(formData, "suggestedAction");
  const context = getString(formData, "context");
  const tone = getString(formData, "tone") || "friendly and professional";

  const model =
    process.env.OPENAI_MODEL_FOLLOW_UPS ??
    process.env.OPENAI_MODEL_REPORT_INSIGHTS ??
    "gpt-4.1-mini";

  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("ai:follow-up", [reason, suggestedAction, tone]),
    { limit: 12, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return { ok: false, error: rateLimitErrorMessage(rateLimit) };
  }

  const result = await callOpenAiResponses({
    feature: "follow_up",
    model,
    temperature: 0.4,
    maxOutputTokens: 350,
    maxInputChars: 12000,
    input: [
        {
          role: "system",
          content:
            "You write short, practical follow-up messages for dance studios. Keep the message warm, direct, and easy to send by email or text. Do not mention AI, internal product features, database details, or unsupported promises. Do not invent dates, discounts, prices, or lesson details that were not provided. Return only the message text with no markdown.",
        },
        {
          role: "user",
          content: `Write a short follow-up message.\n\nContact: ${personName}\nReason: ${reason}\nSuggested action: ${suggestedAction}\nContext: ${context || "No extra context provided."}\nTone: ${tone}`,
        },
    ],
  });

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const text = result.text;

  await recordUsageEvent({
    featureKey: "ai_action",
    source: "follow_up_ai_assistant",
    metadata: { reason, suggestedAction, tone },
  });

  return {
    ok: true,
    message: text,
  };
}
