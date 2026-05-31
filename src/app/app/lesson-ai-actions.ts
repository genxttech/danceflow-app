"use server";

import { studioHasFeature } from "@/lib/billing/access";

export type LessonAIAssistantState = {
  ok: boolean;
  error?: string;
  summary?: string;
  practiceNotes?: string;
  nextFocus?: string;
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
    if (!match) return null;

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

export async function generateLessonAssistantAction(
  _previousState: LessonAIAssistantState,
  formData: FormData,
): Promise<LessonAIAssistantState> {
  const canUseAi = await studioHasFeature("ai_assistant");

  if (!canUseAi) {
    return {
      ok: false,
      error: "AI lesson help is available on Growth and Pro plans.",
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

  const mode = getString(formData, "mode") || "lesson_recap";
  const task = getString(formData, "task") || "student_friendly";
  const clientName = getString(formData, "clientName") || "the student";
  const appointmentType = getString(formData, "appointmentType") || "lesson";
  const lessonTitle = getString(formData, "lessonTitle");
  const instructorNotes = getString(formData, "instructorNotes");
  const currentSummary = getString(formData, "currentSummary");
  const currentHomework = getString(formData, "currentHomework");
  const currentNextFocus = getString(formData, "currentNextFocus");
  const syllabusName = getString(formData, "syllabusName");
  const danceStyle = getString(formData, "danceStyle");
  const figureTitle = getString(formData, "figureTitle");
  const figureDescription = getString(formData, "figureDescription");
  const progressStatus = getString(formData, "progressStatus");
  const progressNotes = getString(formData, "progressNotes");

  const model =
    process.env.OPENAI_MODEL_LESSON_ASSISTANT ??
    process.env.OPENAI_MODEL_REPORT_INSIGHTS ??
    "gpt-4.1-mini";

  const prompt = {
    mode,
    task,
    clientName,
    appointmentType,
    lessonTitle: lessonTitle || null,
    instructorNotes: instructorNotes || null,
    currentSummary: currentSummary || null,
    currentHomework: currentHomework || null,
    currentNextFocus: currentNextFocus || null,
    syllabusName: syllabusName || null,
    danceStyle: danceStyle || null,
    figureTitle: figureTitle || null,
    figureDescription: figureDescription || null,
    progressStatus: progressStatus || null,
    progressNotes: progressNotes || null,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_output_tokens: 800,
      input: [
        {
          role: "system",
          content:
            "You help dance instructors write clear, encouraging, student-friendly lesson recap and syllabus practice notes. Keep the tone professional, supportive, and practical. Do not mention AI, prompts, internal implementation, phases, database details, or unsupported product claims. Do not invent facts, dates, prices, or guarantees. Avoid medical advice. Return only valid JSON with keys: summary, practiceNotes, nextFocus. Use plain text, short paragraphs, and no markdown.",
        },
        {
          role: "user",
          content: `Draft student-facing lesson or syllabus notes using this context:\n${JSON.stringify(prompt, null, 2)}`,
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
        "AI writing help could not generate notes right now. Please try again.",
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
        summary?: unknown;
        practiceNotes?: unknown;
        nextFocus?: unknown;
      }
    | null;

  if (!parsed) {
    return {
      ok: true,
      summary: text,
      practiceNotes: "",
      nextFocus: "",
    };
  }

  return {
    ok: true,
    summary: cleanText(parsed.summary),
    practiceNotes: cleanText(parsed.practiceNotes),
    nextFocus: cleanText(parsed.nextFocus),
  };
}
