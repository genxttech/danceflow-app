"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLocalNextPath(value: string) {
  if (!value) return "";
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  return value;
}

async function getBaseUrl() {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  if (!host) {
    return process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  }

  return `${proto}://${host}`;
}

async function hasActiveStudioRole(userId: string) {
  const supabase = await createClient();

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (roleError) {
    throw new Error(`Could not determine account access: ${roleError.message}`);
  }

  return !!roleRow?.studio_id;
}

function getPostLoginPath(hasStudioRole: boolean) {
  return hasStudioRole ? "/app" : "/account";
}

function buildSignupRedirectPath(params: {
  signupIntent: string;
  selectedPlan?: string;
  nextPath?: string;
}) {
  const { signupIntent, selectedPlan, nextPath } = params;

  const normalizedNext = normalizeLocalNextPath(nextPath ?? "");
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

  const normalizedNext = normalizeLocalNextPath(params.nextPath ?? "");
  if (normalizedNext) {
    search.set("next", normalizedNext);
  }

  const query = search.toString();
  return query ? `/login?${query}` : "/login";
}

function isExistingUserError(message: string) {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("already registered") ||
    normalized.includes("already been registered") ||
    normalized.includes("user already registered") ||
    normalized.includes("already exists")
  );
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

async function attachPortalAccessForEmail(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  email: string;
}) {
  const { supabase, userId, email } = params;

  if (!email) return;

  const { error } = await supabase.rpc("link_portal_client_by_email", {
    p_user_id: userId,
    p_email: email,
  });

  if (error) {
    throw new Error(`Portal auto-link failed: ${error.message}`);
  }
}

async function syncAccountAfterAuth(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  email: string;
  fullName?: string | null;
}) {
  const { supabase, userId, email, fullName } = params;

  await upsertProfile({
    supabase,
    userId,
    email,
    fullName,
  });

  await attachPortalAccessForEmail({
    supabase,
    userId,
    email,
  });
}

export async function signupAction(formData: FormData) {
  const fullName = getString(formData, "fullName");
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const signupIntent = getString(formData, "signupIntent") || "public";
  const selectedPlan = getString(formData, "selectedPlan");
  const nextPath = getString(formData, "nextPath");

  if (!fullName || !email) {
    return { error: "Full name and email are required." };
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

  if (!password) {
    return { error: "Password is required." };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        signup_intent: signupIntent,
        selected_plan: selectedPlan || null,
      },
    },
  });

  if (signUpError) {
    if (isExistingUserError(signUpError.message)) {
      redirect(
        buildLoginRedirectPath({
          email,
          loginIntent: signupIntent,
          selectedPlan,
          nextPath: redirectPath,
          mode: "resume-signup",
        })
      );
    }

    return { error: signUpError.message };
  }

  const user = signUpData.user;

  if (!user) {
    return { error: "User account was not created." };
  }

  const hasImmediateSession = !!signUpData.session;

  if (!hasImmediateSession) {
    redirect(
      buildLoginRedirectPath({
        email,
        loginIntent: signupIntent,
        selectedPlan,
        nextPath: redirectPath,
        mode: "verify-email",
      })
    );
  }

  try {
    await syncAccountAfterAuth({
      supabase,
      userId: user.id,
      email,
      fullName,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Account setup failed.",
    };
  }

  redirect(redirectPath);
}

export async function loginAction(formData: FormData) {
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const next = normalizeLocalNextPath(getString(formData, "next"));
  const loginMode = getString(formData, "loginMode") || "password";
  const loginIntent = getString(formData, "loginIntent") || "public";

  if (!email) {
    return { error: "Email is required." };
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
        loginIntent: "public",
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
    });
  } catch (syncError) {
    return {
      error:
        syncError instanceof Error
          ? syncError.message
          : "Account sync failed after login.",
    };
  }

  if (next) {
    redirect(next);
  }

  const hasStudioRole = await hasActiveStudioRole(user.id);

  if (loginIntent === "studio" || loginIntent === "organizer") {
    redirect("/app");
  }

  redirect(getPostLoginPath(hasStudioRole));
}

export async function requestPasswordResetAction(formData: FormData) {
  const email = getString(formData, "email").toLowerCase();
  const loginIntent = getString(formData, "loginIntent") || "studio";
  const next = normalizeLocalNextPath(getString(formData, "next"));

  if (!email) {
    return { error: "Email is required." };
  }

  const supabase = await createClient();
  const baseUrl = await getBaseUrl();

  const redirectTo = `${baseUrl}/login?intent=${encodeURIComponent(
    loginIntent
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

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export async function signOutAction() {
  await logoutAction();
}