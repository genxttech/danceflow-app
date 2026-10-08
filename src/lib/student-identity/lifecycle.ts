import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePortalConnectionState } from "@/lib/student-identity/portal-connection-state";

export type ClientRelationshipType =
  | "self"
  | "guardian"
  | "parent"
  | "billing_contact"
  | "dependent_manager"
  | "dependent";

export type ClientAccountLinkStatus =
  | "unclaimed"
  | "invited"
  | "claim_pending"
  | "linked"
  | "disconnected"
  | "former_client"
  | "rejected"
  | "conflict";

export type ClientAccountLinkRecord = {
  id: string;
  studio_id: string;
  client_id: string;
  user_id: string | null;
  status: ClientAccountLinkStatus;
  relationship_type: ClientRelationshipType;
  can_view_schedule?: boolean;
  can_view_billing?: boolean;
  can_manage_bookings?: boolean;
  can_sign_documents?: boolean;
  is_primary?: boolean;
  invited_email: string | null;
  invite_sent_at: string | null;
  invite_expires_at: string | null;
  linked_at: string | null;
  disconnected_at: string | null;
  disconnect_reason: string | null;
  conflict_details: string | null;
  created_at: string;
  updated_at: string;
};

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Phase 8D -- document-signing permission written when a link row is created or reused.
 *   - a client's own account (self) always signs for itself;
 *   - a NEW non-self link (guardian, parent, billing contact, ...) gets signing only when staff explicitly grant it;
 *   - an EXISTING non-self row (e.g. an invitation being accepted) keeps its stored decision -- never rewritten.
 * Relationship type alone never grants signing authority. (The database default is also false; see
 * 20261101090000_client_account_links_signing_default.sql.)
 */
export function signingPermissionWrite(params: {
  relationshipType: ClientRelationshipType;
  isNewRow: boolean;
  explicitGrant?: boolean;
}): { can_sign_documents?: boolean } {
  if (params.relationshipType === "self") return { can_sign_documents: true };
  if (params.explicitGrant === true) return { can_sign_documents: true };
  return params.isNewRow ? { can_sign_documents: false } : {};
}

export function createClientAccountInviteToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: tokenHash(token) };
}

export async function getClientAccountLink(clientId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_account_links")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Client account link lookup failed: ${error.message}`);
  return (data as ClientAccountLinkRecord | null) ?? null;
}

