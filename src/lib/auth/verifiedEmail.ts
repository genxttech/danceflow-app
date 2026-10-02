import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { appendEmailLegalText, sanitizeEmailSubject } from "@/lib/email/brand";
import { renderDanceFlowSystemEmail } from "@/lib/notifications/email-branding";
import { resolveOutboundFromEmail } from "@/lib/notifications/outbound";

/*
  LAUNCH-SEC-1C-A: verified-email proof and credential binding.

  The database is the authority (20261008090000_launchsec1ca_verified_email_proof.sql):
  - record_email_proof_web / record_email_proof_mobile take no arguments and only
    record proof for the caller's live session when that session carries a fresh
    validated mailbox authentication ('otp');
  - every first proof is binding_required; nothing is claim-eligible until the
    user binds a password from that exact proof session;
  - my_verified_email() (used by 1C-B) also requires a live session created after
    binding.

  Nothing here enforces claims; that is 1C-B.
*/

export const MIN_BINDING_PASSWORD_LENGTH = 8;

export type EmailProofResult = "binding_required" | "bound" | "not_recorded";

export type EmailBindingStatus =
  | "no_session"
  | "unproven"
  | "binding_required"
  | "binding_ready"
  | "bound"
  | "unavailable";

export type BindingFailureCode =
  | "weak_password"
  | "not_authenticated"
  | "not_ready"
  | "revoke_failed"
  | "password_update_failed"
  | "bind_expired";

const BINDING_STATUSES: readonly EmailBindingStatus[] = [
  "no_session",
  "unproven",
  "binding_required",
  "binding_ready",
  "bound",
];

function logCode(event: string, code: unknown) {
  console.warn(event, { code: typeof code === "string" ? code : null });
}

export async function recordEmailProof(
  client: SupabaseClient,
  source: "web" | "mobile",
): Promise<EmailProofResult> {
  const fn = source === "web" ? "record_email_proof_web" : "record_email_proof_mobile";
  const { data, error } = await client.rpc(fn);

  if (error) {
    logCode("email_proof_record_failed", error.code);
    return "not_recorded";
  }

  return data === "binding_required" || data === "bound" ? data : "not_recorded";
}

export async function getEmailBindingStatus(
  client: SupabaseClient,
): Promise<EmailBindingStatus> {
  const { data, error } = await client.rpc("email_binding_status");

  if (error) {
    logCode("email_binding_status_failed", error.code);
    return "unavailable";
  }

  return BINDING_STATUSES.includes(data as EmailBindingStatus)
    ? (data as EmailBindingStatus)
    : "unavailable";
}

/** Revokes every session of the token's user except the token's own session. */
export async function revokeOtherSessions(
  adminClient: SupabaseClient,
  accessToken: string,
): Promise<boolean> {
  if (!accessToken) return false;
  const { error } = await adminClient.auth.admin.signOut(accessToken, "others");

  if (error) {
    logCode("email_binding_revoke_failed", error.code);
    return false;
  }

  return true;
}

