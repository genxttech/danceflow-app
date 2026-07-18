"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  deleteDanceFlowAccount,
  leaveStudioRelationship,
} from "@/lib/student-identity/account-controls";

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
