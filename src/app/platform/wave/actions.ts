"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

export async function updateWaveRolloutAction(formData: FormData) {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const studioId = String(formData.get("studioId") ?? "");
  const status = String(formData.get("status") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();
  const confirmation = String(formData.get("confirmation") ?? "");

  if (!studioId || !["pilot", "active", "suspended"].includes(status)) {
    redirect("/platform/wave?status=invalid_rollout_change");
  }

  if (status === "suspended" && confirmation !== "SUSPEND") {
    redirect("/platform/wave?status=suspension_confirmation_required");
  }

  const { error } = await supabase.rpc("set_wave_posting_entitlement", {
    target_studio_id: studioId,
    target_status: status,
    target_notes: notes || null,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/platform/wave");
  redirect("/platform/wave?status=rollout_updated");
}
