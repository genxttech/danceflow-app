import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import {
  createAmbassadorInviteAction,
  deactivateAmbassadorInviteAction,
} from "./actions";

type SearchParams = Promise<{
  created?: string;
  deactivated?: string;
  error?: string;
  invite?: string;
}>;

type PlatformInviteRow = {
  id: string;
  email: string;
  invite_type: string;
  granted_plan: string;
  billing_override_reason: string;
  duration_months: number;
  expires_at: string;
  used_at: string | null;
  claimed_studio_id: string | null;
  created_at: string;
  notes: string | null;
  active: boolean;
};

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function statusLabel(invite: PlatformInviteRow) {
  if (invite.used_at) return "Used";
  if (!invite.active) return "Inactive";
  if (new Date(invite.expires_at).getTime() < Date.now()) return "Expired";
  return "Active";
}

function statusClass(invite: PlatformInviteRow) {
  const status = statusLabel(invite);

  if (status === "Active") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "Used") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}

function errorMessage(code: string | undefined) {
  if (!code) return null;

  if (code === "valid_email_required") return "Enter a valid email address for the invite.";
  if (code === "create_failed") return "The invite could not be created. Check the database migration and try again.";
  if (code === "deactivate_failed") return "The invite could not be deactivated.";
  if (code === "missing_invite") return "The invite was missing. Refresh and try again.";

  return "Something went wrong. Try again.";
}

export default async function PlatformInvitesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const supabase = await createClient();

  const { data: invites, error } = await supabase
    .from("platform_invites")
    .select(
      `
      id,
      email,
      invite_type,
      granted_plan,
      billing_override_reason,
      duration_months,
      expires_at,
      used_at,
      claimed_studio_id,
      created_at,
      notes,
      active
    `
    )
    .order("created_at", { ascending: false })
    .limit(25);

  const typedInvites = (invites ?? []) as PlatformInviteRow[];
  const createdInviteLink = params.invite ? decodeURIComponent(params.invite) : null;
  const pageError = errorMessage(params.error) || (error ? "Invite records could not be loaded." : null);

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">
              Platform Invites
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Ambassador Pro invite codes
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
              Create email-bound, one-use invite links for DanceFlow Ambassador Pro accounts.
              The invite lets the ambassador create a Pro workspace without starting a Stripe trial.
            </p>
          </div>

          <div className="rounded-2xl border border-violet-100 bg-violet-50 px-4 py-3 text-sm text-violet-950">
            <p className="font-semibold">V1 behavior</p>
            <p className="mt-1 leading-6">
              Links are tied to one email, expire, and can only be claimed once.
            </p>
          </div>
        </div>
      </section>

      {pageError ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {pageError}
        </div>
      ) : null}

      {params.deactivated ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Invite deactivated.
        </div>
      ) : null}

      {createdInviteLink ? (
        <section className="rounded-[2rem] border border-green-200 bg-green-50 p-5 text-green-950 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-green-700">
            Invite created
          </p>
          <p className="mt-2 text-sm leading-7">
            Copy this link and send it only to the invited ambassador email address.
          </p>
          <div className="mt-4 break-all rounded-2xl border border-green-200 bg-white px-4 py-3 font-mono text-xs text-slate-800">
            {createdInviteLink}
          </div>
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <form
          action={createAmbassadorInviteAction}
          className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Create ambassador invite
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">
            This creates a private link. The recipient must sign in with this exact email to claim it.
          </p>

          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Ambassador email</span>
              <input
                name="email"
                type="email"
                required
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                placeholder="name@example.com"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Comp duration</span>
                <select
                  name="durationMonths"
                  defaultValue="12"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                >
                  <option value="6">6 months</option>
                  <option value="12">12 months</option>
                  <option value="18">18 months</option>
                  <option value="24">24 months</option>
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Invite expires</span>
                <select
                  name="expiresInDays"
                  defaultValue="30"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                >
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                  <option value="60">60 days</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Internal notes</span>
              <textarea
                name="notes"
                rows={4}
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                defaultValue="DanceFlow Ambassador Pro Pilot"
              />
            </label>
          </div>

          <button
            type="submit"
            className="mt-5 w-full rounded-2xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700"
          >
            Generate invite link
          </button>
        </form>

        <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-slate-950">
            Invite rules
          </h2>
          <div className="mt-4 grid gap-3 text-sm leading-7 text-slate-600">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              The token itself is only shown once after creation. DanceFlow stores only the token hash.
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              The claiming user must be signed in with the invited email address.
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              Successful claim creates a Pro workspace with ambassador billing override and no Stripe trial.
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold tracking-tight text-slate-950">
          Recent invites
        </h2>

        {typedInvites.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            No ambassador invites yet.
          </p>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            <div className="divide-y divide-slate-200">
              {typedInvites.map((invite) => (
                <div key={invite.id} className="grid gap-4 p-4 lg:grid-cols-[1.3fr_0.8fr_0.8fr_auto] lg:items-center">
                  <div>
                    <p className="font-medium text-slate-950">{invite.email}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Created {formatDate(invite.created_at)} · Expires {formatDate(invite.expires_at)}
                    </p>
                    {invite.notes ? (
                      <p className="mt-2 text-sm text-slate-600">{invite.notes}</p>
                    ) : null}
                  </div>

                  <div className="text-sm text-slate-600">
                    <p className="font-medium text-slate-900">Pro / Ambassador</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {invite.duration_months} month comp
                    </p>
                  </div>

                  <div>
                    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusClass(invite)}`}>
                      {statusLabel(invite)}
                    </span>
                    {invite.claimed_studio_id ? (
                      <p className="mt-2 text-xs text-slate-500">Workspace claimed</p>
                    ) : null}
                  </div>

                  {!invite.used_at && invite.active ? (
                    <form action={deactivateAmbassadorInviteAction}>
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <button
                        type="submit"
                        className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        Deactivate
                      </button>
                    </form>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
