"use server";

export type EventDescriptionAIState = {
  ok: boolean;
  error?: string;
  summaryText?: string;
  descriptionText?: string;
  socialCaption?: string;
  ticketCopy?: string;
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

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export async function generateEventDescriptionAssistantAction(
  _previousState: EventDescriptionAIState,
  formData: FormData,
): Promise<EventDescriptionAIState> {
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
            "You write public event and class descriptions for dance studios and dance event organizers. Keep copy clear, welcoming, and action-oriented. Do not mention AI, internal implementation, prompts, phases, database details, or unsupported product claims. Do not invent exact prices, discounts, locations, instructors, dates, times, policies, or guarantees unless provided. Return only valid JSON with keys: summaryText, descriptionText, socialCaption, ticketCopy. summaryText must be 1-2 short sentences. descriptionText must be plain text with short paragraphs and no markdown. socialCaption must be concise and social-ready. ticketCopy must be one short call-to-action sentence.",
        },
        {
          role: "user",
          content: `Create event or class copy using this context:\n${JSON.stringify(prompt, null, 2)}`,
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
        "AI writing help could not generate copy right now. Please try again.",
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
