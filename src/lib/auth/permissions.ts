export type AppRole =
  | "platform_admin"
  | "studio_owner"
  | "studio_admin"
  | "front_desk"
  | "instructor";

export function canManageSettings(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role);
}

export function canManagePackages(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role);
}

export function canSellPackages(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role);
}

export function canViewPayments(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role);
}

export function canManageInstructors(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role);
}

export function canManageRooms(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin"].includes(role);
}

export function canEditClients(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role);
}

export function canCreateAppointments(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk", "instructor"].includes(role);
}

export function canEditAppointments(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk", "instructor"].includes(role);
}

export function canMarkAttendance(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk", "instructor"].includes(role);
}

export function canAdjustBalances(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role);
}

export function canViewReports(role: string) {
  return ["platform_admin", "studio_owner", "studio_admin", "front_desk"].includes(role);
}