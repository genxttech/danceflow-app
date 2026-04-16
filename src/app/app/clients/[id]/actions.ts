"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { canEditClients } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

export async function updateIndependentInstructorSettingsAction(
  formData: FormData
) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;
  const linkedInstructorIdRaw = getString(formData, "linkedInstructorId");
  const isIndependentInstructor = formData.get("isIndependentInstructor") === "on";

  if (!clientId) {
    redirect(appendQueryParam("/app/clients", "error", "missing_client"));
  }

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canEditClients(role)) {
    redirect(appendQueryParam(returnTo, "error", "unauthorized"));
  }

  const linkedInstructorId = linkedInstructorIdRaw || null;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, studio_id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .single();

  if (clientError || !client) {
    redirect(appendQueryParam(returnTo, "error", "client_not_found"));
  }

  if (linkedInstructorId) {
    const { data: instructor, error: instructorError } = await supabase
      .from("instructors")
      .select("id, studio_id")
      .eq("id", linkedInstructorId)
      .eq("studio_id", studioId)
      .single();

    if (instructorError || !instructor) {
      redirect(
        appendQueryParam(returnTo, "error", "invalid_linked_instructor")
      );
    }
  }

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      is_independent_instructor: isIndependentInstructor,
      linked_instructor_id: linkedInstructorId,
    })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (updateError) {
    redirect(
      appendQueryParam(returnTo, "error", "independent_instructor_update_failed")
    );
  }

  redirect(
    appendQueryParam(returnTo, "success", "independent_instructor_updated")
  );
}