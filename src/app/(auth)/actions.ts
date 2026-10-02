"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getTrustedRequestOrigin,
  normalizeLocalRedirectPath,
} from "@/lib/security/redirects";
import {
  claimGroupLessonRecapsForUser,
  decidePortalDestination,
  ensurePortalProfileAndClientLinks,
  getGroupLessonRecapTokenFromPath,
  listLinkedPortalDestinations,
  PORTAL_SELECTED_STUDIO_COOKIE,
} from "@/lib/auth/portal-linking";
import { getAccessibleStudioRolesForUser } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { getMyVerifiedEmail } from "@/lib/auth/verifiedIdentity";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmailVerificationLink } from "@/lib/auth/verifiedEmail";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function getBaseUrl() {
  const headerStore = await headers();
  return getTrustedRequestOrigin(headerStore);
}

function getPostLoginPath(hasWorkspaceRole: boolean) {
  return hasWorkspaceRole ? "/app" : "/account";
}

// FC-1B5B: reuses the same shared active-workspace source of truth /app's
// own layout uses (getAccessibleStudioRolesForUser -- merges active
// user_studio_roles and active organizer_users), rather than a hand-rolled,
// studio_owner-only query. Any active role at any studio/organizer
// workspace now qualifies for /app; a stale independent_instructor label
// (clients.is_independent_instructor) alone never does, since that flag is
// never consulted by this helper.
// FC-1B5B: exported (alongside getPostLoginRedirectPath below) so the
// password-login routing decision can be unit-tested directly, without
// exercising signInWithPassword/rate-limiting/profile-sync -- none of which
// bear on the /app-vs-/account-vs-portal decision under test.
export async function hasActiveWorkspaceRole(userId: string): Promise<boolean> {
  const roles = await getAccessibleStudioRolesForUser(userId);
  return roles.length > 0;
}

async function getPortalRedirectPath(userId: string): Promise<string | null> {
  const cookieStore = await cookies();
  const rememberedStudioId =
    cookieStore.get(PORTAL_SELECTED_STUDIO_COOKIE)?.value ?? null;

  const destinations = await listLinkedPortalDestinations(userId);
  const decision = decidePortalDestination(destinations, rememberedStudioId);

  if (decision.type === "single") return decision.path;
  if (decision.type === "multiple") return "/portal/choose";
  return null;
}

export async function getPostLoginRedirectPath(userId: string): Promise<string> {
  const hasWorkspaceRole = await hasActiveWorkspaceRole(userId);

  if (hasWorkspaceRole) {
    return getPostLoginPath(true);
  }

  const portalPath = await getPortalRedirectPath(userId);

  if (portalPath) {
    return portalPath;
  }

  return getPostLoginPath(false);
}

function buildSignupRedirectPath(params: {
  signupIntent: string;
  selectedPlan?: string;
  nextPath?: string;
}) {
  const { signupIntent, selectedPlan, nextPath } = params;

  const normalizedNext = normalizeLocalRedirectPath(nextPath ?? "");
  if (normalizedNext) {
    return normalizedNext;
  }

  if (signupIntent === "studio" || signupIntent === "organizer") {
    const search = new URLSearchParams({
      intent: signupIntent,
    });

    if (selectedPlan) {
      search.set("plan", selectedPlan);
    }

    return `/get-started/complete?${search.toString()}`;
  }

  return "/account";
}

function buildLoginRedirectPath(params: {
  email?: string;
  loginIntent?: string;
  selectedPlan?: string;
  nextPath?: string;
  mode?:
    | "resume-signup"
    | "check-email"
    | "verify-email"
    | "reset-sent"
    | "password-updated"
    | "default";
}) {
  const search = new URLSearchParams();

  if (params.mode && params.mode !== "default") {
    search.set("mode", params.mode);
  }

  if (params.email) {
    search.set("email", params.email);
  }

  if (params.loginIntent) {
    search.set("intent", params.loginIntent);
  }

  if (params.selectedPlan) {
    search.set("plan", params.selectedPlan);
  }

  const normalizedNext = normalizeLocalRedirectPath(params.nextPath ?? "");
  if (normalizedNext) {
    search.set("next", normalizedNext);
  }

  const query = search.toString();
  return query ? `/login?${query}` : "/login";
}

