import { createAdminClient } from "@/lib/supabase/admin";

const GROUP_RECAP_TOKEN_PATH_PATTERN =
  /^\/recaps\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[/?#]|$)/i;

type EnsurePortalProfileAndClientLinksParams = {
  userId: string;
  email: string | null | undefined;
  fullName?: string | null;
  studioId?: string | null;
};

type GroupLessonRecapRecipientClaimRow = {
  id: string;
  recap_id: string;
  delivery_status: string;
};

export function getGroupLessonRecapTokenFromPath(value: string | null | undefined) {
  const path = value?.trim() ?? "";
  const match = path.match(GROUP_RECAP_TOKEN_PATH_PATTERN);

  return match?.[1] ?? null;
}

async function claimGroupLessonRecapRecipient(params: {
  admin: ReturnType<typeof createAdminClient>;
  recipient: GroupLessonRecapRecipientClaimRow;
  userId: string;
}) {
  const { admin, recipient, userId } = params;

  const { data: existingRecipient, error: existingError } = await admin
    .from("group_lesson_recap_recipients")
    .select("id")
    .eq("recap_id", recipient.recap_id)
    .eq("user_id", userId)
    .neq("id", recipient.id)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Group recap claim lookup failed: ${existingError.message}`);
  }

  const payload: {
    delivery_status: string;
    user_id?: string;
  } = {
    delivery_status: "claimed",
  };

  if (!existingRecipient) {
    payload.user_id = userId;
  }

  const { error } = await admin
    .from("group_lesson_recap_recipients")
    .update(payload)
    .eq("id", recipient.id)
    .neq("delivery_status", "revoked");

  if (error) {
    throw new Error(`Group recap claim failed: ${error.message}`);
  }
}

export async function claimGroupLessonRecapsForUser(params: {
  userId: string;
  email: string | null | undefined;
  recapToken?: string | null;
}) {
  const { userId, recapToken } = params;
  const normalizedEmail = params.email?.trim().toLowerCase() ?? "";

  if (!userId) {
    return { claimedCount: 0 };
  }

  const admin = createAdminClient();
  const recipientsById = new Map<string, GroupLessonRecapRecipientClaimRow>();

  if (recapToken) {
    const { data: tokenRecipient, error: tokenError } = await admin
      .from("group_lesson_recap_recipients")
      .select("id, recap_id, delivery_status")
      .eq("secure_token", recapToken)
      .neq("delivery_status", "revoked")
      .maybeSingle();

    if (tokenError) {
      throw new Error(`Group recap token claim lookup failed: ${tokenError.message}`);
    }

    if (tokenRecipient) {
      recipientsById.set(tokenRecipient.id, tokenRecipient as GroupLessonRecapRecipientClaimRow);
    }
  }

  if (normalizedEmail) {
    const { data: emailRecipients, error: emailError } = await admin
      .from("group_lesson_recap_recipients")
      .select("id, recap_id, delivery_status")
      .ilike("guest_email", normalizedEmail)
      .neq("delivery_status", "revoked")
      .limit(50);

    if (emailError) {
      throw new Error(`Group recap email claim lookup failed: ${emailError.message}`);
    }

    for (const recipient of emailRecipients ?? []) {
      recipientsById.set(recipient.id, recipient as GroupLessonRecapRecipientClaimRow);
    }
  }

  let claimedCount = 0;

  for (const recipient of recipientsById.values()) {
    await claimGroupLessonRecapRecipient({
      admin,
      recipient,
      userId,
    });
    claimedCount += 1;
  }

  return { claimedCount };
}

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
