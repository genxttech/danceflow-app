"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getLumiUsageAllowance,
  recordLumiUsage,
  resolveLumiPortalAccess,
} from "@/lib/lumi/portal";

export type LumiAssistantState = {
  ok: boolean;
  error?: string;
  headline?: string;
  summary?: string;
  practicePriorities?: string[];
  instructorQuestions?: string[];
  encouragement?: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function journeyPath(studioSlug: string) {
  return `/portal/${encodeURIComponent(studioSlug)}/journey`;
}

export async function createLumiGoalAction(formData: FormData) {
  const studioSlug = getString(formData, "studioSlug");
  const title = getString(formData, "title").slice(0, 160);
  const category = getString(formData, "category") || "general";
  const targetDate = getString(formData, "targetDate");
  const notes = getString(formData, "notes").slice(0, 1000);
  const returnTo = journeyPath(studioSlug);

  if (!studioSlug || !title) {
    redirect(`${returnTo}?error=${encodeURIComponent("Add a goal before saving.")}`);
  }

  const access = await resolveLumiPortalAccess(studioSlug);
  if (!access.allowed) redirect(returnTo);

  const allowedCategories = new Set([
    "general",
    "social",
    "syllabus",
    "showcase",
    "competition",
    "confidence",
    "fitness",
  ]);
  const { error } = await access.admin.from("student_dance_goals").insert({
    studio_id: access.studio.id,
    client_id: access.client.id,
    title,
    category: allowedCategories.has(category) ? category : "general",
    target_date: targetDate || null,
    notes: notes || null,
  });

  if (error) {
    redirect(`${returnTo}?error=${encodeURIComponent("Your goal could not be saved.")}`);
  }

  revalidatePath(returnTo);
  redirect(`${returnTo}?success=goal-added`);
}

export async function completeLumiGoalAction(formData: FormData) {
  const studioSlug = getString(formData, "studioSlug");
  const goalId = getString(formData, "goalId");
  const returnTo = journeyPath(studioSlug);
  const access = await resolveLumiPortalAccess(studioSlug);
  if (!access.allowed || !goalId) redirect(returnTo);

  await access.admin
    .from("student_dance_goals")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", goalId)
    .eq("studio_id", access.studio.id)
    .eq("client_id", access.client.id);

  revalidatePath(returnTo);
  redirect(`${returnTo}?success=goal-completed`);
}

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
  error?: { message?: string };
};

function outputText(data: OpenAiResponse) {
  return (
    data.output_text?.trim() ||
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() ||
    ""
  );
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function generateLumiPlanAction(
  _previousState: LumiAssistantState,
  formData: FormData,
): Promise<LumiAssistantState> {
  const studioSlug = getString(formData, "studioSlug");
  const requestedTask = getString(formData, "task");
  const task = ["weekly_plan", "next_lesson", "recap_patterns"].includes(
    requestedTask,
  )
    ? requestedTask
    : "weekly_plan";
  const access = await resolveLumiPortalAccess(studioSlug);

  if (!access.allowed) {
    return { ok: false, error: "LUMI is not available for this portal right now." };
  }

  const allowance = await getLumiUsageAllowance(access);
  if (!allowance.allowed) {
    return {
      ok: false,
      error: "Your studio's monthly AI allowance has been used. Try again after it renews.",
    };
  }

  if (process.env.AI_FEATURES_ENABLED !== "true" || !process.env.OPENAI_API_KEY) {
    return { ok: false, error: "LUMI is not configured yet." };
  }

  const nowIso = new Date().toISOString();
  const [{ data: goals }, { data: appointments }, { data: syllabusAssignments }] =
    await Promise.all([
      access.admin
        .from("student_dance_goals")
        .select("title, category, notes, target_date, status")
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(8),
      access.admin
        .from("appointments")
        .select("id, title, appointment_type, starts_at, status")
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .order("starts_at", { ascending: false })
        .limit(20),
      access.admin
        .from("client_syllabus_assignments")
        .select(
          `id, visible_in_portal, archived_at,
           syllabus_templates (name, dance_style, level),
           client_syllabus_progress (status, notes, show_notes_in_portal, syllabus_template_items (title))`,
        )
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("visible_in_portal", true)
        .is("archived_at", null)
        .limit(8),
    ]);

  const appointmentIds = (appointments ?? []).map((item) => item.id);
  const { data: recaps } = appointmentIds.length
    ? await access.admin
        .from("lesson_recaps")
        .select("appointment_id, summary, homework, next_focus, updated_at")
        .eq("studio_id", access.studio.id)
        .in("appointment_id", appointmentIds)
        .eq("visible_to_client", true)
        .order("updated_at", { ascending: false })
        .limit(6)
    : { data: [] };

  const upcoming = (appointments ?? [])
    .filter((item) => item.starts_at >= nowIso && item.status !== "cancelled")
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 3);
  const studentName =
    `${access.client.first_name ?? ""} ${access.client.last_name ?? ""}`.trim() ||
    "the dancer";
  const visibleSyllabusProgress = (syllabusAssignments ?? []).map(
    (assignment) => ({
      ...assignment,
      client_syllabus_progress: (assignment.client_syllabus_progress ?? []).map(
        (progress) => ({
          status: progress.status,
          notes: progress.show_notes_in_portal ? progress.notes : null,
          syllabus_template_items: progress.syllabus_template_items,
        }),
      ),
    }),
  );
  const context = {
    task,
    studentName,
    goals: goals ?? [],
    visibleLessonRecaps: recaps ?? [],
    visibleSyllabusProgress,
    upcomingLessons: upcoming,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model:
        process.env.OPENAI_MODEL_LUMI ??
        process.env.OPENAI_MODEL_LESSON_ASSISTANT ??
        "gpt-4.1-mini",
      temperature: 0.35,
      max_output_tokens: 900,
      input: [
        {
          role: "system",
          content:
            "You are LUMI, a warm student-facing dance journey assistant. Use only the provided student-visible goals, lesson recaps, syllabus progress, and schedule. Reinforce the instructor's coaching and never override it. Do not invent technique, progress, results, diagnoses, guarantees, or private studio information. Give practical, encouraging priorities and questions the dancer can discuss with the instructor. Return only valid JSON with keys: headline, summary, practicePriorities (array of up to 4 short strings), instructorQuestions (array of up to 3 short strings), encouragement.",
        },
        {
          role: "user",
          content: `Create the requested dance journey guidance from this context:\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAiResponse;
  if (!response.ok) {
    return { ok: false, error: data.error?.message ?? "LUMI could not prepare guidance right now." };
  }

  const parsed = parseJson(outputText(data)) as {
    headline?: unknown;
    summary?: unknown;
    practicePriorities?: unknown;
    instructorQuestions?: unknown;
    encouragement?: unknown;
  } | null;

  if (!parsed) return { ok: false, error: "LUMI did not return readable guidance." };

  await recordLumiUsage(access, { task });
  const list = (value: unknown, max: number) =>
    Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, max)
      : [];

  return {
    ok: true,
    headline: String(parsed.headline ?? "Your next dance focus").trim(),
    summary: String(parsed.summary ?? "").trim(),
    practicePriorities: list(parsed.practicePriorities, 4),
    instructorQuestions: list(parsed.instructorQuestions, 3),
    encouragement: String(parsed.encouragement ?? "").trim(),
  };
}