async function upsertProfile(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  email: string;
  fullName?: string | null;
}) {
  const { supabase, userId, email, fullName } = params;

  const payload: {
    id: string;
    email: string;
    full_name?: string;
  } = {
    id: userId,
    email,
  };

  if (fullName?.trim()) {
    payload.full_name = fullName.trim();
  }

  const { error } = await supabase.from("profiles").upsert(payload, {
    onConflict: "id",
  });

  if (error) {
    throw new Error(`Profile creation failed: ${error.message}`);
  }
}

async function syncAccountAfterAuth(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  email: string;
  fullName?: string | null;
  nextPath?: string | null;
}) {
  const { supabase, userId, email, fullName, nextPath } = params;

  await upsertProfile({
    supabase,
    userId,
    email,
    fullName,
  });

  // LAUNCH-SEC-1C-B: email-based claims require this session's verified email.
  const verifiedEmail = await getMyVerifiedEmail(supabase);

  await ensurePortalProfileAndClientLinks({
    userId,
    email,
    fullName,
    verifiedEmail,
  });

  await claimGroupLessonRecapsForUser({
    userId,
    email,
    verifiedEmail,
    recapToken: getGroupLessonRecapTokenFromPath(nextPath),
  });
}

export async function signupAction(formData: FormData) {
  const fullName = getString(formData, "fullName");
  const email = getString(formData, "email").toLowerCase();
  const signupIntent = getString(formData, "signupIntent") || "public";
  const selectedPlan = getString(formData, "selectedPlan");
  const nextPath = getString(formData, "nextPath");

  if (!fullName || !email) {
    return { error: "Full name and email are required." };
  }

  const signupRateLimit = checkRateLimit(
    await getServerActionRateLimitKey("auth:signup", [email, signupIntent]),
    { limit: 5, windowMs: 15 * 60 * 1000 },
  );

  if (!signupRateLimit.allowed) {
    return { error: rateLimitErrorMessage(signupRateLimit) };
  }

  const supabase = await createClient();

  const redirectPath = buildSignupRedirectPath({
    signupIntent,
    selectedPlan,
    nextPath,
  });

  if (signupIntent === "public") {
    const baseUrl = await getBaseUrl();

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${baseUrl}/callback?next=${encodeURIComponent(
          redirectPath
        )}`,
        data: {
          full_name: fullName,
          signup_intent: signupIntent,
        },
      },
    });

    if (error) {
      return { error: error.message };
    }

    redirect(
      buildLoginRedirectPath({
        email,
        loginIntent: "public",
        nextPath: redirectPath,
        mode: "check-email",
      })
    );
  }

  /*
    LAUNCH-SEC-1C-A: business signup is passwordless-first and no longer
    depends on Supabase "Confirm email" being OFF:
      email -> DanceFlow mailbox link (token_hash) -> /callback proof ->
      create password (binding) -> new session -> trial setup.
    Intent/plan travel in the new user's metadata (set server-side) and in a
    normalized local `next` path; neither grants anything. Business legal
    acceptance is recorded later by the existing authenticated /legal/accept
    gate that trial setup and billing already enforce.
  */
  const sent = await sendEmailVerificationLink({
    adminClient: createAdminClient(),
    email,
    baseUrl: await getBaseUrl(),
    nextPath: redirectPath,
    purpose: "signup",
    userMetadata: {
      full_name: fullName,
      signup_intent: signupIntent,
      selected_plan: selectedPlan || null,
    },
  });

  if (!sent) {
    return { error: "We could not send your confirmation email. Please try again in a moment." };
  }

  redirect(
    buildLoginRedirectPath({
      email,
      loginIntent: signupIntent,
      selectedPlan,
      nextPath: redirectPath,
      mode: "check-email",
    })
  );
}

export async function loginAction(formData: FormData) {
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const next = normalizeLocalRedirectPath(getString(formData, "next"));
  const loginMode = getString(formData, "loginMode") || "password";
  const loginIntent = getString(formData, "loginIntent") || "public";

  if (!email) {
    return { error: "Email is required." };
  }

  const loginRateLimit = checkRateLimit(
    await getServerActionRateLimitKey(`auth:${loginMode === "magic_link" ? "magic" : "password"}`, [email]),
    { limit: loginMode === "magic_link" ? 4 : 8, windowMs: 15 * 60 * 1000 },
  );

  if (!loginRateLimit.allowed) {
    return { error: rateLimitErrorMessage(loginRateLimit) };
  }

  const supabase = await createClient();

  if (loginMode === "magic_link") {
    const baseUrl = await getBaseUrl();
    const redirectTo = next || "/account";

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${baseUrl}/callback?next=${encodeURIComponent(
          redirectTo
        )}`,
      },
    });

    if (error) {
      return { error: error.message };
    }

    redirect(
      buildLoginRedirectPath({
        email,
        loginIntent,
        nextPath: redirectTo,
        mode: "check-email",
      })
    );
  }

  if (!password) {
    return { error: "Password is required." };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  const user = data.user;

  if (!user?.id) {
    return { error: "Login succeeded, but no user session was returned." };
  }

  try {
    await syncAccountAfterAuth({
      supabase,
      userId: user.id,
      email,
      fullName:
        typeof user.user_metadata?.full_name === "string"
          ? user.user_metadata.full_name
          : null,
      nextPath: next,
    });
  } catch (syncError) {
    return {
      error:
        syncError instanceof Error
          ? syncError.message
          : "Account sync failed after login.",
    };
  }

  if (next && next !== "/account") {
    redirect(next);
  }

  const redirectPath = await getPostLoginRedirectPath(user.id);
  redirect(redirectPath);
}

