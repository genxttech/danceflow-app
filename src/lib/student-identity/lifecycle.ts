import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

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
  relationship_type: string;
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
    relationship_type: "self",
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
      relationship_type: "self",
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

  if (otherLinkedClient) {
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

  const { error: clientUpdateError } = await admin
    .from("clients")
    .update({ portal_user_id: params.userId, updated_at: now })
    .eq("id", params.clientId)
    .eq("studio_id", params.studioId);

  if (clientUpdateError) {
    throw new Error(`Portal access link failed: ${clientUpdateError.message}`);
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
