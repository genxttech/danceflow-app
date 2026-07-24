"use server";

import { redirect } from "next/navigation";
import { Resend } from "resend";
import { renderDanceFlowSystemEmail } from "@/lib/notifications/email-branding";

function getString(formData: FormData, key: string, maxLength = 4000) {
  const value = formData.get(key);
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .trim()
        .slice(0, maxLength)
    : "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }

  return new Resend(apiKey);
}

export async function sendSupportRequestAction(formData: FormData) {
  const name = getString(formData, "name", 160);
  const email = getString(formData, "email", 320).toLowerCase();
  const workspaceName = getString(formData, "workspaceName", 200);
  const issueType = getString(formData, "issueType", 120);
  const message = getString(formData, "message", 8000);

  if (!name || !email || !issueType || !message) {
    redirect("/app/support?error=missing-fields");
  }

  if (!isValidEmail(email)) {
    redirect("/app/support?error=invalid-email");
  }

  const from =
    process.env.OUTBOUND_EMAIL_FROM ||
    process.env.NOTIFICATION_FROM_EMAIL ||
    "DanceFlow <notify@idanceflow.com>";

  const to = process.env.SUPPORT_TO_EMAIL || "support@idanceflow.com";

  const resend = getResendClient();

  const subject = `DanceFlow support request: ${issueType}`;

  const bodyText = [
    "New DanceFlow support request",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    workspaceName ? `Workspace / Studio: ${workspaceName}` : "",
    `Issue Type: ${issueType}`,
    "",
    "Message:",
    message,
    "",
    "Reply directly to this email to respond to the person who submitted the request.",
  ]
    .filter(Boolean)
    .join("\n");

  const bodyHtml = renderDanceFlowSystemEmail({
    previewText: subject,
    eyebrow: "DanceFlow Support",
    heading: "New support request",
    intro: "A DanceFlow user submitted a support request.",
    bodyText,
    detailRows: [
      { label: "Name", value: name },
      { label: "Email", value: email },
      ...(workspaceName
        ? [{ label: "Workspace / Studio", value: workspaceName }]
        : []),
      { label: "Issue type", value: issueType },
    ],
    footerText:
      "Replying to this message sends your response directly to the person who submitted the request.",
  });

  const response = await resend.emails.send({
    from,
    to: [to],
    replyTo: email,
    subject,
    text: bodyText,
    html: bodyHtml,
  });

  if (response.error) {
    console.error("Support request email failed", response.error);
    redirect("/app/support?error=send-failed");
  }

  redirect("/app/support?sent=1");
}