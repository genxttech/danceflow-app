"use server";

import { redirect } from "next/navigation";
import { Resend } from "resend";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }

  return new Resend(apiKey);
}

export async function sendSupportRequestAction(formData: FormData) {
  const name = getString(formData, "name");
  const email = getString(formData, "email");
  const workspaceName = getString(formData, "workspaceName");
  const issueType = getString(formData, "issueType");
  const message = getString(formData, "message");

  if (!name || !email || !issueType || !message) {
    redirect("/app/support?error=missing-fields");
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

  const response = await resend.emails.send({
    from,
    to: [to],
    replyTo: email,
    subject,
    text: bodyText,
  });

  if (response.error) {
    console.error("Support request email failed", response.error);
    redirect("/app/support?error=send-failed");
  }

  redirect("/app/support?sent=1");
}