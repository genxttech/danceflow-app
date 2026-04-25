"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  type AppRole,
  canAssignTargetRole,
  canExportWithOverride,
  isOrganizerOwner,
  isPlatformAdmin,
  isStudioOwner,
} from "@/lib/auth/permissions";
import {
  canAssignRoleUnderPlan,
  getCurrentWorkspaceCapabilitiesForUser,
} from "@/lib/billing/access";

function isNextRedirectError(error: unknown): error is { digest: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

type ExportPermissionKey =
  | "export_clients"
  | "export_financials"
  | "export_schedule"
  | "export_events"
  | "export_reports";

const ASSIGNABLE_ROLES = new Set<AppRole>([
  "studio_admin",
  "front_desk",
  "instructor",
  "independent_instructor",
  "organizer_admin",
]);

const EXPORT_PERMISSION_KEYS = new Set<ExportPermissionKey>([
  "export_clients",
  "export_financials",
  "export_schedule",
  "export_events",
  "export_reports",
]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function parseBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes";
}

function parseRole(value: string): AppRole | null {
  const normalized = value.trim() as AppRole;
  return ASSIGNABLE_ROLES.has(normalized) ? normalized : null;
}

function parseExportPermission(value: string): ExportPermissionKey | null {
  const normalized = value.trim() as ExportPermissionKey;
  return EXPORT_PERMISSION_KEYS.has(normalized) ? normalized : null;
}

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function redirectTeamWithMessage(kind: "success" | "error", message: string): never {
  const params = new URLSearchParams({
    [kind]: message,
  });

  redirect(`/app/settings/team?${params.toString()}`);
}

async function getActorContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in.");
  }

  const workspace = await getCurrentStudioContext();
  const capabilities = await getCurrentWorkspaceCapabilitiesForUser();

  if (!workspace?.studioId) {
    throw new Error("No active workspace selected.");
  }

  if (!capabilities || capabilities.studioId !== workspace.studioId) {
    throw new Error("Could not load workspace capabilities.");
  }

  const actorRole = workspace.studioRole ?? null;
  const actorIsOwner =
    isPlatformAdmin(actorRole) ||
    isStudioOwner(actorRole) ||
    isOrganizerOwner(actorRole);

  return {
    supabase,
    actorUserId: user.id,
    actorEmail: user.email ? normalizeEmail(user.email) : null,
    studioId: workspace.studioId,
    actorRole,
    actorIsOwner,
    capabilities,
  };
}

async function countAssignedRole(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  role: AppRole;
}) {
  const { data, error } = await args.supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", args.studioId)
    .eq("role", args.role)
    .eq("active", true);

  if (error) {
    throw new Error(`Could not count assigned roles: ${error.message}`);
  }

  return (data ?? []).length;
}

