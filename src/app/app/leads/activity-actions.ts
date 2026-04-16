"use server";

import { redirect } from "next/navigation";
import { requireClientEditAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function getLeadActivitySuccessRedirect(
  formData: FormData,
  fallback: string,
  successCode: string
) {
  const returnTo = getString(formData, "returnTo");
  return appendQueryParam(returnTo || fallback, "success", successCode);
}

function getLeadActivityErrorRedirect(
  formData: FormData,
  fallback: string,
  errorCode: string
) {
  const returnTo = getString(formData, "returnTo");
  return appendQueryParam(returnTo || fallback, "error", errorCode);
}

const ALLOWED_ACTIVITY_TYPES = [
  "note",
  "call",
  "text",
  "email",
  "consultation",
  "follow_up",
] as const;

export async function createLeadActivityAction(
  prevState: { error: string },
  formData: FormData
) {
  const clientId = getString(formData, "clientId");
  const fallbackUrl = clientId ? `/app/clients/${clientId}` : "/app/leads";

  try {
    const { supabase, studioId, user } = await requireClientEditAccess();

    const activityType = getString(formData, "activityType");
    const note = getString(formData, "note");
    const followUpDate = getString(formData, "followUpDate");
    const followUpTime = getString(formData, "followUpTime");

    if (!clientId) {
      return { error: "Missing client ID." };
    }

    if (
      !ALLOWED_ACTIVITY_TYPES.includes(
        activityType as (typeof ALLOWED_ACTIVITY_TYPES)[number]
      )
    ) {
      return { error: "Invalid activity type." };
    }

    if (!note) {
      return { error: "Activity note is required." };
    }

    let followUpDueAt: string | null = null;

    if (followUpDate) {
      followUpDueAt = followUpTime
        ? `${followUpDate}T${followUpTime}:00`
        : `${followUpDate}T09:00:00`;
    }

    const { error } = await supabase.from("lead_activities").insert({
      studio_id: studioId,
      client_id: clientId,
      activity_type: activityType,
      note,
      follow_up_due_at: followUpDueAt,
      created_by: user.id,
    });

    if (error) {
      return { error: `Lead activity creation failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(
    getLeadActivitySuccessRedirect(formData, fallbackUrl, "lead_activity_created")
  );
}

export async function completeLeadFollowUpAction(formData: FormData) {
  const activityId = getString(formData, "activityId");
  const clientId = getString(formData, "clientId");
  const fallbackUrl = clientId ? `/app/clients/${clientId}` : "/app/leads";

  try {
    const { supabase, studioId } = await requireClientEditAccess();

    if (!activityId || !clientId) {
      redirect(
        getLeadActivityErrorRedirect(formData, fallbackUrl, "followup_complete_failed")
      );
    }

    const { error } = await supabase
      .from("lead_activities")
      .update({
        completed_at: new Date().toISOString(),
      })
      .eq("id", activityId)
      .eq("studio_id", studioId);

    if (error) {
      redirect(
        getLeadActivityErrorRedirect(formData, fallbackUrl, "followup_complete_failed")
      );
    }

    redirect(
      getLeadActivitySuccessRedirect(formData, fallbackUrl, "followup_completed")
    );
  } catch {
    redirect(getLeadActivityErrorRedirect(formData, fallbackUrl, "unknown"));
  }
}