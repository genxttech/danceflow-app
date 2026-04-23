import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin, requireAuthenticatedUser } from "./platform";

const PLATFORM_STUDIO_COOKIE = "platform_selected_studio_id";
const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

type StudioRoleRow = {
  studio_id: string;
  role: string;
  active: boolean;
  studios?:
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

type StudioStatusRow = {
  subscription_status: string | null;
};

export type StudioWorkspace = {
  studioId: string;
  studioRole: string;
  studioName: string;
  studioSlug: string | null;
  studioPublicName: string | null;
  isSelected: boolean;
};

export type StudioContext = {
  studioId: string;
  studioRole: string | null;
  isPlatformAdmin: boolean;
  userId: string;
  email: string | null;
};

export type WorkspaceAccessState = {
  studioId: string;
  status: string | null;
  allowed: boolean;
  blocked: boolean;
};

async function getCookieValue(name: string) {
  const cookieStore = await cookies();
  return cookieStore.get(name)?.value ?? null;
}

function getStudioFromJoin(
  value: StudioRoleRow["studios"]
):
  | {
      id: string;
      name: string;
      slug: string | null;
      public_name: string | null;
    }
  | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function workspaceLooksLikeOrganizer(
  studio:
    | {
        id: string;
        name: string;
        slug: string | null;
        public_name: string | null;
      }
    | null
) {
  const normalized = (studio?.name ?? "").trim().toLowerCase();

  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events") ||
    normalized.includes(" festival") ||
    normalized.includes(" event")
  );
}

function normalizeWorkspaceRole(row: StudioRoleRow) {
  const studio = getStudioFromJoin(row.studios);
  const rawRole = (row.role ?? "").trim().toLowerCase();

  if (!workspaceLooksLikeOrganizer(studio)) {
    return row.role;
  }

  if (rawRole === "studio_owner") {
    return "organizer_owner";
  }

  if (rawRole === "studio_admin") {
    return "organizer_admin";
  }

  return row.role;
}

async function getAccessibleStudioRolesForUser(userId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("user_studio_roles")
    .select(`
      studio_id,
      role,
      active,
      studios (
        id,
        name,
        slug,
        public_name
      )
    `)
    .eq("user_id", userId)
    .eq("active", true)
    .order("studio_id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load studio workspaces: ${error.message}`);
  }

  return (data ?? []) as StudioRoleRow[];
}

function pickSelectedWorkspace(
  roles: StudioRoleRow[],
  selectedStudioId: string | null
) {
  if (!roles.length) return null;

  if (selectedStudioId) {
    const selected = roles.find((row) => row.studio_id === selectedStudioId);
    if (selected) return selected;
  }

  return roles[0];
}

export function isOrganizerRole(role: string | null | undefined) {
  return (role ?? "").trim().toLowerCase().startsWith("organizer_");
}

export function isWorkspaceAccessAllowedStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

export async function getSelectedPlatformStudioIdFromCookie() {
  return getCookieValue(PLATFORM_STUDIO_COOKIE);
}

export async function getSelectedAppStudioIdFromCookie() {
  return getCookieValue(APP_SELECTED_STUDIO_COOKIE);
}

export async function getAccessibleStudios(): Promise<StudioWorkspace[]> {
  const profile = await requireAuthenticatedUser();
  const roles = await getAccessibleStudioRolesForUser(profile.id);
  const selectedStudioId = await getSelectedAppStudioIdFromCookie();
  const selected = pickSelectedWorkspace(roles, selectedStudioId);

  return roles
    .map((row) => {
      const studio = getStudioFromJoin(row.studios);
      if (!studio) return null;

      return {
        studioId: row.studio_id,
        studioRole: normalizeWorkspaceRole(row),
        studioName: studio.name,
        studioSlug: studio.slug,
        studioPublicName: studio.public_name,
        isSelected: row.studio_id === selected?.studio_id,
      } satisfies StudioWorkspace;
    })
    .filter((value): value is StudioWorkspace => Boolean(value));
}

