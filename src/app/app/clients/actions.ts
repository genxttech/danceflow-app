"use server";

import { randomUUID } from "crypto";
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
import {
  cleanFormText,
  getValidationError,
  getValidatedValue,
  normalizeOptionalDate,
  normalizeOptionalEmail,
  normalizeOptionalPhone,
  normalizeOptionalUuid,
  normalizeTextList,
  rawFormString,
} from "@/lib/validation/forms";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getStringList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function normalizeClientTextList(
  formData: FormData,
  key: string,
  fieldLabel: string,
  allowedValues: readonly string[]
) {
  return normalizeTextList(getStringList(formData, key), {
    fieldLabel,
    maxItems: 40,
    maxItemLength: 120,
    allowedValues,
  });
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

const CLIENT_PHOTO_BUCKET = "client-photos";
const MAX_CLIENT_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_CLIENT_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CLIENT_DANCE_STYLE_VALUES = [
  "American Smooth",
  "American Smooth - Waltz",
  "American Smooth - Tango",
  "American Smooth - Foxtrot",
  "American Smooth - Viennese Waltz",
  "American Rhythm",
  "American Rhythm - Cha Cha",
  "American Rhythm - Rumba",
  "American Rhythm - East Coast Swing",
  "American Rhythm - Bolero",
  "American Rhythm - Mambo",
  "International Ballroom",
  "International Ballroom - Waltz",
  "International Ballroom - Tango",
  "International Ballroom - Viennese Waltz",
  "International Ballroom - Foxtrot",
  "International Ballroom - Quickstep",
  "International Latin",
  "International Latin - Cha Cha",
  "International Latin - Samba",
  "International Latin - Rumba",
  "International Latin - Paso Doble",
  "International Latin - Jive",
  "Country",
  "Country - Two Step",
  "Country - West Coast Swing",
  "Country - Nightclub Two Step",
  "Country - Waltz",
  "Country - Polka",
  "Social / Club",
  "Social / Club - Salsa",
  "Social / Club - Bachata",
  "Social / Club - Merengue",
  "Social / Club - Hustle",
  "Social / Club - Argentine Tango"
] as const;

const CLIENT_DANCE_GOAL_VALUES = [
  "Social dancing",
  "Practice partner",
  "Wedding dance",
  "Date night",
  "Showcase",
  "Competition",
  "Confidence",
  "Fitness",
  "New hobby",
  "Meet people",
  "Improve technique",
  "Prepare for an event"
] as const;


function getOptionalImageFile(formData: FormData, key: string) {
  const value = formData.get(key);

  if (!(value instanceof File) || value.size === 0) {
    return null;
  }

  return value;
}

function safePhotoFileName(file: File) {
  const extension =
    file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";

  const baseName = file.name
    .replace(/\.[^/.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);

  return `${baseName || "client-photo"}.${extension}`;
}

async function uploadClientPhoto(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
  file: File | null;
}) {
  const { supabase, studioId, clientId, file } = params;

  if (!file) {
    return { url: null as string | null, error: null as string | null };
  }

  if (!ALLOWED_CLIENT_PHOTO_TYPES.has(file.type)) {
    return {
      url: null,
      error: "Client photo must be a JPG, PNG, or WebP image.",
    };
  }

  if (file.size > MAX_CLIENT_PHOTO_BYTES) {
    return {
      url: null,
      error: "Client photo must be 5MB or smaller.",
    };
  }

  const photoPath = `${studioId}/${clientId}/${Date.now()}-${safePhotoFileName(file)}`;
  const { error: uploadError } = await supabase.storage
    .from(CLIENT_PHOTO_BUCKET)
    .upload(photoPath, file, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return {
      url: null,
      error: `Client photo upload failed: ${uploadError.message}`,
    };
  }

  const { data } = supabase.storage.from(CLIENT_PHOTO_BUCKET).getPublicUrl(photoPath);

  return { url: data.publicUrl, error: null as string | null };
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

  if (!status || !isAllowedOptionValue(CLIENT_STATUS_OPTIONS, status)) {
    return "Invalid client status.";
  }

  if (
    skillLevel &&
    !isAllowedOptionValue(CLIENT_SKILL_LEVEL_OPTIONS, skillLevel)
  ) {
    return "Invalid skill level.";
  }

  if (
    referralSource &&
    !isAllowedOptionValue(CLIENT_REFERRAL_SOURCE_OPTIONS, referralSource)
  ) {
    return "Invalid referral source.";
  }

  return null;
}

function normalizeClientPayload(params: {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  birthday: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  danceStyles: string[];
  danceInterests?: string;
  danceGoals?: string[];
  includeDanceGoals?: boolean;
  skillLevel: string;
  notes: string;
  referralSource: string;
  status: string;
  linkedInstructorId: string | null;
  isIndependentInstructor: boolean;
}) {
  const {
    firstName,
    lastName,
    email,
    phone,
    birthday,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    danceStyles,
    danceInterests,
    danceGoals,
    includeDanceGoals = false,
    skillLevel,
    notes,
    referralSource,
    status,
    linkedInstructorId,
    isIndependentInstructor,
  } = params;

  const normalizedLinkedInstructorId = isIndependentInstructor
    ? linkedInstructorId
    : null;
  const normalizedDanceInterests = danceStyles.length
    ? danceStyles.join(", ")
    : danceInterests ?? "";

  return {
    first_name: firstName,
    last_name: lastName,
    email: email || null,
    phone: phone || null,
    birthday: birthday || null,
    address_line1: addressLine1 || null,
    address_line2: addressLine2 || null,
    city: city || null,
    state: state || null,
    postal_code: postalCode || null,
    country: country || null,
    dance_interests: normalizedDanceInterests || null,
    ...(includeDanceGoals ? { dance_goals: danceGoals?.length ? danceGoals : null } : {}),
    skill_level: skillLevel
      ? normalizeOptionValue(CLIENT_SKILL_LEVEL_OPTIONS, skillLevel)
      : null,
    notes: notes || null,
    referral_source: referralSource
      ? normalizeOptionValue(CLIENT_REFERRAL_SOURCE_OPTIONS, referralSource)
      : null,
    status: normalizeOptionValue(CLIENT_STATUS_OPTIONS, status) ?? "lead",
    is_independent_instructor: isIndependentInstructor,
    linked_instructor_id: normalizedLinkedInstructorId,
  };
}

export async function createClientAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await getCurrentUserStudioContext();

    const firstNameResult = cleanFormText(formData, "firstName", {
      fieldLabel: "First name",
      maxLength: 80,
      required: true,
    });
    const lastNameResult = cleanFormText(formData, "lastName", {
      fieldLabel: "Last name",
      maxLength: 80,
      required: true,
    });
    const emailResult = normalizeOptionalEmail(rawFormString(formData, "email"));
    const phoneResult = normalizeOptionalPhone(rawFormString(formData, "phone"));
    const birthdayResult = normalizeOptionalDate(rawFormString(formData, "birthday"), "Birthday");
    const addressLine1Result = cleanFormText(formData, "addressLine1", {
      fieldLabel: "Address line 1",
      maxLength: 160,
    });
    const addressLine2Result = cleanFormText(formData, "addressLine2", {
      fieldLabel: "Address line 2",
      maxLength: 160,
    });
    const cityResult = cleanFormText(formData, "city", {
      fieldLabel: "City",
      maxLength: 80,
    });
    const stateResult = cleanFormText(formData, "state", {
      fieldLabel: "State",
      maxLength: 80,
    });
    const postalCodeResult = cleanFormText(formData, "postalCode", {
      fieldLabel: "ZIP / postal code",
      maxLength: 20,
    });
    const countryResult = cleanFormText(formData, "country", {
      fieldLabel: "Country",
      maxLength: 80,
    });
    const danceStylesResult = normalizeClientTextList(
      formData,
      "danceStyles",
      "Dance styles",
      CLIENT_DANCE_STYLE_VALUES
    );
    const danceGoalsResult = normalizeClientTextList(
      formData,
      "danceGoals",
      "Dance goals",
      CLIENT_DANCE_GOAL_VALUES
    );
    const notesResult = cleanFormText(formData, "notes", {
      fieldLabel: "Notes",
      maxLength: 3000,
      allowNewlines: true,
    });
    const partnerFirstNameResult = cleanFormText(formData, "partnerFirstName", {
      fieldLabel: "Partner first name",
      maxLength: 80,
    });
    const partnerLastNameResult = cleanFormText(formData, "partnerLastName", {
      fieldLabel: "Partner last name",
      maxLength: 80,
    });
    const partnerEmailResult = normalizeOptionalEmail(
      rawFormString(formData, "partnerEmail"),
      "Partner email"
    );
    const partnerPhoneResult = normalizeOptionalPhone(
      rawFormString(formData, "partnerPhone"),
      "Partner phone"
    );
    const partnerDanceStylesResult = normalizeClientTextList(
      formData,
      "partnerDanceStyles",
      "Partner dance styles",
      CLIENT_DANCE_STYLE_VALUES
    );
    const partnerDanceGoalsResult = normalizeClientTextList(
      formData,
      "partnerDanceGoals",
      "Partner dance goals",
      CLIENT_DANCE_GOAL_VALUES
    );
    const linkedInstructorIdResult = normalizeOptionalUuid(
      rawFormString(formData, "linkedInstructorId"),
      "Linked instructor"
    );

    const validationError = getValidationError([
      firstNameResult,
      lastNameResult,
      emailResult,
      phoneResult,
      birthdayResult,
      addressLine1Result,
      addressLine2Result,
      cityResult,
      stateResult,
      postalCodeResult,
      countryResult,
      danceStylesResult,
      danceGoalsResult,
      notesResult,
      partnerFirstNameResult,
      partnerLastNameResult,
      partnerEmailResult,
      partnerPhoneResult,
      partnerDanceStylesResult,
      partnerDanceGoalsResult,
      linkedInstructorIdResult,
    ]);
    if (validationError) {
      return { error: validationError };
    }

    const firstName = getValidatedValue(firstNameResult);
    const lastName = getValidatedValue(lastNameResult);
    const email = getValidatedValue(emailResult);
    const phone = getValidatedValue(phoneResult);
    const birthday = getValidatedValue(birthdayResult) ?? "";
    const addressLine1 = getValidatedValue(addressLine1Result);
    const addressLine2 = getValidatedValue(addressLine2Result);
    const city = getValidatedValue(cityResult);
    const state = getValidatedValue(stateResult);
    const postalCode = getValidatedValue(postalCodeResult);
    const country = getValidatedValue(countryResult);
    const danceStyles = getValidatedValue(danceStylesResult);
    const danceGoals = getValidatedValue(danceGoalsResult);
    const skillLevel = getString(formData, "skillLevel");
    const notes = getValidatedValue(notesResult);
    const referralSource = getString(formData, "referralSource");
    const status = getString(formData, "status") || "lead";
    const linkedInstructorId = getValidatedValue(linkedInstructorIdResult);
    const isIndependentInstructor =
      formData.get("isIndependentInstructor") === "on";
    const clientPhoto = getOptionalImageFile(formData, "clientPhoto");
    const createPartner = formData.get("createPartner") === "on";
    const partnerFirstName = getValidatedValue(partnerFirstNameResult);
    const partnerLastName = getValidatedValue(partnerLastNameResult);
    const partnerEmail = getValidatedValue(partnerEmailResult);
    const partnerPhone = getValidatedValue(partnerPhoneResult);
    const partnerDanceStyles = getValidatedValue(partnerDanceStylesResult);
    const partnerDanceGoals = getValidatedValue(partnerDanceGoalsResult);

    if (createPartner && (!partnerFirstName || !partnerLastName)) {
      return {
        error:
          "Partner first name and last name are required when adding a partner.",
      };
    }

    const dropdownError = validateClientDropdowns({
      status,
      skillLevel,
      referralSource,
    });

    if (dropdownError) {
      return { error: dropdownError };
    }

    if (linkedInstructorId && !isIndependentInstructor) {
      return {
        error:
          "Linked instructor profile can only be used when the client is marked as an independent instructor.",
      };
    }

    const linkedInstructorValidation = await validateLinkedInstructor({
      supabase,
      studioId,
      linkedInstructorId,
    });

    if (!linkedInstructorValidation.ok) {
      return { error: linkedInstructorValidation.error };
    }

    if (email) {
      const { data: duplicateClient } = await supabase
        .from("clients")
        .select("id")
        .eq("studio_id", studioId)
        .eq("email", email)
        .limit(1)
        .maybeSingle();

      if (duplicateClient) {
        return {
          error:
            "A client with this email already exists in this studio. Update the existing record instead.",
        };
      }
    }

    if (partnerEmail) {
      const { data: duplicatePartner } = await supabase
        .from("clients")
        .select("id")
        .eq("studio_id", studioId)
        .eq("email", partnerEmail)
        .limit(1)
        .maybeSingle();

      if (duplicatePartner) {
        return {
          error:
            "A client with the partner email already exists in this studio. Create the first client, then link the existing partner record.",
        };
      }
    }

    const payload = normalizeClientPayload({
      firstName,
      lastName,
      email,
      phone,
      birthday,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      danceStyles,
      danceGoals,
      includeDanceGoals: true,
      skillLevel,
      notes,
      referralSource,
      status,
      linkedInstructorId,
      isIndependentInstructor,
    });

    const clientId = randomUUID();
    const photoResult = await uploadClientPhoto({
      supabase,
      studioId,
      clientId,
      file: clientPhoto,
    });

    if (photoResult.error) {
      return { error: photoResult.error };
    }

    const partnerClientId = createPartner ? randomUUID() : null;

    const { error } = await supabase.from("clients").insert({
      id: clientId,
      studio_id: studioId,
      ...payload,
      photo_url: photoResult.url,
    });

    if (error) {
      return { error: `Client creation failed: ${error.message}` };
    }

    if (createPartner && partnerClientId) {
      const partnerPayload = normalizeClientPayload({
        firstName: partnerFirstName,
        lastName: partnerLastName,
        email: partnerEmail,
        phone: partnerPhone,
        birthday: "",
        addressLine1,
        addressLine2,
        city,
        state,
        postalCode,
        country,
        danceStyles: partnerDanceStyles.length ? partnerDanceStyles : danceStyles,
        danceGoals: partnerDanceGoals.length ? partnerDanceGoals : danceGoals,
        includeDanceGoals: true,
        skillLevel,
        notes: "",
        referralSource,
        status,
        linkedInstructorId: null,
        isIndependentInstructor: false,
      });

      const { error: partnerError } = await supabase.from("clients").insert({
        id: partnerClientId,
        studio_id: studioId,
        ...partnerPayload,
        partner_client_id: clientId,
      });

      if (partnerError) {
        return { error: `Partner creation failed: ${partnerError.message}` };
      }

      const { error: linkError } = await supabase
        .from("clients")
        .update({ partner_client_id: partnerClientId })
        .eq("id", clientId)
        .eq("studio_id", studioId);

      if (linkError) {
        return { error: `Partner link failed: ${linkError.message}` };
      }
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
  let clientIdForRedirect = "";

  try {
    const { supabase, studioId } = await getCurrentUserStudioContext();

    const clientIdResult = normalizeOptionalUuid(rawFormString(formData, "clientId"), "Client");
    const firstNameResult = cleanFormText(formData, "firstName", {
      fieldLabel: "First name",
      maxLength: 80,
      required: true,
    });
    const lastNameResult = cleanFormText(formData, "lastName", {
      fieldLabel: "Last name",
      maxLength: 80,
      required: true,
    });
    const emailResult = normalizeOptionalEmail(rawFormString(formData, "email"));
    const phoneResult = normalizeOptionalPhone(rawFormString(formData, "phone"));
    const birthdayResult = normalizeOptionalDate(rawFormString(formData, "birthday"), "Birthday");
    const addressLine1Result = cleanFormText(formData, "addressLine1", {
      fieldLabel: "Address line 1",
      maxLength: 160,
    });
    const addressLine2Result = cleanFormText(formData, "addressLine2", {
      fieldLabel: "Address line 2",
      maxLength: 160,
    });
    const cityResult = cleanFormText(formData, "city", {
      fieldLabel: "City",
      maxLength: 80,
    });
    const stateResult = cleanFormText(formData, "state", {
      fieldLabel: "State",
      maxLength: 80,
    });
    const postalCodeResult = cleanFormText(formData, "postalCode", {
      fieldLabel: "ZIP / postal code",
      maxLength: 20,
    });
    const countryResult = cleanFormText(formData, "country", {
      fieldLabel: "Country",
      maxLength: 80,
    });
    const danceInterestsResult = cleanFormText(formData, "danceInterests", {
      fieldLabel: "Dance interests",
      maxLength: 500,
    });
    const danceStylesResult = normalizeClientTextList(
      formData,
      "danceStyles",
      "Dance styles",
      CLIENT_DANCE_STYLE_VALUES
    );
    const danceGoalsResult = normalizeClientTextList(
      formData,
      "danceGoals",
      "Dance goals",
      CLIENT_DANCE_GOAL_VALUES
    );
    const notesResult = cleanFormText(formData, "notes", {
      fieldLabel: "Notes",
      maxLength: 3000,
      allowNewlines: true,
    });
    const linkedInstructorIdResult = normalizeOptionalUuid(
      rawFormString(formData, "linkedInstructorId"),
      "Linked instructor"
    );

    const validationError = getValidationError([
      clientIdResult,
      firstNameResult,
      lastNameResult,
      emailResult,
      phoneResult,
      birthdayResult,
      addressLine1Result,
      addressLine2Result,
      cityResult,
      stateResult,
      postalCodeResult,
      countryResult,
      danceInterestsResult,
      danceStylesResult,
      danceGoalsResult,
      notesResult,
      linkedInstructorIdResult,
    ]);
    if (validationError) {
      return { error: validationError };
    }

    const clientId = getValidatedValue(clientIdResult);
    if (!clientId) {
      return { error: "Missing client id." };
    }

    clientIdForRedirect = clientId;

    const firstName = getValidatedValue(firstNameResult);
    const lastName = getValidatedValue(lastNameResult);
    const email = getValidatedValue(emailResult);
    const phone = getValidatedValue(phoneResult);
    const birthday = getValidatedValue(birthdayResult) ?? "";
    const addressLine1 = getValidatedValue(addressLine1Result);
    const addressLine2 = getValidatedValue(addressLine2Result);
    const city = getValidatedValue(cityResult);
    const state = getValidatedValue(stateResult);
    const postalCode = getValidatedValue(postalCodeResult);
    const country = getValidatedValue(countryResult);
    const danceInterests = getValidatedValue(danceInterestsResult);
    const danceStyles = getValidatedValue(danceStylesResult);
    const danceGoals = getValidatedValue(danceGoalsResult);
    const skillLevel = getString(formData, "skillLevel");
    const notes = getValidatedValue(notesResult);
    const referralSource = getString(formData, "referralSource");
    const status = getString(formData, "status") || "lead";
    const linkedInstructorId = getValidatedValue(linkedInstructorIdResult);
    const isIndependentInstructor =
      formData.get("isIndependentInstructor") === "on";
    const clientPhoto = getOptionalImageFile(formData, "clientPhoto");

    const dropdownError = validateClientDropdowns({
      status,
      skillLevel,
      referralSource,
    });

    if (dropdownError) {
      return { error: dropdownError };
    }

    if (linkedInstructorId && !isIndependentInstructor) {
      return {
        error:
          "Linked instructor profile can only be used when the client is marked as an independent instructor.",
      };
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

    if (email) {
      const { data: duplicateClient } = await supabase
        .from("clients")
        .select("id")
        .eq("studio_id", studioId)
        .eq("email", email)
        .neq("id", clientId)
        .limit(1)
        .maybeSingle();

      if (duplicateClient) {
        return {
          error:
            "Another client with this email already exists in this studio. Use a different email or update the existing record.",
        };
      }
    }

    const payload = normalizeClientPayload({
      firstName,
      lastName,
      email,
      phone,
      birthday,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      danceStyles,
      danceInterests,
      danceGoals,
      includeDanceGoals: formData.has("danceGoals"),
      skillLevel,
      notes,
      referralSource,
      status,
      linkedInstructorId,
      isIndependentInstructor,
    });

    const photoResult = await uploadClientPhoto({
      supabase,
      studioId,
      clientId,
      file: clientPhoto,
    });

    if (photoResult.error) {
      return { error: photoResult.error };
    }

    const updatePayload = {
      ...payload,
      ...(photoResult.url ? { photo_url: photoResult.url } : {}),
    };

    const { error } = await supabase
      .from("clients")
      .update(updatePayload)
      .eq("id", clientId)
      .eq("studio_id", studioId);

    if (error) {
      return { error: `Client update failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(`/app/clients/${clientIdForRedirect}?success=client_updated`);
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
  const isIndependentInstructor =
    formData.get("isIndependentInstructor") === "on";

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

  if (linkedInstructorId && !isIndependentInstructor) {
    redirect(
      appendQueryParam(
        returnTo,
        "error",
        "linked_instructor_requires_independent_flag"
      )
    );
  }

  if (linkedInstructorId) {
    const { data: instructor, error: instructorError } = await supabase
      .from("instructors")
      .select("id, studio_id")
      .eq("id", linkedInstructorId)
      .eq("studio_id", studioId)
      .single();

    if (instructorError || !instructor) {
      redirect(appendQueryParam(returnTo, "error", "invalid_linked_instructor"));
    }
  }

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      is_independent_instructor: isIndependentInstructor,
      linked_instructor_id: isIndependentInstructor ? linkedInstructorId : null,
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
