"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyVerifiedEmail } from "@/lib/auth/verifiedIdentity";
import {
  acceptClientInvitation,
  rejectClientInvitation,
} from "@/lib/student-identity/lifecycle";

function formValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// GC-3.4B-0: only known lifecycle codes reach the URL; anything else
// (including raw database text) collapses to a generic failure code.
const INVITE_ERROR_CODES = new Set([
  "invite_not_found",
  "invite_expired",
  "invite_email_mismatch",
  "invite_verification_required",
  "invite_conflict",
  "invite_rejected",
  "invite_disconnected",
  "invite_former_client",
]);

function inviteErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return INVITE_ERROR_CODES.has(message) ? message : "invite_failed";
}

function invitePath(token: string) {
  return `/studio-invites/${encodeURIComponent(token)}`;
}

async function getInviteCaller(token: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?intent=public&next=${encodeURIComponent(invitePath(token))}`);
  }

  // GC-3.4B-0 (S3): the canonical verified email for this live session,
  // never user.email.
  return { userId: user.id, verifiedEmail: await getMyVerifiedEmail(supabase) };
}

export async function acceptStudioInviteAction(formData: FormData) {
  const token = formValue(formData, "token");
  if (!token) redirect("/account?error=invite_not_found");

  const caller = await getInviteCaller(token);

  // GC-3.4B-0 (S5): redirect() throws NEXT_REDIRECT, so it must never run
  // inside this try/catch; only the mutation does.
  let destination: string;
  try {
    const invitation = await acceptClientInvitation({ token, ...caller });
    destination = invitation.studioSlug
      ? `/portal/${encodeURIComponent(invitation.studioSlug)}?invite=accepted`
      : "/account?success=studio_invite_accepted";
  } catch (error) {
    destination = `${invitePath(token)}?error=${encodeURIComponent(inviteErrorCode(error))}`;
  }

  redirect(destination);
}

export async function rejectStudioInviteAction(formData: FormData) {
  const token = formValue(formData, "token");
  if (!token) redirect("/account?error=invite_not_found");

  const caller = await getInviteCaller(token);

  let destination = "/account?success=studio_invite_rejected";
  try {
    await rejectClientInvitation({ token, ...caller });
  } catch (error) {
    destination = `${invitePath(token)}?error=${encodeURIComponent(inviteErrorCode(error))}`;
  }

  redirect(destination);
}