export async function getCurrentStudioRole() {
  const profile = await requireAuthenticatedUser();
  const roles = await getAccessibleStudioRolesForUser(profile.id);
  const selectedStudioId = await getSelectedAppStudioIdFromCookie();
  const selected = pickSelectedWorkspace(roles, selectedStudioId);

  if (!selected) {
    return null;
  }

  return {
    studio_id: selected.studio_id,
    role: normalizeWorkspaceRole(selected),
    active: selected.active,
    studios: selected.studios,
  } as StudioRoleRow;
}

export async function getCurrentStudioContext(): Promise<StudioContext> {
  const profile = await requireAuthenticatedUser();
  const platformAdmin = await isPlatformAdmin();

  if (platformAdmin) {
    const selectedStudioId = await getSelectedPlatformStudioIdFromCookie();

    if (!selectedStudioId) {
      redirect("/platform/studios");
    }

    return {
      studioId: selectedStudioId,
      studioRole: "platform_admin",
      isPlatformAdmin: true,
      userId: profile.id,
      email: profile.email,
    };
  }

  const studioRole = await getCurrentStudioRole();

  if (!studioRole) {
    redirect("/account");
  }

  return {
    studioId: studioRole.studio_id,
    studioRole: studioRole.role,
    isPlatformAdmin: false,
    userId: profile.id,
    email: profile.email,
  };
}

export async function getStudioContextForStudio(
  studioId: string
): Promise<StudioContext> {
  const profile = await requireAuthenticatedUser();
  const platformAdmin = await isPlatformAdmin();

  if (platformAdmin) {
    return {
      studioId,
      studioRole: "platform_admin",
      isPlatformAdmin: true,
      userId: profile.id,
      email: profile.email,
    };
  }

  const roles = await getAccessibleStudioRolesForUser(profile.id);
  const matchingRole = roles.find((row) => row.studio_id === studioId);

  if (!matchingRole) {
    redirect("/app");
  }

  return {
    studioId,
    studioRole: normalizeWorkspaceRole(matchingRole),
    isPlatformAdmin: false,
    userId: profile.id,
    email: profile.email,
  };
}

export async function getWorkspaceAccessStateForStudio(
  studioId: string
): Promise<WorkspaceAccessState> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("studios")
    .select("subscription_status")
    .eq("id", studioId)
    .maybeSingle<StudioStatusRow>();

  if (error) {
    throw new Error(`Failed to load workspace access status: ${error.message}`);
  }

  const status = data?.subscription_status ?? null;
  const allowed = isWorkspaceAccessAllowedStatus(status);

  return {
    studioId,
    status,
    allowed,
    blocked: !allowed,
  };
}

export async function getCurrentWorkspaceAccessState(): Promise<WorkspaceAccessState> {
  const context = await getCurrentStudioContext();

  if (context.isPlatformAdmin) {
    return {
      studioId: context.studioId,
      status: "platform_admin",
      allowed: true,
      blocked: false,
    };
  }

  return getWorkspaceAccessStateForStudio(context.studioId);
}

export async function requireStudioRole(allowedRoles: string[]) {
  const context = await getCurrentStudioContext();

  if (context.isPlatformAdmin) {
    return context;
  }

  if (!context.studioRole || !allowedRoles.includes(context.studioRole)) {
    redirect("/app");
  }

  return context;
}

export async function canManageStudioSettings() {
  const context = await getCurrentStudioContext();

  if (context.isPlatformAdmin) {
    return true;
  }

  return ["studio_owner", "studio_admin"].includes(context.studioRole ?? "");
}

export async function canManageEventOperationsForStudio(studioId: string) {
  const context = await getStudioContextForStudio(studioId);

  if (context.isPlatformAdmin) {
    return true;
  }

  return [
    "studio_owner",
    "studio_admin",
    "organizer_owner",
    "organizer_admin",
  ].includes(context.studioRole ?? "");
}