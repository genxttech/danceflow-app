"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireInstructorManageAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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