export async function requestPasswordResetAction(formData: FormData) {
  const email = getString(formData, "email").toLowerCase();
  const loginIntent = getString(formData, "loginIntent") || "studio";
  const next = normalizeLocalRedirectPath(getString(formData, "next"));

  if (!email) {
    return { error: "Email is required." };
  }

  const resetRateLimit = checkRateLimit(
    await getServerActionRateLimitKey("auth:password-reset", [email]),
    { limit: 4, windowMs: 30 * 60 * 1000 },
  );

  if (!resetRateLimit.allowed) {
    return { error: rateLimitErrorMessage(resetRateLimit) };
  }

  const supabase = await createClient();
  const baseUrl = await getBaseUrl();

  const resetSearch = new URLSearchParams({
    intent: loginIntent,
  });

  if (next) {
    resetSearch.set("next", next);
  }

  const redirectTo = `${baseUrl}/callback?next=${encodeURIComponent(
    `/reset-password?${resetSearch.toString()}`
  )}`;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });

  if (error) {
    return { error: error.message };
  }

  redirect(
    buildLoginRedirectPath({
      email,
      loginIntent,
      nextPath: next,
      mode: "reset-sent",
    })
  );
}

export async function updatePasswordAction(formData: FormData) {
  const password = getString(formData, "password");
  const confirmPassword = getString(formData, "confirmPassword");
  const loginIntent = getString(formData, "loginIntent") || "studio";
  const next = normalizeLocalRedirectPath(getString(formData, "next"));

  const errorSearch = new URLSearchParams({
    intent: loginIntent,
  });

  if (next) {
    errorSearch.set("next", next);
  }

  function redirectWithError(message: string): never {
    errorSearch.set("error", message);
    redirect(`/reset-password?${errorSearch.toString()}`);
  }

  if (!password) {
    redirectWithError("Password is required.");
  }

  if (password.length < 8) {
    redirectWithError("Password must be at least 8 characters.");
  }

  if (password !== confirmPassword) {
    redirectWithError("Passwords do not match.");
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirectWithError("Your reset link expired. Please request a new password reset email.");
  }

  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    redirectWithError("Password update failed. Please request a fresh reset link.");
  }

  const loginSearch = new URLSearchParams({
    mode: "password-updated",
    intent: loginIntent,
  });

  if (user.email) {
    loginSearch.set("email", user.email);
  }

  if (next) {
    loginSearch.set("next", next);
  }

  redirect(`/login?${loginSearch.toString()}`);
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function signOutAction() {
  await logoutAction();
}
