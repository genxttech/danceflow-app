"use server";

import crypto from "crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function hashInviteToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

export async function claimAmbassadorInviteAction(formData: FormData) {
  const supabase = await createClient();

  const token = normalizeText(formData.get("invite"));
  const workspaceName = normalizeText(formData.get("workspaceName"));
  const timezone = normalizeText(formData.get("timezone")) || "America/New_York";

  if (!token) {
    redirect("/get-started/ambassador?error=missing_invite");
  }

  if (!workspaceName) {
    redirect(`/get-started/ambassador?invite=${encodeURIComponent(token)}&error=workspace_required`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/get-started/ambassador?invite=${token}`)}`);
  }

  const tokenHash = hashInviteToken(token);

  const { error } = await supabase.rpc("claim_platform_invite", {
    p_token_hash: tokenHash,
    p_workspace_name: workspaceName,
    p_timezone: timezone,
  });

  if (error) {
    console.error("claimAmbassadorInviteAction error", error);
    redirect(`/get-started/ambassador?invite=${encodeURIComponent(token)}&error=claim_failed`);
  }

  redirect("/app");
}
