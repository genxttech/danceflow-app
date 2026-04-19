import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  canAdjustBalances,
  canCreateAppointments,
  canEditAppointments,
  canEditClients,
  canManageInstructors,
  canManagePackages,
  canManageRooms,
  canManageSettings,
  canMarkAttendance,
  canSellPackages,
  canViewPayments,
  canViewReports,
} from "@/lib/auth/permissions";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type AuthUser = Awaited<ReturnType<SupabaseServerClient["auth"]["getUser"]>>["data"]["user"];

type StudioGuardContext = {
  supabase: SupabaseServerClient;
  user: NonNullable<AuthUser>;
  studioId: string;
  studioRole: string | null;
  isPlatformAdmin: boolean;
};

export async function getCurrentUserStudioContext(): Promise<StudioGuardContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be logged in.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active studio context found.");
  }

  return {
    supabase,
    user,
    studioId: context.studioId,
    studioRole: context.studioRole ?? null,
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
  };
}

function requirePermission(params: {
  ctx: StudioGuardContext;
  allowed: (role: string) => boolean;
  message: string;
}) {
  const { ctx, allowed, message } = params;

  if (ctx.isPlatformAdmin) {
    return ctx;
  }

  if (!allowed(ctx.studioRole ?? "")) {
    throw new Error(message);
  }

  return ctx;
}

export async function requireClientEditAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canEditClients,
    message: "You do not have permission to manage clients.",
  });
}

export async function requireInstructorManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canManageInstructors,
    message: "You do not have permission to manage instructors.",
  });
}

export async function requireRoomManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canManageRooms,
    message: "You do not have permission to manage rooms.",
  });
}

export async function requirePackageManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canManagePackages,
    message: "You do not have permission to manage package templates.",
  });
}

export async function requirePackageSellAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canSellPackages,
    message: "You do not have permission to sell packages.",
  });
}

export async function requireSettingsManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canManageSettings,
    message: "You do not have permission to manage studio settings.",
  });
}

export async function requireAppointmentCreateAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canCreateAppointments,
    message: "You do not have permission to create appointments.",
  });
}

export async function requireAppointmentEditAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canEditAppointments,
    message: "You do not have permission to edit appointments.",
  });
}

export async function requireAttendanceAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canMarkAttendance,
    message: "You do not have permission to mark attendance.",
  });
}

export async function requireBalanceAdjustmentAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canAdjustBalances,
    message: "You do not have permission to adjust package balances.",
  });
}

export async function requirePaymentsViewAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canViewPayments,
    message: "You do not have permission to access payments.",
  });
}

export async function requireReportsAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canViewReports,
    message: "You do not have permission to access reports.",
  });
}