export async function createOrRefreshClientInvitation(params: {
  studioId: string;
  clientId: string;
  email: string;
  userId?: string | null;
  relationshipType?: ClientRelationshipType;
  /** Phase 8D: authorized staff explicitly allow this non-self relationship to sign documents. */
  grantDocumentSigning?: boolean;
}) {
  const admin = createAdminClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const invite = createClientAccountInviteToken();
  const email = normalizedEmail(params.email);
  const requestedUserId = params.userId ?? null;

  /*
   * A client/user pair is unique across every lifecycle status, not only open
   * invitations. Look up both the current open invitation and any existing row
   * for the resolved auth user before deciding whether to insert.
   */
  const { data: existingRows, error: existingError } = await admin
    .from("client_account_links")
    .select("id, user_id, status, relationship_type, is_primary, created_at, invite_token_hash, invite_expires_at, invited_email")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .order("created_at", { ascending: false });

  if (existingError) {
    throw new Error(`Client invitation lookup failed: ${existingError.message}`);
  }

  const rows = existingRows ?? [];
  const existingForUser = requestedUserId
    ? rows.find((row) => row.user_id === requestedUserId) ?? null
    : null;
  const openInvitation =
    rows.find((row) =>
      ["invited", "claim_pending"].includes(String(row.status)),
    ) ?? null;

  // Portal / Multi-Studio H2-A: eligibility now comes from the same
  // canonical resolver the admin display uses, scoped to the resolved
  // target user -- this is the one place that decides "does this specific
  // person already have access," never the admin display's own
  // latest-row-overall answer.
  const targetUserState = resolvePortalConnectionState({
    rows: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      status: row.status,
      relationshipType: row.relationship_type,
      isPrimary: row.is_primary,
      createdAt: row.created_at,
      inviteTokenHash: row.invite_token_hash,
      inviteExpiresAt: row.invite_expires_at,
    })),
    targetUserId: requestedUserId,
  });

  if (targetUserState.kind === "linked") {
    throw new Error("This client already has portal access with that DanceFlow account.");
  }

  const existing = openInvitation ?? existingForUser;
  const relationshipType = params.relationshipType ?? "self";

  const payload = {
    studio_id: params.studioId,
    client_id: params.clientId,
    user_id: requestedUserId ?? existing?.user_id ?? null,
    status: "invited",
    relationship_type: relationshipType,
    can_view_schedule: true,
    can_view_billing: true,
    can_manage_bookings: true,
    // A reused row keeps its stored signing decision only when it is the SAME person (relationship + email); an
    // open invitation re-targeted to someone else is treated as new, so a previous grant is never carried over.
    ...signingPermissionWrite({
      relationshipType,
      isNewRow:
        !existing?.id ||
        existing.relationship_type !== relationshipType ||
        normalizedEmail(existing.invited_email ?? "") !== normalizedEmail(email),
      explicitGrant: params.grantDocumentSigning,
    }),
    is_primary: relationshipType === "self",
    initiated_by: "studio",
    invited_email: email,
    invite_token_hash: invite.hash,
    invite_sent_at: now.toISOString(),
    invite_expires_at: expiresAt.toISOString(),
    accepted_at: null,
    rejected_at: null,
    claimed_at: null,
    linked_at: null,
    conflict_details: null,
    disconnected_at: null,
    disconnected_by: null,
    disconnect_reason: null,
    updated_at: now.toISOString(),
  };

  const query = existing?.id
    ? admin.from("client_account_links").update(payload).eq("id", existing.id)
    : admin.from("client_account_links").insert(payload);

  const { data, error } = await query.select("*").single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "This client already has a portal relationship for that DanceFlow account. Refresh the client page before resending the invitation.",
      );
    }
    throw new Error(`Client invitation save failed: ${error.message}`);
  }

  return {
    link: data as ClientAccountLinkRecord,
    token: invite.token,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function linkExistingClientAccount(params: {
  studioId: string;
  clientId: string;
  userId: string;
  invitedEmail: string;
  relationshipType?: ClientRelationshipType;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const relationshipType = params.relationshipType ?? "self";

  const { data: client, error: clientError } = await admin
    .from("clients")
    .select("id")
    .eq("id", params.clientId)
    .eq("studio_id", params.studioId)
    .single();

  if (clientError || !client) {
    throw new Error("Client record could not be found.");
  }

  if (relationshipType === "self") {
    const { data: existingSelfLink, error: selfLinkError } = await admin
      .from("client_account_links")
      .select("id, user_id")
      .eq("studio_id", params.studioId)
      .eq("client_id", params.clientId)
      .eq("status", "linked")
      .eq("relationship_type", "self")
      .maybeSingle();

    if (selfLinkError) {
      throw new Error(`Client account check failed: ${selfLinkError.message}`);
    }

    if (existingSelfLink?.user_id && existingSelfLink.user_id !== params.userId) {
      await admin.from("client_account_links").insert({
        studio_id: params.studioId,
        client_id: params.clientId,
        user_id: params.userId,
        status: "conflict",
        relationship_type: "self",
        initiated_by: "studio",
        invited_email: normalizedEmail(params.invitedEmail),
        conflict_details:
          "The client record already has a different self account relationship.",
        updated_at: now,
      });

      throw new Error(
        "This client record is already connected to a different self account.",
      );
    }

    const { data: otherSelfLink, error: otherSelfError } = await admin
      .from("client_account_links")
      .select("id, client_id")
      .eq("user_id", params.userId)
      .eq("studio_id", params.studioId)
      .eq("status", "linked")
      .eq("relationship_type", "self")
      .neq("client_id", params.clientId)
      .limit(1)
      .maybeSingle();

    if (otherSelfError) {
      throw new Error(`Account conflict check failed: ${otherSelfError.message}`);
    }

    if (otherSelfLink) {
      await admin.from("client_account_links").insert({
        studio_id: params.studioId,
        client_id: params.clientId,
        user_id: params.userId,
        status: "conflict",
        relationship_type: "self",
        initiated_by: "studio",
        invited_email: normalizedEmail(params.invitedEmail),
        conflict_details:
          "This account already has a self relationship with another client in this studio.",
        updated_at: now,
      });

      throw new Error(
        "This account is already connected to another self client in this studio.",
      );
    }
  }

  const { data: relationshipRows, error: existingLinkError } = await admin
    .from("client_account_links")
    .select("id, user_id, status, relationship_type, invited_email, created_at")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("relationship_type", relationshipType)
    .order("created_at", { ascending: false });

  if (existingLinkError) {
    throw new Error(`Account relationship lookup failed: ${existingLinkError.message}`);
  }

  // GC-3.4B-0: a row issued to a DIFFERENT email is a distinct staff intent
  // (e.g. another parent's guardian invitation) and is never taken over.
  const linkEmail = normalizedEmail(params.invitedEmail);
  const sameIntentEmail = (row: { invited_email?: string | null }) =>
    !row.invited_email || normalizedEmail(row.invited_email) === linkEmail;

  const exactUserLink =
    (relationshipRows ?? []).find((row) => row.user_id === params.userId) ?? null;
  const reusableInvitation =
    (relationshipRows ?? []).find(
      (row) =>
        !row.user_id &&
        sameIntentEmail(row) &&
        ["unclaimed", "invited", "claim_pending", "conflict", "rejected", "disconnected"].includes(
          String(row.status),
        ),
    ) ?? null;
  const existingLink = exactUserLink ?? reusableInvitation;

  const payload = {
    studio_id: params.studioId,
    client_id: params.clientId,
    user_id: params.userId,
    status: "linked",
    relationship_type: relationshipType,
    can_view_schedule: true,
    can_view_billing: true,
    can_manage_bookings: true,
    ...signingPermissionWrite({ relationshipType, isNewRow: !existingLink?.id }),
    is_primary: relationshipType === "self",
    initiated_by: "studio",
    invited_email: normalizedEmail(params.invitedEmail),
    claimed_at: now,
    linked_at: now,
    accepted_at: now,
    disconnected_at: null,
    disconnected_by: null,
    disconnect_reason: null,
    conflict_details: null,
    // A reused invitation row's token is spent once the row is linked.
    invite_token_hash: null,
    invite_expires_at: null,
    updated_at: now,
  };

  const { error: linkError } = existingLink?.id
    ? await admin
        .from("client_account_links")
        .update(payload)
        .eq("id", existingLink.id)
        .eq("studio_id", params.studioId)
        .eq("client_id", params.clientId)
    : await admin.from("client_account_links").insert(payload);

  if (linkError) {
    throw new Error(`Account relationship save failed: ${linkError.message}`);
  }

  // GC-3.4B-0: retire only open invitations for this same intent (same
  // relationship type, and for non-self the same invited email; a client has
  // at most one self account, so any open self invitation is moot). A distinct
  // staff-issued invitation -- e.g. the client's own self invitation while a
  // guardian is linked -- keeps its token.
  const canonicalLinkId = existingLink?.id ?? null;
  const staleInvitationIds = (relationshipRows ?? [])
    .filter(
      (row) =>
        row.id !== canonicalLinkId &&
        ["invited", "claim_pending"].includes(String(row.status)) &&
        (relationshipType === "self" || sameIntentEmail(row)),
    )
    .map((row) => String(row.id));

  const { error: staleInviteError } = staleInvitationIds.length
    ? await admin
        .from("client_account_links")
        .update({
          invite_token_hash: null,
          invite_expires_at: null,
          updated_at: now,
        })
        .eq("studio_id", params.studioId)
        .eq("client_id", params.clientId)
        .in("status", ["invited", "claim_pending"])
        .in("id", staleInvitationIds)
    : { error: null };
  if (staleInviteError) {
    console.error(
      "Linked client account, but stale invitation cleanup failed:",
      staleInviteError.message,
    );
  }
}

export async function disconnectClientAccount(params: {
  studioId: string;
  clientId: string;
  disconnectedBy: string;
  reason: string;
  formerClient?: boolean;
  userId?: string | null;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const status = params.formerClient ? "former_client" : "disconnected";

  let query = admin
    .from("client_account_links")
    .update({
      status,
      disconnected_at: now,
      disconnected_by: params.disconnectedBy || null,
      disconnect_reason: params.reason,
      updated_at: now,
    })
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("status", "linked");

  if (params.userId) {
    query = query.eq("user_id", params.userId);
  }

  const { data: disconnectedLinks, error: linkError } = await query.select("user_id");
  if (linkError) {
    throw new Error(`Account relationship update failed: ${linkError.message}`);
  }

  // H2-B3: clear the legacy clients.portal_user_id mirror for exactly the
  // relationship(s) just disconnected above -- never for a client whose
  // mirror belongs to a different user than the one actually disconnected
  // here. Scoped to the exact user_id(s) the update itself just touched
  // (not merely params.userId, which callers may omit), and to this exact
  // client/studio.
  const disconnectedUserIds = Array.from(
    new Set(
      (disconnectedLinks ?? [])
        .map((link) => link.user_id)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  );

  for (const disconnectedUserId of disconnectedUserIds) {
    const { error: mirrorError } = await admin
      .from("clients")
      .update({ portal_user_id: null, updated_at: now })
      .eq("id", params.clientId)
      .eq("studio_id", params.studioId)
      .eq("portal_user_id", disconnectedUserId);

    if (mirrorError) {
      throw new Error(`Legacy portal mirror cleanup failed: ${mirrorError.message}`);
    }
  }

  if (params.formerClient) {
    const { error: clientUpdateError } = await admin
      .from("clients")
      .update({
        status: "inactive",
        updated_at: now,
      })
      .eq("id", params.clientId)
      .eq("studio_id", params.studioId);

    if (clientUpdateError) {
      throw new Error(`Former-client update failed: ${clientUpdateError.message}`);
    }
  }
}


export type ClientInvitationView = {
  id: string;
  studioId: string;
  clientId: string;
  status: ClientAccountLinkStatus;
  invitedEmail: string | null;
  inviteExpiresAt: string | null;
  studioName: string;
  studioSlug: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  conflictDetails: string | null;
  relationshipType: ClientRelationshipType;
};

export async function getClientInvitationByToken(
  token: string,
): Promise<ClientInvitationView | null> {
  const admin = createAdminClient();
  const hash = tokenHash(token);

  const { data, error } = await admin
    .from("client_account_links")
    .select(`
      id,
      studio_id,
      client_id,
      status,
      invited_email,
      invite_expires_at,
      conflict_details,
      relationship_type,
      studios (
        name,
        public_name,
        slug
      ),
      clients (
        first_name,
        last_name
      )
    `)
    .eq("invite_token_hash", hash)
    .maybeSingle();

  if (error) {
    throw new Error(`Invitation lookup failed: ${error.message}`);
  }

  if (!data) return null;

  const studio = Array.isArray(data.studios) ? data.studios[0] : data.studios;
  const client = Array.isArray(data.clients) ? data.clients[0] : data.clients;

  return {
    id: data.id,
    studioId: data.studio_id,
    clientId: data.client_id,
    status: data.status as ClientAccountLinkStatus,
    invitedEmail: data.invited_email,
    inviteExpiresAt: data.invite_expires_at,
    studioName: studio?.public_name?.trim() || studio?.name || "DanceFlow studio",
    studioSlug: studio?.slug ?? null,
    clientFirstName: client?.first_name ?? null,
    clientLastName: client?.last_name ?? null,
    conflictDetails: data.conflict_details ?? null,
    relationshipType: data.relationship_type as ClientRelationshipType,
  };
}

/*
 * GC-3.4B-0: who may act on a client invitation. Proof is the strong invite
 * token PLUS the caller session's canonical verified email
 * (getMyVerifiedEmail -> public.my_verified_email()) equal to the invited
 * email. user.email alone is never identity evidence. Anything else is a
 * refusal that writes nothing and reveals no invitation detail.
 */
export type ClientInvitationIdentity = "verified_match" | "verification_required" | "mismatch";

export function clientInvitationIdentity(
  invitedEmail: string | null | undefined,
  verifiedEmail: string | null | undefined,
): ClientInvitationIdentity {
  const invited = invitedEmail?.trim().toLowerCase() ?? "";
  const verified = verifiedEmail?.trim().toLowerCase() ?? "";
  if (!verified) return "verification_required";
  if (!invited || invited !== verified) return "mismatch";
  return "verified_match";
}

function assertClientInvitationIdentity(
  invitation: ClientInvitationView,
  verifiedEmail: string | null,
) {
  const identity = clientInvitationIdentity(invitation.invitedEmail, verifiedEmail);
  if (identity === "verification_required") throw new Error("invite_verification_required");
  if (identity === "mismatch") throw new Error("invite_email_mismatch");
}

export async function acceptClientInvitation(params: {
  token: string;
  userId: string;
  /** The caller session's verified email (getMyVerifiedEmail); never user.email. */
  verifiedEmail: string | null;
}) {
  const admin = createAdminClient();
  const invitation = await getClientInvitationByToken(params.token);
  const now = new Date().toISOString();

  if (!invitation) {
    throw new Error("invite_not_found");
  }

  // GC-3.4B-0 (S2/S3): identity is decided before any status branch or write.
  // A mismatched or unverified caller changes nothing: no user_id, no
  // conflict transition, no token change.
  assertClientInvitationIdentity(invitation, params.verifiedEmail);
  const email = normalizedEmail(params.verifiedEmail ?? "");

  if (!["invited", "claim_pending"].includes(invitation.status)) {
    if (invitation.status === "linked") return invitation;
    throw new Error(`invite_${invitation.status}`);
  }

  if (
    invitation.inviteExpiresAt &&
    new Date(invitation.inviteExpiresAt).getTime() <= Date.now()
  ) {
    await admin
      .from("client_account_links")
      .update({
        status: "rejected",
        rejected_at: now,
        conflict_details: "Invitation expired before acceptance.",
        updated_at: now,
      })
      .eq("id", invitation.id);

    throw new Error("invite_expired");
  }

  try {
    await linkExistingClientAccount({
      studioId: invitation.studioId,
      clientId: invitation.clientId,
      userId: params.userId,
      invitedEmail: email,
      relationshipType: invitation.relationshipType,
    });
  } catch (error) {
    const details =
      error instanceof Error ? error.message : "Account relationship conflict.";

    // The caller is the verified invitee here. The conflict row is only a
    // staff review signal: resolveClientAccountConflict never promotes it.
    await admin
      .from("client_account_links")
      .update({
        status: "conflict",
        user_id: params.userId,
        conflict_details: details,
        updated_at: now,
      })
      .eq("id", invitation.id);

    throw new Error("invite_conflict");
  }

  await admin
    .from("client_account_links")
    .update({
      invite_token_hash: null,
      invite_expires_at: null,
      updated_at: now,
    })
    .eq("id", invitation.id);

  return invitation;
}

export async function rejectClientInvitation(params: {
  token: string;
  userId: string;
  /** The caller session's verified email (getMyVerifiedEmail); never user.email. */
  verifiedEmail: string | null;
}) {
  const admin = createAdminClient();
  const invitation = await getClientInvitationByToken(params.token);
  const now = new Date().toISOString();

  if (!invitation) throw new Error("invite_not_found");

  // GC-3.4B-0: rejecting is a write too; same verified-identity requirement.
  assertClientInvitationIdentity(invitation, params.verifiedEmail);

  const { error } = await admin
    .from("client_account_links")
    .update({
      user_id: params.userId,
      status: "rejected",
      rejected_at: now,
      invite_token_hash: null,
      invite_expires_at: null,
      updated_at: now,
    })
    .eq("id", invitation.id)
    .in("status", ["invited", "claim_pending"]);

  if (error) {
    throw new Error(`Invitation rejection failed: ${error.message}`);
  }

  return invitation;
}

export async function resolveClientAccountConflict(params: {
  studioId: string;
  clientId: string;
  resolution: "link_matching_account" | "dismiss_conflict";
  matchingUserId?: string | null;
  invitedEmail: string;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: conflictRows, error: conflictError } = await admin
    .from("client_account_links")
    .select("id, relationship_type, invited_email")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("status", "conflict")
    .order("updated_at", { ascending: false });

  const conflicts = (conflictRows ?? []) as Array<{
    id: string;
    relationship_type: string | null;
    invited_email: string | null;
  }>;

  if (conflictError || !conflicts.length) {
    throw new Error("No unresolved account conflict was found.");
  }

  if (params.resolution === "dismiss_conflict") {
    const conflict = conflicts[0];
    const { error } = await admin
      .from("client_account_links")
      .update({
        status: "disconnected",
        disconnected_at: now,
        disconnect_reason: "Conflict dismissed by studio staff.",
        conflict_details: null,
        updated_at: now,
      })
      .eq("id", conflict.id);

    if (error) throw new Error(`Conflict dismissal failed: ${error.message}`);
    return;
  }

  if (!params.matchingUserId) {
    throw new Error("No matching DanceFlow account is available to link.");
  }

  // GC-3.4B-0 (S1): the matching account is the verified owner of
  // params.invitedEmail (the caller checks verified_email_for_user), so only a
  // conflict issued to that same email can be resolved by linking it. A
  // conflict for a different email (e.g. another parent's invitation) is a
  // separate staff intent and is left untouched.
  const matchingEmail = normalizedEmail(params.invitedEmail);
  const conflict = conflicts.find(
    (row) => normalizedEmail(row.invited_email ?? "") === matchingEmail,
  );

  if (!matchingEmail || !conflict) {
    throw new Error("No unresolved account conflict was found for this client's email.");
  }

  const relationshipType =
    (conflict.relationship_type as ClientRelationshipType | null) ?? "self";

  // Only the verified matching account is linked, with the relationship type
  // staff originally issued. A conflict row is never promoted to 'linked': it
  // may carry a different (mismatched) account's user_id, and promoting it
  // would grant that account access.
  await linkExistingClientAccount({
    studioId: params.studioId,
    clientId: params.clientId,
    userId: params.matchingUserId,
    invitedEmail: params.invitedEmail,
    relationshipType,
  });

  // Supersede only the conflict rows for this same intent (same invited email
  // and relationship type): they are now satisfied, and their invite tokens
  // must stop working. Conflicts for other emails or relationship types stay
  // for separate staff review. (A row that already belonged to the matching
  // account was relinked in place and is no longer 'conflict'.)
  const sameIntentIds = conflicts
    .filter(
      (row) =>
        normalizedEmail(row.invited_email ?? "") === matchingEmail &&
        ((row.relationship_type as ClientRelationshipType | null) ?? "self") === relationshipType,
    )
    .map((row) => row.id);

  const { error: supersedeError } = await admin
    .from("client_account_links")
    .update({
      status: "disconnected",
      disconnected_at: now,
      disconnect_reason: "Conflict superseded by studio staff resolution.",
      conflict_details: null,
      invite_token_hash: null,
      invite_expires_at: null,
      updated_at: now,
    })
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("status", "conflict")
    .in("id", sameIntentIds);

  if (supersedeError) {
    throw new Error(`Conflict supersession failed: ${supersedeError.message}`);
  }
}
