import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

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

async function getActiveStudioRoles(params: {
  supabase: ReturnType<typeof createServerClient>;
  userId: string;
}) {
  const { supabase, userId } = params;

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

async function upsertProfile(params: {
  supabase: ReturnType<typeof createServerClient>;
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
  supabase: ReturnType<typeof createServerClient>;
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

function normalizeLocalNextPath(value: string | null) {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  return value;
}

function getRequestedNextPath(requestUrl: URL) {
  const raw =
    requestUrl.searchParams.get("next") ||
    requestUrl.searchParams.get("redirect_to") ||
    requestUrl.searchParams.get("redirectTo");

  if (!raw) return null;

  const normalizedLocal = normalizeLocalNextPath(raw);
  if (normalizedLocal) return normalizedLocal;

  try {
    const parsed = new URL(raw);

    if (parsed.origin !== requestUrl.origin) {
      return null;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function getFallbackNextPathFromUserMetadata(user: {
  user_metadata?: Record<string, unknown> | null;
}) {
  const signupIntent =
    typeof user.user_metadata?.signup_intent === "string"
      ? user.user_metadata.signup_intent.trim().toLowerCase()
      : "";

  const selectedPlan =
    typeof user.user_metadata?.selected_plan === "string"
      ? user.user_metadata.selected_plan.trim().toLowerCase()
      : "";

  if (signupIntent === "studio" || signupIntent === "organizer") {
    const search = new URLSearchParams({
      intent: signupIntent,
    });

    if (selectedPlan) {
      search.set("plan", selectedPlan);
    }

    return `/get-started/complete?${search.toString()}`;
  }

  return null;
}

function pickPreferredWorkspace(params: {
  roles: StudioRoleRow[];
  requestedNextPath: string | null;
  fallbackNextPath: string | null;
}) {
  const { roles, requestedNextPath, fallbackNextPath } = params;

  if (!roles.length) return null;

  const nextPath = requestedNextPath || fallbackNextPath || "";
  const wantsOrganizer =
    nextPath.includes("intent=organizer") ||
    nextPath.includes("path=organizer") ||
    nextPath.startsWith("/app/events");

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

function getPostAuthAppDestination(params: {
  requestedNextPath: string | null;
  fallbackNextPath: string | null;
  selectedWorkspace: StudioRoleRow | null;
}) {
  const { requestedNextPath, fallbackNextPath, selectedWorkspace } = params;

  if (requestedNextPath) return requestedNextPath;
  if (fallbackNextPath) return fallbackNextPath;

  if (!selectedWorkspace) {
    return "/account";
  }

  const studio = getStudioFromJoin(selectedWorkspace.studios);

  if (isOrganizerWorkspaceName(studio?.name)) {
  return "/app";
}

  return "/app";
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const requestedNextPath = getRequestedNextPath(requestUrl);

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=missing-code", request.url)
    );
  }

  let response = NextResponse.redirect(new URL("/account", request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(exchangeError.message)}`,
        request.url
      )
    );
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL("/login?error=missing-user-after-callback", request.url)
    );
  }

  const email = user.email?.trim().toLowerCase() ?? "";

  try {
    await upsertProfile({
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

    await attachPortalAccessForEmail({
      supabase,
      userId: user.id,
      email,
    });
  } catch (syncError) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          syncError instanceof Error ? syncError.message : "callback-sync-failed"
        )}`,
        request.url
      )
    );
  }

  let roles: StudioRoleRow[] = [];

  try {
    roles = await getActiveStudioRoles({
      supabase,
      userId: user.id,
    });
  } catch (roleError) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          roleError instanceof Error ? roleError.message : "role-lookup-failed"
        )}`,
        request.url
      )
    );
  }

  const fallbackNextPath = getFallbackNextPathFromUserMetadata(user);
  const selectedWorkspace = pickPreferredWorkspace({
    roles,
    requestedNextPath,
    fallbackNextPath,
  });

  const destination = getPostAuthAppDestination({
    requestedNextPath,
    fallbackNextPath,
    selectedWorkspace,
  });

  const finalResponse = NextResponse.redirect(new URL(destination, request.url));

  for (const cookie of response.cookies.getAll()) {
    finalResponse.cookies.set(cookie);
  }

  if (selectedWorkspace?.studio_id) {
    finalResponse.cookies.set(APP_SELECTED_STUDIO_COOKIE, selectedWorkspace.studio_id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }

  return finalResponse;
}