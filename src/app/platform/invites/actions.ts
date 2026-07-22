"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { renderDanceFlowSystemEmail } from "@/lib/notifications/email-branding";
import { createClient } from "@/lib/supabase/server";
import {
  cleanTextValue,
  getValidationError,
  getValidatedValue,
  normalizeOptionalUuid,
  normalizeRequiredEmail,
  normalizeRequiredEnum,
  rawFormString,
} from "@/lib/validation/forms";

const INVITE_DURATION_MONTHS = ["6", "12", "18", "24"] as const;
const INVITE_EXPIRATION_DAYS = ["7", "14", "30", "60"] as const;

function validatedInviteText(value: string | null | undefined, fieldLabel: string, maxLength: number) {
  const result = cleanTextValue(value, { fieldLabel, maxLength });
  if (!result.ok) throw new Error(result.error);
  return result.value;
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

function buildInviteLink(token: string) {
  return `${buildBaseUrl()}/get-started/ambassador?invite=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildInviteEmailHtml({
  recipientName,
  inviteLink,
  durationMonths,
}: {
  recipientName: string;
  inviteLink: string;
  durationMonths: number;
}) {
  const greetingName = recipientName || "there";
  const bodyText = [
    `I'm inviting you to join the DanceFlow Ambassador Pro Pilot.`,
    `You'll receive ${durationMonths} months of complimentary Pro access so you can use DanceFlow with your own teaching business, explore the full feature set, and share feedback from the perspective of a traveling instructor.`,
    "",
    "Your invite is tied to this email address.",
    "",
    "Once you're in, we can schedule a short onboarding call and get your workspace set up.",
  ].join("\n");

  return renderDanceFlowSystemEmail({
    previewText: "Your DanceFlow Ambassador Pro invite",
    eyebrow: "DanceFlow Ambassador Pro",
    heading: "You’re invited to DanceFlow Ambassador Pro",
    greeting: `Hi ${greetingName},`,
    bodyText,
    actionLabel: "Accept Your Invite",
    actionUrl: inviteLink,
    footerText: "This invitation was sent by DanceFlow.",
  });
}

function buildInviteEmailText({
  recipientName,
  inviteLink,
  durationMonths,
}: {
  recipientName: string;
  inviteLink: string;
  durationMonths: number;
}) {
  const greetingName = recipientName || "there";
  const safeInviteLink = inviteLink;

  return `Hi ${greetingName},\n\nI'm inviting you to join the DanceFlow Ambassador Pro Pilot. You'll receive ${durationMonths} months of complimentary Pro access so you can use DanceFlow with your own teaching business, explore the full feature set, and share feedback from the perspective of a traveling instructor.\n\nYour invite is tied to this email address. Use this link to create or connect your DanceFlow account and activate your Ambassador Pro access:\n\n${safeInviteLink}\n\nOnce you're in, we can schedule a short onboarding call and get your workspace set up.\n\nThanks,\nMichael\nDanceFlow`;
}

async function sendAmbassadorInviteEmail({
  to,
  recipientName,
  inviteLink,
  durationMonths,
}: {
  to: string;
  recipientName: string;
  inviteLink: string;
  durationMonths: number;
}) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: "Missing RESEND_API_KEY.",
    };
  }

  const from =
    process.env.RESEND_FROM_EMAIL?.trim() ||
    process.env.MARKETING_FROM_EMAIL?.trim() ||
    "DanceFlow <notify@idanceflow.com>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your DanceFlow Ambassador Pro invite",
      html: buildInviteEmailHtml({ recipientName, inviteLink, durationMonths }),
      text: buildInviteEmailText({ recipientName, inviteLink, durationMonths }),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      error: body || `Resend request failed with ${response.status}.`,
    };
  }

  return {
    ok: true,
    error: null,
  };
}

