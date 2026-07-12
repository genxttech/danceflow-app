"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import {
  cleanTextValue,
  getValidatedValue,
  normalizeOptionalUuid,
  rawFormString,
  safeLocalRedirectPath,
} from "@/lib/validation/forms";

const DISMISSAL_STATUSES = new Set(["reviewed", "skipped"]);
const FOLLOW_UP_CATEGORIES = new Set([
  "onboarding_nudge",
  "billing_follow_up",
  "trial_conversion",
  "technical_support",
  "retention_save",
  "upgrade_opportunity",
]);
const FOLLOW_UP_PRIORITIES = new Set(["low", "medium", "high"]);

function safeReturnPath(value: FormDataEntryValue | null) {
  const path = safeLocalRedirectPath(typeof value === "string" ? value : "", "/platform/ops-review");
  return path.startsWith("/platform") ? path : "/platform/ops-review";
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

function normalizeSignalKey(value: FormDataEntryValue | null) {
  const raw = rawFormString({ get: () => value } as unknown as FormData, "signalKey");
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9:_-]{0,120}$/.test(normalized)) return "";
  return normalized;
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

async function getCurrentUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, userId: user?.id ?? null };
}

export async function markPlatformOpsReviewSignalAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeReturnPath(formData.get("returnTo"));
  const studioId = normalizeUuid(formData.get("studioId"), "Studio");
  const signalKey = normalizeSignalKey(formData.get("signalKey"));
  const status = normalizeSetValue(formData.get("status"), DISMISSAL_STATUSES, "reviewed");
  const reason = nullableText(formData.get("reason"));

  if (!studioId || !signalKey) redirect(returnTo);

  const { supabase, userId } = await getCurrentUserId();

  const { error } = await supabase.from("platform_ops_review_dismissals").upsert(
    {
      studio_id: studioId,
      signal_key: signalKey,
      status,
      reason,
      metadata: {
        source: "platform_ops_review",
      },
      created_by: userId,
    },
    {
      onConflict: "studio_id,signal_key,status",
    }
  );

  if (error) {
    throw new Error(`Failed to mark ops review signal: ${error.message}`);
  }

  revalidatePath("/platform/ops-review");
  revalidatePath("/platform/success");
  revalidatePath("/platform/studio-health");
  revalidatePath(`/platform/studios/${studioId}`);
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}signal_${status}=1`);
}

export async function createOpsReviewFollowUpAction(formData: FormData) {
  await requirePlatformAdmin();

  const returnTo = safeReturnPath(formData.get("returnTo"));
  const studioId = normalizeUuid(formData.get("studioId"), "Studio");
  const signalKey = normalizeSignalKey(formData.get("signalKey"));
  const category = normalizeSetValue(formData.get("category"), FOLLOW_UP_CATEGORIES, "onboarding_nudge");
  const priority = normalizeSetValue(formData.get("priority"), FOLLOW_UP_PRIORITIES, "medium");
  const note = nullableText(formData.get("note"));
  const nextFollowUpAt = nullableDate(formData.get("nextFollowUpAt"));

  if (!studioId || !signalKey) redirect(returnTo);

  const { supabase, userId } = await getCurrentUserId();

  const { error: followUpError } = await supabase.from("platform_success_followups").insert({
    studio_id: studioId,
    category,
    priority,
    status: "open",
    note,
    next_follow_up_at: nextFollowUpAt,
    created_by: userId,
    updated_by: userId,
  });

  if (followUpError) {
    throw new Error(`Failed to create ops review follow-up: ${followUpError.message}`);
  }

  const { error: dismissalError } = await supabase.from("platform_ops_review_dismissals").upsert(
    {
      studio_id: studioId,
      signal_key: signalKey,
      status: "reviewed",
      reason: "Follow-up created from Ops Review",
      metadata: {
        source: "platform_ops_review",
        follow_up_category: category,
        follow_up_priority: priority,
      },
      created_by: userId,
    },
    {
      onConflict: "studio_id,signal_key,status",
    }
  );

  if (dismissalError) {
    throw new Error(`Failed to mark ops review signal reviewed: ${dismissalError.message}`);
  }

  revalidatePath("/platform/ops-review");
  revalidatePath("/platform/success");
  revalidatePath("/platform/studio-health");
  revalidatePath(`/platform/studios/${studioId}`);
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}followup_created=1`);
}
