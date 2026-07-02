import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  claimGroupLessonRecapsForUser,
  ensurePortalProfileAndClientLinks,
  getAuthUserFullName,
  getGroupLessonRecapTokenFromPath,
} from "@/lib/auth/portal-linking";

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

type PortalClientRow = {
  studio_id: string;
  studios:
    | {
        slug: string | null;
      }
    | {
        slug: string | null;
      }[]
    | null;
};

function getStudioFromJoin(value: StudioRoleRow["studios"]) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function getPortalStudioFromJoin(value: PortalClientRow["studios"]) {
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

function isGenericAuthLandingPath(path: string | null) {
  if (!path) return true;

  return (
    path === "/account" ||
    path === "/login" ||
    path.startsWith("/login?") ||
    path === "/portal"
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

async function getPortalRedirectPath(params: {
  supabase: ReturnType<typeof createServerClient>;
  userId: string;
}) {
  const { supabase, userId } = params;

  const { data, error } = await supabase
    .from("clients")
    .select(
      `
      studio_id,
      studios (
        slug
      )
    `
    )
    .eq("portal_user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const portalClient = data as PortalClientRow;
  const studio = getPortalStudioFromJoin(portalClient.studios);

  if (!studio?.slug) {
    return null;
  }

  return `/portal/${studio.slug}`;
}

async function acceptTeamInvitationsForEmail(params: {
  supabase: ReturnType<typeof createServerClient>;
  email: string;
}) {
  const { supabase, email } = params;

  if (!email) return 0;

  const { data, error } = await supabase.rpc("accept_pending_team_invitations", {
    p_email: email,
  });

  if (error) {
    throw new Error(`Team invitation acceptance failed: ${error.message}`);
  }

  return typeof data === "number" ? data : 0;
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

function getPostAuthDestination(params: {
  requestedNextPath: string | null;
  fallbackNextPath: string | null;
  selectedWorkspace: StudioRoleRow | null;
  portalPath: string | null;
}) {
  const { requestedNextPath, fallbackNextPath, selectedWorkspace, portalPath } =
    params;

  /*
    If the magic link requested a specific real destination, honor it.
    Examples:
    /get-started/complete
    /app
    /favorites
    /discover/studios
  */
  if (requestedNextPath && !isGenericAuthLandingPath(requestedNextPath)) {
    return requestedNextPath;
  }

  /*
    Workspace users should go to the app.
  */
  if (selectedWorkspace) {
    return "/app";
  }

  /*
    Portal users should not land back on /login or /account after clicking
    the first magic link. Once the callback links their email to a client
    portal record, send them straight to that portal.
  */
  if (portalPath) {
    return portalPath;
  }

  /*
    Studio/organizer signup fallback.
  */
  if (fallbackNextPath) {
    return fallbackNextPath;
  }

  /*
    Public accounts with no workspace/portal should land in account.
  */
  if (requestedNextPath) {
    return requestedNextPath;
  }

  return "/account";
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const otpType = requestUrl.searchParams.get("type") as EmailOtpType | null;
  const requestedNextPath = getRequestedNextPath(requestUrl);

  if (!code && !tokenHash) {
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

  const { error: exchangeError } = tokenHash
    ? await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: otpType ?? "magiclink",
      })
    : await supabase.auth.exchangeCodeForSession(code!);

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
  let acceptedTeamInvitationCount = 0;
  let claimedGroupRecapCount = 0;

  try {
    await ensurePortalProfileAndClientLinks({
      userId: user.id,
      email,
      fullName: getAuthUserFullName(user),
    });

    const claimResult = await claimGroupLessonRecapsForUser({
      userId: user.id,
      email,
      recapToken: getGroupLessonRecapTokenFromPath(requestedNextPath),
    });
    claimedGroupRecapCount = claimResult.claimedCount;

    acceptedTeamInvitationCount = await acceptTeamInvitationsForEmail({
      supabase,
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

  let portalPath: string | null = null;

  try {
    portalPath = await getPortalRedirectPath({
      supabase,
      userId: user.id,
    });
  } catch {
    portalPath = null;
  }

  const fallbackNextPath = getFallbackNextPathFromUserMetadata(user);
  const selectedWorkspace = pickPreferredWorkspace({
    roles,
    requestedNextPath,
    fallbackNextPath,
  });

  const destination = getPostAuthDestination({
    requestedNextPath,
    fallbackNextPath,
    selectedWorkspace,
    portalPath,
  });

  const destinationUrl = new URL(destination, request.url);

  if (acceptedTeamInvitationCount > 0) {
    destinationUrl.searchParams.set(
      "team_invite_accepted",
      String(acceptedTeamInvitationCount)
    );
  }

  if (claimedGroupRecapCount > 0) {
    destinationUrl.searchParams.set(
      "group_recap_claimed",
      String(claimedGroupRecapCount)
    );
  }

  const finalResponse = NextResponse.redirect(destinationUrl);

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
