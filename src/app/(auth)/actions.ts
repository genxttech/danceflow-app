"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getPostLoginPath(hasStudioRole: boolean) {
  return hasStudioRole ? "/app" : "/account";
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

async function getBaseUrl() {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  if (!host) {
    return process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  }

  return `${proto}://${host}`;
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
  const signupMode = getString(formData, "signupMode") || "password";

  if (!fullName || !email) {
    return { error: "Full name and email are required." };
  }

  const supabase = await createClient();

  if (signupMode === "magic_link_public") {
    const baseUrl = await getBaseUrl();
    const redirectTo =
      signupIntent === "public" ? "/account" : "/get-started";

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${baseUrl}/callback?next=${encodeURIComponent(
          redirectTo
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
      `/login?check-email=1&email=${encodeURIComponent(
        email
      )}&intent=${encodeURIComponent(signupIntent)}`
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
      },
    },
  });

  if (signUpError) {
    return { error: signUpError.message };
  }

  const user = signUpData.user;

  if (!user) {
    return { error: "User account was not created." };
  }

  const hasImmediateSession = !!signUpData.session;

  if (!hasImmediateSession) {
    redirect(
      `/login?signup=check-email&intent=${encodeURIComponent(signupIntent)}`
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

  redirect(`/get-started?welcome=1&intent=${encodeURIComponent(signupIntent)}`);
}

export async function loginAction(formData: FormData) {
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const next = getString(formData, "next");
  const loginMode = getString(formData, "loginMode") || "password";

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

    redirect(`/login?check-email=1&email=${encodeURIComponent(email)}`);
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
  redirect(getPostLoginPath(hasStudioRole));
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}