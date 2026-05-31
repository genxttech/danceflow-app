"use server";

export type FollowUpMessageState = {
  ok: boolean;
  error?: string;
  message?: string;
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

export async function generateFollowUpMessageAction(
  _previousState: FollowUpMessageState,
  formData: FormData,
): Promise<FollowUpMessageState> {
  if (process.env.AI_FEATURES_ENABLED !== "true") {
    return {
      ok: false,
      error: "AI follow-up help is not enabled yet.",
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: "AI follow-up help is not configured yet.",
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

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_output_tokens: 350,
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
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAiResponse;

  if (!response.ok) {
    return {
      ok: false,
      error:
        data.error?.message ??
        "AI follow-up help could not generate a message right now. Please try again.",
    };
  }

  const text = getOutputText(data);

  if (!text) {
    return {
      ok: false,
      error: "AI follow-up help did not return a readable response.",
    };
  }

  return {
    ok: true,
    message: text,
  };
}
