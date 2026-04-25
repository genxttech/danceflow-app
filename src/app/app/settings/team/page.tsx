import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CopyInviteLinkButton from "./CopyInviteLinkButton";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  canExportWithOverride,
  isOrganizerOwner,
  isPlatformAdmin,
  isStudioOwner,
  type AppRole,
} from "@/lib/auth/permissions";
import { getCurrentWorkspaceCapabilitiesForUser } from "@/lib/billing/access";
import {
  deactivateTeamMemberAction,
  inviteTeamMemberAction,
  revokeInvitationAction,
  setExportPermissionOverrideAction,
} from "./actions";

type TeamMemberRow = {
  user_id: string;
  role: AppRole;
  active: boolean;
};

type TeamInvitationRow = {
  id: string;
  email: string;
  role: AppRole;
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
};

type PermissionOverrideRow = {
  user_id: string;
  permission_key: ExportPermissionKey;
  allowed: boolean;
};

type ExportPermissionKey =
  | "export_clients"
  | "export_financials"
  | "export_schedule"
  | "export_events"
  | "export_reports";

const STUDIO_ROLE_OPTIONS: Array<{ value: AppRole; label: string }> = [
  { value: "studio_admin", label: "Studio Manager" },
  { value: "front_desk", label: "Front Desk" },
  { value: "instructor", label: "Instructor" },
  { value: "independent_instructor", label: "Independent Instructor" },
];

const ORGANIZER_ROLE_OPTIONS: Array<{ value: AppRole; label: string }> = [
  { value: "organizer_admin", label: "Organizer Admin" },
];

const EXPORT_OPTIONS: Array<{ key: ExportPermissionKey; label: string }> = [
  { key: "export_clients", label: "Export clients" },
  { key: "export_financials", label: "Export financials" },
  { key: "export_schedule", label: "Export schedule" },
  { key: "export_events", label: "Export events" },
  { key: "export_reports", label: "Export reports" },
];

