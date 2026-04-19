import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  isPlatformAdmin,
  requireAuthenticatedUser,
} from "./platform";

const PLATFORM_STUDIO_COOKIE = "platform_selected_studio_id";

type StudioRoleRow = {
  studio_id: string;
  role: string;
  active: boolean;
};

type StudioContext = {
  studioId: string;
  studioRole: string | null;
  isPlatformAdmin: boolean;
  userId: string;
  email: string | null;
};

async function getSelectedPlatformStudioIdFromCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(PLATFORM_STUDIO_COOKIE)?.value ?? null;
}

export async function getCurrentStudioRole() {
  const profile = await requireAuthenticatedUser();
  const supabase = await createClient();

  const { data: roleRow, error } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role, active")
    .eq("user_id", profile.id)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (error || !roleRow) {
    return null;
  }

  return roleRow as StudioRoleRow;
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
    redirect("/login");
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
  const supabase = await createClient();
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

  const { data: roleRow, error } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role, active")
    .eq("user_id", profile.id)
    .eq("studio_id", studioId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (error || !roleRow) {
    redirect("/app");
  }

  return {
    studioId,
    studioRole: roleRow.role,
    isPlatformAdmin: false,
    userId: profile.id,
    email: profile.email,
  };
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

  return ["studio_owner", "studio_admin"].includes(context.studioRole ?? "");
}