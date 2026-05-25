"use server";

import crypto from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

function hashInviteToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value: FormDataEntryValue | null) {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

function isUuid(value: string | null) {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value
      )
  );
}


function normalizePassword(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}

function inviteReturnPath(token: string) {
  return `/get-started/ambassador?invite=${encodeURIComponent(token)}`;
}

function isAlreadyRegisteredError(errorMessage: string | undefined) {
  const message = String(errorMessage ?? "").toLowerCase();
  return (
    message.includes("already") ||
    message.includes("registered") ||
    message.includes("exists") ||
    message.includes("duplicate")
  );
}

export async function createAmbassadorAccountAction(formData: FormData) {
  const supabase = await createClient();
  const adminSupabase = createAdminClient();

  const token = normalizeText(formData.get("invite"));
  const password = normalizePassword(formData.get("password"));
  const confirmPassword = normalizePassword(formData.get("confirmPassword"));

  if (!token) {
    redirect("/get-started/ambassador?error=missing_invite");
  }

  const returnPath = inviteReturnPath(token);

  if (!password || !confirmPassword) {
    redirect(`${returnPath}&error=password_required`);
  }

  if (password.length < 8) {
    redirect(`${returnPath}&error=password_too_short`);
  }

  if (password !== confirmPassword) {
    redirect(`${returnPath}&error=password_mismatch`);
  }

  const tokenHash = hashInviteToken(token);

  const { data: invite, error: inviteError } = await adminSupabase
    .from("platform_invites")
    .select("email, active, used_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (inviteError || !invite) {
    console.error("createAmbassadorAccountAction invite lookup error", inviteError);
    redirect(`${returnPath}&error=claim_failed`);
  }

  const typedInvite = invite as {
    email: string;
    active: boolean;
    used_at: string | null;
    expires_at: string;
  };

  if (!typedInvite.active || typedInvite.used_at || new Date(typedInvite.expires_at).getTime() < Date.now()) {
    redirect(`${returnPath}&error=claim_failed`);
  }

  const email = typedInvite.email.trim().toLowerCase();

  const { error: createUserError } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      invited_by: "ambassador_invite",
    },
  });

  if (createUserError) {
    console.error("createAmbassadorAccountAction create user error", createUserError);

    if (isAlreadyRegisteredError(createUserError.message)) {
      redirect(`${returnPath}&error=account_exists`);
    }

    redirect(`${returnPath}&error=account_create_failed`);
  }

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    console.error("createAmbassadorAccountAction sign-in error", signInError);
    redirect(`${returnPath}&error=sign_in_failed`);
  }

  redirect(returnPath);
}

export async function claimAmbassadorInviteAction(formData: FormData) {
  const supabase = await createClient();

  const token = normalizeText(formData.get("invite"));
  const claimMode = normalizeText(formData.get("claimMode")) || "new";
  const existingStudioId = normalizeOptionalText(formData.get("existingStudioId"));
  const workspaceName = normalizeText(formData.get("workspaceName"));
  const timezone = normalizeText(formData.get("timezone")) || "America/New_York";

  if (!token) {
    redirect("/get-started/ambassador?error=missing_invite");
  }

  const returnPath = `/get-started/ambassador?invite=${encodeURIComponent(token)}`;

  if (claimMode === "existing" && !isUuid(existingStudioId)) {
    redirect(`${returnPath}&error=workspace_choice_required`);
  }

  if (claimMode !== "existing" && !workspaceName) {
    redirect(`${returnPath}&error=workspace_required`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(returnPath)}`);
  }

  const tokenHash = hashInviteToken(token);

  const { data: claimedStudioId, error } = await supabase.rpc("claim_platform_invite", {
    p_token_hash: tokenHash,
    p_workspace_name: claimMode === "existing" ? null : workspaceName,
    p_timezone: timezone,
    p_existing_studio_id: claimMode === "existing" ? existingStudioId : null,
  });

  if (error || !claimedStudioId) {
    console.error("claimAmbassadorInviteAction error", error);
    redirect(`${returnPath}&error=claim_failed`);
  }

  const cookieStore = await cookies();
  cookieStore.set(APP_SELECTED_STUDIO_COOKIE, String(claimedStudioId), {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });

  redirect("/app");
}


