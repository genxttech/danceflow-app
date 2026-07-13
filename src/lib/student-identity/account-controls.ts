import { createHash } from "node:crypto";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function leaveStudioRelationship(params: {
  user: User;
  studioId: string;
  reason?: string;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: link, error: linkError } = await admin
    .from("client_account_links")
    .select("id, client_id, studio_id, status")
    .eq("user_id", params.user.id)
    .eq("studio_id", params.studioId)
    .eq("status", "linked")
    .maybeSingle();

  if (linkError) throw new Error(`Studio relationship lookup failed: ${linkError.message}`);
  if (!link) throw new Error("This studio is not currently connected to your account.");

  const reason =
    params.reason?.trim().slice(0, 500) ||
    "Dancer left the studio from account settings.";

  const { error: linkUpdateError } = await admin
    .from("client_account_links")
    .update({
      status: "disconnected",
      disconnected_at: now,
      disconnected_by: params.user.id,
      disconnect_reason: reason,
      left_by_user_at: now,
      updated_at: now,
    })
    .eq("id", link.id)
    .eq("user_id", params.user.id)
    .eq("status", "linked");

  if (linkUpdateError) {
    throw new Error(`Studio relationship update failed: ${linkUpdateError.message}`);
  }

  const { error: clientUpdateError } = await admin
    .from("clients")
    .update({
      portal_user_id: null,
      updated_at: now,
    })
    .eq("id", link.client_id)
    .eq("studio_id", link.studio_id)
    .eq("portal_user_id", params.user.id);

  if (clientUpdateError) {
    throw new Error(`Studio portal access removal failed: ${clientUpdateError.message}`);
  }

  return { clientId: link.client_id, studioId: link.studio_id };
}

export async function deleteDanceFlowAccount(user: User) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const userReferenceHash = hash(user.id);
  const emailHash = user.email ? hash(user.email.trim().toLowerCase()) : null;

  const { data: links, error: linksError } = await admin
    .from("client_account_links")
    .select("id, client_id, studio_id, status")
    .eq("user_id", user.id);

  if (linksError) {
    throw new Error(`Account relationship lookup failed: ${linksError.message}`);
  }

  const linkedRows = links ?? [];

  const { error: clientsError } = await admin
    .from("clients")
    .update({
      portal_user_id: null,
      updated_at: now,
    })
    .eq("portal_user_id", user.id);

  if (clientsError) {
    throw new Error(`Studio portal cleanup failed: ${clientsError.message}`);
  }

  if (linkedRows.length > 0) {
    const { error: relationshipError } = await admin
      .from("client_account_links")
      .update({
        status: "disconnected",
        deleted_user_reference_hash: userReferenceHash,
        account_deleted_at: now,
        disconnected_at: now,
        disconnected_by: user.id,
        disconnect_reason: "DanceFlow account deleted by the account owner.",
        updated_at: now,
      })
      .eq("user_id", user.id);

    if (relationshipError) {
      throw new Error(`Relationship history preservation failed: ${relationshipError.message}`);
    }
  }

  const { error: auditError } = await admin.from("account_deletion_audit").insert({
    user_reference_hash: userReferenceHash,
    requested_email_hash: emailHash,
    linked_relationship_count: linkedRows.length,
    deleted_at: now,
  });

  if (auditError) {
    throw new Error(`Account deletion audit failed: ${auditError.message}`);
  }

  const { error: authDeleteError } = await admin.auth.admin.deleteUser(user.id);

  if (authDeleteError) {
    throw new Error(`DanceFlow account deletion failed: ${authDeleteError.message}`);
  }

  return {
    deleted: true,
    preservedStudioRelationshipCount: linkedRows.length,
  };
}
