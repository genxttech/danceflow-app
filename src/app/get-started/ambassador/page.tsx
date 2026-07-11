import Link from "next/link";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { createClient } from "@/lib/supabase/server";
import { claimAmbassadorInviteAction, createAmbassadorAccountAction } from "./actions";
import { normalizePublicToken, sha256TokenHash } from "@/lib/security/tokens";

type SearchParams = Promise<{
  invite?: string;
  error?: string;
}>;

type InvitePreviewRow = {
  email: string;
  invite_type: string;
  granted_plan: string;
  billing_override_reason: string;
  duration_months: number;
  expires_at: string;
  used_at: string | null;
  active: boolean;
};

type UserWorkspaceRow = {
  studio_id: string;
  role: string;
  studios:
    | {
        id: string;
        name: string;
        public_name: string | null;
        slug: string | null;
        billing_plan: string | null;
        subscription_status: string | null;
      }
    | {
        id: string;
        name: string;
        public_name: string | null;
        slug: string | null;
        billing_plan: string | null;
        subscription_status: string | null;
      }[]
    | null;
};

type WorkspaceOption = {
  studioId: string;
  role: string;
  name: string;
  publicName: string | null;
  billingPlan: string | null;
  subscriptionStatus: string | null;
};

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function titleCaseRole(value: string | null | undefined) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getWorkspaceFromJoin(row: UserWorkspaceRow) {
  return Array.isArray(row.studios) ? row.studios[0] ?? null : row.studios;
}

function errorMessage(code: string | undefined) {
  if (!code) return null;
  if (code === "missing_invite") return "This ambassador invite link is missing its invite token.";
  if (code === "workspace_required") return "Enter a workspace name to continue.";
  if (code === "workspace_choice_required") return "Choose an existing workspace or create a new one.";
  if (code === "claim_failed") return "This invite could not be claimed. Confirm you are signed in with the invited email and that the invite has not expired.";
  if (code === "password_required") return "Enter a password to create your DanceFlow account.";
  if (code === "password_too_short") return "Your password must be at least 8 characters.";
  if (code === "password_mismatch") return "The passwords did not match. Try again.";
  if (code === "account_exists") return "A DanceFlow account already exists for this email. Sign in with that account to continue.";
  if (code === "account_create_failed") return "The account could not be created. Try again or contact DanceFlow.";
  if (code === "sign_in_failed") return "The account was created, but sign-in did not complete. Sign in with your new password to continue.";
  return "Something went wrong. Try again.";
}

