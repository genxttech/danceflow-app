import { canManageEventDocuments } from "@/lib/auth/permissions";

export function canManageDocumentsRole(
  role: string | null | undefined,
) {
  const value = (role ?? "").toLowerCase();

  if (["studio_owner", "studio_admin", "owner", "admin", "front_desk"].includes(value)) {
    return true;
  }

  return canManageEventDocuments(value);
}
