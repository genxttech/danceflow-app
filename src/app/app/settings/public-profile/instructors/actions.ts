"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";

function normalizeOptionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeOptionalInteger(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function savePublicInstructorAction(formData: FormData) {
  await requireStudioRole(["studio_owner", "studio_admin"]);

  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  const instructorId = String(formData.get("instructor_id") ?? "").trim();
  if (!instructorId) {
    throw new Error("Instructor is required.");
  }

  const { data: instructor, error: instructorError } = await supabase
    .from("instructors")
    .select("id, studio_id")
    .eq("id", instructorId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (instructorError || !instructor) {
    throw new Error("Instructor not found for this studio.");
  }

  const payload = {
    public_profile_enabled: formData.get("public_profile_enabled") === "on",
    public_bio: normalizeOptionalText(formData.get("public_bio")),
    public_photo_url: normalizeOptionalText(formData.get("public_photo_url")),
    specialties: normalizeOptionalText(formData.get("specialties")),
    years_experience: normalizeOptionalInteger(formData.get("years_experience")),
    display_order: normalizeOptionalInteger(formData.get("display_order")) ?? 0,
  };

  const { error: updateError } = await supabase
    .from("instructors")
    .update(payload)
    .eq("id", instructorId)
    .eq("studio_id", context.studioId);

  if (updateError) {
    throw new Error(`Failed to save instructor public profile: ${updateError.message}`);
  }

  revalidatePath("/app/settings/public-profile/instructors");
  revalidatePath("/app/settings/public-profile");

  const { data: studio } = await supabase
    .from("studios")
    .select("slug")
    .eq("id", context.studioId)
    .maybeSingle();

  if (studio?.slug) {
    revalidatePath(`/studios/${studio.slug}`);
  }

  redirect("/app/settings/public-profile/instructors?saved=1");
}