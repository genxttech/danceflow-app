"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { callOpenAiResponses } from "@/lib/ai/providerCall";
import { studioHasFeature } from "@/lib/billing/access";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canViewCommunications } from "@/lib/auth/permissions";
import { updateMarketingCampaignDraftAction } from "./actions";
import { getUsageAllowance, getUsageLimitMessage, recordUsageEvent } from "@/lib/usage/addons";

export type CampaignAIAssistantState = {
  ok: boolean;
  error?: string;
  subjectIdeas?: string[];
  previewText?: string;
  bodyText?: string;
};

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOutputText(data: OpenAiResponse) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();

  return text || null;
}

function parseJsonFromText(text: string) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

export async function generateCampaignDraftAssistantAction(
  _previousState: CampaignAIAssistantState,
  formData: FormData,
): Promise<CampaignAIAssistantState> {
  const canUseAi = await studioHasFeature("ai_assistant");

  if (!canUseAi) {
    return {
      ok: false,
      error: "AI campaign drafting is available on Growth and Pro plans.",
    };
  }

  const allowance = await getUsageAllowance({ featureKey: "ai_action" });

  if (!allowance.allowed) {
    return {
      ok: false,
      error: getUsageLimitMessage(allowance, "AI action"),
    };
  }

  const audienceLabel = getString(formData, "audienceLabel") || "selected audience";
  const campaignContext = getString(formData, "campaignContext") || "dance business";
  const eventName = getString(formData, "eventName");
  const task = getString(formData, "task") || "generate";
  const goal = getString(formData, "goal");
  const currentSubject = getString(formData, "currentSubject");
  const currentPreviewText = getString(formData, "currentPreviewText");
  const currentBodyText = getString(formData, "currentBodyText");
  const ctaLabel = getString(formData, "ctaLabel");
  const ctaUrl = getString(formData, "ctaUrl");

  const model =
    process.env.OPENAI_MODEL_CAMPAIGN_DRAFTS ??
    process.env.OPENAI_MODEL_REPORT_INSIGHTS ??
    "gpt-4.1-mini";

  const prompt = {
    campaignContext,
    audienceLabel,
    eventName: eventName || null,
    task,
    goal: goal || null,
    currentSubject: currentSubject || null,
    currentPreviewText: currentPreviewText || null,
    currentBodyText: currentBodyText || null,
    ctaLabel: ctaLabel || null,
    ctaUrl: ctaUrl || null,
  };

  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("ai:campaign-draft", [audienceLabel, eventName, task]),
    { limit: 10, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return { ok: false, error: rateLimitErrorMessage(rateLimit) };
  }

  const result = await callOpenAiResponses({
    feature: "campaign_draft",
    model,
    temperature: 0.45,
    maxOutputTokens: 900,
    maxInputChars: 20000,
    input: [
        {
          role: "system",
          content:
            "You write practical marketing emails for dance studios and dance event organizers. Keep the copy clear, friendly, and action-oriented. Do not mention AI, internal implementation, prompts, phases, database details, or unsupported product claims. Do not invent exact dates, prices, discounts, locations, or guarantees unless provided. Return only valid JSON with keys: subjectIdeas, previewText, bodyText. subjectIdeas must be an array of 3 short subject lines. previewText must be one short preview sentence. bodyText must be plain text with short paragraphs and no markdown.",
        },
        {
          role: "user",
          content: `Create campaign copy using this context:\n${JSON.stringify(prompt, null, 2)}`,
        },
    ],
  });

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const text = result.text;

  const parsed = parseJsonFromText(text) as
    | {
        subjectIdeas?: unknown;
        previewText?: unknown;
        bodyText?: unknown;
      }
    | null;

  await recordUsageEvent({
    featureKey: "ai_action",
    source: "campaign_ai_assistant",
    metadata: { audienceLabel, task, hasEventName: Boolean(eventName) },
  });

  if (!parsed) {
    return {
      ok: true,
      subjectIdeas: [],
      previewText: "",
      bodyText: text,
    };
  }

  return {
    ok: true,
    subjectIdeas: cleanStringArray(parsed.subjectIdeas),
    previewText: String(parsed.previewText ?? "").trim(),
    bodyText: String(parsed.bodyText ?? "").trim(),
  };
}

/**
 * Marketing M-1b: apply the assistant's suggestion (subject / preview / body) to a studio campaign draft.
 * Explicitly user-confirmed (confirmApply=yes), never sends, never calls the AI provider (so no ai_action usage is
 * recorded here; generation stays metered in generateCampaignDraftAssistantAction), and writes only through
 * updateMarketingCampaignDraftAction, which refuses non-draft campaigns, started deliveries, a frozen send state and
 * unauthorized roles. Fields not supplied keep the campaign's current values.
 */
export async function applyCampaignAiSuggestionToDraftAction(formData: FormData) {
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/marketing/campaigns/${campaignId}`
    : "/app/marketing/campaigns";
  const fail = (code: string): never => redirect(`${fallback}?campaign_error=${code}`);

  if (!campaignId) fail("not_found");
  if (getString(formData, "confirmApply") !== "yes") fail("apply_not_confirmed");

  const subject = getString(formData, "subject");
  const previewText = getString(formData, "previewText");
  const bodyText = getString(formData, "bodyText");
  if (!subject && !previewText && !bodyText) fail("apply_empty");

  const context = await getCurrentStudioContext();
  if (!context.studioId) redirect("/login");
  if (!canViewCommunications(context.studioRole ?? "")) fail("unauthorized");

  const supabase = await createClient();
  const { data: campaign, error } = await supabase
    .from("marketing_campaigns")
    .select("id, name, subject, preview_text, body_text, cta_label, cta_url, audience_type, audience_event_id")
    .eq("id", campaignId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (error || !campaign) return fail("not_found");

  const merged = new FormData();
  merged.set("campaignId", campaign.id);
  merged.set("name", campaign.name ?? "");
  merged.set("audienceType", campaign.audience_type ?? "");
  merged.set("audienceEventId", campaign.audience_event_id ?? "");
  merged.set("subject", subject || campaign.subject || "");
  merged.set("previewText", previewText || campaign.preview_text || "");
  merged.set("bodyText", bodyText || campaign.body_text || "");
  merged.set("ctaLabel", campaign.cta_label ?? "");
  merged.set("ctaUrl", campaign.cta_url ?? "");

  await updateMarketingCampaignDraftAction(merged);
}
