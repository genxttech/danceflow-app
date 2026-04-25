export type AppRole =
  | "platform_admin"
  | "studio_owner"
  | "studio_admin"
  | "front_desk"
  | "instructor"
  | "independent_instructor"
  | "organizer_owner"
  | "organizer_admin";

export type ExportPermissionKey =
  | "export_clients"
  | "export_financials"
  | "export_schedule"
  | "export_events"
  | "export_reports";

export function isPlatformAdmin(role: string | null | undefined) {
  return role === "platform_admin";
}

export function isStudioOwner(role: string | null | undefined) {
  return role === "studio_owner";
}

export function isStudioAdmin(role: string | null | undefined) {
  return role === "studio_admin";
}

export function isOrganizerOwner(role: string | null | undefined) {
  return role === "organizer_owner";
}

export function isOrganizerAdmin(role: string | null | undefined) {
  return role === "organizer_admin";
}

export function isFrontDesk(role: string | null | undefined) {
  return role === "front_desk";
}

export function isInstructor(role: string | null | undefined) {
  return role === "instructor";
}

export function isIndependentInstructor(role: string | null | undefined) {
  return role === "independent_instructor";
}

export function isStudioWorkspaceRole(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ].includes(role ?? "");
}

export function isOrganizerWorkspaceRole(role: string | null | undefined) {
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

export function canManageSettings(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "organizer_owner",
    "organizer_admin",
  ].includes(role ?? "");
}

export function canManageBilling(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "organizer_owner"].includes(role ?? "");
}

export function canManagePayouts(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "organizer_owner"].includes(role ?? "");
}

export function canManagePackages(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canSellPackages(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canManageMemberships(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canSellMemberships(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canViewPayments(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canTakePayments(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canManageInstructors(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role ?? "");
}

export function canManageRooms(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role ?? "");
}

export function canEditClients(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canViewClients(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ].includes(role ?? "");
}

export function canCreateAppointments(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ].includes(role ?? "");
}

export function canEditAppointments(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ].includes(role ?? "");
}

export function canMarkAttendance(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ].includes(role ?? "");
}

export function canAdjustBalances(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canViewReports(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
  ].includes(role ?? "");
}

export function canManageOrganizers(role: string | null | undefined) {
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

export function canManageEvents(role: string | null | undefined) {
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

export function canManageEventRegistrations(role: string | null | undefined) {
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

export function canCheckInEventAttendees(role: string | null | undefined) {
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

export function canAssignRoles(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "organizer_owner"].includes(role ?? "");
}

export function canTransferOwnership(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "organizer_owner"].includes(role ?? "");
}

export function canDeleteWorkspace(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "organizer_owner"].includes(role ?? "");
}

export function canManageSensitiveSettings(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "organizer_owner"].includes(role ?? "");
}

export function hasDefaultExportPermission(
  role: string | null | undefined,
  permission: ExportPermissionKey
) {
  if (role === "platform_admin") return true;

  if (role === "studio_owner" || role === "organizer_owner") return true;

  if (role === "studio_admin") {
    return permission === "export_reports";
  }

  if (role === "organizer_admin") {
    return permission === "export_reports" || permission === "export_events";
  }

  return false;
}

export function canExportWithOverride(args: {
  role: string | null | undefined;
  permission: ExportPermissionKey;
  overrideAllowed?: boolean | null;
}) {
  const { role, permission, overrideAllowed } = args;

  if (hasDefaultExportPermission(role, permission)) {
    return true;
  }

  return overrideAllowed === true;
}

export function canAssignTargetRole(args: {
  actorRole: string | null | undefined;
  targetRole: AppRole;
}) {
  const { actorRole, targetRole } = args;

  if (actorRole === "platform_admin") return true;

  if (actorRole === "studio_owner") {
    return [
      "studio_admin",
      "front_desk",
      "instructor",
      "independent_instructor",
    ].includes(targetRole);
  }

  if (actorRole === "organizer_owner") {
    return ["organizer_admin"].includes(targetRole);
  }

  return false;
}