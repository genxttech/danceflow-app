"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value.length ? value : null;
}

function getList(formData: FormData, key: string) {
  return getString(formData, key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function savePartnerSearchProfileAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const displayName = getString(formData, "displayName");
  const visibility = getString(formData, "visibility") || "draft";

  if (!displayName) {
    redirect("/app/partner-search?error=missing_name");
  }

  const now = new Date().toISOString();
  const payload = {
    user_id: user.id,
    display_name: displayName,
    headline: getOptionalString(formData, "headline"),
    bio: getOptionalString(formData, "bio"),
    city: getOptionalString(formData, "city"),
    state: getOptionalString(formData, "state"),
    lead_follow_role: getString(formData, "leadFollowRole") || "either",
    dance_styles: getList(formData, "danceStyles"),
    skill_level: getString(formData, "skillLevel") || "social",
    goals: getList(formData, "goals"),
    availability_notes: getOptionalString(formData, "availabilityNotes"),
    contact_preference: getString(formData, "contactPreference") || "message",
    contact_email: getOptionalString(formData, "contactEmail"),
    contact_phone: getOptionalString(formData, "contactPhone"),
    visibility,
    published_at: visibility === "published" ? now : null,
    updated_at: now,
  };

  const { data: existing, error: existingError } = await supabase
    .from("dancer_partner_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle<{ id: string }>();

  if (existingError) {
    redirect("/app/partner-search?error=save_failed");
  }

  const { error } = existing?.id
    ? await supabase
        .from("dancer_partner_profiles")
        .update(payload)
        .eq("id", existing.id)
        .eq("user_id", user.id)
    : await supabase.from("dancer_partner_profiles").insert({
        ...payload,
        created_at: now,
      });

  if (error) {
    redirect("/app/partner-search?error=save_failed");
  }

  revalidatePath("/app/partner-search");
  revalidatePath("/discover/partners");
  redirect("/app/partner-search?success=saved");
}
