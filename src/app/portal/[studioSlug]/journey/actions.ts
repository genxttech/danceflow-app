"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveLumiPortalAccess } from "@/lib/lumi/portal";
import {
  getLumiUsageSnapshot,
  lumiRefusalMessage,
  releaseLumiUsage,
  reserveLumiUsage,
  settleLumiUsage,
} from "@/lib/lumi/usage";
import { callOpenAiResponses, isAiFeatureEnabled } from "@/lib/ai/providerCall";
import { orderSyllabusProgress, serializeLumiContext } from "@/lib/lumi/context";

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

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

type GroupLessonRecapRow = {
  title: string | null;
  summary: string | null;
  technique_notes: string | null;
  safety_notes: string | null;
  practice_assignment: string | null;
  published_at: string | null;
};

type GroupLessonRecapRecipientRow = {
  group_lesson_recaps: GroupLessonRecapRow | GroupLessonRecapRow[] | null;
};

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

  if (!isAiFeatureEnabled("lumi_plan")) {
    return { ok: false, error: "LUMI is not configured yet." };
  }

  const snapshot = await getLumiUsageSnapshot(access);
  if (!snapshot.allowed) {
    return { ok: false, error: lumiRefusalMessage(snapshot.reason) };
  }

  // Rate limit BEFORE any context query or provider spend. Keyed by the signed-in dancer + studio (not only the IP).
  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("ai:lumi", [studioSlug, access.client.id, task]),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return { ok: false, error: rateLimitErrorMessage(rateLimit) };
  }

  // Reserve capacity BEFORE the provider call (concurrency-safe: see lib/lumi/usage.ts).
  const reservation = await reserveLumiUsage(access, task);
  if (!reservation.ok) {
    return { ok: false, error: lumiRefusalMessage(reservation.reason) };
  }

  let settled = false;
  try {
  const nowIso = new Date().toISOString();
  const [{ data: goals }, { data: appointments }, { data: syllabusAssignments }, { data: groupRecapRows }] =
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
           client_syllabus_progress (status, notes, show_notes_in_portal, updated_at, syllabus_template_items (title))`,
        )
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("visible_in_portal", true)
        .is("archived_at", null)
        .order("assigned_at", { ascending: false })
        .limit(8),
      access.admin
        .from("group_lesson_recap_recipients")
        .select(
          `group_lesson_recaps!inner (
            title,
            summary,
            technique_notes,
            safety_notes,
            practice_assignment,
            published_at
          )`,
        )
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("group_lesson_recaps.status", "published")
        .order("created_at", { ascending: false })
        .limit(6),
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
      client_syllabus_progress: orderSyllabusProgress(assignment.client_syllabus_progress ?? []).map(
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
    visibleGroupLessonRecaps: ((groupRecapRows ?? []) as GroupLessonRecapRecipientRow[])
      .map((row) => firstRelation(row.group_lesson_recaps))
      .filter((recap): recap is GroupLessonRecapRow => Boolean(recap)),
    visibleSyllabusProgress,
    upcomingLessons: upcoming,
  };

  const result = await callOpenAiResponses({
    feature: "lumi_plan",
    model:
      process.env.OPENAI_MODEL_LUMI ??
      process.env.OPENAI_MODEL_LESSON_ASSISTANT ??
      "gpt-4.1-mini",
    temperature: 0.35,
    maxOutputTokens: 900,
    maxInputChars: 40000,
    input: [
      {
        role: "system",
        content:
          "You are LUMI, a warm student-facing dance journey assistant. Use only the provided student-visible goals, private lesson recaps, group lesson recaps, syllabus progress, and schedule. Reinforce the instructor's coaching and never override it. Do not invent technique, progress, results, diagnoses, guarantees, or private studio information. Give practical, encouraging priorities and questions the dancer can discuss with the instructor. Return only valid JSON with keys: headline, summary, practicePriorities (array of up to 4 short strings), instructorQuestions (array of up to 3 short strings), encouragement.",
      },
      {
        role: "user",
        content: `Create the requested dance journey guidance from this context:\n${serializeLumiContext(context)}`,
      },
    ],
  });

  if (!result.ok) {
    // Give the reserved capacity back only when nothing was billed (refused before sending, or rejected by the provider).
    // A timeout, a dropped connection or an empty answer may still have been billed, so it stays counted.
    settled = true;
    if (result.mayHaveBilled) {
      await settleLumiUsage(access, reservation.id, task, { outcome: result.reason });
    } else {
      await releaseLumiUsage(access, reservation.id, task);
    }
    return { ok: false, error: result.message };
  }

  // The provider was reached and produced output: this request is billable whether or not the JSON parses.
  settled = true;
  await settleLumiUsage(access, reservation.id, task, {
    outcome: "ok",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  const parsed = parseJson(result.text) as {
    headline?: unknown;
    summary?: unknown;
    practicePriorities?: unknown;
    instructorQuestions?: unknown;
    encouragement?: unknown;
  } | null;

  if (!parsed) return { ok: false, error: "LUMI did not return readable guidance." };

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
  } catch (error) {
    // Anything thrown between reservation and settlement (a context query, a crash in parsing) must not leave the
    // reserved capacity stuck. A call that already reached the provider stays counted.
    if (!settled) await releaseLumiUsage(access, reservation.id, task);
    console.error("LUMI plan generation failed", error instanceof Error ? error.message : error);
    return { ok: false, error: "LUMI could not prepare guidance right now." };
  }
}
