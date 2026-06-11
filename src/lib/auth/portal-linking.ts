import { createAdminClient } from "@/lib/supabase/admin";

type EnsurePortalProfileAndClientLinksParams = {
  userId: string;
  email: string | null | undefined;
  fullName?: string | null;
  studioId?: string | null;
};

export async function ensurePortalProfileAndClientLinks({
  userId,
  email,
  fullName,
  studioId,
}: EnsurePortalProfileAndClientLinksParams) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";

  if (!userId || !normalizedEmail) {
    return { linkedClientIds: [] as string[] };
  }

  const admin = createAdminClient();
  const profilePayload: {
    id: string;
    email: string;
    full_name?: string | null;
    updated_at: string;
  } = {
    id: userId,
    email: normalizedEmail,
    updated_at: new Date().toISOString(),
  };

  const trimmedFullName = fullName?.trim();
  if (trimmedFullName) {
    profilePayload.full_name = trimmedFullName;
  }

  const { error: profileError } = await admin.from("profiles").upsert(profilePayload, {
    onConflict: "id",
  });

  if (profileError) {
    throw new Error(`Portal profile sync failed: ${profileError.message}`);
  }

  let linkQuery = admin
    .from("clients")
    .update({
      portal_user_id: userId,
      updated_at: new Date().toISOString(),
    })
    .ilike("email", normalizedEmail)
    .is("portal_user_id", null);

  if (studioId) {
    linkQuery = linkQuery.eq("studio_id", studioId);
  }

  const { data: linkedClients, error: clientLinkError } = await linkQuery.select("id");

  if (clientLinkError) {
    throw new Error(`Portal client link failed: ${clientLinkError.message}`);
  }

  return {
    linkedClientIds: (linkedClients ?? []).map((client) => String(client.id)),
  };
}

export function getAuthUserFullName(user: {
  user_metadata?: Record<string, unknown> | null;
}) {
  const fullName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name
        : null;

  return fullName;
}
