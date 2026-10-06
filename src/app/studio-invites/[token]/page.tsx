import type { ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { buildEmailVerificationPath } from "@/lib/auth/verifiedEmail";
import { getMyVerifiedEmail } from "@/lib/auth/verifiedIdentity";
import {
  clientInvitationIdentity,
  getClientInvitationByToken,
} from "@/lib/student-identity/lifecycle";
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
    return "This invitation was sent to a different email address than the one on this account.";
  }
  if (code === "invite_verification_required") {
    return "Confirm your email address before accepting this invitation.";
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

function isInvitationExpired(inviteExpiresAt: string | null) {
  return Boolean(inviteExpiresAt && new Date(inviteExpiresAt).getTime() <= Date.now());
}

function GenericInviteState({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-4 py-12">
      <div className="w-full rounded-[32px] border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">{message}</p>
        {children}
      </div>
    </main>
  );
}

function OpenAccountLink() {
  return (
    <Link href="/account" className="mt-6 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
      Open My Account
    </Link>
  );
}

/*
  GC-3.4B-0 render order. Invitation detail (studio, client name, invited
  email) is shown only to a signed-out holder of the mailbox-delivered token
  (the existing invitation design) or to a signed-in account whose VERIFIED
  email matches the invitation. A handled invitation, a mismatched account
  and an unverified account see generic states with no client, email or
  relationship detail.
*/
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
  const message = errorMessage(search.error);
  const invitePath = `/studio-invites/${encodeURIComponent(token)}`;

  if (!invitation) {
    return (
      <GenericInviteState
        title="Invitation not found"
        message="This link is invalid or has already been replaced by a newer invitation."
      >
        <OpenAccountLink />
      </GenericInviteState>
    );
  }

  if (!["invited", "claim_pending"].includes(invitation.status)) {
    return (
      <GenericInviteState
        title="Invitation already handled"
        message={message ?? "This invitation has already been used or closed. If you need access, contact the studio."}
      >
        {/* Generic on purpose: /account lists the viewer's own Student Portals, so no studio is named here. */}
        <Link href="/account" className="mt-6 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
          Open Student Portal
        </Link>
      </GenericInviteState>
    );
  }

  if (user) {
    const identity = clientInvitationIdentity(
      invitation.invitedEmail,
      await getMyVerifiedEmail(supabase),
    );

    if (identity === "verification_required") {
      return (
        <GenericInviteState
          title="Confirm your email to continue"
          message="Before accepting a studio invitation, confirm the email address on your DanceFlow account."
        >
          <Link
            href={buildEmailVerificationPath(invitePath)}
            className="mt-6 inline-flex rounded-xl bg-purple-800 px-5 py-3 text-sm font-semibold text-white"
          >
            Confirm My Email
          </Link>
        </GenericInviteState>
      );
    }

    if (identity === "mismatch") {
      return (
        <GenericInviteState
          title="This invitation is for a different account"
          message="Sign out, then open the invitation link from the email the studio sent and sign in with that email address."
        >
          <form action="/auth/logout" method="post" className="mt-6">
            <button className="rounded-xl bg-amber-800 px-5 py-3 text-sm font-semibold text-white">
              Sign Out
            </button>
          </form>
        </GenericInviteState>
      );
    }
  }

  const expired = isInvitationExpired(invitation.inviteExpiresAt);

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
                  href={`/login?intent=public&next=${encodeURIComponent(invitePath)}`}
                  className="mt-4 inline-flex rounded-xl bg-purple-800 px-5 py-3 text-sm font-semibold text-white"
                >
                  Sign In to Continue
                </Link>
              </div>
            ) : expired ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                This invitation has expired. Ask {invitation.studioName} to send a new one.
              </div>
            ) : (
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
            )}

            <p className="text-xs leading-5 text-slate-500">
              Accepting gives this student portal access to the client record they already maintain.
              It does not merge or transfer ownership of records from other studios.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
