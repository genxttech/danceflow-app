"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import {
  cleanTextValue,
  getValidatedValue,
  normalizeOptionalUuid,
  safeLocalRedirectPath,
} from "@/lib/validation/forms";

const FOLLOW_UP_CATEGORIES = new Set([
  "onboarding_nudge",
  "billing_follow_up",
  "trial_conversion",
  "technical_support",
  "retention_save",
  "upgrade_opportunity",
]);

const FOLLOW_UP_PRIORITIES = new Set(["low", "medium", "high"]);
const FOLLOW_UP_OUTCOMES = new Set([
  "contacted",
  "waiting_on_customer",
  "converted",
  "resolved",
  "not_interested",
  "needs_internal_work",
  "other",
]);

function safeReturnPath(value: FormDataEntryValue | null) {
  const path = safeLocalRedirectPath(typeof value === "string" ? value : "", "/platform/success");
  return path.startsWith("/platform") ? path : "/platform/success";
}

function normalizeUuid(value: FormDataEntryValue | null, fieldLabel: string) {
  const result = normalizeOptionalUuid(typeof value === "string" ? value : "", fieldLabel);
  return result.ok ? result.value : null;
}

function cleanLimitedText(value: FormDataEntryValue | null, fieldLabel: string, maxLength: number) {
  const result = cleanTextValue(typeof value === "string" ? value : "", {
    fieldLabel,
    maxLength,
    allowNewlines: true,
  });

  return result.ok ? getValidatedValue(result) || null : null;
}

function normalizeSetValue(value: FormDataEntryValue | null, allowed: Set<string>, fallback: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function nullableText(value: FormDataEntryValue | null) {
  return cleanLimitedText(value, "Note", 1200);
}

function nullableDate(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return raw;
}

export async function createPlatformSuccessFollowUpAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioId = normalizeUuid(formData.get("studioId"), "Studio");
  const returnTo = safeReturnPath(formData.get("returnTo"));

  if (!studioId) {
    redirect(returnTo);
  }

  const category = normalizeSetValue(formData.get("category"), FOLLOW_UP_CATEGORIES, "onboarding_nudge");
  const priority = normalizeSetValue(formData.get("priority"), FOLLOW_UP_PRIORITIES, "medium");
  const note = nullableText(formData.get("note"));
  const nextFollowUpAt = nullableDate(formData.get("nextFollowUpAt"));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_success_followups").insert({
    studio_id: studioId,
    category,
    priority,
    status: "open",
    note,
    next_follow_up_at: nextFollowUpAt,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  });

  if (error) {
    throw new Error(`Failed to save success follow-up: ${error.message}`);
  }

  revalidatePath("/platform/success");
  revalidatePath("/platform/studio-health");
  revalidatePath(`/platform/studios/${studioId}`);
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}followup_created=1`);
}

export async function completePlatformSuccessFollowUpAction(formData: FormData) {
  await requirePlatformAdmin();

  const followUpId = normalizeUuid(formData.get("followUpId"), "Follow-up");
  const returnTo = safeReturnPath(formData.get("returnTo"));
  const outcome = normalizeSetValue(formData.get("outcome"), FOLLOW_UP_OUTCOMES, "contacted");
  const completionNote = nullableText(formData.get("completionNote"));

  if (!followUpId) {
    redirect(returnTo);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: existing, error: loadError } = await supabase
    .from("platform_success_followups")
    .select("studio_id, note")
    .eq("id", followUpId)
    .maybeSingle<{ studio_id: string; note: string | null }>();

  if (loadError) {
    throw new Error(`Failed to load success follow-up: ${loadError.message}`);
  }

  const note = completionNote
    ? [existing?.note, `Completion: ${completionNote}`].filter(Boolean).join("\n\n")
    : existing?.note ?? null;

  const { error } = await supabase
    .from("platform_success_followups")
    .update({
      status: "completed",
      outcome,
      note,
      completed_at: new Date().toISOString(),
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", followUpId);

  if (error) {
    throw new Error(`Failed to complete success follow-up: ${error.message}`);
  }

  revalidatePath("/platform/success");
  revalidatePath("/platform/studio-health");
  if (existing?.studio_id) revalidatePath(`/platform/studios/${existing.studio_id}`);
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}followup_completed=1`);
}
