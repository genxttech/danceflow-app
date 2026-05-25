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
  const greetingName = escapeHtml(recipientName || "there");
  const safeInviteLink = escapeHtml(inviteLink);

  return `
    <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:24px; color:#0f172a;">
      <div style="max-width:640px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:24px; padding:28px;">
        <p style="margin:0 0 8px; font-size:12px; letter-spacing:0.16em; text-transform:uppercase; color:#7c3aed; font-weight:700;">DanceFlow Ambassador Pro Pilot</p>
        <h1 style="margin:0; font-size:28px; line-height:1.2; color:#020617;">You&apos;re invited to DanceFlow Ambassador Pro</h1>
        <p style="margin:20px 0 0; font-size:15px; line-height:1.7; color:#334155;">Hi ${greetingName},</p>
        <p style="margin:12px 0 0; font-size:15px; line-height:1.7; color:#334155;">
          I&apos;m inviting you to join the DanceFlow Ambassador Pro Pilot. You&apos;ll receive ${durationMonths} months of complimentary Pro access so you can use DanceFlow with your own teaching business, explore the full feature set, and share feedback from the perspective of a traveling instructor.
        </p>
        <p style="margin:12px 0 0; font-size:15px; line-height:1.7; color:#334155;">
          Your invite is tied to this email address. Click below to create or connect your DanceFlow account and activate your Ambassador Pro access.
        </p>
        <div style="margin:26px 0;">
          <a href="${safeInviteLink}" style="display:inline-block; background:#7c3aed; color:#ffffff; text-decoration:none; padding:14px 20px; border-radius:16px; font-weight:700; font-size:14px;">Accept Your Invite</a>
        </div>
        <p style="margin:0; font-size:13px; line-height:1.7; color:#64748b;">
          If the button does not work, copy and paste this link into your browser:<br />
          <span style="word-break:break-all; color:#334155;">${safeInviteLink}</span>
        </p>
        <hr style="border:none; border-top:1px solid #e2e8f0; margin:24px 0;" />
        <p style="margin:0; font-size:14px; line-height:1.7; color:#334155;">
          Once you&apos;re in, we can schedule a short onboarding call and get your workspace set up.
        </p>
        <p style="margin:16px 0 0; font-size:14px; line-height:1.7; color:#334155;">Thanks,<br />Michael<br />DanceFlow</p>
      </div>
    </div>
  `;
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
  const greetingName = escapeHtml(recipientName || "there");
  const safeInviteLink = escapeHtml(inviteLink);

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

  const recipientName = normalizeText(formData.get("recipientName"));
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

  const inviteId = normalizeText(formData.get("inviteId"));

  if (!inviteId) {
    redirect("/platform/invites?error=missing_invite");
  }

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

