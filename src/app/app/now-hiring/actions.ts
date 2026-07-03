"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
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

export async function saveStudioJobPostingAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const postingId = getString(formData, "postingId");
  const title = getString(formData, "title");
  const status = getString(formData, "status") || "draft";

  if (!title) {
    redirect("/app/now-hiring?error=missing_title");
  }

  const now = new Date().toISOString();
  const payload = {
    studio_id: studioId,
    title,
    role_type: getString(formData, "roleType") || "instructor",
    employment_type: getString(formData, "employmentType") || "contract",
    location_type: getString(formData, "locationType") || "in_person",
    city: getOptionalString(formData, "city"),
    state: getOptionalString(formData, "state"),
    compensation_summary: getOptionalString(formData, "compensationSummary"),
    dance_styles: getList(formData, "danceStyles"),
    requirements: getOptionalString(formData, "requirements"),
    description: getOptionalString(formData, "description"),
    apply_url: getOptionalString(formData, "applyUrl"),
    apply_email: getOptionalString(formData, "applyEmail"),
    apply_phone: getOptionalString(formData, "applyPhone"),
    contact_name: getOptionalString(formData, "contactName"),
    status,
    published_at: status === "published" ? now : null,
    created_by: user.id,
    updated_at: now,
  };

  const { error } = postingId
    ? await supabase
        .from("studio_job_postings")
        .update(payload)
        .eq("id", postingId)
        .eq("studio_id", studioId)
    : await supabase.from("studio_job_postings").insert({
        ...payload,
        created_at: now,
      });

  if (error) {
    redirect("/app/now-hiring?error=save_failed");
  }

  revalidatePath("/app/now-hiring");
  revalidatePath("/discover/jobs");
  redirect("/app/now-hiring?success=saved");
}
