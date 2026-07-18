export function canManageDocumentsRole(
  role: string | null | undefined,
) {
  const value = (role ?? "").toLowerCase();

  return [
    "studio_owner",
    "studio_admin",
    "owner",
    "admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(value);
}
