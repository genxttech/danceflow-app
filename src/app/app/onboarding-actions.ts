"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

function normalizeChecklistType(value: FormDataEntryValue | string | null | undefined) {
  const checklistTypeRaw = String(value ?? "studio").trim();
  return checklistTypeRaw === "organizer" ? "organizer" : "studio";
}

export async function dismissWorkspaceOnboardingAction(formData: FormData) {
  const checklistType = normalizeChecklistType(formData.get("checklistType"));

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to hide the setup checklist.");
  }

  const context = await getCurrentStudioContext();
  const now = new Date().toISOString();

  const { error } = await supabase.from("workspace_onboarding_preferences").upsert(
    {
      studio_id: context.studioId,
      user_id: user.id,
      checklist_type: checklistType,
      dismissed_at: now,
      updated_at: now,
    },
    {
      onConflict: "studio_id,user_id,checklist_type",
    }
  );

  if (error) {
    throw new Error(`Could not hide setup checklist: ${error.message}`);
  }

  revalidatePath("/app");
}

export async function completeWorkspaceOnboardingAction(checklistTypeInput: "studio" | "organizer") {
  const checklistType = normalizeChecklistType(checklistTypeInput);

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to complete the setup checklist.");
  }

  const context = await getCurrentStudioContext();
  const now = new Date().toISOString();

  const { error } = await supabase.from("workspace_onboarding_preferences").upsert(
    {
      studio_id: context.studioId,
      user_id: user.id,
      checklist_type: checklistType,
      completed_at: now,
      updated_at: now,
    },
    {
      onConflict: "studio_id,user_id,checklist_type",
    }
  );

  if (error) {
    throw new Error(`Could not complete setup checklist: ${error.message}`);
  }

  revalidatePath("/app");
}