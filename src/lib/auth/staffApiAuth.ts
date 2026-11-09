import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  createBearerScopedClient,
  extractAuthorizationBearerToken,
  normalizeStudentApiUuid,
} from "@/lib/auth/studentApiAuth";
import {
  getWorkspacesForUserWithClient,
  isWorkspaceAccessAllowedStatus,
} from "@/lib/auth/studio";
import { isPlatformAdmin } from "@/lib/auth/permissions";
import { getDanceFlowAccountStatus } from "@/lib/student-identity/account-security";

/**
 * The /api/staff/* boundary. The web staff surface reaches its studio through cookies and redirects; a native client has neither, so this boundary differs on purpose:
 *
 * - The user comes from the Authorization bearer token only. There is no cookie fallback, so a browser session can never satisfy these routes.
 * - The workspace is named explicitly by the caller and checked against the caller's own memberships. There is no selected-workspace state.
 * - Every refusal is a JSON error with a stable `code`. Nothing here redirects, and an unexpected failure is a 503, never a pass.
 * - All reads run through a client carrying the caller's token, so RLS and RPCs see auth.uid(). The service role is used only for the account status lookup.
 * - Platform admins are refused in v1: web platform authority depends on an AAL2 session and an audited support context, and neither exists on this surface yet.
 */

export type StaffApiErrorCode =
  | "unauthenticated"
  | "account_inactive"
  | "platform_admin_unsupported"
  | "invalid_request"
  | "not_a_member"
  | "workspace_paused"
  | "role_not_permitted"
  | "not_found"
  | "service_unavailable";

const STAFF_API_HEADERS = { "Cache-Control": "private, no-store" };

export function staffApiError(code: StaffApiErrorCode, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status, headers: STAFF_API_HEADERS });
}

export function staffApiJson(body: unknown) {
  return NextResponse.json(body, { headers: STAFF_API_HEADERS });
}

export function staffApiUnavailable(path: string, failure: unknown) {
  console.error("Staff API request failed", {
    path,
    message: failure instanceof Error ? failure.message : String(failure),
  });
  return staffApiError("service_unavailable", "Try again in a moment.", 503);
}

type GuardFailure = { ok: false; response: NextResponse };

export type StaffApiUser = {
  user: User;
  /** Carries the caller's own token: RLS and auth.uid() apply. */
  supabase: SupabaseClient;
  fullName: string | null;
};

export type StaffApiContext = StaffApiUser & {
  studioId: string;
  studioRole: string;
  /** studios.timezone as stored; resolve it before use. */
  studioTimeZone: string | null;
};

type ProfileRow = { full_name: string | null; platform_role: string | null };

function isBanned(user: User, now = Date.now()) {
  const bannedUntil = user.banned_until ? new Date(user.banned_until).getTime() : 0;
  return bannedUntil > now;
}

// An auth outage must not read as an expired token: the app signs the user out on a 401.
function isTransientAuthFailure(error: { status?: number; name?: string }) {
  return (
    error.name === "AuthRetryableFetchError" ||
    error.status === undefined ||
    error.status === 0 ||
    error.status >= 500
  );
}

async function resolveStaffUser(request: Request): Promise<GuardFailure | ({ ok: true } & StaffApiUser)> {
  const token = extractAuthorizationBearerToken(request);
  if (!token) {
    return { ok: false, response: staffApiError("unauthenticated", "Authentication required.", 401) };
  }

  const supabase = createBearerScopedClient(token);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error && isTransientAuthFailure(error)) {
    throw new Error(`Token verification unavailable: ${error.message}`);
  }
  if (error || !user) {
    return { ok: false, response: staffApiError("unauthenticated", "Authentication required.", 401) };
  }

  const inactive = () => ({
    ok: false as const,
    response: staffApiError("account_inactive", "This account is not active.", 403),
  });

  if (isBanned(user)) return inactive();

  const account = await getDanceFlowAccountStatus(user.id);
  if (account.status !== "active") return inactive();

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("full_name, platform_role")
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  if (profileError) throw new Error(`Profile lookup failed: ${profileError.message}`);
  if (!profile) return inactive();

  if (isPlatformAdmin(profile.platform_role)) {
    return {
      ok: false,
      response: staffApiError(
        "platform_admin_unsupported",
        "Platform admin accounts cannot use the staff API yet.",
        403,
      ),
    };
  }

  return { ok: true, user, supabase, fullName: profile.full_name };
}

/** Identity only, for routes that are not about one workspace (GET /api/staff/me). Never throws. */
export async function requireStaffApiUser(
  request: Request,
): Promise<GuardFailure | ({ ok: true } & StaffApiUser)> {
  try {
    return await resolveStaffUser(request);
  } catch (failure) {
    return { ok: false, response: staffApiUnavailable(new URL(request.url).pathname, failure) };
  }
}

/**
 * Identity, then membership of the named workspace, then that workspace's subscription (the check web staff get from app/layout.tsx). Membership comes first so a non-member
 * learns nothing about another studio's state: a studio that does not exist and one the caller does not belong to are the same 403. Never throws.
 */
export async function requireStaffApi(
  request: Request,
  studioId: string,
): Promise<GuardFailure | ({ ok: true } & StaffApiContext)> {
  const path = new URL(request.url).pathname;

  try {
    const resolved = await resolveStaffUser(request);
    if (!resolved.ok) return resolved;

    const normalizedStudioId = normalizeStudentApiUuid(studioId)?.toLowerCase();
    if (!normalizedStudioId) {
      return { ok: false, response: staffApiError("invalid_request", "A valid workspace id is required.", 400) };
    }

    const notAMember = () => ({
      ok: false as const,
      response: staffApiError("not_a_member", "You do not have access to this workspace.", 403),
    });

    const { supabase, user } = resolved;
    const workspaces = await getWorkspacesForUserWithClient(user.id, supabase as never);
    const workspace = workspaces.find((row) => row.studioId === normalizedStudioId);

    if (!workspace) return notAMember();

    // A studio role row must not be able to carry platform authority through the permission helpers, all of which grant platform_admin.
    if (isPlatformAdmin(workspace.role)) return notAMember();

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("subscription_status, timezone")
      .eq("id", normalizedStudioId)
      .maybeSingle<{ subscription_status: string | null; timezone: string | null }>();

    if (studioError) throw new Error(`Workspace status lookup failed: ${studioError.message}`);

    if (!isWorkspaceAccessAllowedStatus(studio?.subscription_status)) {
      return {
        ok: false,
        response: staffApiError(
          "workspace_paused",
          "This workspace is paused until billing is resolved.",
          403,
        ),
      };
    }

    return {
      ok: true,
      user,
      supabase,
      fullName: resolved.fullName,
      studioId: normalizedStudioId,
      studioRole: workspace.role,
      studioTimeZone: studio?.timezone ?? null,
    };
  } catch (failure) {
    return { ok: false, response: staffApiUnavailable(path, failure) };
  }
}
