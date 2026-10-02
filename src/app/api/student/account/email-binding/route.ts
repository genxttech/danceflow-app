import { NextResponse } from "next/server";
import {
  createStudentApiUserScopedClient,
  extractStudentBearerToken,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import {
  completePasswordBinding,
  type BindingFailureCode,
} from "@/lib/auth/verifiedEmail";
import { checkRateLimit, getIpFromRequest, rateLimitedJson } from "@/lib/security/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/*
  LAUNCH-SEC-1C-A: mobile credential binding. Requires the bearer token of the
  exact fresh proof session (checked in the database); no user id, email or
  session id is read from the request body. Success revokes every session, so
  the app signs in again with an email code.
*/

const FAILURE_MESSAGES: Record<BindingFailureCode, { status: number; message: string }> = {
  weak_password: { status: 400, message: "Choose a password with at least 8 characters." },
  not_authenticated: { status: 401, message: "Please sign in again to continue." },
  not_ready: { status: 409, message: "Your verification link has expired. Sign in with a new email link to continue." },
  bind_expired: { status: 409, message: "Your verification link has expired. Sign in with a new email link to continue." },
  revoke_failed: { status: 503, message: "We could not finish securing your account. Please try again." },
  password_update_failed: { status: 503, message: "We could not save your password. Please try again." },
};

export async function POST(request: Request) {
  const accessToken = extractStudentBearerToken(request);
  if (!accessToken) return studentApiJsonError("Authentication required.", 401);

  const limit = checkRateLimit(`student:email-binding:${getIpFromRequest(request)}`, {
    limit: 8,
    windowMs: 15 * 60 * 1000,
  });
  if (!limit.allowed) return rateLimitedJson(limit);

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return studentApiJsonError("Invalid request.", 400);
  }

  const result = await completePasswordBinding({
    userClient: await createStudentApiUserScopedClient(request),
    adminClient: createAdminClient(),
    accessToken,
    password,
  });

  if (!result.ok) {
    const failure = FAILURE_MESSAGES[result.code];
    return studentApiJsonError(failure.message, failure.status);
  }

  return NextResponse.json({ bound: true });
}
