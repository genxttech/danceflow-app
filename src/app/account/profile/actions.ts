"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getDancerProfile,
  normalizeDancerProfileUpdate,
  updateDancerProfile,
} from "@/lib/student-identity/profile";

function value(formData: FormData, key: string) {
  const item = formData.get(key);
  return typeof item === "string" ? item : "";
}

function list(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function updateAccountDancerProfileAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?intent=public&next=/account/profile");
  }

  try {
    const current = await getDancerProfile(user);
    const input = normalizeDancerProfileUpdate({
      firstName: value(formData, "firstName"),
      lastName: value(formData, "lastName"),
      preferredName: value(formData, "preferredName"),
      phone: value(formData, "phone"),
      birthday: value(formData, "birthday"),
      photoUrl: current.photoUrl,
      addressLine1: value(formData, "addressLine1"),
      addressLine2: value(formData, "addressLine2"),
      city: value(formData, "city"),
      state: value(formData, "state"),
      postalCode: value(formData, "postalCode"),
      country: value(formData, "country"),
      danceInterests: value(formData, "danceInterests"),
      danceGoals: list(value(formData, "danceGoals")),
      skillLevel: value(formData, "skillLevel"),
      bio: value(formData, "bio"),
      profileVisibility: value(formData, "profileVisibility") || "private",
    });

    await updateDancerProfile(user, input);
  } catch (error) {
    console.error("Web dancer profile update failed", error);
    redirect("/account/profile?error=profile_update_failed");
  }

  redirect("/account/profile?success=profile_updated");
}
