"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import {
  cleanTextValue,
  getValidatedValue,
  normalizeOptionalUuid,
  normalizeRequiredEnum,
  rawFormString,
} from "@/lib/validation/forms";

export async function updateWaveRolloutAction(formData: FormData) {
  await requirePlatformAdmin();

  const studioIdResult = normalizeOptionalUuid(rawFormString(formData, "studioId"), "Studio");
  const statusResult = normalizeRequiredEnum(
    rawFormString(formData, "status"),
    ["pilot", "active", "suspended"] as const,
    "Wave rollout status",
  );
  const notesResult = cleanTextValue(rawFormString(formData, "notes"), {
    fieldLabel: "Notes",
    maxLength: 1200,
    allowNewlines: true,
  });

  if (!studioIdResult.ok || !studioIdResult.value || !statusResult.ok || !notesResult.ok) {
    redirect("/platform/wave?status=invalid_rollout_change");
  }

  const studioId = studioIdResult.value;
  const status = getValidatedValue(statusResult);
  const notes = getValidatedValue(notesResult);
  const confirmation = rawFormString(formData, "confirmation");

  if (status === "suspended" && confirmation !== "SUSPEND") {
    redirect("/platform/wave?status=suspension_confirmation_required");
  }

  const supabase = await createClient();
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