export default async function AmbassadorInvitePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const token = normalizePublicToken(params.invite ?? null, {
    minLength: 24,
    maxLength: 128,
    allowUuid: false,
  }) ?? "";
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let invite: InvitePreviewRow | null = null;
  let workspaceOptions: WorkspaceOption[] = [];

  if (token) {
    const tokenHash = sha256TokenHash(token);

    const { data, error: previewError } = await supabase
      .rpc("get_platform_invite_public_preview", {
        p_token_hash: tokenHash,
      })
      .maybeSingle();

    if (previewError) {
      console.error("Ambassador invite preview lookup failed", previewError);
    }

    invite = data as InvitePreviewRow | null;
  }

  const pageError = errorMessage(params.error);
  const inviteExpired = invite ? new Date(invite.expires_at).getTime() < Date.now() : false;
  const inviteUnavailable = !invite || !invite.active || invite.used_at || inviteExpired;
  const signedInEmail = user?.email?.toLowerCase() ?? null;
  const inviteEmail = invite?.email?.toLowerCase() ?? null;
  const emailMismatch = Boolean(signedInEmail && inviteEmail && signedInEmail !== inviteEmail);

  if (user && invite && !inviteUnavailable && !emailMismatch) {
    const { data: workspaceRows, error: workspaceError } = await supabase
      .from("user_studio_roles")
      .select(
        `
        studio_id,
        role,
        studios (
          id,
          name,
          public_name,
          slug,
          billing_plan,
          subscription_status
        )
      `
      )
      .eq("user_id", user.id)
      .eq("active", true)
      .in("role", [
        "studio_owner",
        "studio_admin",
        "independent_instructor",
        "organizer_owner",
        "organizer_admin",
      ])
      .order("studio_id", { ascending: true });

    if (workspaceError) {
      console.error("Ambassador invite workspace lookup failed", workspaceError);
    }

    workspaceOptions = ((workspaceRows ?? []) as UserWorkspaceRow[])
      .map((row) => {
        const studio = getWorkspaceFromJoin(row);
        if (!studio) return null;

        return {
          studioId: row.studio_id,
          role: row.role,
          name: studio.name,
          publicName: studio.public_name,
          billingPlan: studio.billing_plan,
          subscriptionStatus: studio.subscription_status,
        } satisfies WorkspaceOption;
      })
      .filter((value): value is WorkspaceOption => Boolean(value));
  }

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#f5f3ff_0%,#ffffff_30%,#f8fafc_100%)]">
        <section className="mx-auto max-w-4xl px-6 py-14 lg:px-8 lg:py-20">
          <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-600">
              DanceFlow Ambassador Pro Pilot
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Claim your Ambassador Pro access
            </h1>
            <p className="mt-4 text-sm leading-7 text-slate-600">
              This private invite gives you DanceFlow Pro access without starting a Stripe trial.
              It can create a new workspace or upgrade an existing workspace you already manage.
            </p>

            {pageError ? (
              <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {pageError}
              </div>
            ) : null}

            {!token ? (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800">
                This page requires an ambassador invite link. Use the link sent by DanceFlow.
              </div>
            ) : null}

            {token && !invite ? (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800">
                This invite was not found or cannot be viewed. Confirm the full link was copied correctly.
              </div>
            ) : null}

            {invite ? (
              <div className="mt-6 grid gap-3 rounded-2xl border border-violet-100 bg-violet-50 p-4 text-sm text-violet-950 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Invited email
                  </p>
                  <p className="mt-1 font-medium">{invite.email}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Access
                  </p>
                  <p className="mt-1 font-medium">Pro · {invite.duration_months} months</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Invite expires
                  </p>
                  <p className="mt-1 font-medium">{formatDate(invite.expires_at)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Status
                  </p>
                  <p className="mt-1 font-medium">
                    {invite.used_at
                      ? "Already used"
                      : !invite.active
                        ? "Inactive"
                        : inviteExpired
                          ? "Expired"
                          : "Ready to claim"}
                  </p>
                </div>
              </div>
            ) : null}

            {!user && token && invite && !inviteUnavailable ? (
              <div className="mt-6 grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Create your DanceFlow login</h2>
                  <p className="mt-2 text-sm leading-7 text-slate-600">
                    This invite is tied to {invite.email}. Create a password for that email and DanceFlow will bring you back here to choose or create your Ambassador Pro workspace.
                  </p>
                </div>

                <form action={createAmbassadorAccountAction} className="grid gap-4">
                  <input type="hidden" name="invite" value={token} />

                  <div className="rounded-2xl border border-violet-100 bg-white px-4 py-3 text-sm text-slate-700">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                      Account email
                    </p>
                    <p className="mt-1 font-medium text-slate-950">{invite.email}</p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-sm font-medium text-slate-700">Password</span>
                      <input
                        name="password"
                        type="password"
                        required
                        minLength={8}
                        autoComplete="new-password"
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                        placeholder="At least 8 characters"
                      />
                    </label>

                    <label className="block">
                      <span className="text-sm font-medium text-slate-700">Confirm password</span>
                      <input
                        name="confirmPassword"
                        type="password"
                        required
                        minLength={8}
                        autoComplete="new-password"
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                        placeholder="Re-enter password"
                      />
                    </label>
                  </div>

                  <button
                    type="submit"
                    className="w-full rounded-2xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-violet-700 sm:w-auto"
                  >
                    Create account and continue
                  </button>
                </form>

                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600">
                  Already have a DanceFlow account for {invite.email}?{" "}
                  <Link
                    href={`/login?next=${encodeURIComponent(`/get-started/ambassador?invite=${token}`)}`}
                    className="font-semibold text-violet-700 hover:text-violet-800"
                  >
                    Sign in to continue.
                  </Link>
                </div>
              </div>
            ) : null}

            {user && emailMismatch ? (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-7 text-amber-800">
                This invite was sent to {invite?.email}, but you are signed in as {user.email}. Sign out and use the invited email to claim this access.
              </div>
            ) : null}

            {user && invite && !inviteUnavailable && !emailMismatch ? (
              <div className="mt-6 space-y-5">
                {workspaceOptions.length > 0 ? (
                  <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <h2 className="text-lg font-semibold text-slate-950">Use an existing workspace</h2>
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      Choose this option if you already have DanceFlow data you want to keep using after the ambassador pilot.
                    </p>

                    <div className="mt-4 grid gap-3">
                      {workspaceOptions.map((workspace) => (
                        <form
                          key={workspace.studioId}
                          action={claimAmbassadorInviteAction}
                          className="rounded-2xl border border-slate-200 bg-white p-4"
                        >
                          <input type="hidden" name="invite" value={token} />
                          <input type="hidden" name="claimMode" value="existing" />
                          <input type="hidden" name="existingStudioId" value={workspace.studioId} />

                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="font-semibold text-slate-950">
                                {workspace.publicName || workspace.name}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {titleCaseRole(workspace.role)} · Current plan: {workspace.billingPlan ?? "—"} · Status: {workspace.subscriptionStatus ?? "—"}
                              </p>
                            </div>
                            <button
                              type="submit"
                              className="w-full rounded-2xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 sm:w-auto"
                            >
                              Apply Pro access here
                            </button>
                          </div>
                        </form>
                      ))}
                    </div>
                  </section>
                ) : null}

                <form action={claimAmbassadorInviteAction} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <input type="hidden" name="invite" value={token} />
                  <input type="hidden" name="claimMode" value="new" />

                  <h2 className="text-lg font-semibold text-slate-950">
                    {workspaceOptions.length > 0 ? "Or create a new workspace" : "Create your workspace"}
                  </h2>
                  <p className="mt-2 text-sm leading-7 text-slate-600">
                    Use this if you want a fresh Ambassador Pro workspace. You can keep using this same workspace and data if you continue after the pilot.
                  </p>

                  <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_220px]">
                    <label className="block">
                      <span className="text-sm font-medium text-slate-700">Workspace name</span>
                      <input
                        name="workspaceName"
                        required
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                        placeholder="Your teaching business or studio name"
                      />
                    </label>

                    <label className="block">
                      <span className="text-sm font-medium text-slate-700">Timezone</span>
                      <select
                        name="timezone"
                        defaultValue="America/New_York"
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                      >
                        <option value="America/New_York">Eastern</option>
                        <option value="America/Chicago">Central</option>
                        <option value="America/Denver">Mountain</option>
                        <option value="America/Phoenix">Arizona</option>
                        <option value="America/Los_Angeles">Pacific</option>
                      </select>
                    </label>
                  </div>

                  <button
                    type="submit"
                    className="mt-5 w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-sm font-semibold text-violet-700 shadow-sm transition hover:bg-violet-50 sm:w-auto"
                  >
                    Create new Ambassador Pro workspace
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}





