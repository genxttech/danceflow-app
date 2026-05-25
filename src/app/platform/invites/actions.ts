"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

function normalizeEmail(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function hashInviteToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildBaseUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, "");
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();

  if (vercelUrl) {
    return `https://${vercelUrl.replace(/\/$/, "")}`;
  }

  return "http://localhost:3000";
}

export async function createAmbassadorInviteAction(formData: FormData) {
  const adminUser = await requirePlatformAdmin();
  const supabase = await createClient();

  const email = normalizeEmail(formData.get("email"));
  const durationMonths = Number(formData.get("durationMonths") ?? 12);
  const expiresInDays = Number(formData.get("expiresInDays") ?? 30);
  const notes = normalizeText(formData.get("notes"));

  if (!email || !email.includes("@")) {
    redirect("/platform/invites?error=valid_email_required");
  }

  const safeDurationMonths = Number.isFinite(durationMonths)
    ? Math.max(1, Math.min(36, Math.trunc(durationMonths)))
    : 12;

  const safeExpiresInDays = Number.isFinite(expiresInDays)
    ? Math.max(1, Math.min(90, Math.trunc(expiresInDays)))
    : 30;

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + safeExpiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from("platform_invites").insert({
    email,
    token_hash: tokenHash,
    invite_type: "ambassador_pro",
    granted_plan: "pro",
    billing_override_reason: "ambassador",
    duration_months: safeDurationMonths,
    expires_at: expiresAt,
    created_by_user_id: adminUser.id,
    notes: notes || "DanceFlow Ambassador Pro Pilot",
    active: true,
  });

  if (error) {
    console.error("createAmbassadorInviteAction error", error);
    redirect("/platform/invites?error=create_failed");
  }

  const inviteLink = `${buildBaseUrl()}/get-started/ambassador?invite=${encodeURIComponent(token)}`;

  revalidatePath("/platform/invites");
  redirect(`/platform/invites?created=1&invite=${encodeURIComponent(inviteLink)}`);
}

export async function deactivateAmbassadorInviteAction(formData: FormData) {
  await requirePlatformAdmin();
  const supabase = await createClient();

  const inviteId = normalizeText(formData.get("inviteId"));

  if (!inviteId) {
    redirect("/platform/invites?error=missing_invite");
  }

  const { error } = await supabase
    .from("platform_invites")
    .update({ active: false })
    .eq("id", inviteId)
    .is("used_at", null);

  if (error) {
    console.error("deactivateAmbassadorInviteAction error", error);
    redirect("/platform/invites?error=deactivate_failed");
  }

  revalidatePath("/platform/invites");
  redirect("/platform/invites?deactivated=1");
}
