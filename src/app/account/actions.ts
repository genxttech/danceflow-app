"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  deleteDanceFlowAccount,
  leaveStudioRelationship,
} from "@/lib/student-identity/account-controls";
import {
  deactivateDanceFlowAccount,
  normalizeAccountEmail,
} from "@/lib/student-identity/account-security";

function value(formData: FormData, key: string) {
  const item = formData.get(key);
  return typeof item === "string" ? item.trim() : "";
}

export async function leaveStudioAction(formData: FormData) {
  const linkId = value(formData, "linkId");
  const studioId = value(formData, "studioId");
  const confirmation = value(formData, "confirmation");
  const reason = value(formData, "reason");

  if (!linkId || !studioId || confirmation !== "LEAVE") {
    redirect("/account?error=leave_confirmation_required");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  try {
    await leaveStudioRelationship({ user, linkId, studioId, reason });
  } catch (error) {
    console.error("Leave studio failed", error);
    redirect("/account?error=leave_studio_failed");
  }

  redirect("/account?success=studio_left");
}

export async function deleteAccountAction(formData: FormData) {
  const confirmation = value(formData, "confirmation");

  if (confirmation !== "DELETE") {
    redirect("/account?error=delete_confirmation_required");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  try {
    await deleteDanceFlowAccount(user);
  } catch (error) {
    console.error("Account deletion failed", error);
    redirect("/account?error=account_delete_failed");
  }

  redirect("/?account=deleted");
}


export async function requestLoginEmailChangeAction(formData: FormData) {
  const requestedEmail = value(formData, "email");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  let email: string;
  try {
    email = normalizeAccountEmail(requestedEmail);
  } catch {
    redirect("/account?error=invalid_login_email");
  }

  if (email === user.email?.trim().toLowerCase()) {
    redirect("/account?error=login_email_unchanged");
  }

  const redirectTo = `${
    process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com"
  }/account?success=email_change_confirmed`;

  const { error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: redirectTo },
  );

  if (error) {
    console.error("Web login email change request failed", error.message);
    redirect("/account?error=login_email_change_failed");
  }

  redirect("/account?success=email_change_requested");
}

export async function deactivateAccountAction(formData: FormData) {
  const confirmation = value(formData, "confirmation");
  const reason = value(formData, "reason");

  if (confirmation !== "DEACTIVATE") {
    redirect("/account?error=deactivate_confirmation_required");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  try {
    await deactivateDanceFlowAccount({ user, reason });
    await supabase.auth.signOut();
  } catch (error) {
    console.error("Account deactivation failed", error);
    redirect("/account?error=account_deactivate_failed");
  }

  redirect("/login?account=deactivated");
}
