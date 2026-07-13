"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { linkExistingClientAccount } from "@/lib/student-identity/lifecycle";
import {
  cleanTextValue,
  getValidationError,
  getValidatedValue,
  normalizeOptionalUuid,
  rawFormString,
  safeLocalRedirectPath,
} from "@/lib/validation/forms";

const PLATFORM_STUDIO_COOKIE = "platform_selected_studio_id";

function cleanActionText(formData: FormData, key: string, fieldLabel: string, maxLength: number, allowNewlines = false) {
  const result = cleanTextValue(rawFormString(formData, key), {
    fieldLabel,
    maxLength,
    allowNewlines,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function requireUuidFromForm(formData: FormData, key: string, fieldLabel: string, returnTo = "/platform") {
  const result = normalizeOptionalUuid(rawFormString(formData, key), fieldLabel);
  if (!result.ok || !result.value) redirect(returnTo);
  return result.value;
}

function optionalSafeUrl(value: string) {
  const cleaned = cleanTextValue(value, { fieldLabel: "URL", maxLength: 2048 });
  if (!cleaned.ok || !cleaned.value) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(cleaned.value)
    ? cleaned.value
    : `https://${cleaned.value}`;

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function enterStudioContextAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioId = requireUuidFromForm(formData, "studioId", "Studio", "/platform/studios");

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
  await requirePlatformAdmin();

  const cookieStore = await cookies();
  const selectedStudioIdResult = normalizeOptionalUuid(
    cookieStore.get(PLATFORM_STUDIO_COOKIE)?.value ?? "",
    "Selected studio",
  );

  return selectedStudioIdResult.ok ? selectedStudioIdResult.value : null;
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

  const titleResult = cleanTextValue(rawFormString(formData, "title"), {
    fieldLabel: "Alert title",
    maxLength: 140,
    required: true,
  });
  const messageResult = cleanTextValue(rawFormString(formData, "message"), {
    fieldLabel: "Alert message",
    maxLength: 1200,
    allowNewlines: true,
    required: true,
  });
  const readMoreLabelResult = cleanTextValue(rawFormString(formData, "readMoreLabel"), {
    fieldLabel: "Read more label",
    maxLength: 80,
  });

  const validationError = getValidationError([titleResult, messageResult, readMoreLabelResult]);
  if (validationError) {
    redirect("/platform?broadcast_error=missing_required");
  }

  const title = getValidatedValue(titleResult);
  const message = getValidatedValue(messageResult);
  const readMoreUrl = optionalSafeUrl(rawFormString(formData, "readMoreUrl"));
  const readMoreLabel = getValidatedValue(readMoreLabelResult);

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
    read_more_url: readMoreUrl,
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

  const alertId = requireUuidFromForm(formData, "alertId", "Alert");
  const active = rawFormString(formData, "active") === "true";

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
  const alertIdResult = normalizeOptionalUuid(rawFormString(formData, "alertId"), "Alert");
  if (!alertIdResult.ok || !alertIdResult.value) return;
  const alertId = alertIdResult.value;

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
  return safeLocalRedirectPath(typeof value === "string" ? value : "", fallback);
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
  const actionType = normalizeAdminActionType(formData.get("actionType"));
  const note = cleanActionText(formData, "note", "Admin note", 2500, true);
  const returnTo = safeReturnPath(formData.get("returnTo"));
  const targetId = requireUuidFromForm(formData, "targetId", "Target", returnTo);

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

  const active = rawFormString(formData, "active") === "true";
  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const studioId = studioIdResult.ok ? studioIdResult.value : null;
  const returnTo = safeReturnPath(formData.get("returnTo"), studioId ? `/platform/studios/${studioId}` : "/platform/studios");
  if (!studioId) redirect(returnTo);
  const note = cleanActionText(formData, "note", "Admin note", 2500, true);

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
  if (["submitted", "verified", "rejected", "all"].includes(normalized)) {
    redirect(`/platform/credentials?status=${encodeURIComponent(normalized)}&saved=1`);
  }

  redirect("/platform/credentials?saved=1");
}

export async function approveInstructorCredentialAction(formData: FormData) {
  await requirePlatformAdmin();

  const currentStatus = cleanActionText(formData, "currentStatus", "Current status", 40) || "submitted";
  const credentialId = requireUuidFromForm(formData, "credentialId", "Credential", `/platform/credentials?status=${encodeURIComponent(currentStatus)}`);
  const reviewNote = cleanActionText(formData, "reviewNote", "Review note", 1200, true);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("instructor_credentials")
    .update({
      verification_status: "verified",
      review_note: reviewNote || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user?.id ?? null,
    })
    .eq("id", credentialId);

  if (error) {
    throw new Error(`Failed to approve instructor credential: ${error.message}`);
  }

  revalidatePath("/platform/credentials");
  revalidatePath("/app/settings/public-profile/instructors");
  credentialReviewRedirect("verified");
}

export async function rejectInstructorCredentialAction(formData: FormData) {
  await requirePlatformAdmin();

  const currentStatus = cleanActionText(formData, "currentStatus", "Current status", 40) || "submitted";
  const credentialId = requireUuidFromForm(formData, "credentialId", "Credential", `/platform/credentials?status=${encodeURIComponent(currentStatus)}`);
  const reviewNote = cleanActionText(formData, "reviewNote", "Review note", 1200, true);

  const supabase = await createClient();

  const { error } = await supabase
    .from("instructor_credentials")
    .update({
      verification_status: "rejected",
      review_note: reviewNote || "Credential could not be verified from the submitted information.",
      reviewed_at: new Date().toISOString(),
      reviewed_by: null,
    })
    .eq("id", credentialId);

  if (error) {
    throw new Error(`Failed to reject instructor credential: ${error.message}`);
  }

  revalidatePath("/platform/credentials");
  revalidatePath("/app/settings/public-profile/instructors");
  credentialReviewRedirect("rejected");
}

export async function resetInstructorCredentialAction(formData: FormData) {
  await requirePlatformAdmin();

  const currentStatus = cleanActionText(formData, "currentStatus", "Current status", 40) || "submitted";
  const credentialId = requireUuidFromForm(formData, "credentialId", "Credential", `/platform/credentials?status=${encodeURIComponent(currentStatus)}`);

  const supabase = await createClient();

  const { error } = await supabase
    .from("instructor_credentials")
    .update({
      verification_status: "submitted",
      review_note: null,
      reviewed_at: null,
      reviewed_by: null,
      submitted_at: new Date().toISOString(),
    })
    .eq("id", credentialId);

  if (error) {
    throw new Error(`Failed to reset instructor credential: ${error.message}`);
  }

  revalidatePath("/platform/credentials");
  credentialReviewRedirect("submitted");
}


export async function repairStudioPortalLinksAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const studioId = studioIdResult.ok ? studioIdResult.value : null;
  const returnTo = safeReturnPath(
    formData.get("returnTo"),
    studioId ? `/platform/studios/${studioId}` : "/platform/studios"
  );

  if (!studioId) {
    redirect(returnTo);
  }

  const supabase = await createClient();
  const adminSupabase = createAdminClient();
  const {
    data: { user: adminUser },
  } = await supabase.auth.getUser();

  const { data: clients, error: clientsError } = await adminSupabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .eq("studio_id", studioId)
    .not("email", "is", null);

  if (clientsError) {
    throw new Error(`Failed to load clients for portal repair: ${clientsError.message}`);
  }

  const clientRows = (clients ?? []) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>;

  const { data: existingLinks, error: existingLinksError } = await adminSupabase
    .from("client_account_links")
    .select("client_id, user_id, status")
    .eq("studio_id", studioId);

  if (existingLinksError) {
    throw new Error(`Failed to load account links for portal repair: ${existingLinksError.message}`);
  }

  const linksByClientId = new Map(
    (existingLinks ?? []).map((link) => [String(link.client_id), link] as const),
  );

  const { data: authUsersData, error: authUsersError } = await adminSupabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (authUsersError) {
    throw new Error(`Failed to load auth users for portal repair: ${authUsersError.message}`);
  }

  const authByEmail = new Map(
    (authUsersData.users ?? [])
      .filter((authUser) => authUser.email)
      .map((authUser) => [String(authUser.email).trim().toLowerCase(), authUser] as const)
  );

  let profilesUpserted = 0;
  let linksCreated = 0;
  let skippedAlreadyLinked = 0;
  let skippedNoAuthUser = 0;
  let skippedMismatchedLink = 0;

  for (const client of clientRows) {
    const normalizedEmail = String(client.email ?? "").trim().toLowerCase();
    if (!normalizedEmail) continue;

    const matchingAuthUser = authByEmail.get(normalizedEmail);
    if (!matchingAuthUser) {
      skippedNoAuthUser += 1;
      continue;
    }

    const displayName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();

    const { error: profileError } = await adminSupabase.from("profiles").upsert(
      {
        id: matchingAuthUser.id,
        full_name: displayName || matchingAuthUser.user_metadata?.full_name || null,
        email: matchingAuthUser.email ?? client.email,
        platform_role: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

    if (profileError) {
      throw new Error(`Failed to upsert portal profile for ${client.email}: ${profileError.message}`);
    }

    profilesUpserted += 1;

    const existingLink = linksByClientId.get(client.id);
    if (
      existingLink?.status === "linked" &&
      existingLink.user_id === matchingAuthUser.id
    ) {
      skippedAlreadyLinked += 1;
      continue;
    }

    if (
      existingLink?.status === "linked" &&
      existingLink.user_id &&
      existingLink.user_id !== matchingAuthUser.id
    ) {
      skippedMismatchedLink += 1;
      continue;
    }

    await linkExistingClientAccount({
      studioId,
      clientId: client.id,
      userId: matchingAuthUser.id,
      invitedEmail: normalizedEmail,
    });

    linksCreated += 1;
  }

  const note = [
    `Portal account-link repair completed for studio ${studioId}.`,
    `Profiles upserted: ${profilesUpserted}.`,
    `Links created: ${linksCreated}.`,
    `Already linked: ${skippedAlreadyLinked}.`,
    `No auth user: ${skippedNoAuthUser}.`,
    `Mismatched existing links skipped: ${skippedMismatchedLink}.`,
  ].join(" ");

  await supabase.from("platform_admin_actions").insert({
    target_type: "workspace",
    target_id: studioId,
    action_type: "resolved",
    note,
    created_by: adminUser?.id ?? null,
  });

  revalidatePath(`/platform/studios/${studioId}`);
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}portal_repair=1`);
}

function normalizeMobilePushCategory(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "account").trim().toLowerCase();

  if (
    normalized === "schedule" ||
    normalized === "event" ||
    normalized === "favorites" ||
    normalized === "learning" ||
    normalized === "account" ||
    normalized === "partner" ||
    normalized === "system"
  ) {
    return normalized;
  }

  return "account";
}

export async function sendPlatformTestMobilePushAction(formData: FormData) {
  await requirePlatformAdmin();

  const userIdResult = normalizeOptionalUuid(rawFormString(formData, "userId"), "User");
  const userId = userIdResult.ok ? userIdResult.value : null;
  const title =
    cleanActionText(formData, "title", "Notification title", 120) || "DanceFlow test notification";
  const body =
    cleanActionText(formData, "body", "Notification body", 500, true) ||
    "Your DanceFlow mobile push setup is working.";
  const category = normalizeMobilePushCategory(formData.get("category"));

  if (!userId) {
    redirect("/platform/mobile-push?error=missing_user");
  }

  const { sendMobilePushToUser } = await import("@/lib/notifications/expoPush");

  const result = await sendMobilePushToUser({
    userId,
    category,
    title,
    body,
    data: {
      source: "platform_test",
    },
  });

  const status = result.status;
  const sent = result.sent;
  const failed = result.failed;

  revalidatePath("/platform/mobile-push");
  redirect(`/platform/mobile-push?status=${status}&sent=${sent}&failed=${failed}`);
}
