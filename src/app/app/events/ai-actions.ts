"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { callOpenAiResponses } from "@/lib/ai/providerCall";
import { studioHasFeature } from "@/lib/billing/access";
import { getUsageAllowance, getUsageLimitMessage, recordUsageEvent } from "@/lib/usage/addons";
export type EventDescriptionAIState = {
  ok: boolean;
  error?: string;
  summaryText?: string;
  descriptionText?: string;
  socialCaption?: string;
  ticketCopy?: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export async function generateEventDescriptionAssistantAction(
  _previousState: EventDescriptionAIState,
  formData: FormData,
): Promise<EventDescriptionAIState> {
  const canUseAi = await studioHasFeature("ai_assistant");

  if (!canUseAi) {
    return {
      ok: false,
      error: "AI event writing help is available on Growth and Pro plans.",
    };
  }

  const allowance = await getUsageAllowance({ featureKey: "ai_action" });

  if (!allowance.allowed) {
    return {
      ok: false,
      error: getUsageLimitMessage(allowance, "AI action"),
    };
  }

  const eventName = getString(formData, "eventName");
  const eventType = getString(formData, "eventType") || "event";
  const danceCategory = getString(formData, "danceCategory");
  const danceStyles = getString(formData, "danceStyles");
  const startDate = getString(formData, "startDate");
  const startTime = getString(formData, "startTime");
  const venueName = getString(formData, "venueName");
  const city = getString(formData, "city");
  const state = getString(formData, "state");
  const beginnerFriendly = getString(formData, "beginnerFriendly") === "true";
  const currentSummary = getString(formData, "currentSummary");
  const currentDescription = getString(formData, "currentDescription");
  const task = getString(formData, "task") || "generate";
  const goal = getString(formData, "goal");

  const model =
    process.env.OPENAI_MODEL_EVENT_DESCRIPTIONS ??
    process.env.OPENAI_MODEL_CAMPAIGN_DRAFTS ??
    process.env.OPENAI_MODEL_REPORT_INSIGHTS ??
    "gpt-4.1-mini";

  const prompt = {
    eventName: eventName || null,
    eventType,
    danceCategory: danceCategory || null,
    danceStyles: danceStyles || null,
    startDate: startDate || null,
    startTime: startTime || null,
    venueName: venueName || null,
    city: city || null,
    state: state || null,
    beginnerFriendly,
    task,
    goal: goal || null,
    currentSummary: currentSummary || null,
    currentDescription: currentDescription || null,
  };

  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("ai:event-description", [eventName, eventType, task]),
    { limit: 10, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return { ok: false, error: rateLimitErrorMessage(rateLimit) };
  }

  const result = await callOpenAiResponses({
    feature: "event_description",
    model,
    temperature: 0.45,
    maxOutputTokens: 900,
    maxInputChars: 16000,
    input: [
        {
          role: "system",
          content:
            "You write public event and class descriptions for dance studios and dance event organizers. Keep copy clear, welcoming, and action-oriented. Do not mention AI, internal implementation, prompts, phases, database details, or unsupported product claims. Do not invent exact prices, discounts, locations, instructors, dates, times, policies, or guarantees unless provided. Return only valid JSON with keys: summaryText, descriptionText, socialCaption, ticketCopy. summaryText must be 1-2 short sentences. descriptionText must be plain text with short paragraphs and no markdown. socialCaption must be concise and social-ready. ticketCopy must be one short call-to-action sentence.",
        },
        {
          role: "user",
          content: `Create event or class copy using this context:\n${JSON.stringify(prompt, null, 2)}`,
        },
    ],
  });

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const text = result.text;

  await recordUsageEvent({
    featureKey: "ai_action",
    source: "event_ai_assistant",
    metadata: { task },
  });

  const parsed = parseJsonFromText(text) as
    | {
        summaryText?: unknown;
        descriptionText?: unknown;
        socialCaption?: unknown;
        ticketCopy?: unknown;
      }
    | null;

  if (!parsed) {
    return {
      ok: true,
      summaryText: "",
      descriptionText: text,
      socialCaption: "",
      ticketCopy: "",
    };
  }

  return {
    ok: true,
    summaryText: cleanText(parsed.summaryText),
    descriptionText: cleanText(parsed.descriptionText),
    socialCaption: cleanText(parsed.socialCaption),
    ticketCopy: cleanText(parsed.ticketCopy),
  };
}
