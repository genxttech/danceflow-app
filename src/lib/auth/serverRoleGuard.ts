import { createClient } from "@/lib/supabase/server";
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

export async function getCurrentUserStudioContext() {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be logged in.");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    throw new Error("No active studio membership found.");
  }

  return {
    supabase,
    user,
    studioId: roleRow.studio_id as string,
    role: roleRow.role as string,
  };
}

export async function requireClientEditAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canEditClients(ctx.role)) {
    throw new Error("You do not have permission to manage clients.");
  }
  return ctx;
}

export async function requireInstructorManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canManageInstructors(ctx.role)) {
    throw new Error("You do not have permission to manage instructors.");
  }
  return ctx;
}

export async function requireRoomManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canManageRooms(ctx.role)) {
    throw new Error("You do not have permission to manage rooms.");
  }
  return ctx;
}

export async function requirePackageManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canManagePackages(ctx.role)) {
    throw new Error("You do not have permission to manage package templates.");
  }
  return ctx;
}

export async function requirePackageSellAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canSellPackages(ctx.role)) {
    throw new Error("You do not have permission to sell packages.");
  }
  return ctx;
}

export async function requireSettingsManageAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canManageSettings(ctx.role)) {
    throw new Error("You do not have permission to manage studio settings.");
  }
  return ctx;
}

export async function requireAppointmentCreateAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canCreateAppointments(ctx.role)) {
    throw new Error("You do not have permission to create appointments.");
  }
  return ctx;
}

export async function requireAppointmentEditAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canEditAppointments(ctx.role)) {
    throw new Error("You do not have permission to edit appointments.");
  }
  return ctx;
}

export async function requireAttendanceAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canMarkAttendance(ctx.role)) {
    throw new Error("You do not have permission to mark attendance.");
  }
  return ctx;
}

export async function requireBalanceAdjustmentAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canAdjustBalances(ctx.role)) {
    throw new Error("You do not have permission to adjust package balances.");
  }
  return ctx;
}

export async function requirePaymentsViewAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canViewPayments(ctx.role)) {
    throw new Error("You do not have permission to access payments.");
  }
  return ctx;
}

export async function requireReportsAccess() {
  const ctx = await getCurrentUserStudioContext();
  if (!canViewReports(ctx.role)) {
    throw new Error("You do not have permission to access reports.");
  }
  return ctx;
}