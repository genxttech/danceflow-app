"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  acceptClientInvitation,
  rejectClientInvitation,
} from "@/lib/student-identity/lifecycle";

function formValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function acceptStudioInviteAction(formData: FormData) {
  const token = formValue(formData, "token");
  if (!token) redirect("/account?error=invite_not_found");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect(`/login?intent=public&next=${encodeURIComponent(`/studio-invites/${token}`)}`);
  }

  try {
    const invitation = await acceptClientInvitation({
      token,
      userId: user.id,
      userEmail: user.email,
    });

    if (invitation.studioSlug) {
      redirect(
        `/portal/${encodeURIComponent(invitation.studioSlug)}?invite=accepted`,
      );
    }

    redirect("/account?success=studio_invite_accepted");
  } catch (error) {
    const code = error instanceof Error ? error.message : "invite_failed";
    redirect(
      `/studio-invites/${encodeURIComponent(token)}?error=${encodeURIComponent(code)}`,
    );
  }
}

export async function rejectStudioInviteAction(formData: FormData) {
  const token = formValue(formData, "token");
  if (!token) redirect("/account?error=invite_not_found");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect(`/login?intent=public&next=${encodeURIComponent(`/studio-invites/${token}`)}`);
  }

  try {
    await rejectClientInvitation({
      token,
      userId: user.id,
      userEmail: user.email,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "invite_failed";
    redirect(
      `/studio-invites/${encodeURIComponent(token)}?error=${encodeURIComponent(code)}`,
    );
  }

  redirect("/account?success=studio_invite_rejected");
}
