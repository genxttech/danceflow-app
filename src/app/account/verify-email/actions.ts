"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  buildEmailVerificationPath,
  completePasswordBinding,
  sendEmailVerificationLink,
} from "@/lib/auth/verifiedEmail";
import {
  checkRateLimit,
  getServerActionRateLimitKey,
} from "@/lib/security/rate-limit";
import {
  getTrustedRequestOrigin,
  normalizeLocalRedirectPath,
} from "@/lib/security/redirects";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function field(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function pathWith(nextPath: string, key: string, value: string) {
  const base = buildEmailVerificationPath(nextPath || null);
  return `${base}${base.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

// Sends a mailbox link to the signed-in user's CURRENT auth email only.
export async function sendVerificationEmailAction(formData: FormData) {
  const nextPath = normalizeLocalRedirectPath(field(formData, "next"));
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(buildEmailVerificationPath(nextPath || null))}`);
  }

  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) {
    redirect(pathWith(nextPath, "error", "no_email"));
  }

  const limit = checkRateLimit(
    await getServerActionRateLimitKey("auth:verify-email", [user.id]),
    { limit: 4, windowMs: 15 * 60 * 1000 },
  );
  if (!limit.allowed) {
    redirect(pathWith(nextPath, "error", "rate_limited"));
  }

  const sent = await sendEmailVerificationLink({
    adminClient: createAdminClient(),
    email,
    baseUrl: getTrustedRequestOrigin(await headers()),
    nextPath: buildEmailVerificationPath(nextPath || null),
    purpose: "verify",
  });

  redirect(pathWith(nextPath, sent ? "sent" : "error", sent ? "1" : "send_failed"));
}

// Binds a password from the exact fresh proof session (see completePasswordBinding).
export async function bindPasswordAction(formData: FormData) {
  const nextPath = normalizeLocalRedirectPath(field(formData, "next"));
  const password = field(formData, "password");
  const confirmPassword = field(formData, "confirmPassword");

  if (password !== confirmPassword) {
    redirect(pathWith(nextPath, "error", "password_mismatch"));
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(buildEmailVerificationPath(nextPath || null))}`);
  }

  const limit = checkRateLimit(
    await getServerActionRateLimitKey("auth:bind-password", [user.id]),
    { limit: 6, windowMs: 15 * 60 * 1000 },
  );
  if (!limit.allowed) {
    redirect(pathWith(nextPath, "error", "rate_limited"));
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const result = await completePasswordBinding({
    userClient: supabase,
    adminClient: createAdminClient(),
    accessToken: session?.access_token ?? "",
    password,
  });

  if (!result.ok) {
    redirect(pathWith(nextPath, "error", result.code));
  }

  // Every earlier session was revoked by the password replacement; claims need
  // a NEW session created after binding, so sign in again right away.
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: result.email,
    password,
  });

  if (signInError) {
    const search = new URLSearchParams({ mode: "password-updated", email: result.email });
    if (nextPath) search.set("next", nextPath);
    redirect(`/login?${search.toString()}`);
  }

  redirect(nextPath || "/account");
}
