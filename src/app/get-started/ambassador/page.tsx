import crypto from "crypto";
import Link from "next/link";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { createClient } from "@/lib/supabase/server";
import { claimAmbassadorInviteAction } from "./actions";

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

function hashInviteToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function errorMessage(code: string | undefined) {
  if (!code) return null;
  if (code === "missing_invite") return "This ambassador invite link is missing its invite token.";
  if (code === "workspace_required") return "Enter a workspace name to continue.";
  if (code === "claim_failed") return "This invite could not be claimed. Confirm you are signed in with the invited email and that the invite has not expired.";
  return "Something went wrong. Try again.";
}

export default async function AmbassadorInvitePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const token = params.invite?.trim() ?? "";
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let invite: InvitePreviewRow | null = null;

  if (token) {
    const tokenHash = hashInviteToken(token);

    const { data } = await supabase
      .from("platform_invites")
      .select(
        `
        email,
        invite_type,
        granted_plan,
        billing_override_reason,
        duration_months,
        expires_at,
        used_at,
        active
      `
      )
      .eq("token_hash", tokenHash)
      .maybeSingle();

    invite = data as InvitePreviewRow | null;
  }

  const pageError = errorMessage(params.error);
  const inviteExpired = invite ? new Date(invite.expires_at).getTime() < Date.now() : false;
  const inviteUnavailable = !invite || !invite.active || invite.used_at || inviteExpired;
  const signedInEmail = user?.email?.toLowerCase() ?? null;
  const inviteEmail = invite?.email?.toLowerCase() ?? null;
  const emailMismatch = Boolean(signedInEmail && inviteEmail && signedInEmail !== inviteEmail);

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
              Claim your Ambassador Pro workspace
            </h1>
            <p className="mt-4 text-sm leading-7 text-slate-600">
              This private invite creates your DanceFlow Pro workspace without starting a Stripe trial.
              It is tied to the invited email address and can only be used once.
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
              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <h2 className="text-lg font-semibold text-slate-950">Sign in with the invited email</h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  This invite is tied to {invite.email}. Sign in or create your account with that email, then return to this link.
                </p>
                <Link
                  href={`/login?next=${encodeURIComponent(`/get-started/ambassador?invite=${token}`)}`}
                  className="mt-4 inline-flex rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Sign in to continue
                </Link>
              </div>
            ) : null}

            {user && emailMismatch ? (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-7 text-amber-800">
                This invite was sent to {invite?.email}, but you are signed in as {user.email}. Sign out and use the invited email to claim this workspace.
              </div>
            ) : null}

            {user && invite && !inviteUnavailable && !emailMismatch ? (
              <form action={claimAmbassadorInviteAction} className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <input type="hidden" name="invite" value={token} />

                <h2 className="text-lg font-semibold text-slate-950">Create your workspace</h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  This workspace will start with Ambassador Pro access. You can keep using the same workspace and data if you continue after the pilot.
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
                  className="mt-5 w-full rounded-2xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 sm:w-auto"
                >
                  Create Ambassador Pro workspace
                </button>
              </form>
            ) : null}
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
