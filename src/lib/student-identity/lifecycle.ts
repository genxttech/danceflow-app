import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

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
}) {
  const admin = createAdminClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const invite = createClientAccountInviteToken();
  const email = normalizedEmail(params.email);

  const { data: existing, error: existingError } = await admin
    .from("client_account_links")
    .select("id, user_id, status")
    .eq("client_id", params.clientId)
    .in("status", ["invited", "claim_pending"])
    .maybeSingle();

  if (existingError) {
    throw new Error(`Client invitation lookup failed: ${existingError.message}`);
  }

  const payload = {
    studio_id: params.studioId,
    client_id: params.clientId,
    user_id: params.userId ?? existing?.user_id ?? null,
    status: "invited",
    relationship_type: params.relationshipType ?? "self",
    can_view_schedule: true,
    can_view_billing: true,
    can_manage_bookings: true,
    can_sign_documents: true,
    is_primary: (params.relationshipType ?? "self") === "self",
    initiated_by: "studio",
    invited_email: email,
    invite_token_hash: invite.hash,
    invite_sent_at: now.toISOString(),
    invite_expires_at: expiresAt.toISOString(),
    rejected_at: null,
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

  if (error) throw new Error(`Client invitation save failed: ${error.message}`);

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

  const { data: client, error: clientError } = await admin
    .from("clients")
    .select("id, portal_user_id")
    .eq("id", params.clientId)
    .eq("studio_id", params.studioId)
    .single();

  if (clientError || !client) {
    throw new Error("Client record could not be found.");
  }

  if (client.portal_user_id && client.portal_user_id !== params.userId) {
    await admin.from("client_account_links").insert({
      studio_id: params.studioId,
      client_id: params.clientId,
      user_id: client.portal_user_id,
      status: "conflict",
      relationship_type: params.relationshipType ?? "self",
      can_view_schedule: true,
      can_view_billing: true,
      can_manage_bookings: true,
      can_sign_documents: true,
      is_primary: (params.relationshipType ?? "self") === "self",
      initiated_by: "studio",
      invited_email: normalizedEmail(params.invitedEmail),
      conflict_details: "The client record is already connected to a different account.",
      updated_at: now,
    });

    throw new Error("This client record is already connected to a different account.");
  }

  const { data: otherLinkedClient, error: otherError } = await admin
    .from("client_account_links")
    .select("id, client_id")
    .eq("user_id", params.userId)
    .eq("studio_id", params.studioId)
    .eq("status", "linked")
    .neq("client_id", params.clientId)
    .limit(1)
    .maybeSingle();

  if (otherError) {
    throw new Error(`Account conflict check failed: ${otherError.message}`);
  }

  if (otherLinkedClient && (params.relationshipType ?? "self") === "self") {
    await admin.from("client_account_links").upsert(
      {
        studio_id: params.studioId,
        client_id: params.clientId,
        user_id: params.userId,
        status: "conflict",
        relationship_type: "self",
        initiated_by: "studio",
        invited_email: normalizedEmail(params.invitedEmail),
        conflict_details:
          "This account is already connected to another client record in this studio.",
        updated_at: now,
      },
      { onConflict: "client_id,user_id" },
    );

    throw new Error("This account is already connected to another client in this studio.");
  }

  if ((params.relationshipType ?? "self") === "self") {
    const { error: clientUpdateError } = await admin
      .from("clients")
      .update({ portal_user_id: params.userId, updated_at: now })
      .eq("id", params.clientId)
      .eq("studio_id", params.studioId);

    if (clientUpdateError) {
      throw new Error(`Portal access link failed: ${clientUpdateError.message}`);
    }
  }

  const { error: linkError } = await admin.from("client_account_links").upsert(
    {
      studio_id: params.studioId,
      client_id: params.clientId,
      user_id: params.userId,
      status: "linked",
      relationship_type: "self",
      initiated_by: "studio",
      invited_email: normalizedEmail(params.invitedEmail),
      claimed_at: now,
      linked_at: now,
      accepted_at: now,
      disconnected_at: null,
      disconnected_by: null,
      disconnect_reason: null,
      conflict_details: null,
      updated_at: now,
    },
    { onConflict: "client_id,user_id" },
  );

  if (linkError) throw new Error(`Account relationship save failed: ${linkError.message}`);
}

export async function disconnectClientAccount(params: {
  studioId: string;
  clientId: string;
  disconnectedBy: string;
  reason: string;
  formerClient?: boolean;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const status = params.formerClient ? "former_client" : "disconnected";

  const { data: client, error: clientError } = await admin
    .from("clients")
    .select("portal_user_id")
    .eq("id", params.clientId)
    .eq("studio_id", params.studioId)
    .single();

  if (clientError || !client) throw new Error("Client record could not be found.");

  const userId = client.portal_user_id as string | null;

  if (userId) {
    const { error: linkError } = await admin
      .from("client_account_links")
      .update({
        status,
        disconnected_at: now,
        disconnected_by: params.disconnectedBy,
        disconnect_reason: params.reason,
        updated_at: now,
      })
      .eq("client_id", params.clientId)
      .eq("user_id", userId)
      .eq("status", "linked");

    if (linkError) throw new Error(`Account relationship update failed: ${linkError.message}`);
  }

  const { error: clientUpdateError } = await admin
    .from("clients")
    .update({
      portal_user_id: null,
      ...(params.formerClient ? { status: "inactive" } : {}),
      updated_at: now,
    })
    .eq("id", params.clientId)
    .eq("studio_id", params.studioId);

  if (clientUpdateError) {
    throw new Error(`Portal access removal failed: ${clientUpdateError.message}`);
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

export async function acceptClientInvitation(params: {
  token: string;
  userId: string;
  userEmail: string;
}) {
  const admin = createAdminClient();
  const invitation = await getClientInvitationByToken(params.token);
  const email = normalizedEmail(params.userEmail);
  const now = new Date().toISOString();

  if (!invitation) {
    throw new Error("invite_not_found");
  }

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

  if (
    !invitation.invitedEmail ||
    normalizedEmail(invitation.invitedEmail) !== email
  ) {
    await admin
      .from("client_account_links")
      .update({
        status: "conflict",
        user_id: params.userId,
        conflict_details:
          "The signed-in DanceFlow account email does not match the invited email.",
        updated_at: now,
      })
      .eq("id", invitation.id);

    throw new Error("invite_email_mismatch");
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
  userEmail: string;
}) {
  const admin = createAdminClient();
  const invitation = await getClientInvitationByToken(params.token);
  const email = normalizedEmail(params.userEmail);
  const now = new Date().toISOString();

  if (!invitation) throw new Error("invite_not_found");

  if (
    invitation.invitedEmail &&
    normalizedEmail(invitation.invitedEmail) !== email
  ) {
    throw new Error("invite_email_mismatch");
  }

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

  const { data: conflict, error: conflictError } = await admin
    .from("client_account_links")
    .select("id")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("status", "conflict")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conflictError || !conflict) {
    throw new Error("No unresolved account conflict was found.");
  }

  if (params.resolution === "dismiss_conflict") {
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

  await linkExistingClientAccount({
    studioId: params.studioId,
    clientId: params.clientId,
    userId: params.matchingUserId,
    invitedEmail: params.invitedEmail,
  });

  await admin
    .from("client_account_links")
    .update({
      status: "linked",
      conflict_details: null,
      linked_at: now,
      accepted_at: now,
      updated_at: now,
    })
    .eq("id", conflict.id);
}
