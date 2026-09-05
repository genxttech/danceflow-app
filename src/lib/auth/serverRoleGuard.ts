import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  canAdjustBalances,
  canCreateAppointments,
  canEditAppointments,
  canEditClients,
  canManageInstructors,
  canManageOwnFloorRentalAppointment,
  canPreparePayroll,
  canDisbursePayroll,
  canManagePackages,
  canManageRooms,
  canManageSettings,
  canMarkAttendance,
  canSellPackages,
  canViewClients,
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

// FC-1B5D: general CRM client viewing (list, detail) is restricted to
// studio_owner/studio_admin/front_desk (+ platform_admin). instructor
// access to client data is deliberately routed through the
// relationship-scoped RPCs (get_teaching_clients_for_instructor,
// search_bookable_clients_for_instructor) instead of this guard.
export async function requireClientViewAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canViewClients,
    message: "You do not have permission to view clients.",
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

export async function requirePayrollPrepareAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canPreparePayroll,
    message: "You do not have permission to prepare payroll.",
  });
}

export async function requirePayrollDisbursementAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: canDisbursePayroll,
    message: "Only the studio owner can mark payroll paid.",
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

// FC-1: gate for the small set of appointment actions that must remain
// reachable by an independent_instructor for their own floor-rental
// bookings (create/update/cancel/delete), in addition to ordinary staff.
// This only proves role-level eligibility to attempt the action -- the
// caller (src/app/app/schedule/actions.ts) still must verify, per request,
// that an independent_instructor caller is acting on their own linked
// floor-rental client/appointment, never anyone else's.
export async function requireFloorRentalAppointmentAccess() {
  const ctx = await getCurrentUserStudioContext();
  return requirePermission({
    ctx,
    allowed: (role) =>
      canCreateAppointments(role) || canManageOwnFloorRentalAppointment(role),
    message: "You do not have permission to manage this appointment.",
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