"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireInstructorManageAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getCheckbox(formData: FormData, key: string) {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

function getOptionalInteger(formData: FormData, key: string) {
  const value = getString(formData, key);
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFile(formData: FormData, key: string) {
  const value = formData.get(key);

  if (value instanceof File && value.size > 0) {
    return value;
  }

  return null;
}

function safeFileName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function uploadInstructorPhoto({
  supabase,
  studioId,
  file,
}: {
  supabase: Awaited<ReturnType<typeof requireInstructorManageAccess>>["supabase"];
  studioId: string;
  file: File | null;
}) {
  if (!file) return null;

  if (!file.type.startsWith("image/")) {
    throw new Error("Instructor photo must be an image file.");
  }

  const maxBytes = 5 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error("Instructor photo must be smaller than 5 MB.");
  }

  const extension = safeFileName(file.name).split(".").pop() || "jpg";
  const storagePath = `${studioId}/${randomBytes(16).toString("hex")}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from("instructor-photos")
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Instructor photo upload failed: ${uploadError.message}`);
  }

  const { data } = supabase.storage
    .from("instructor-photos")
    .getPublicUrl(storagePath);

  return data.publicUrl;
}

function credentialStatusFor(
  certifications: string,
  titles: string,
  proofUrl: string,
) {
  if (certifications || titles || proofUrl) return "submitted";
  return "unverified";
}

export async function createInstructorAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId, user } = await requireInstructorManageAccess();

    const firstName = getString(formData, "firstName");
    const lastName = getString(formData, "lastName");
    const email = getString(formData, "email");
    const phone = getString(formData, "phone");
    const specialties = getString(formData, "specialties");
    const publicProfileEnabled = getCheckbox(formData, "publicProfileEnabled");
    const publicPhotoUrl = getString(formData, "publicPhotoUrl");
    const instructorPhoto = getFile(formData, "instructorPhoto");
    const uploadedPhotoUrl = await uploadInstructorPhoto({
      supabase,
      studioId,
      file: instructorPhoto,
    });
    const finalPhotoUrl = uploadedPhotoUrl || publicPhotoUrl;
    const publicTitle = getString(formData, "publicTitle");
    const publicBio = getString(formData, "publicBio");
    const publicSpecialties = getString(formData, "publicSpecialties");
    const teachingCertifications = getString(formData, "teachingCertifications");
    const competitiveTitles = getString(formData, "competitiveTitles");
    const credentialProofUrl = getString(formData, "credentialProofUrl");
    const credentialStatus = credentialStatusFor(
      teachingCertifications,
      competitiveTitles,
      credentialProofUrl,
    );
    const yearsExperience = getOptionalInteger(formData, "yearsExperience");
    const displayOrder = getOptionalInteger(formData, "displayOrder") ?? 0;

    if (!firstName || !lastName) {
      return { error: "First name and last name are required." };
    }

    const { error } = await supabase.from("instructors").insert({
      studio_id: studioId,
      first_name: firstName,
      last_name: lastName,
      email: email || null,
      phone: phone || null,
      specialties: specialties || null,
      public_profile_enabled: publicProfileEnabled,
      public_photo_url: finalPhotoUrl || null,
      public_title: publicTitle || null,
      public_bio: publicBio || null,
      public_specialties: publicSpecialties || null,
      teaching_certifications: teachingCertifications || null,
      competitive_titles: competitiveTitles || null,
      credential_proof_url: credentialProofUrl || null,
      credentials_verification_status: credentialStatus,
      credentials_submitted_at: credentialStatus === "submitted" ? new Date().toISOString() : null,
      credentials_review_note: null,
      years_experience: yearsExperience,
      display_order: displayOrder,
      active: true,
      created_by: user.id,
    });

    if (error) {
      return { error: `Instructor creation failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/instructors");
}

export async function updateInstructorAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await requireInstructorManageAccess();

    const instructorId = getString(formData, "instructorId");
    const firstName = getString(formData, "firstName");
    const lastName = getString(formData, "lastName");
    const email = getString(formData, "email");
    const phone = getString(formData, "phone");
    const specialties = getString(formData, "specialties");
    const publicProfileEnabled = getCheckbox(formData, "publicProfileEnabled");
    const publicPhotoUrl = getString(formData, "publicPhotoUrl");
    const instructorPhoto = getFile(formData, "instructorPhoto");
    const uploadedPhotoUrl = await uploadInstructorPhoto({
      supabase,
      studioId,
      file: instructorPhoto,
    });
    const finalPhotoUrl = uploadedPhotoUrl || publicPhotoUrl;
    const publicTitle = getString(formData, "publicTitle");
    const publicBio = getString(formData, "publicBio");
    const publicSpecialties = getString(formData, "publicSpecialties");
    const teachingCertifications = getString(formData, "teachingCertifications");
    const competitiveTitles = getString(formData, "competitiveTitles");
    const credentialProofUrl = getString(formData, "credentialProofUrl");
    const credentialStatus = credentialStatusFor(
      teachingCertifications,
      competitiveTitles,
      credentialProofUrl,
    );
    const yearsExperience = getOptionalInteger(formData, "yearsExperience");
    const displayOrder = getOptionalInteger(formData, "displayOrder") ?? 0;
    const active = getString(formData, "active");

    if (!instructorId) {
      return { error: "Missing instructor ID." };
    }

    if (!firstName || !lastName) {
      return { error: "First name and last name are required." };
    }

    const { error } = await supabase
      .from("instructors")
      .update({
        first_name: firstName,
        last_name: lastName,
        email: email || null,
        phone: phone || null,
        specialties: specialties || null,
        public_profile_enabled: publicProfileEnabled,
        public_photo_url: finalPhotoUrl || null,
        public_title: publicTitle || null,
        public_bio: publicBio || null,
        public_specialties: publicSpecialties || null,
        teaching_certifications: teachingCertifications || null,
        competitive_titles: competitiveTitles || null,
        credential_proof_url: credentialProofUrl || null,
        credentials_verification_status: credentialStatus,
        credentials_submitted_at: credentialStatus === "submitted" ? new Date().toISOString() : null,
        credentials_verified_at: null,
        credentials_verified_by: null,
        years_experience: yearsExperience,
        display_order: displayOrder,
        active: active === "true",
      })
      .eq("id", instructorId)
      .eq("studio_id", studioId);

    if (error) {
      return { error: `Instructor update failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/instructors");
}

export async function deactivateInstructorAction(formData: FormData) {
  const { supabase, studioId } = await requireInstructorManageAccess();

  const instructorId = getString(formData, "instructorId");

  if (!instructorId) {
    throw new Error("Missing instructor ID.");
  }

  const { error } = await supabase
    .from("instructors")
    .update({ active: false })
    .eq("id", instructorId)
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(`Deactivate instructor failed: ${error.message}`);
  }

  redirect("/app/instructors");
}

