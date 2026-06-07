"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

const PLATFORM_STUDIO_COOKIE = "platform_selected_studio_id";

export async function enterStudioContextAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioId = String(formData.get("studioId") ?? "").trim();
  if (!studioId) {
    redirect("/platform/studios");
  }

  const supabase = await createClient();
  const { data: studio, error } = await supabase
    .from("studios")
    .select("id")
    .eq("id", studioId)
    .maybeSingle();

  if (error || !studio) {
    redirect("/platform/studios");
  }

  const cookieStore = await cookies();
  cookieStore.set(PLATFORM_STUDIO_COOKIE, studioId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  redirect("/app");
}

export async function clearStudioContextAction() {
  await requirePlatformAdmin();

  const cookieStore = await cookies();
  cookieStore.delete(PLATFORM_STUDIO_COOKIE);

  redirect("/platform");
}

export async function getPlatformSelectedStudioId() {
  const cookieStore = await cookies();
  return cookieStore.get(PLATFORM_STUDIO_COOKIE)?.value ?? null;
}
function normalizePlatformAlertType(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "info").trim().toLowerCase();
  if (["info", "success", "warning", "maintenance", "critical"].includes(normalized)) {
    return normalized;
  }
  return "info";
}

function normalizePlatformAlertAudience(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "all_workspace_users").trim().toLowerCase();
  if (
    [
      "all_workspace_users",
      "studio_owners",
      "organizers",
      "instructors",
      "independent_instructors",
      "portal_users",
      "all_users",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "all_workspace_users";
}

function nullableDateTime(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

export async function createPlatformBroadcastAlertAction(formData: FormData) {
  await requirePlatformAdmin();

  const title = String(formData.get("title") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();
  const readMoreUrl = String(formData.get("readMoreUrl") ?? "").trim();
  const readMoreLabel = String(formData.get("readMoreLabel") ?? "").trim();

  if (!title || !message) {
    redirect("/platform?broadcast_error=missing_required");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_alerts").insert({
    title,
    message,
    alert_type: normalizePlatformAlertType(formData.get("alertType")),
    audience: normalizePlatformAlertAudience(formData.get("audience")),
    active: formData.get("active") === "on",
    dismissible: formData.get("dismissible") === "on",
    starts_at: nullableDateTime(formData.get("startsAt")),
    ends_at: nullableDateTime(formData.get("endsAt")),
    read_more_url: readMoreUrl || null,
    read_more_label: readMoreLabel || "Read more",
    created_by: user?.id ?? null,
  });

  if (error) {
    throw new Error(`Failed to create broadcast alert: ${error.message}`);
  }

  redirect("/platform?broadcast_created=1");
}

export async function setPlatformBroadcastAlertActiveAction(formData: FormData) {
  await requirePlatformAdmin();

  const alertId = String(formData.get("alertId") ?? "").trim();
  const active = String(formData.get("active") ?? "false") === "true";

  if (!alertId) {
    redirect("/platform");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("platform_alerts")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", alertId);

  if (error) {
    throw new Error(`Failed to update broadcast alert: ${error.message}`);
  }

  redirect("/platform");
}

export async function dismissPlatformBroadcastAlertAction(formData: FormData) {
  const alertId = String(formData.get("alertId") ?? "").trim();
  if (!alertId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const { error } = await supabase.from("platform_alert_dismissals").upsert(
    {
      alert_id: alertId,
      user_id: user.id,
      dismissed_at: new Date().toISOString(),
    },
    { onConflict: "alert_id,user_id" }
  );

  if (error) {
    throw new Error(`Failed to dismiss broadcast alert: ${error.message}`);
  }
}


function safeReturnPath(value: FormDataEntryValue | null, fallback = "/platform") {
  const raw = String(value ?? "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

function normalizeAdminActionType(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "note").trim().toLowerCase();
  if (
    [
      "reviewed",
      "note",
      "follow_up",
      "resolved",
      "suspended_access",
      "restored_access",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "note";
}

function normalizeAdminTargetType(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "workspace").trim().toLowerCase();
  if (
    [
      "workspace",
      "studio",
      "organizer",
      "billing_risk",
      "platform_error",
      "package_deduction_error",
      "webhook",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "workspace";
}

export async function createPlatformAdminAction(formData: FormData) {
  await requirePlatformAdmin();

  const targetType = normalizeAdminTargetType(formData.get("targetType"));
  const targetId = String(formData.get("targetId") ?? "").trim();
  const actionType = normalizeAdminActionType(formData.get("actionType"));
  const note = String(formData.get("note") ?? "").trim();
  const returnTo = safeReturnPath(formData.get("returnTo"));

  if (!targetId) {
    redirect(returnTo);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("platform_admin_actions").insert({
    target_type: targetType,
    target_id: targetId,
    action_type: actionType,
    note: note || null,
    created_by: user?.id ?? null,
  });

  if (error) {
    throw new Error(`Failed to save platform admin action: ${error.message}`);
  }

  redirect(returnTo);
}

export async function setStudioWorkspaceActiveAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioId = String(formData.get("studioId") ?? "").trim();
  const active = String(formData.get("active") ?? "").trim() === "true";
  const note = String(formData.get("note") ?? "").trim();
  const returnTo = safeReturnPath(formData.get("returnTo"), studioId ? `/platform/studios/${studioId}` : "/platform/studios");

  if (!studioId) {
    redirect(returnTo);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error: updateError } = await supabase
    .from("studios")
    .update({ active })
    .eq("id", studioId);

  if (updateError) {
    throw new Error(`Failed to update workspace access: ${updateError.message}`);
  }

  const { error: actionError } = await supabase.from("platform_admin_actions").insert({
    target_type: "workspace",
    target_id: studioId,
    action_type: active ? "restored_access" : "suspended_access",
    note: note || (active ? "Workspace access restored from platform admin." : "Workspace access suspended from platform admin."),
    created_by: user?.id ?? null,
  });

  if (actionError) {
    throw new Error(`Failed to save workspace access action: ${actionError.message}`);
  }

  redirect(returnTo);
}



function credentialReviewRedirect(status: string) {
  const normalized = String(status || "submitted").trim().toLowerCase();
  if (["submitted", "verified", "rejected", "unverified", "all"].includes(normalized)) {
    redirect(`/platform/credentials?status=${encodeURIComponent(normalized)}&saved=1`);
  }

  redirect("/platform/credentials?saved=1");
}

export async function approveInstructorCredentialAction(formData: FormData) {
  await requirePlatformAdmin();

  const instructorId = String(formData.get("instructorId") ?? "").trim();
  const currentStatus = String(formData.get("currentStatus") ?? "submitted").trim();
  const reviewNote = String(formData.get("reviewNote") ?? "").trim();

  if (!instructorId) {
    credentialReviewRedirect(currentStatus);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("instructors")
    .update({
      credentials_verification_status: "verified",
      credentials_review_note: reviewNote || null,
      credentials_verified_at: new Date().toISOString(),
      credentials_verified_by: user?.id ?? null,
    })
    .eq("id", instructorId);

  if (error) {
    throw new Error(`Failed to approve instructor credential: ${error.message}`);
  }

  revalidatePath("/platform/credentials");
  revalidatePath("/app/settings/public-profile/instructors");
  credentialReviewRedirect("verified");
}

export async function rejectInstructorCredentialAction(formData: FormData) {
  await requirePlatformAdmin();

  const instructorId = String(formData.get("instructorId") ?? "").trim();
  const currentStatus = String(formData.get("currentStatus") ?? "submitted").trim();
  const reviewNote = String(formData.get("reviewNote") ?? "").trim();

  if (!instructorId) {
    credentialReviewRedirect(currentStatus);
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from("instructors")
    .update({
      credentials_verification_status: "rejected",
      credentials_review_note: reviewNote || "Credential could not be verified from the submitted information.",
      credentials_verified_at: null,
      credentials_verified_by: null,
    })
    .eq("id", instructorId);

  if (error) {
    throw new Error(`Failed to reject instructor credential: ${error.message}`);
  }

  revalidatePath("/platform/credentials");
  revalidatePath("/app/settings/public-profile/instructors");
  credentialReviewRedirect("rejected");
}

export async function resetInstructorCredentialAction(formData: FormData) {
  await requirePlatformAdmin();

  const instructorId = String(formData.get("instructorId") ?? "").trim();
  const currentStatus = String(formData.get("currentStatus") ?? "submitted").trim();

  if (!instructorId) {
    credentialReviewRedirect(currentStatus);
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from("instructors")
    .update({
      credentials_verification_status: "submitted",
      credentials_review_note: null,
      credentials_verified_at: null,
      credentials_verified_by: null,
    })
    .eq("id", instructorId);

  if (error) {
    throw new Error(`Failed to reset instructor credential: ${error.message}`);
  }

  revalidatePath("/platform/credentials");
  credentialReviewRedirect("submitted");
}