function roleLabel(role: string) {
  if (role === "studio_admin") return "Studio Manager";

  return role
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function badgeClass(role: string) {
  if (role === "studio_owner" || role === "organizer_owner") {
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  }
  if (role === "studio_admin" || role === "organizer_admin") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (role === "front_desk") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function invitationStatus(invite: TeamInvitationRow) {
  if (invite.revoked_at) return "Revoked";
  if (invite.accepted_at) return "Accepted";
  if (new Date(invite.expires_at) < new Date()) return "Expired";
  return "Pending";
}

function invitationBadgeClass(invite: TeamInvitationRow) {
  const status = invitationStatus(invite);
  if (status === "Accepted") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (status === "Revoked") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }
  if (status === "Expired") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sectionCard(
  title: string,
  subtitle: string,
  children: React.ReactNode
) {
  return (
    <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const workspace = await getCurrentStudioContext();
  const capabilities = await getCurrentWorkspaceCapabilitiesForUser();

  if (!workspace?.studioId || !capabilities || capabilities.studioId !== workspace.studioId) {
    redirect("/app");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const successMessage =
    typeof resolvedSearchParams.success === "string" ? resolvedSearchParams.success : null;
  const errorMessage =
    typeof resolvedSearchParams.error === "string" ? resolvedSearchParams.error : null;

  const actorRole = workspace.studioRole ?? null;
  const actorIsOwner =
    isPlatformAdmin(actorRole) ||
    isStudioOwner(actorRole) ||
    isOrganizerOwner(actorRole);

  const workspaceType =
    actorRole === "organizer_owner" || actorRole === "organizer_admin"
      ? "organizer"
      : "studio";

  const roleOptions =
    workspaceType === "organizer" ? ORGANIZER_ROLE_OPTIONS : STUDIO_ROLE_OPTIONS;

  const [
    { data: members, error: membersError },
    { data: overrides, error: overridesError },
    { data: invitations, error: invitationsError },
  ] = await Promise.all([
    supabase
      .from("user_studio_roles")
      .select("user_id, role, active")
      .eq("studio_id", workspace.studioId)
      .order("role", { ascending: true }),

    supabase
      .from("role_permission_overrides")
      .select("user_id, permission_key, allowed")
      .eq("studio_id", workspace.studioId),

    supabase
      .from("team_invitations")
      .select("id, email, role, accepted_at, revoked_at, expires_at, created_at")
      .eq("studio_id", workspace.studioId)
      .order("created_at", { ascending: false }),
  ]);

  if (membersError) {
    throw new Error(`Failed to load team members: ${membersError.message}`);
  }

  if (overridesError) {
    throw new Error(`Failed to load permission overrides: ${overridesError.message}`);
  }

  if (invitationsError) {
    throw new Error(`Failed to load team invitations: ${invitationsError.message}`);
  }

  const typedMembers = ((members ?? []) as TeamMemberRow[]).filter((item) => item.active);
  const typedOverrides = (overrides ?? []) as PermissionOverrideRow[];
  const typedInvitations = (invitations ?? []) as TeamInvitationRow[];

  const activeInvitations = typedInvitations.filter(
    (item) =>
      !item.revoked_at &&
      !item.accepted_at &&
      new Date(item.expires_at) >= new Date()
  );

  const currentStudioAdminCount = typedMembers.filter(
    (item) => item.role === "studio_admin"
  ).length;
  const currentOrganizerAdminCount = typedMembers.filter(
    (item) => item.role === "organizer_admin"
  ).length;

  const overridesByUser = new Map<string, Map<ExportPermissionKey, boolean>>();

  for (const row of typedOverrides) {
    const existing = overridesByUser.get(row.user_id) ?? new Map<ExportPermissionKey, boolean>();
    existing.set(row.permission_key, row.allowed);
    overridesByUser.set(row.user_id, existing);
  }

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Access Management
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Team &amp; Permissions
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Review team access, see pending invitations, and manage workspace permissions in one place.
              </p>

              <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                <span>
                  Workspace role:{" "}
                  <span className="font-medium text-white">{roleLabel(actorRole ?? "unknown")}</span>
                </span>
                <span>
                  Plan:{" "}
                  <span className="font-medium text-white">
                    {capabilities.planName ?? "Unknown"}
                  </span>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/settings"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Settings
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Active Team Members</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{typedMembers.length}</p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Pending Invitations</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{activeInvitations.length}</p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">
                {workspaceType === "organizer" ? "Organizer Admin Seats" : "Studio Manager Seats"}
              </p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {workspaceType === "organizer"
                  ? currentOrganizerAdminCount
                  : currentStudioAdminCount}
              </p>
              <p className="mt-2 text-sm text-slate-500">
                {workspaceType === "organizer"
                  ? capabilities.maxOrganizerAdmins >= 999
                    ? "Unlimited on Organizer"
                    : `${capabilities.maxOrganizerAdmins} included`
                  : capabilities.maxStudioAdmins >= 999
                    ? "Unlimited on Pro"
                    : `${capabilities.maxStudioAdmins} included`}
              </p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Export Control</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">Owner Controlled</p>
              <p className="mt-2 text-sm text-slate-500">
                Export access does not flow automatically to instructors.
              </p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Workspace Type</p>
              <p className="mt-2 text-3xl font-semibold capitalize text-slate-950">
                {workspaceType}
              </p>
              <p className="mt-2 text-sm text-slate-500">
                Roles are filtered to match the current workspace.
              </p>
            </div>
          </div>
        </div>
      </section>

      {successMessage ? (
        <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Success
          </p>
          <p className="mt-2 text-sm leading-7 text-slate-700">{successMessage}</p>
        </section>
      ) : null}

      {errorMessage ? (
        <section className="rounded-[32px] border border-rose-200 bg-rose-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-rose-700">
            Action blocked
          </p>
          <p className="mt-2 text-sm leading-7 text-slate-700">{errorMessage}</p>
        </section>
      ) : null}

      {!actorIsOwner ? (
        <section className="rounded-[32px] border border-amber-200 bg-amber-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">
            Owner approval needed
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            You can view team information, but only the owner can change access
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-700">
            Team invitations, role changes, access removal, and export permissions are
            limited to the workspace owner. Please contact the studio owner or organizer
            owner if you need a team access change.
          </p>

          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/app"
              className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
            >
              Back to Dashboard
            </Link>

            <Link
              href="/app/support"
              className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
            >
              Contact Support
            </Link>
          </div>
        </section>
      ) : null}

      {sectionCard(
        "Invite team member",
        workspaceType === "organizer"
          ? "Invite an organizer admin by email."
          : "Invite staff by email and assign the correct workspace role.",
        actorIsOwner ? (
          <form
            action={inviteTeamMemberAction}
            className="grid gap-4 lg:grid-cols-[1.2fr_1fr_auto]"
          >
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="name@example.com"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-violet-500"
              />
              <p className="mt-2 text-xs leading-6 text-slate-500">
                The invitation will be tied to this email instead of requiring a raw user ID.
                Until email delivery is fully automated everywhere, use the pending invitation card to copy a link
                and send it manually when needed.
              </p>
            </div>

            <div>
              <label htmlFor="targetRole" className="block text-sm font-medium text-slate-700">
                Role
              </label>
              <select
                id="targetRole"
                name="targetRole"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-violet-500"
                defaultValue={roleOptions[0]?.value}
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <button
                type="submit"
                className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
              >
                Send Invite
              </button>
            </div>
          </form>
        ) : (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-900">
            Only the workspace owner can invite team members from this page.
          </div>
        )
      )}

      {sectionCard(
        "Pending invitations",
        "Invitations stay here until they are accepted, revoked, or expired.",
        typedInvitations.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
            No invitations have been created yet.
          </div>
        ) : (
          <div className="space-y-4">
            {typedInvitations.map((invite) => {
              const status = invitationStatus(invite);
              const canRevoke = actorIsOwner && status === "Pending";

              return (
                <div
                  key={invite.id}
                  className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold text-slate-950">{invite.email}</p>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${badgeClass(
                            invite.role
                          )}`}
                        >
                          {roleLabel(invite.role)}
                        </span>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${invitationBadgeClass(
                            invite
                          )}`}
                        >
                          {status}
                        </span>
                      </div>

                      <div className="mt-2 grid gap-1 text-sm text-slate-500">
                        <p>Invited: {fmtDateTime(invite.created_at)}</p>
                        <p>Expires: {fmtDateTime(invite.expires_at)}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {status === "Pending" ? (
                        <CopyInviteLinkButton email={invite.email} />
                      ) : null}

                      {canRevoke ? (
                        <form action={revokeInvitationAction}>
                          <input type="hidden" name="invitationId" value={invite.id} />
                          <button
                            type="submit"
                            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
                          >
                            Revoke Invite
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {sectionCard(
        "Current team",
        actorIsOwner
          ? "Active users in this workspace. Owners stay protected from accidental removal."
          : "You can review active team members here, but only the owner can change access.",
        typedMembers.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
            No active team members were found for this workspace.
          </div>
        ) : (
          <div className="space-y-4">
            {typedMembers.map((member) => {
              const memberOverrides = overridesByUser.get(member.user_id) ?? new Map();

              return (
                <div
                  key={member.user_id}
                  className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold text-slate-950">{member.user_id}</p>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${badgeClass(
                            member.role
                          )}`}
                        >
                          {roleLabel(member.role)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-slate-500">
                        User ID is still shown until the friendly name and email member directory is added.
                      </p>
                    </div>

                    {actorIsOwner &&
                    member.role !== "studio_owner" &&
                    member.role !== "organizer_owner" ? (
                      <form action={deactivateTeamMemberAction}>
                        <input type="hidden" name="targetUserId" value={member.user_id} />
                        <button
                          type="submit"
                          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
                        >
                          Remove Access
                        </button>
                      </form>
                    ) : null}
                  </div>

                  <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_1.2fr]">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-900">Role access</p>
                      <div className="mt-3 grid gap-2 text-sm text-slate-600">
                        <div className="flex items-center justify-between gap-4">
                          <span>Can export clients</span>
                          <span className="font-medium text-slate-900">
                            {canExportWithOverride({
                              role: member.role,
                              permission: "export_clients",
                              overrideAllowed: memberOverrides.get("export_clients"),
                            })
                              ? "Yes"
                              : "No"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>Can export financials</span>
                          <span className="font-medium text-slate-900">
                            {canExportWithOverride({
                              role: member.role,
                              permission: "export_financials",
                              overrideAllowed: memberOverrides.get("export_financials"),
                            })
                              ? "Yes"
                              : "No"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>Can export schedule</span>
                          <span className="font-medium text-slate-900">
                            {canExportWithOverride({
                              role: member.role,
                              permission: "export_schedule",
                              overrideAllowed: memberOverrides.get("export_schedule"),
                            })
                              ? "Yes"
                              : "No"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>Can export events</span>
                          <span className="font-medium text-slate-900">
                            {canExportWithOverride({
                              role: member.role,
                              permission: "export_events",
                              overrideAllowed: memberOverrides.get("export_events"),
                            })
                              ? "Yes"
                              : "No"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span>Can export reports</span>
                          <span className="font-medium text-slate-900">
                            {canExportWithOverride({
                              role: member.role,
                              permission: "export_reports",
                              overrideAllowed: memberOverrides.get("export_reports"),
                            })
                              ? "Yes"
                              : "No"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-900">
                        Owner-granted export overrides
                      </p>

                      {!actorIsOwner ? (
                        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-900">
                          Only the workspace owner can change export permissions.
                        </div>
                      ) : (
                        <div className="mt-3 space-y-3">
                          {EXPORT_OPTIONS.map((option) => {
                            const currentAllowed = memberOverrides.get(option.key) === true;

                            return (
                              <form
                                key={`${member.user_id}-${option.key}`}
                                action={setExportPermissionOverrideAction}
                                className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 md:grid-cols-[1fr_auto_auto]"
                              >
                                <input type="hidden" name="targetUserId" value={member.user_id} />
                                <input type="hidden" name="permissionKey" value={option.key} />

                                <div>
                                  <p className="text-sm font-medium text-slate-900">{option.label}</p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    Use overrides only when the default role access is not enough.
                                  </p>
                                </div>

                                <select
                                  name="allowed"
                                  defaultValue={currentAllowed ? "true" : "false"}
                                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500"
                                >
                                  <option value="false">Blocked</option>
                                  <option value="true">Allowed</option>
                                </select>

                                <button
                                  type="submit"
                                  className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
                                >
                                  Save
                                </button>
                              </form>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {sectionCard(
        "Plan guardrails",
        "This workspace enforces seat and feature limits based on the current subscription.",
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Studio Manager</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {capabilities.canUseStudioAdmin ? "Enabled" : "Blocked"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {capabilities.maxStudioAdmins >= 999
                ? "Unlimited on this plan."
                : `${capabilities.maxStudioAdmins} included seat(s).`}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Front Desk</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {capabilities.canUseFrontDesk ? "Enabled" : "Blocked"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Available on team-oriented studio plans.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Organizer Admin</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {capabilities.canUseOrganizerAdmin ? "Enabled" : "Blocked"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Organizer-only admin access.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Public Events Module</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {capabilities.hasPublicEventModule ? "Enabled" : "Blocked"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Used for organizer and public event workflows.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}