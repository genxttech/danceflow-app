import { createHash } from "node:crypto";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function leaveStudioRelationship(params: {
  user: User;
  linkId: string;
  studioId: string;
  reason?: string;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: link, error: linkError } = await admin
    .from("client_account_links")
    .select("id, client_id, studio_id, status")
    .eq("id", params.linkId)
    .eq("user_id", params.user.id)
    .eq("studio_id", params.studioId)
    .eq("status", "linked")
    .maybeSingle();

  if (linkError) {
    throw new Error(`Studio relationship lookup failed: ${linkError.message}`);
  }

  if (!link) {
    throw new Error("This studio relationship is not currently connected.");
  }

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

  return {
    linkId: String(link.id),
    clientId: String(link.client_id),
    studioId: params.studioId,
  };
}

async function deleteUserRows(
  table: string,
  column: string,
  userId: string,
) {
  const admin = createAdminClient();
  const { error } = await admin.from(table).delete().eq(column, userId);

  if (error) {
    throw new Error(`Account cleanup failed for ${table}: ${error.message}`);
  }
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

  if (linkedRows.length > 0) {
    const { error: relationshipError } = await admin
      .from("client_account_links")
      .update({
        user_id: null,
        status: "disconnected",
        deleted_user_reference_hash: userReferenceHash,
        account_deleted_at: now,
        disconnected_at: now,
        disconnected_by: null,
        disconnect_reason: "DanceFlow account deleted by the account owner.",
        updated_at: now,
      })
      .eq("user_id", user.id);

    if (relationshipError) {
      throw new Error(
        `Relationship history preservation failed: ${relationshipError.message}`,
      );
    }
  }

  const { error: registrationError } = await admin
    .from("event_registrations")
    .update({ user_id: null })
    .eq("user_id", user.id);

  if (registrationError) {
    throw new Error(
      `Event registration history preservation failed: ${registrationError.message}`,
    );
  }

  const { error: legalError } = await admin
    .from("legal_agreement_acceptances")
    .update({
      user_id: null,
      user_reference_hash: userReferenceHash,
      ip_address: null,
      user_agent: null,
    })
    .eq("user_id", user.id);

  if (legalError) {
    throw new Error(
      `Legal acceptance anonymization failed: ${legalError.message}`,
    );
  }

  for (const table of [
    "mobile_push_tokens",
    "mobile_notification_log",
    "mobile_notification_preferences",
    "user_favorites",
    "dancer_partner_profiles",
    "dancer_profiles",
    "user_account_status",
  ]) {
    await deleteUserRows(table, "user_id", user.id);
  }

  await deleteUserRows("profiles", "id", user.id);

  const { error: auditError } = await admin
    .from("account_deletion_audit")
    .insert({
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
    deleted: true as const,
    preservedStudioRelationshipCount: linkedRows.length,
  };
}
