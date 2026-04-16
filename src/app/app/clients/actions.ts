"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  CLIENT_REFERRAL_SOURCE_OPTIONS,
  CLIENT_SKILL_LEVEL_OPTIONS,
  CLIENT_STATUS_OPTIONS,
  isAllowedOptionValue,
  normalizeOptionValue,
} from "@/lib/forms/options";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

async function getCurrentUserStudioContext() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  return {
    supabase,
    studioId: context.studioId,
    role: context.studioRole ?? "",
    isPlatformAdmin: context.isPlatformAdmin ?? false,
  };
}

async function validateLinkedInstructor(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  linkedInstructorId: string | null;
}) {
  const { supabase, studioId, linkedInstructorId } = params;

  if (!linkedInstructorId) {
    return { ok: true as const };
  }

  const { data: instructor, error: instructorError } = await supabase
    .from("instructors")
    .select("id, studio_id")
    .eq("id", linkedInstructorId)
    .eq("studio_id", studioId)
    .single();

  if (instructorError || !instructor) {
    return {
      ok: false as const,
      error: "Selected linked instructor is invalid for this studio.",
    };
  }

  return { ok: true as const };
}

function validateClientDropdowns(params: {
  status: string;
  skillLevel: string;
  referralSource: string;
}) {
  const { status, skillLevel, referralSource } = params;

  if (!isAllowedOptionValue(CLIENT_STATUS_OPTIONS, status)) {
    return "Invalid client status.";
  }

  if (!isAllowedOptionValue(CLIENT_SKILL_LEVEL_OPTIONS, skillLevel)) {
    return "Invalid skill level.";
  }

  if (!isAllowedOptionValue(CLIENT_REFERRAL_SOURCE_OPTIONS, referralSource)) {
    return "Invalid referral source.";
  }

  return null;
}

export async function createClientAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await getCurrentUserStudioContext();

    const firstName = getString(formData, "firstName");
    const lastName = getString(formData, "lastName");
    const email = getString(formData, "email");
    const phone = getString(formData, "phone");
    const danceInterests = getString(formData, "danceInterests");
    const skillLevel = getString(formData, "skillLevel");
    const notes = getString(formData, "notes");
    const referralSource = getString(formData, "referralSource");
    const status = getString(formData, "status") || "lead";
    const linkedInstructorIdRaw = getString(formData, "linkedInstructorId");
    const isIndependentInstructor =
      formData.get("isIndependentInstructor") === "on";

    const linkedInstructorId = linkedInstructorIdRaw || null;

    if (!firstName || !lastName) {
      return { error: "First name and last name are required." };
    }

    const dropdownError = validateClientDropdowns({
      status,
      skillLevel,
      referralSource,
    });

    if (dropdownError) {
      return { error: dropdownError };
    }

    const linkedInstructorValidation = await validateLinkedInstructor({
      supabase,
      studioId,
      linkedInstructorId,
    });

    if (!linkedInstructorValidation.ok) {
      return { error: linkedInstructorValidation.error };
    }

    const { error } = await supabase.from("clients").insert({
      studio_id: studioId,
      first_name: firstName,
      last_name: lastName,
      email: email || null,
      phone: phone || null,
      dance_interests: danceInterests || null,
      skill_level: normalizeOptionValue(CLIENT_SKILL_LEVEL_OPTIONS, skillLevel),
      notes: notes || null,
      referral_source: normalizeOptionValue(
        CLIENT_REFERRAL_SOURCE_OPTIONS,
        referralSource
      ),
      status: normalizeOptionValue(CLIENT_STATUS_OPTIONS, status) ?? "lead",
      is_independent_instructor: isIndependentInstructor,
      linked_instructor_id: linkedInstructorId,
    });

    if (error) {
      return { error: `Client creation failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/clients");
}

export async function updateClientAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await getCurrentUserStudioContext();

    const clientId = getString(formData, "clientId");
    const firstName = getString(formData, "firstName");
    const lastName = getString(formData, "lastName");
    const email = getString(formData, "email");
    const phone = getString(formData, "phone");
    const danceInterests = getString(formData, "danceInterests");
    const skillLevel = getString(formData, "skillLevel");
    const notes = getString(formData, "notes");
    const referralSource = getString(formData, "referralSource");
    const status = getString(formData, "status") || "lead";
    const linkedInstructorIdRaw = getString(formData, "linkedInstructorId");
    const isIndependentInstructor =
      formData.get("isIndependentInstructor") === "on";

    const linkedInstructorId = linkedInstructorIdRaw || null;

    if (!clientId) {
      return { error: "Missing client id." };
    }

    if (!firstName || !lastName) {
      return { error: "First name and last name are required." };
    }

    const dropdownError = validateClientDropdowns({
      status,
      skillLevel,
      referralSource,
    });

    if (dropdownError) {
      return { error: dropdownError };
    }

    const { data: existingClient, error: existingClientError } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .single();

    if (existingClientError || !existingClient) {
      return { error: "Client not found." };
    }

    const linkedInstructorValidation = await validateLinkedInstructor({
      supabase,
      studioId,
      linkedInstructorId,
    });

    if (!linkedInstructorValidation.ok) {
      return { error: linkedInstructorValidation.error };
    }

    const { error } = await supabase
      .from("clients")
      .update({
        first_name: firstName,
        last_name: lastName,
        email: email || null,
        phone: phone || null,
        dance_interests: danceInterests || null,
        skill_level: normalizeOptionValue(CLIENT_SKILL_LEVEL_OPTIONS, skillLevel),
        notes: notes || null,
        referral_source: normalizeOptionValue(
          CLIENT_REFERRAL_SOURCE_OPTIONS,
          referralSource
        ),
        status: normalizeOptionValue(CLIENT_STATUS_OPTIONS, status) ?? "lead",
        is_independent_instructor: isIndependentInstructor,
        linked_instructor_id: linkedInstructorId,
      })
      .eq("id", clientId)
      .eq("studio_id", studioId);

    if (error) {
      return { error: `Client update failed: ${error.message}` };
    }

    redirect(`/app/clients/${clientId}`);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
}

export async function archiveClientAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || "/app/clients";

  if (!clientId) {
    redirect(appendQueryParam(returnTo, "error", "missing_client"));
  }

  const { supabase, studioId } = await getCurrentUserStudioContext();

  const { error } = await supabase
    .from("clients")
    .update({ status: "archived" })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (error) {
    redirect(appendQueryParam(returnTo, "error", "archive_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "client_archived"));
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

  const { supabase, studioId } = await getCurrentUserStudioContext();
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