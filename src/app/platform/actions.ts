"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
