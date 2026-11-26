import { createHash } from "node:crypto";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { AccountFilesDeletionError, purgeOwnPartnerPhotos } from "@/lib/student-identity/account-files";

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

  // H2-B3: clear the legacy clients.portal_user_id mirror for exactly this
  // client, only if it still points at the user who just left -- never a
  // different user's mirror.
  const { error: mirrorError } = await admin
    .from("clients")
    .update({ portal_user_id: null, updated_at: now })
    .eq("id", link.client_id)
    .eq("studio_id", params.studioId)
    .eq("portal_user_id", params.user.id);

  if (mirrorError) {
    throw new Error(`Legacy portal mirror cleanup failed: ${mirrorError.message}`);
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

/**
 * Self-service deletion removes the login itself (auth user + profiles row), and
 * user_studio_roles / profiles cascade on that delete. A login that also runs a
 * studio, an organizer account or the platform would silently lose that access
 * and could leave a studio without its owner, so self-service deletion refuses it.
 */
export class AccountDeletionBlockedError extends Error {
  constructor(readonly reasons: Array<"studio_role" | "organizer_role" | "platform_admin">) {
    super(
      "This login also manages a studio, an organizer account or the platform, so it can't be deleted here. Hand over or remove those roles first, or contact DanceFlow support.",
    );
    this.name = "AccountDeletionBlockedError";
  }
}

export async function managedAccessBlockingDeletion(userId: string) {
  const admin = createAdminClient();
  const [studioRoles, organizerRoles, profile] = await Promise.all([
    admin.from("user_studio_roles").select("id").eq("user_id", userId).eq("active", true).limit(1),
    admin.from("organizer_users").select("id").eq("user_id", userId).eq("active", true).limit(1),
    admin.from("profiles").select("platform_role").eq("id", userId).limit(1),
  ]);

  for (const result of [studioRoles, organizerRoles, profile]) {
    if (result.error) {
      throw new Error(`Account role check failed: ${result.error.message}`);
    }
  }

  const reasons: AccountDeletionBlockedError["reasons"] = [];
  if ((studioRoles.data ?? []).length > 0) reasons.push("studio_role");
  if ((organizerRoles.data ?? []).length > 0) reasons.push("organizer_role");
  const platformRole = (profile.data as Array<{ platform_role?: string | null }> | null)?.[0]?.platform_role;
  if (platformRole === "platform_admin") reasons.push("platform_admin");
  return reasons;
}

/** The listing leaves public view first, so a deletion that stops at the files never leaves it showing a half-removed photo. */
async function archivePartnerListing(userId: string, now: string) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("dancer_partner_profiles")
    .update({ visibility: "archived", updated_at: now })
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Partner listing cleanup failed: ${error.message}`);
  }
}

const SECOND_PASS_BUDGET_MS = 8_000;

/** True only when the auth server says this login no longer exists. */
async function loginIsGone(userId: string) {
  const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
  if (error) return error.status === 404 || error.code === "user_not_found";
  return !data?.user;
}

/**
 * Deletes the account. Safe to call again after an interruption, and safe when two requests run at once: if a step fails because another
 * request has already removed the login, the deletion is reported as done.
 */
export async function deleteDanceFlowAccount(user: User) {
  try {
    return await runAccountDeletion(user);
  } catch (error) {
    if (error instanceof AccountDeletionBlockedError || !(await loginIsGone(user.id))) throw error;
    await secondFilePass(user.id, hash(user.id));
    return { deleted: true as const, preservedStudioRelationshipCount: 0 };
  }
}

/** A second pass catches a file added while the deletion ran. The account is already gone, so a failure is recorded for follow-up
 *  (account reference hash and counts only) and does not report the deletion as failed. */
async function secondFilePass(userId: string, userReferenceHash: string) {
  try {
    // Shorter than the first pass: the request should not hit its time limit before a failure is recorded.
    const late = await purgeOwnPartnerPhotos(userId, { budgetMs: SECOND_PASS_BUDGET_MS });
    if (late > 0) {
      console.warn("Account deletion: files added during deletion were removed", { userReferenceHash, removed: late });
    }
  } catch (error) {
    console.error("Account deletion: second file pass failed, follow up needed", {
      userReferenceHash,
      code: error instanceof AccountFilesDeletionError ? error.code : "unexpected",
      removed: error instanceof AccountFilesDeletionError ? error.removed : 0,
    });
  }
}

async function runAccountDeletion(user: User) {
  const blockingRoles = await managedAccessBlockingDeletion(user.id);
  if (blockingRoles.length > 0) {
    throw new AccountDeletionBlockedError(blockingRoles);
  }

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

  // Before the account is marked for deletion: if the files cannot be removed, the account stays usable and the owner can try again.
  await archivePartnerListing(user.id, now);
  await purgeOwnPartnerPhotos(user.id);

  const { error: pendingDeletionError } = await admin
    .from("user_account_status")
    .upsert(
      {
        user_id: user.id,
        status: "pending_deletion",
        updated_at: now,
      },
      { onConflict: "user_id" },
    );

  if (pendingDeletionError) {
    throw new Error(
      `Account deletion status update failed: ${pendingDeletionError.message}`,
    );
  }

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

  // H2-B3: clear the legacy clients.portal_user_id mirror only where it still points at the user being deleted, never a different user's
  // mirror. Matched on the mirror itself, not on the relationship rows: an interrupted earlier attempt has already detached those.
  const { error: mirrorError } = await admin
    .from("clients")
    .update({ portal_user_id: null, updated_at: now })
    .eq("portal_user_id", user.id);

  if (mirrorError) {
    throw new Error(`Legacy portal mirror cleanup failed: ${mirrorError.message}`);
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

  await secondFilePass(user.id, userReferenceHash);

  return {
    deleted: true as const,
    preservedStudioRelationshipCount: linkedRows.length,
  };
}
