"use server";

import { studioHasFeature } from "@/lib/billing/access";
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

  if (process.env.AI_FEATURES_ENABLED !== "true") {
    return {
      ok: false,
      error: "AI writing help is not enabled yet.",
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: "AI writing help is not configured yet.",
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

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.45,
      max_output_tokens: 900,
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
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAiResponse;

  if (!response.ok) {
    return {
      ok: false,
      error:
        data.error?.message ??
        "AI writing help could not generate a draft right now. Please try again.",
    };
  }

  const text = getOutputText(data);

  if (!text) {
    return {
      ok: false,
      error: "AI writing help did not return a readable response.",
    };
  }

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