async function getExistingMembership(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
}) {
  const { data, error } = await args.supabase
    .from("user_studio_roles")
    .select("user_id, role, active")
    .eq("studio_id", args.studioId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load existing membership: ${error.message}`);
  }

  return data;
}

function roleFitsWorkspaceType(args: {
  targetRole: AppRole;
  actorRole: string | null | undefined;
}) {
  const { targetRole, actorRole } = args;

  const actorInOrganizerWorkspace =
    actorRole === "organizer_owner" || actorRole === "organizer_admin";
  const actorInStudioWorkspace =
    actorRole === "studio_owner" ||
    actorRole === "studio_admin" ||
    actorRole === "front_desk" ||
    actorRole === "instructor" ||
    actorRole === "independent_instructor";

  if (targetRole === "organizer_admin") {
    return actorInOrganizerWorkspace || actorRole === "platform_admin";
  }

  if (
    targetRole === "studio_admin" ||
    targetRole === "front_desk" ||
    targetRole === "instructor" ||
    targetRole === "independent_instructor"
  ) {
    return actorInStudioWorkspace || actorRole === "platform_admin";
  }

  return false;
}

async function assertPlanAllowsRole(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  capabilities: NonNullable<Awaited<ReturnType<typeof getCurrentWorkspaceCapabilitiesForUser>>>;
  targetRole: AppRole;
}) {
  const currentStudioAdminCount = await countAssignedRole({
    supabase: args.supabase,
    studioId: args.studioId,
    role: "studio_admin",
  });

  const currentOrganizerAdminCount = await countAssignedRole({
    supabase: args.supabase,
    studioId: args.studioId,
    role: "organizer_admin",
  });

  const allowedByPlan = canAssignRoleUnderPlan({
    planCode: args.capabilities.planCode,
    targetRole: args.targetRole,
    currentStudioAdminCount,
    currentOrganizerAdminCount,
  });

  if (!allowedByPlan) {
    if (args.targetRole === "studio_admin" && args.capabilities.planCode === "starter") {
      throw new Error("Studio Admin is not available on Starter. Upgrade to Growth or Pro.");
    }

    if (args.targetRole === "studio_admin" && args.capabilities.planCode === "growth") {
      throw new Error("Growth includes 1 Studio Admin seat. Upgrade to Pro for more.");
    }

    if (args.targetRole === "organizer_admin" && args.capabilities.planCode !== "organizer") {
      throw new Error("Organizer Admin is only available on Organizer workspaces.");
    }

    throw new Error("That role is not available on the current plan.");
  }
}

function revalidateTeamScreens() {
  revalidatePath("/app/settings/team");
  revalidatePath("/app");
  revalidatePath("/app/settings");
}

export async function inviteTeamMemberAction(formData: FormData) {
  try {
    const { supabase, studioId, actorRole, actorIsOwner, actorUserId, actorEmail, capabilities } =
      await getActorContext();

    if (!actorIsOwner) {
      redirectTeamWithMessage("error", "Only the workspace owner can invite team members.");
    }

    const email = normalizeEmail(getString(formData, "email"));
    const targetRole = parseRole(getString(formData, "targetRole"));

    if (!email) {
      redirectTeamWithMessage("error", "Email is required.");
    }

    if (!isEmailLike(email)) {
      redirectTeamWithMessage("error", "Enter a valid email address.");
    }

    if (actorEmail && email === actorEmail) {
      redirectTeamWithMessage("error", "Owners already have access and do not need an invitation.");
    }

    if (!targetRole) {
      redirectTeamWithMessage("error", "A valid role is required.");
    }

    if (!roleFitsWorkspaceType({ targetRole, actorRole })) {
      redirectTeamWithMessage("error", "That role does not match the current workspace type.");
    }

    if (!canAssignTargetRole({ actorRole, targetRole })) {
      redirectTeamWithMessage("error", "You are not allowed to assign that role.");
    }

    await assertPlanAllowsRole({
      supabase,
      studioId,
      capabilities,
      targetRole,
    });

    const { error: inviteError } = await supabase.from("team_invitations").insert({
      studio_id: studioId,
      email,
      role: targetRole,
      invited_by: actorUserId,
    });

    if (inviteError) {
      const normalized = inviteError.message.toLowerCase();

      if (
        normalized.includes("duplicate key") ||
        normalized.includes("team_invitations_one_active_invite_idx")
      ) {
        redirectTeamWithMessage("error", "An active invitation already exists for that email and role.");
      }

      redirectTeamWithMessage("error", `Could not create invitation: ${inviteError.message}`);
    }

    revalidateTeamScreens();
    redirectTeamWithMessage("success", "Invitation created.");
    } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectTeamWithMessage(
      "error",
      error instanceof Error ? error.message : "Something went wrong."
    );
  }
}

export async function revokeInvitationAction(formData: FormData) {
  try {
    const { supabase, studioId, actorIsOwner } = await getActorContext();

    if (!actorIsOwner) {
      redirectTeamWithMessage("error", "Only the workspace owner can revoke invitations.");
    }

    const invitationId = getString(formData, "invitationId");

    if (!invitationId) {
      redirectTeamWithMessage("error", "Invitation ID is required.");
    }

    const { error: revokeError } = await supabase
      .from("team_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", invitationId)
      .eq("studio_id", studioId)
      .is("accepted_at", null)
      .is("revoked_at", null);

    if (revokeError) {
      redirectTeamWithMessage("error", `Could not revoke invitation: ${revokeError.message}`);
    }

    revalidateTeamScreens();
    redirectTeamWithMessage("success", "Invitation revoked.");
    } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectTeamWithMessage(
      "error",
      error instanceof Error ? error.message : "Something went wrong."
    );
  }
}

export async function upsertTeamMemberRoleAction(formData: FormData) {
  try {
    const { supabase, studioId, actorRole, actorIsOwner, capabilities } =
      await getActorContext();

    if (!actorIsOwner) {
      redirectTeamWithMessage("error", "Only the workspace owner can assign team roles.");
    }

    const targetUserId = getString(formData, "targetUserId");
    const rawRole = getString(formData, "targetRole");
    const targetRole = parseRole(rawRole);

    if (!targetUserId) {
      redirectTeamWithMessage("error", "Target user is required.");
    }

    if (!targetRole) {
      redirectTeamWithMessage("error", "A valid role is required.");
    }

    if (!roleFitsWorkspaceType({ targetRole, actorRole })) {
      redirectTeamWithMessage("error", "That role does not match the current workspace type.");
    }

    if (!canAssignTargetRole({ actorRole, targetRole })) {
      redirectTeamWithMessage("error", "You are not allowed to assign that role.");
    }

    const currentStudioAdminCount = await countAssignedRole({
      supabase,
      studioId,
      role: "studio_admin",
    });

    const currentOrganizerAdminCount = await countAssignedRole({
      supabase,
      studioId,
      role: "organizer_admin",
    });

    const existingMembership = await getExistingMembership({
      supabase,
      studioId,
      userId: targetUserId,
    });

    const assigningIntoSameRole =
      existingMembership?.active === true && existingMembership?.role === targetRole;

    const effectiveStudioAdminCount =
      targetRole === "studio_admin" && assigningIntoSameRole
        ? Math.max(0, currentStudioAdminCount - 1)
        : currentStudioAdminCount;

    const effectiveOrganizerAdminCount =
      targetRole === "organizer_admin" && assigningIntoSameRole
        ? Math.max(0, currentOrganizerAdminCount - 1)
        : currentOrganizerAdminCount;

    const allowedByPlan = canAssignRoleUnderPlan({
      planCode: capabilities.planCode,
      targetRole,
      currentStudioAdminCount: effectiveStudioAdminCount,
      currentOrganizerAdminCount: effectiveOrganizerAdminCount,
    });

    if (!allowedByPlan) {
      if (targetRole === "studio_admin" && capabilities.planCode === "starter") {
        redirectTeamWithMessage("error", "Studio Admin is not available on Starter. Upgrade to Growth or Pro.");
      }

      if (targetRole === "studio_admin" && capabilities.planCode === "growth") {
        redirectTeamWithMessage("error", "Growth includes 1 Studio Admin seat. Upgrade to Pro for more.");
      }

      if (targetRole === "organizer_admin" && capabilities.planCode !== "organizer") {
        redirectTeamWithMessage("error", "Organizer Admin is only available on Organizer workspaces.");
      }

      redirectTeamWithMessage("error", "That role is not available on the current plan.");
    }

    const { error: upsertError } = await supabase.from("user_studio_roles").upsert(
      {
        studio_id: studioId,
        user_id: targetUserId,
        role: targetRole,
        active: true,
      },
      {
        onConflict: "studio_id,user_id",
      }
    );

    if (upsertError) {
      redirectTeamWithMessage("error", `Could not save team role: ${upsertError.message}`);
    }

    revalidateTeamScreens();
    redirectTeamWithMessage("success", "Team role saved.");
    } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectTeamWithMessage(
      "error",
      error instanceof Error ? error.message : "Something went wrong."
    );
  }
}

export async function deactivateTeamMemberAction(formData: FormData) {
  try {
    const { supabase, studioId, actorRole, actorIsOwner, actorUserId } =
      await getActorContext();

    if (!actorIsOwner) {
      redirectTeamWithMessage("error", "Only the workspace owner can remove team access.");
    }

    const targetUserId = getString(formData, "targetUserId");

    if (!targetUserId) {
      redirectTeamWithMessage("error", "Target user is required.");
    }

    if (targetUserId === actorUserId && !isPlatformAdmin(actorRole)) {
      redirectTeamWithMessage("error", "Owners cannot remove their own access here.");
    }

    const existingMembership = await getExistingMembership({
      supabase,
      studioId,
      userId: targetUserId,
    });

    if (!existingMembership) {
      redirectTeamWithMessage("error", "That team member was not found in this workspace.");
    }

    if (
      (existingMembership.role === "studio_owner" ||
        existingMembership.role === "organizer_owner") &&
      !isPlatformAdmin(actorRole)
    ) {
      redirectTeamWithMessage("error", "Owner access cannot be removed here.");
    }

    const { error: updateError } = await supabase
      .from("user_studio_roles")
      .update({ active: false })
      .eq("studio_id", studioId)
      .eq("user_id", targetUserId);

    if (updateError) {
      redirectTeamWithMessage("error", `Could not remove team access: ${updateError.message}`);
    }

    revalidateTeamScreens();
    redirectTeamWithMessage("success", "Team access removed.");
    } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectTeamWithMessage(
      "error",
      error instanceof Error ? error.message : "Something went wrong."
    );
  }
}

export async function setExportPermissionOverrideAction(formData: FormData) {
  try {
    const { supabase, studioId, actorRole, actorIsOwner } = await getActorContext();

    if (!actorIsOwner) {
      redirectTeamWithMessage("error", "Only the workspace owner can change export permissions.");
    }

    const targetUserId = getString(formData, "targetUserId");
    const permissionKey = parseExportPermission(getString(formData, "permissionKey"));
    const allowed = parseBoolean(formData, "allowed");

    if (!targetUserId) {
      redirectTeamWithMessage("error", "Target user is required.");
    }

    if (!permissionKey) {
      redirectTeamWithMessage("error", "A valid export permission is required.");
    }

    const existingMembership = await getExistingMembership({
      supabase,
      studioId,
      userId: targetUserId,
    });

    if (!existingMembership || !existingMembership.active) {
      redirectTeamWithMessage("error", "That team member does not have active workspace access.");
    }

    const alreadyAllowedByDefault = canExportWithOverride({
      role: existingMembership.role,
      permission: permissionKey,
      overrideAllowed: false,
    });

    if (alreadyAllowedByDefault && allowed) {
      const { error: deleteError } = await supabase
        .from("role_permission_overrides")
        .delete()
        .eq("studio_id", studioId)
        .eq("user_id", targetUserId)
        .eq("permission_key", permissionKey);

      if (deleteError) {
        redirectTeamWithMessage("error", `Could not clean up redundant override: ${deleteError.message}`);
      }

      revalidateTeamScreens();
      redirectTeamWithMessage(
        "success",
        "No override was needed because that role already has this export access by default."
      );
    }

    const { error: upsertError } = await supabase
      .from("role_permission_overrides")
      .upsert(
        {
          studio_id: studioId,
          user_id: targetUserId,
          permission_key: permissionKey,
          allowed,
          created_by: actorRole === "platform_admin" ? null : undefined,
        },
        {
          onConflict: "studio_id,user_id,permission_key",
        }
      );

    if (upsertError) {
      redirectTeamWithMessage("error", `Could not save export permission: ${upsertError.message}`);
    }

    revalidateTeamScreens();
    redirectTeamWithMessage("success", "Export permission saved.");
    } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectTeamWithMessage(
      "error",
      error instanceof Error ? error.message : "Something went wrong."
    );
  }
}