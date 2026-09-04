import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  buildLoginErrorPath,
  normalizeRedirectParam,
} from "@/lib/security/redirects";
import {
  claimGroupLessonRecapsForUser,
  decidePortalDestination,
  ensurePortalProfileAndClientLinks,
  getAuthUserFullName,
  getGroupLessonRecapTokenFromPath,
  listLinkedPortalDestinations,
  PORTAL_SELECTED_STUDIO_COOKIE,
} from "@/lib/auth/portal-linking";
import { getAccessibleStudioRolesForUser, isOrganizerRole } from "@/lib/auth/studio";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

// FC-1B5C: the shared active-workspace source of truth from studio.ts
// (merges active user_studio_roles and active organizer_users) replaces
// the local, incomplete getActiveStudioRoles query this file used to have.
type WorkspaceRoleRow = Awaited<
  ReturnType<typeof getAccessibleStudioRolesForUser>
>[number];

function getStudioFromJoin(value: WorkspaceRoleRow["studios"]) {
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

function getRequestedNextPath(requestUrl: URL) {
  const raw =
    requestUrl.searchParams.get("next") ||
    requestUrl.searchParams.get("redirect_to") ||
    requestUrl.searchParams.get("redirectTo");

  if (!raw) return null;

  return normalizeRedirectParam(raw, requestUrl.origin, null);
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

// FC-1B5C: getAccessibleStudioRolesForUser orders by studio_id (the
// ordering other /app callers rely on) -- callback re-sorts its own copy
// by created_at ascending here to preserve the workspace-preference
// ordering this route has always used, without needing a second query.
export function sortByCreatedAtAscending(roles: WorkspaceRoleRow[]) {
  return [...roles].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

async function getPortalRedirectPath(params: {
  userId: string;
  rememberedStudioId: string | null;
}) {
  const destinations = await listLinkedPortalDestinations(params.userId);
  const decision = decidePortalDestination(destinations, params.rememberedStudioId);

  if (decision.type === "single") return decision.path;
  if (decision.type === "multiple") return "/portal/choose";
  return null;
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

export function pickPreferredWorkspace(params: {
  roles: WorkspaceRoleRow[];
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
    // FC-1B5C: a genuine organizer_users-sourced role already carries the
    // correct organizer_owner/admin/staff role string, so isOrganizerRole
    // recognizes it directly with no name heuristic needed. The legacy
    // isOrganizerWorkspaceName heuristic is preserved unchanged (not
    // widened) for rows that are only reachable via studio-name matching
    // (e.g. a studio_owner/admin row whose studio name looks organizer).
    const organizerWorkspace =
      roles.find((row) => {
        const studio = getStudioFromJoin(row.studios);
        return isOrganizerRole(row.role) || isOrganizerWorkspaceName(studio?.name);
      }) ?? null;

    if (organizerWorkspace) {
      return organizerWorkspace;
    }
  }

  return roles[0];
}

export function getPostAuthDestination(params: {
  requestedNextPath: string | null;
  fallbackNextPath: string | null;
  selectedWorkspace: WorkspaceRoleRow | null;
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
      new URL(buildLoginErrorPath("missing-code"), request.url)
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
    console.error("Auth callback exchange failed", {
      message: exchangeError.message,
      code:
        "code" in exchangeError && typeof exchangeError.code === "string"
          ? exchangeError.code
          : null,
      status:
        "status" in exchangeError && typeof exchangeError.status === "number"
          ? exchangeError.status
          : null,
      flow: tokenHash ? "token_hash" : "pkce_code",
      hasRequestedNextPath: Boolean(requestedNextPath),
      host: requestUrl.host,
    });

    return NextResponse.redirect(
      new URL(buildLoginErrorPath("auth-callback-failed"), request.url)
    );
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL(buildLoginErrorPath("missing-user-after-callback"), request.url)
    );
  }

  const email = user.email?.trim().toLowerCase() ?? "";
  let acceptedTeamInvitationCount = 0;
  let claimedGroupRecapCount = 0;

  try {
    const isExplicitStudioInvite =
      requestedNextPath?.startsWith("/studio-invites/") === true;

    if (!isExplicitStudioInvite) {
      await ensurePortalProfileAndClientLinks({
        userId: user.id,
        email,
        fullName: getAuthUserFullName(user),
      });
    }

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
      new URL(buildLoginErrorPath("callback-sync-failed"), request.url)
    );
  }

  let roles: WorkspaceRoleRow[] = [];

  try {
    // FC-1B5C: pass this route's own already-authenticated `supabase`
    // instance explicitly -- it just performed the code/token exchange, so
    // its session is only available in-memory on this instance and via
    // request/response cookie objects this handler manages itself. The
    // default internal client getAccessibleStudioRolesForUser would
    // otherwise construct (via next/headers cookies()) cannot see that
    // session within this same request, which would silently read as
    // unauthenticated and return zero rows.
    const rawRoles = await getAccessibleStudioRolesForUser(user.id, supabase);
    roles = sortByCreatedAtAscending(rawRoles);
  } catch (roleError) {
    return NextResponse.redirect(
      new URL(buildLoginErrorPath("role-lookup-failed"), request.url)
    );
  }

  let portalPath: string | null = null;

  try {
    portalPath = await getPortalRedirectPath({
      userId: user.id,
      rememberedStudioId:
        request.cookies.get(PORTAL_SELECTED_STUDIO_COOKIE)?.value ?? null,
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
