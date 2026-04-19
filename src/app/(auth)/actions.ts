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

export async function signupAction(formData: FormData) {
  const fullName = getString(formData, "fullName");
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const signupIntent = getString(formData, "signupIntent") || "public";

  if (!fullName || !email || !password) {
    return { error: "Full name, email, and password are required." };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = await createClient();

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

  const { error: profileError } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      full_name: fullName,
      email,
    },
    {
      onConflict: "id",
    }
  );

  if (profileError) {
    return { error: `Profile creation failed: ${profileError.message}` };
  }

  const hasImmediateSession = !!signUpData.session;

  if (!hasImmediateSession) {
    redirect(`/login?signup=check-email&intent=${encodeURIComponent(signupIntent)}`);
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
        emailRedirectTo: `${baseUrl}/auth/callback?next=${encodeURIComponent(
          redirectTo
        )}`,
      },
    });

    if (error) {
      return { error: error.message };
    }

    redirect(
      `/login?check-email=1&email=${encodeURIComponent(email)}`
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

  const userId = data.user?.id;

  if (!userId) {
    return { error: "Login succeeded, but no user session was returned." };
  }

  if (next) {
    redirect(next);
  }

  const hasStudioRole = await hasActiveStudioRole(userId);
  redirect(getPostLoginPath(hasStudioRole));
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}