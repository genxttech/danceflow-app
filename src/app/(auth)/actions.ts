"use server";

import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

type StudioRoleRow = {
  studio_id: string;
  role: string;
  studios:
    | {
        id: string;
        name: string;
        slug: string | null;
        public_name: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string | null;
        public_name: string | null;
      }[]
    | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLocalNextPath(value: string) {
  if (!value) return "";

  if (!value.startsWith("/")) {
    return "";
  }

  if (value.startsWith("//")) {
    return "";
  }

  return value;
}

function getStudioFromJoin(value: StudioRoleRow["studios"]) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isOrganizerWorkspaceName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events")
  );
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

async function getActiveWorkspacesForUser(userId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("user_studio_roles")
    .select(
      `
      studio_id,
      role,
      studios (
        id,
        name,
        slug,
        public_name
      )
    `
    )
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Could not determine account access: ${error.message}`);
  }

  return (data ?? []) as StudioRoleRow[];
}

function pickPreferredWorkspace(params: {
  roles: StudioRoleRow[];
  nextPath?: string;
  signupIntent?: string;
}) {
  const { roles, nextPath, signupIntent } = params;

  if (!roles.length) return null;

  const wantsOrganizer =
    signupIntent === "organizer" ||
    (nextPath ?? "").includes("intent=organizer") ||
    (nextPath ?? "").includes("path=organizer") ||
    (nextPath ?? "").startsWith("/app/events");

  if (wantsOrganizer) {
    const organizerWorkspace =
      roles.find((row) => {
        const studio = getStudioFromJoin(row.studios);
        return isOrganizerWorkspaceName(studio?.name);
      }) ?? null;

    if (organizerWorkspace) {
      return organizerWorkspace;
    }
  }

  return roles[0];
}

async function setSelectedWorkspaceCookie(studioId: string) {
  const cookieStore = await cookies();

  cookieStore.set(APP_SELECTED_STUDIO_COOKIE, studioId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

function getPostLoginPath(params: {
  selectedWorkspace: StudioRoleRow | null;
  nextPath?: string;
}) {
  const { selectedWorkspace, nextPath } = params;

  if (nextPath) {
    return nextPath;
  }

  if (!selectedWorkspace) {
    return "/account";
  }

  const studio = getStudioFromJoin(selectedWorkspace.studios);

  if (isOrganizerWorkspaceName(studio?.name)) {
    return "/app";
  }

  return "/app";
}

export async function signupAction(formData: FormData) {
  const fullName = getString(formData, "fullName");
  const email = getString(formData, "email").toLowerCase();
  const password = getString(formData, "password");
  const signupIntent = getString(formData, "signupIntent") || "public";
  const signupMode = getString(formData, "signupMode") || "password";
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

  if (signupMode === "magic_link_public" || signupMode === "magic_link_paid_path") {
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
          selected_plan: selectedPlan || null,
        },
      },
    });

    if (error) {
      return { error: error.message };
    }

    const loginSearch = new URLSearchParams({
      "check-email": "1",
      email,
      intent: signupIntent,
    });

    if (selectedPlan) {
      loginSearch.set("plan", selectedPlan);
    }

    if (redirectPath) {
      loginSearch.set("next", redirectPath);
    }

    redirect(`/login?${loginSearch.toString()}`);
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
    return { error: signUpError.message };
  }

  const user = signUpData.user;

  if (!user) {
    return { error: "User account was not created." };
  }

  const hasImmediateSession = !!signUpData.session;

  if (!hasImmediateSession) {
    const loginSearch = new URLSearchParams({
      signup: "check-email",
      intent: signupIntent,
    });

    if (selectedPlan) {
      loginSearch.set("plan", selectedPlan);
    }

    if (redirectPath) {
      loginSearch.set("next", redirectPath);
    }

    redirect(`/login?${loginSearch.toString()}`);
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
  const signupIntent = getString(formData, "intent").toLowerCase();

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
        data: {
          signup_intent: signupIntent || null,
        },
      },
    });

    if (error) {
      return { error: error.message };
    }

    const loginSearch = new URLSearchParams({
      "check-email": "1",
      email,
    });

    if (signupIntent) {
      loginSearch.set("intent", signupIntent);
    }

    if (next) {
      loginSearch.set("next", next);
    }

    redirect(`/login?${loginSearch.toString()}`);
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
          : typeof user.user_metadata?.name === "string"
            ? user.user_metadata.name
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

  const roles = await getActiveWorkspacesForUser(user.id);
  const selectedWorkspace = pickPreferredWorkspace({
    roles,
    nextPath: next,
    signupIntent,
  });

  if (selectedWorkspace?.studio_id) {
    await setSelectedWorkspaceCookie(selectedWorkspace.studio_id);
  }

  redirect(
    getPostLoginPath({
      selectedWorkspace,
      nextPath: next || undefined,
    })
  );
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}