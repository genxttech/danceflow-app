import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeUuidToken } from "@/lib/security/tokens";
import { reactivateDanceFlowAccount } from "@/lib/student-identity/account-security";
import { portalClientPath } from "@/lib/student-identity/portal-context";

export const PORTAL_SELECTED_STUDIO_COOKIE = "portal_selected_studio_id";

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

  const {
    data: { user },
    error: userLookupError,
  } = await admin.auth.admin.getUserById(userId);

  if (userLookupError || !user) {
    throw new Error("DanceFlow account could not be loaded.");
  }

  await reactivateDanceFlowAccount(user);

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


function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

// H3: a portal user can hold simultaneous `linked` client_account_links rows
// across multiple different studios (H2-B2 RLS already assumes and supports
// this). The routing decision unit is a *studio*, not a raw linked row --
// multiple rows within the same studio (self + guardian) are not ambiguous
// for login routing, since resolvePortalRelationship()/the `?client=` param
// already resolve that once inside a studio. Only multiple distinct studios
// are a genuine login-time choice.
export type PortalDestinationRow = {
  studioId: string;
  studioSlug: string;
  studioName: string | null;
  studioPublicName: string | null;
  clientId: string;
  relationshipType: string;
  isPrimary: boolean;
  createdAt: string;
  isIndependentInstructor: boolean;
};

type RawLinkedDestinationRow = {
  client_id: string;
  studio_id: string;
  relationship_type: string;
  is_primary: boolean | null;
  created_at: string;
  studios:
    | { slug: string | null; name: string | null; public_name: string | null }
    | { slug: string | null; name: string | null; public_name: string | null }[]
    | null;
  clients:
    | { is_independent_instructor: boolean | null }
    | { is_independent_instructor: boolean | null }[]
    | null;
};

/**
 * Fetches every currently-`linked` client_account_links row for a user,
 * across every studio, with no `.limit()` and no DB-side ordering -- the
 * tie-break (is_primary desc, created_at asc) is applied explicitly in JS
 * by pickRepresentativeRow/decidePortalDestination/resolveDestinationForStudio
 * below, so it behaves identically against a real Postgres multi-column
 * ORDER BY and against a single-column-only test fake.
 */
export async function listLinkedPortalDestinations(
  userId: string,
): Promise<PortalDestinationRow[]> {
  if (!userId) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_account_links")
    .select(`
      client_id,
      studio_id,
      relationship_type,
      is_primary,
      created_at,
      studios (
        slug,
        name,
        public_name
      ),
      clients (
        is_independent_instructor
      )
    `)
    .eq("user_id", userId)
    .eq("status", "linked");

  if (error || !data) return [];

  return (data as RawLinkedDestinationRow[])
    .map((row) => {
      const studio = firstRelation(row.studios);
      const client = firstRelation(row.clients);
      if (!studio?.slug) return null;

      return {
        studioId: row.studio_id,
        studioSlug: studio.slug,
        studioName: studio.name,
        studioPublicName: studio.public_name,
        clientId: row.client_id,
        relationshipType: row.relationship_type,
        isPrimary: row.is_primary === true,
        createdAt: row.created_at,
        isIndependentInstructor: client?.is_independent_instructor === true,
      } satisfies PortalDestinationRow;
    })
    .filter((row): row is PortalDestinationRow => row !== null);
}

// Primary before non-primary; otherwise oldest first -- matches
// byLinkedPrecedence in portal-connection-state.ts (itself documented as
// matching resolvePortalRelationship's order("is_primary", desc).order(
// "created_at", asc)) exactly, including comparing createdAt as parsed
// numeric timestamps rather than raw ISO strings.
function pickRepresentativeRow(rows: PortalDestinationRow[]): PortalDestinationRow {
  return [...rows].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  })[0];
}

export type PortalStudioOption = {
  studioId: string;
  studioSlug: string;
  studioName: string | null;
  studioPublicName: string | null;
  isIndependentInstructor: boolean;
};

export type PortalRoutingDecision =
  | { type: "none" }
  | { type: "single"; path: string }
  | { type: "multiple"; options: PortalStudioOption[] };

/**
 * Pure decision function -- no I/O. Groups rows by studioId (the H3
 * decision unit) and decides whether to auto-route or hand back to the
 * caller a list of options for /portal/choose to render. A remembered
 * studio is only ever used as a hint here; the caller (resolveDestinationForStudio)
 * still re-derives the actual destination from the fresh rows, never trusts
 * the hint's shape directly.
 */
export function decidePortalDestination(
  rows: PortalDestinationRow[],
  rememberedStudioId: string | null,
): PortalRoutingDecision {
  if (!rows.length) return { type: "none" };

  const studioIds = Array.from(new Set(rows.map((row) => row.studioId)));

  if (studioIds.length === 1) {
    const destination = resolveDestinationForStudio(rows, studioIds[0]);
    return destination ? { type: "single", path: destination.path } : { type: "none" };
  }

  if (rememberedStudioId && studioIds.includes(rememberedStudioId)) {
    const destination = resolveDestinationForStudio(rows, rememberedStudioId);
    if (destination) return { type: "single", path: destination.path };
  }

  return {
    type: "multiple",
    options: studioIds.map((studioId) => {
      const rep = pickRepresentativeRow(rows.filter((row) => row.studioId === studioId));
      return {
        studioId,
        studioSlug: rep.studioSlug,
        studioName: rep.studioName,
        studioPublicName: rep.studioPublicName,
        isIndependentInstructor: rep.isIndependentInstructor,
      } satisfies PortalStudioOption;
    }),
  };
}

/**
 * Derives the representative (studioId, clientId, path) for exactly one
 * studio from a fresh set of rows -- used both by decidePortalDestination's
 * auto-route paths and by choosePortalDestinationAction (H3's chooser) to
 * turn a validated studioId into the same deterministic destination
 * automatic routing would have produced. Returns null if the given
 * studioId isn't present among the (already-fresh, already-user-scoped)
 * rows -- callers must treat that as "not a valid choice", never fall back
 * to guessing.
 */
export function resolveDestinationForStudio(
  rows: PortalDestinationRow[],
  studioId: string,
): { studioId: string; clientId: string; path: string } | null {
  const studioRows = rows.filter((row) => row.studioId === studioId);
  if (!studioRows.length) return null;

  const rep = pickRepresentativeRow(studioRows);
  return {
    studioId,
    clientId: rep.clientId,
    path: portalClientPath(rep.studioSlug, rep.clientId),
  };
}

export async function getLinkedClientIdsForUser(params: {
  userId: string;
  studioId?: string | null;
}) {
  const admin = createAdminClient();
  let query = admin
    .from("client_account_links")
    .select("client_id")
    .eq("user_id", params.userId)
    .eq("status", "linked");

  if (params.studioId) {
    query = query.eq("studio_id", params.studioId);
  }

  const { data, error } = await query.limit(250);
  if (error) {
    throw new Error(`Portal relationship lookup failed: ${error.message}`);
  }

  return Array.from(
    new Set((data ?? []).map((item) => String(item.client_id))),
  );
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
