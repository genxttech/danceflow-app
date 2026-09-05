export type AppRole =
  | "platform_admin"
  | "studio_owner"
  | "studio_admin"
  | "front_desk"
  | "instructor"
  | "independent_instructor"
  | "organizer_owner"
  | "organizer_admin"
  | "organizer_staff";

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

export function isOrganizerStaff(role: string | null | undefined) {
  return role === "organizer_staff";
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
  return [
    "platform_admin",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
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


export function canManageCommerce(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role ?? "");
}

export function canSellCommerce(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canViewCommerceOrders(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canManageInstructors(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role ?? "");
}

export function canPreparePayroll(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role ?? "");
}

export function canDisbursePayroll(role: string | null | undefined) {
  return ["platform_admin", "studio_owner"].includes(role ?? "");
}

export function canManageRooms(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role ?? "");
}

export function canViewCommunications(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export function canEditClients(role: string | null | undefined) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

// FC-1B1: independent_instructor is not host-studio staff -- their host
// relationship exists only to support their own floor-rental activity, not
// general access to the studio's unrelated client roster.
//
// FC-1B5D: instructor is no longer a general CRM role either. The client
// PII containment design replaces broad instructor clients access with two
// narrow, relationship-scoped interfaces instead:
// get_teaching_clients_for_instructor (for clients they actually teach,
// field-minimized) and search_bookable_clients_for_instructor (to find any
// studio client when booking a first appointment, name-only). Neither
// depends on this function -- both are SECURITY DEFINER RPCs called
// directly, independent of canViewClients/RLS. See
// requireClientViewAccess in serverRoleGuard.ts for the enforcement point.
export function canViewClients(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
  ].includes(role ?? "");
}

// FC-1: independent_instructor is deliberately excluded from general staff
// appointment/attendance authority. SR-A found this role granted broad
// create/edit/attendance access identical to real studio staff, with the
// intended narrowing (their own floor-rental relationship only) enforced in
// just one code path -- meaning every other appointment-mutating action was
// reachable with no scoping at all. See canManageOwnFloorRentalAppointment
// below and requireFloorRentalAppointmentAccess in serverRoleGuard.ts for
// the narrow, purpose-built replacement.
export function canCreateAppointments(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
  ].includes(role ?? "");
}

export function canEditAppointments(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
  ].includes(role ?? "");
}

export function canMarkAttendance(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
  ].includes(role ?? "");
}

// FC-1B1: gates the general staff schedule-viewing surface (the appointment
// detail page and the full studio calendar), as opposed to the specific
// create/edit/attendance mutation gates above. independent_instructor is
// excluded for the same reason as those -- their host relationship is
// floor-rental-only, not general studio staff access. This is a
// read-visibility gate; it does not change who may mutate appointments
// (unaffected, see FC-1).
export function canViewStudioSchedule(role: string | null | undefined) {
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
  ].includes(role ?? "");
}

// FC-1: the narrow replacement for independent_instructor's former broad
// appointment authority. This only identifies the role -- callers must
// still verify the specific appointment is the instructor's own linked
// floor-rental relationship before allowing any mutation (see
// requireFloorRentalAppointmentAccess in serverRoleGuard.ts and its use in
// src/app/app/schedule/actions.ts).
export function canManageOwnFloorRentalAppointment(
  role: string | null | undefined,
) {
  return role === "independent_instructor";
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

export function canViewOrganizerWorkspace(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return [
    "platform_admin",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
}

export function canManageOrganizerProfile(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(
    role ?? "",
  );
}

export function canManageOrganizerTeam(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return ["platform_admin", "organizer_owner"].includes(role ?? "");
}

export function canManageOrganizers(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageOrganizerProfile(role, isPlatformAdmin);
}

export function canManageEvents(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(
    role ?? "",
  );
}

export function canManageEventTickets(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return [
    "platform_admin",
    "studio_owner",
    "studio_admin",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
}

export function canManageEventRegistrations(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageEventTickets(role, isPlatformAdmin);
}

export function canCheckInEventAttendees(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageEventTickets(role, isPlatformAdmin);
}

export function canManageOrganizerContacts(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageEventTickets(role, isPlatformAdmin);
}

export function canManageOrganizerCampaigns(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageEventTickets(role, isPlatformAdmin);
}

export function canManageEventDocuments(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageEventTickets(role, isPlatformAdmin);
}

export function canViewOrganizerFinancials(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return [
    "platform_admin",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
}

export function canExportOrganizerFinancials(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(
    role ?? "",
  );
}

export function canManageEventSettlement(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return canManageEventTickets(role, isPlatformAdmin);
}

export function canReopenEventSettlement(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(
    role ?? "",
  );
}

export function canManageOrganizerExpenses(
  role: string | null | undefined,
  isPlatformAdmin = false,
) {
  if (isPlatformAdmin) return true;
  return ["platform_admin", "organizer_owner", "organizer_admin"].includes(
    role ?? "",
  );
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
    return ["organizer_admin", "organizer_staff"].includes(targetRole);
  }

  if (actorRole === "organizer_admin") {
    return targetRole === "organizer_staff";
  }

  return false;
}