"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

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
  const raw = String(value ?? "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/platform/ops-review";
  return raw;
}

function normalizeSetValue(value: FormDataEntryValue | null, allowed: Set<string>, fallback: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function nullableText(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
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
  const studioId = String(formData.get("studioId") ?? "").trim();
  const signalKey = String(formData.get("signalKey") ?? "").trim();
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
  const studioId = String(formData.get("studioId") ?? "").trim();
  const signalKey = String(formData.get("signalKey") ?? "").trim();
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