/*
  Exact ordering (each step fails closed; the identity stays binding_required):
  1. verify the access token signature and read sub + session_id from it;
  2. ask the DB, as that user, whether THIS session is the stored proof session
     with a mailbox authentication no older than 30 minutes ("binding_ready");
  3. revoke every other session (attacker sessions cannot race the change);
  4. replace the password with the admin API, which revokes ALL sessions,
     including the proof session and any attacker re-login;
  5. only after 4 succeeds, mark the identity bound for that exact session.
  If 5 fails after 4 succeeded, the user re-verifies and binds again.
*/
export async function completePasswordBinding(params: {
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
  accessToken: string;
  password: string;
}): Promise<{ ok: true; email: string } | { ok: false; code: BindingFailureCode }> {
  const { userClient, adminClient, accessToken, password } = params;

  if (password.length < MIN_BINDING_PASSWORD_LENGTH) {
    return { ok: false, code: "weak_password" };
  }

  if (!accessToken) {
    return { ok: false, code: "not_authenticated" };
  }

  const { data: claimsData, error: claimsError } = await adminClient.auth.getClaims(accessToken);
  const userId = typeof claimsData?.claims?.sub === "string" ? claimsData.claims.sub : "";
  const sessionId =
    typeof claimsData?.claims?.session_id === "string" ? claimsData.claims.session_id : "";

  if (claimsError || !userId || !sessionId) {
    return { ok: false, code: "not_authenticated" };
  }

  if ((await getEmailBindingStatus(userClient)) !== "binding_ready") {
    return { ok: false, code: "not_ready" };
  }

  if (!(await revokeOtherSessions(adminClient, accessToken))) {
    return { ok: false, code: "revoke_failed" };
  }

  const { data: updated, error: updateError } = await adminClient.auth.admin.updateUserById(
    userId,
    { password },
  );

  if (updateError || !updated?.user) {
    logCode("email_binding_password_update_failed", updateError?.code);
    return {
      ok: false,
      code: updateError?.code === "weak_password" ? "weak_password" : "password_update_failed",
    };
  }

  const { data: bound, error: bindError } = await adminClient.rpc("complete_email_binding", {
    p_user_id: userId,
    p_session_id: sessionId,
  });

  if (bindError || bound !== true) {
    logCode("email_binding_complete_failed", bindError?.code ?? "not_bound");
    return { ok: false, code: "bind_expired" };
  }

  return { ok: true, email: (updated.user.email ?? "").trim().toLowerCase() };
}

export function buildEmailVerificationPath(nextPath: string | null | undefined) {
  const search = new URLSearchParams();
  if (nextPath) search.set("next", nextPath);
  const query = search.toString();
  return `/account/verify-email${query ? `?${query}` : ""}`;
}

/*
  Sends a DanceFlow-branded mailbox link that lands on /callback with a
  token_hash (the validated non-PKCE verifyOtp path). The address is always
  supplied by the server: the signed-in user's current auth email, or the
  address entered on the business signup form.
*/
export async function sendEmailVerificationLink(params: {
  adminClient: SupabaseClient;
  email: string;
  baseUrl: string;
  nextPath: string;
  purpose: "verify" | "signup";
  userMetadata?: Record<string, string | null>;
}): Promise<boolean> {
  const email = params.email.trim().toLowerCase();
  if (!email) return false;

  const { data, error } = await params.adminClient.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: params.userMetadata ? { data: params.userMetadata } : undefined,
  });

  const tokenHash = data?.properties?.hashed_token;

  if (error || !tokenHash) {
    logCode("email_verification_link_failed", error?.code);
    return false;
  }

  const actionUrl = `${params.baseUrl}/callback?token_hash=${encodeURIComponent(
    tokenHash,
  )}&type=magiclink&next=${encodeURIComponent(params.nextPath)}`;

  const isSignup = params.purpose === "signup";
  const subject = isSignup
    ? "Confirm your email to finish your DanceFlow account"
    : "Verify your email for DanceFlow";
  const bodyText = isSignup
    ? "Confirm this email address to keep setting up your DanceFlow business account. After you confirm, you will create your password and continue to your trial."
    : "Confirm this email address to keep your DanceFlow account secure. After you confirm, you will create a password for this account.";

  const html = renderDanceFlowSystemEmail({
    previewText: subject,
    eyebrow: "DanceFlow",
    heading: isSignup ? "Confirm your email" : "Verify your email",
    bodyText: `${bodyText}\n\nThis link expires soon and can be used once. If you did not request it, you can ignore this email.`,
    actionLabel: isSignup ? "Confirm email" : "Verify email",
    actionUrl,
    footerText: "This security message was sent by DanceFlow.",
  });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logCode("email_verification_send_failed", "missing_provider_key");
    return false;
  }

  try {
    const response = await new Resend(apiKey).emails.send({
      from: resolveOutboundFromEmail(),
      to: [email],
      subject: sanitizeEmailSubject(subject),
      text: appendEmailLegalText(`${bodyText}\n\n${actionUrl}`),
      html,
    });

    if (response.error) {
      logCode("email_verification_send_failed", response.error.name);
      return false;
    }
  } catch {
    logCode("email_verification_send_failed", "provider_exception");
    return false;
  }

  return true;
}
