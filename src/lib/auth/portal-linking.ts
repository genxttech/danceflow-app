import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeUuidToken } from "@/lib/security/tokens";

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

export function getGroupLessonRecapTokenFromPath(
  value: string | null | undefined,
) {
  const path = value?.trim() ?? "";
  const match = path.match(GROUP_RECAP_TOKEN_PATH_PATTERN);

  return normalizeUuidToken(match?.[1] ?? null);
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
    throw new Error(
      `Group recap claim lookup failed: ${existingError.message}`,
    );
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
  const { userId } = params;
  const recapToken = normalizeUuidToken(params.recapToken ?? null);
  const normalizedEmail = params.email?.trim().toLowerCase() ?? "";

  if (!userId) {
    return { claimedCount: 0 };
  }

  const admin = createAdminClient();
  const recipientsById = new Map<
    string,
    GroupLessonRecapRecipientClaimRow
  >();

  if (recapToken) {
    const { data: tokenRecipient, error: tokenError } = await admin
      .from("group_lesson_recap_recipients")
      .select("id, recap_id, delivery_status")
      .eq("secure_token", recapToken)
      .neq("delivery_status", "revoked")
      .maybeSingle();

    if (tokenError) {
      throw new Error(
        `Group recap token claim lookup failed: ${tokenError.message}`,
      );
    }

    if (tokenRecipient) {
      recipientsById.set(
        tokenRecipient.id,
        tokenRecipient as GroupLessonRecapRecipientClaimRow,
      );
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
      throw new Error(
        `Group recap email claim lookup failed: ${emailError.message}`,
      );
    }

    for (const recipient of emailRecipients ?? []) {
      recipientsById.set(
        recipient.id,
        recipient as GroupLessonRecapRecipientClaimRow,
      );
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

function splitFullName(value: string | null | undefined) {
  const parts = value?.trim().split(/\s+/).filter(Boolean) ?? [];
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
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
  const now = new Date().toISOString();
  const names = splitFullName(fullName);

  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: userId,
      email: normalizedEmail,
      ...(fullName?.trim() ? { full_name: fullName.trim() } : {}),
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (profileError) {
    throw new Error(`Portal profile sync failed: ${profileError.message}`);
  }

  const { error: dancerProfileError } = await admin
    .from("dancer_profiles")
    .upsert(
      {
        user_id: userId,
        first_name: names.firstName,
        last_name: names.lastName,
        updated_at: now,
      },
      { onConflict: "user_id", ignoreDuplicates: true },
    );

  if (dancerProfileError) {
    throw new Error(`Dancer profile sync failed: ${dancerProfileError.message}`);
  }

  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_client_account_invitation",
    {
      p_user_id: userId,
      p_email: normalizedEmail,
      p_studio_id: studioId || null,
    },
  );

  if (claimError) {
    throw new Error(`Portal invitation claim failed: ${claimError.message}`);
  }

  const claimedClientIds = (claimed ?? []).map((item: { client_id: string }) =>
    String(item.client_id),
  );

  const { data: existingLinks, error: existingError } = await admin
    .from("client_account_links")
    .select("client_id")
    .eq("user_id", userId)
    .eq("status", "linked")
    .limit(100);

  if (existingError) {
    throw new Error(`Portal relationship lookup failed: ${existingError.message}`);
  }

  return {
    linkedClientIds: Array.from(
      new Set([
        ...claimedClientIds,
        ...(existingLinks ?? []).map((item) => String(item.client_id)),
      ]),
    ),
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