function createFeedToken() {
  return randomBytes(32).toString("base64url");
}

export async function createInstructorCalendarFeedAction(formData: FormData) {
  const { supabase, studioId } = await requireInstructorManageAccess();

  const instructorId = getString(formData, "instructorId");

  if (!instructorId) {
    throw new Error("Missing instructor ID.");
  }

  const { data: instructor, error: instructorError } = await supabase
    .from("instructors")
    .select("id, studio_id")
    .eq("id", instructorId)
    .eq("studio_id", studioId)
    .single();

  if (instructorError || !instructor) {
    throw new Error(
      `Could not verify instructor before creating calendar feed: ${
        instructorError?.message ?? "Instructor not found."
      }`
    );
  }

  const { error } = await supabase.from("instructor_calendar_feeds").upsert(
    {
      studio_id: studioId,
      instructor_id: instructorId,
      token: createFeedToken(),
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "instructor_id" }
  );

  if (error) {
    throw new Error(`Could not create calendar feed: ${error.message}`);
  }

  revalidatePath("/app/instructors");
  redirect("/app/instructors");
}

export async function regenerateInstructorCalendarFeedAction(formData: FormData) {
  const { supabase, studioId } = await requireInstructorManageAccess();

  const instructorId = getString(formData, "instructorId");

  if (!instructorId) {
    throw new Error("Missing instructor ID.");
  }

  const { data: instructor, error: instructorError } = await supabase
    .from("instructors")
    .select("id, studio_id")
    .eq("id", instructorId)
    .eq("studio_id", studioId)
    .single();

  if (instructorError || !instructor) {
    throw new Error(
      `Could not verify instructor before regenerating calendar feed: ${
        instructorError?.message ?? "Instructor not found."
      }`
    );
  }

  const { error } = await supabase.from("instructor_calendar_feeds").upsert(
    {
      studio_id: studioId,
      instructor_id: instructorId,
      token: createFeedToken(),
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "instructor_id" }
  );

  if (error) {
    throw new Error(`Could not regenerate calendar feed: ${error.message}`);
  }

  revalidatePath("/app/instructors");
  redirect("/app/instructors");
}

