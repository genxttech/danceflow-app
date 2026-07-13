import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getClientInvitationByToken } from "@/lib/student-identity/lifecycle";
import {
  acceptStudioInviteAction,
  rejectStudioInviteAction,
} from "./actions";

function displayName(firstName: string | null, lastName: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Studio client";
}

function errorMessage(code: string | undefined) {
  if (code === "invite_expired") {
    return "This invitation has expired. Ask the studio to send a new invitation.";
  }
  if (code === "invite_email_mismatch") {
    return "The signed-in email does not match the email invited by the studio.";
  }
  if (code === "invite_conflict") {
    return "DanceFlow found a conflicting client or account relationship. The studio must review it before access can be granted.";
  }
  if (code === "invite_rejected") {
    return "This invitation was previously rejected.";
  }
  if (code === "invite_disconnected" || code === "invite_former_client") {
    return "This studio relationship is no longer active.";
  }
  return code ? "This invitation could not be completed." : null;
}

export default async function StudioInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const search = await searchParams;
  const invitation = await getClientInvitationByToken(token);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!invitation) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl items-center px-4 py-12">
        <div className="w-full rounded-[32px] border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-950">
            Invitation not found
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            This link is invalid or has already been replaced by a newer invitation.
          </p>
          <Link href="/account" className="mt-6 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
            Open My Account
          </Link>
        </div>
      </main>
    );
  }

  const expired =
    invitation.inviteExpiresAt &&
    new Date(invitation.inviteExpiresAt).getTime() <= Date.now();
  const signedInEmail = user?.email?.trim().toLowerCase() ?? "";
  const invitedEmail = invitation.invitedEmail?.trim().toLowerCase() ?? "";
  const emailMismatch = Boolean(user && invitedEmail && signedInEmail !== invitedEmail);
  const message = errorMessage(search.error);

  return (
    <main className="min-h-screen bg-[#fff8f1] px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <div className="overflow-hidden rounded-[36px] border border-orange-100 bg-white shadow-sm">
          <div className="bg-gradient-to-br from-purple-900 via-fuchsia-800 to-orange-500 p-8 text-white">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-100">
              DanceFlow Studio Invitation
            </p>
            <h1 className="mt-3 text-3xl font-semibold">
              {invitation.studioName} invited you
            </h1>
            <p className="mt-3 text-sm leading-7 text-white/85">
              Connect your DanceFlow account to the studio client record for{" "}
              {displayName(invitation.clientFirstName, invitation.clientLastName)}.
            </p>
          </div>

          <div className="space-y-5 p-8">
            {message ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800">
                {message}
              </div>
            ) : null}

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Invited email
              </p>
              <p className="mt-1 font-semibold text-slate-950">
                {invitation.invitedEmail || "No email recorded"}
              </p>
            </div>

            {!user ? (
              <div>
                <p className="text-sm leading-7 text-slate-600">
                  Sign in with the invited email before accepting this studio connection.
                </p>
                <Link
                  href={`/login?intent=public&next=${encodeURIComponent(`/studio-invites/${token}`)}`}
                  className="mt-4 inline-flex rounded-xl bg-purple-800 px-5 py-3 text-sm font-semibold text-white"
                >
                  Sign In to Continue
                </Link>
              </div>
            ) : emailMismatch ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="font-semibold text-amber-900">Wrong account signed in</p>
                <p className="mt-2 text-sm leading-6 text-amber-800">
                  You are signed in as {user.email}. Sign out and use {invitation.invitedEmail}.
                </p>
                <form action="/auth/logout" method="post" className="mt-4">
                  <button className="rounded-xl bg-amber-800 px-4 py-2 text-sm font-semibold text-white">
                    Sign Out
                  </button>
                </form>
              </div>
            ) : expired ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                This invitation has expired. Ask {invitation.studioName} to send a new one.
              </div>
            ) : invitation.status === "linked" ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="font-semibold text-emerald-900">Already connected</p>
                <Link
                  href={invitation.studioSlug ? `/portal/${invitation.studioSlug}` : "/account"}
                  className="mt-3 inline-flex rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"
                >
                  Open Studio Portal
                </Link>
              </div>
            ) : ["invited", "claim_pending"].includes(invitation.status) ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <form action={acceptStudioInviteAction}>
                  <input type="hidden" name="token" value={token} />
                  <button className="w-full rounded-xl bg-purple-800 px-5 py-3 text-sm font-semibold text-white hover:bg-purple-900">
                    Accept Studio Connection
                  </button>
                </form>
                <form action={rejectStudioInviteAction}>
                  <input type="hidden" name="token" value={token} />
                  <button className="w-full rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Reject Invitation
                  </button>
                </form>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                This invitation is currently marked {invitation.status.replaceAll("_", " ")}.
                {invitation.conflictDetails ? ` ${invitation.conflictDetails}` : ""}
              </div>
            )}

            <p className="text-xs leading-5 text-slate-500">
              Accepting gives this studio portal access to the client record they already maintain.
              It does not merge or transfer ownership of records from other studios.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