export async function createAmbassadorInviteAction(formData: FormData) {
  const adminUser = await requirePlatformAdmin();
  const supabase = await createClient();

  const emailResult = normalizeRequiredEmail(rawFormString(formData, "email"), "Ambassador email");
  const durationResult = normalizeRequiredEnum(
    rawFormString(formData, "durationMonths") || "12",
    INVITE_DURATION_MONTHS,
    "Comp duration"
  );
  const expiresResult = normalizeRequiredEnum(
    rawFormString(formData, "expiresInDays") || "30",
    INVITE_EXPIRATION_DAYS,
    "Invite expiration"
  );
  const recipientNameResult = cleanTextValue(rawFormString(formData, "recipientName"), {
    fieldLabel: "Ambassador name",
    maxLength: 120,
  });
  const notesResult = cleanTextValue(rawFormString(formData, "notes"), {
    fieldLabel: "Internal notes",
    maxLength: 1200,
    allowNewlines: true,
  });

  const validationError = getValidationError([
    emailResult,
    durationResult,
    expiresResult,
    recipientNameResult,
    notesResult,
  ]);

  if (validationError) {
    redirect("/platform/invites?error=valid_email_required");
  }

  const email = getValidatedValue(emailResult);
  const recipientName = getValidatedValue(recipientNameResult);
  const notes = getValidatedValue(notesResult);
  const safeDurationMonths = Number(getValidatedValue(durationResult));
  const safeExpiresInDays = Number(getValidatedValue(expiresResult));

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + safeExpiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const inviteLink = buildInviteLink(token);

  const { data: invite, error } = await supabase
    .from("platform_invites")
    .insert({
      email,
      recipient_name: recipientName || null,
      token_hash: tokenHash,
      invite_type: "ambassador_pro",
      granted_plan: "pro",
      billing_override_reason: "ambassador",
      duration_months: safeDurationMonths,
      expires_at: expiresAt,
      created_by_user_id: adminUser.id,
      notes: notes || "DanceFlow Ambassador Pro Pilot",
      active: true,
    })
    .select("id")
    .single();

  if (error || !invite) {
    console.error("createAmbassadorInviteAction error", error);
    redirect("/platform/invites?error=create_failed");
  }

  const sendResult = await sendAmbassadorInviteEmail({
    to: email,
    recipientName,
    inviteLink,
    durationMonths: safeDurationMonths,
  });

  if (!sendResult.ok) {
    console.error("createAmbassadorInviteAction email error", sendResult.error);

    await supabase
      .from("platform_invites")
      .update({
        last_send_error: sendResult.error?.slice(0, 1000) || "Email send failed.",
      })
      .eq("id", invite.id);

    revalidatePath("/platform/invites");
    redirect("/platform/invites?error=email_send_failed");
  }

  await supabase
    .from("platform_invites")
    .update({
      sent_at: new Date().toISOString(),
      last_sent_at: new Date().toISOString(),
      last_sent_by_user_id: adminUser.id,
      send_count: 1,
      last_send_error: null,
    })
    .eq("id", invite.id);

  revalidatePath("/platform/invites");
  redirect("/platform/invites?sent=1");
}

export async function resendAmbassadorInviteAction(formData: FormData) {
  const adminUser = await requirePlatformAdmin();
  const supabase = await createClient();

  const inviteIdResult = normalizeOptionalUuid(rawFormString(formData, "inviteId"), "Invite");

  if (!inviteIdResult.ok || !inviteIdResult.value) {
    redirect("/platform/invites?error=missing_invite");
  }

  const inviteId = inviteIdResult.value;

  const { data: invite, error: inviteError } = await supabase
    .from("platform_invites")
    .select(
      `
      id,
      email,
      recipient_name,
      duration_months,
      used_at,
      expires_at,
      active,
      send_count
      `
    )
    .eq("id", inviteId)
    .maybeSingle();

  if (inviteError || !invite) {
    console.error("resendAmbassadorInviteAction lookup error", inviteError);
    redirect("/platform/invites?error=missing_invite");
  }

  const typedInvite = invite as {
    id: string;
    email: string;
    recipient_name: string | null;
    duration_months: number;
    used_at: string | null;
    expires_at: string;
    active: boolean;
    send_count: number | null;
  };

  if (!typedInvite.active || typedInvite.used_at) {
    redirect("/platform/invites?error=invite_not_resendable");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const inviteLink = buildInviteLink(token);
  const isExpired = new Date(typedInvite.expires_at).getTime() < Date.now();

  const tokenUpdate: Record<string, string | null> = {
    token_hash: tokenHash,
    last_send_error: null,
  };

  if (isExpired) {
    tokenUpdate.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const { error: updateTokenError } = await supabase
    .from("platform_invites")
    .update(tokenUpdate)
    .eq("id", typedInvite.id)
    .is("used_at", null)
    .eq("active", true);

  if (updateTokenError) {
    console.error("resendAmbassadorInviteAction token update error", updateTokenError);
    redirect("/platform/invites?error=resend_failed");
  }

  const sendResult = await sendAmbassadorInviteEmail({
    to: typedInvite.email,
    recipientName: typedInvite.recipient_name ?? "",
    inviteLink,
    durationMonths: typedInvite.duration_months,
  });

  if (!sendResult.ok) {
    console.error("resendAmbassadorInviteAction email error", sendResult.error);

    await supabase
      .from("platform_invites")
      .update({
        last_send_error: sendResult.error?.slice(0, 1000) || "Email resend failed.",
      })
      .eq("id", typedInvite.id);

    redirect("/platform/invites?error=email_send_failed");
  }

  const resendUpdate: Record<string, string | number | null> = {
    last_sent_at: new Date().toISOString(),
    last_sent_by_user_id: adminUser.id,
    send_count: (typedInvite.send_count ?? 0) + 1,
    last_send_error: null,
  };

  if (!typedInvite.send_count) {
    resendUpdate.sent_at = new Date().toISOString();
  }

  await supabase
    .from("platform_invites")
    .update(resendUpdate)
    .eq("id", typedInvite.id);

  revalidatePath("/platform/invites");
  redirect("/platform/invites?resent=1");
}

export async function deactivateAmbassadorInviteAction(formData: FormData) {
  await requirePlatformAdmin();
  const supabase = await createClient();

  const inviteIdResult = normalizeOptionalUuid(rawFormString(formData, "inviteId"), "Invite");

  if (!inviteIdResult.ok || !inviteIdResult.value) {
    redirect("/platform/invites?error=missing_invite");
  }

  const inviteId = inviteIdResult.value;

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

