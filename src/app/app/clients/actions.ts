"use server";

import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { DOCUMENT_FILES_BUCKET, sourceStoragePath } from "@/lib/documents/signing";
import { getPdfPageSizes, sha256Hex } from "@/lib/documents/pdf";
import { renderTemplateVersionPdf } from "@/lib/documents/template-pdf";
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
import {
  IMAGE_UPLOAD_MIME_TYPES,
  getOptionalUploadFile,
  validateUploadFile,
} from "@/lib/security/uploads";

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

  const validation = await validateUploadFile(file, {
    fieldLabel: "Client photo",
    maxBytes: MAX_CLIENT_PHOTO_BYTES,
    allowedMimeTypes: IMAGE_UPLOAD_MIME_TYPES,
    allowedExtensions: ["jpg", "jpeg", "png", "webp"],
    kind: "image",
  });

  if (!validation.ok) {
    return {
      url: null,
      error: validation.error,
    };
  }

  const photoPath = `${studioId}/${clientId}/${Date.now()}-${crypto.randomUUID()}.${validation.extension}`;
  const { error: uploadError } = await supabase.storage
    .from(CLIENT_PHOTO_BUCKET)
    .upload(photoPath, file, {
      cacheControl: "3600",
      contentType: validation.mimeType,
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


export type OnboardingDocumentOption = {
  id: string;
  title: string;
  description: string | null;
  requiresSignature: boolean;
  isRequired: boolean;
};

export async function loadOnboardingDocumentOptionsAction(): Promise<
  OnboardingDocumentOption[]
> {
  const { supabase, studioId } = await getCurrentUserStudioContext();

  const { data, error } = await supabase
    .from("document_templates")
    .select("id, title, description, requires_signature, is_required")
    .eq("studio_id", studioId)
    .eq("scope", "studio")
    .eq("is_active", true)
    .order("is_required", { ascending: false })
    .order("title", { ascending: true });

  if (error) {
    console.error("Could not load onboarding document options:", error.message);
    return [];
  }

  return (data ?? []).map((template) => ({
    id: String(template.id),
    title: String(template.title ?? "Untitled document"),
    description:
      typeof template.description === "string" ? template.description : null,
    requiresSignature: template.requires_signature === true,
    isRequired: template.is_required === true,
  }));
}

async function loadStudioDocumentBrandingForOnboarding(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
) {
  const { data: studio } = await admin
    .from("studios")
    .select("name, public_name, public_logo_url")
    .eq("id", studioId)
    .maybeSingle();

  const studioName =
    String(studio?.public_name ?? studio?.name ?? "Your studio").trim() ||
    "Your studio";
  const logoUrl =
    typeof studio?.public_logo_url === "string"
      ? studio.public_logo_url.trim()
      : "";

  if (!logoUrl) {
    return {
      studioName,
      studioLogoBytes: null,
      studioLogoMimeType: null,
    } as const;
  }

  try {
    const response = await fetch(logoUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) throw new Error("Logo request failed.");

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      ?.toLowerCase();

    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      return {
        studioName,
        studioLogoBytes: null,
        studioLogoMimeType: null,
      } as const;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
      return {
        studioName,
        studioLogoBytes: null,
        studioLogoMimeType: null,
      } as const;
    }

    return {
      studioName,
      studioLogoBytes: bytes,
      studioLogoMimeType: contentType,
    } as const;
  } catch {
    return {
      studioName,
      studioLogoBytes: null,
      studioLogoMimeType: null,
    } as const;
  }
}

async function createOnboardingDocumentDraft(params: {
  studioId: string;
  clientId: string;
  templateId: string;
  assignedBy: string;
}) {
  const admin = createAdminClient();

  const [{ data: template, error: templateError }, { data: client, error: clientError }] =
    await Promise.all([
      admin
        .from("document_templates")
        .select(
          "id, studio_id, is_active, current_version, current_version_id, title, description, body, default_consent_text",
        )
        .eq("id", params.templateId)
        .eq("studio_id", params.studioId)
        .eq("scope", "studio")
        .maybeSingle(),
      admin
        .from("clients")
        .select("id, first_name, last_name, email")
        .eq("id", params.clientId)
        .eq("studio_id", params.studioId)
        .maybeSingle(),
    ]);

  if (templateError || !template || !template.is_active) {
    throw new Error("Selected onboarding document is unavailable.");
  }

  if (clientError || !client) {
    throw new Error("New client could not be loaded for document assignment.");
  }

  const signerEmail =
    typeof client.email === "string" ? client.email.trim().toLowerCase() : "";

  if (!signerEmail || !signerEmail.includes("@")) {
    throw new Error(
      "A valid client email is required before onboarding documents can be prepared.",
    );
  }

  const { data: existing } = await admin
    .from("document_assignments")
    .select("id")
    .eq("template_id", params.templateId)
    .eq("client_id", params.clientId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (existing) {
    return { envelopeId: null as string | null, skipped: true as const };
  }

  const { data: version, error: versionError } = await admin
    .from("document_template_versions")
    .select("id, version_number, title, description, body, consent_text")
    .eq("id", template.current_version_id)
    .eq("template_id", params.templateId)
    .maybeSingle();

  if (versionError || !version) {
    throw new Error("The selected document's current version could not be loaded.");
  }

  const signerName =
    [client.first_name, client.last_name].filter(Boolean).join(" ").trim() ||
    signerEmail;
  const branding = await loadStudioDocumentBrandingForOnboarding(
    admin,
    params.studioId,
  );
  const pdfBytes = await renderTemplateVersionPdf({
    title: version.title || template.title,
    description: version.description ?? template.description,
    body: version.body || template.body,
    versionNumber: Number(version.version_number ?? template.current_version ?? 1),
    consentText: version.consent_text ?? template.default_consent_text,
    studioName: branding.studioName,
    studioLogoBytes: branding.studioLogoBytes,
    studioLogoMimeType: branding.studioLogoMimeType,
  });

  const pageSizes = await getPdfPageSizes(pdfBytes);
  const envelopeId = randomUUID();
  const assignmentId = randomUUID();
  const sourcePath = sourceStoragePath(params.studioId, envelopeId);
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

  const { error: uploadError } = await admin.storage
    .from(DOCUMENT_FILES_BUCKET)
    .upload(sourcePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: false,
      cacheControl: "0",
    });

  if (uploadError) {
    throw new Error("Could not create the onboarding signing PDF.");
  }

  const { error: envelopeError } = await admin
    .from("document_sign_envelopes")
    .insert({
      id: envelopeId,
      studio_id: params.studioId,
      template_id: params.templateId,
      template_version_id: version.id,
      client_id: params.clientId,
      assignment_id: null,
      source_kind: "template_version",
      title: version.title || template.title,
      signer_name: signerName,
      signer_email: signerEmail,
      status: "draft",
      token_hash: null,
      source_bucket: DOCUMENT_FILES_BUCKET,
      source_path: sourcePath,
      source_sha256: sha256Hex(pdfBytes),
      page_count: pageSizes.length,
      page_sizes: pageSizes,
      expires_at: expiresAt,
      created_by: params.assignedBy,
    });

  if (envelopeError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    throw new Error("Could not create the onboarding signing request.");
  }

  const { error: assignmentError } = await admin
    .from("document_assignments")
    .insert({
      id: assignmentId,
      template_id: params.templateId,
      template_version_id: version.id,
      studio_id: params.studioId,
      client_id: params.clientId,
      assigned_to_email: signerEmail,
      status: "pending",
      due_at: null,
      assigned_by: params.assignedBy,
      sign_envelope_id: envelopeId,
    });

  if (assignmentError) {
    await admin.from("document_sign_envelopes").delete().eq("id", envelopeId);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    throw new Error("Could not create the onboarding document assignment.");
  }

  const { error: envelopeLinkError } = await admin
    .from("document_sign_envelopes")
    .update({ assignment_id: assignmentId })
    .eq("id", envelopeId)
    .eq("studio_id", params.studioId);

  if (envelopeLinkError) {
    await admin.from("document_assignments").delete().eq("id", assignmentId);
    await admin.from("document_sign_envelopes").delete().eq("id", envelopeId);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    throw new Error("Could not link the onboarding signing request.");
  }

  await admin.from("document_sign_events").insert({
    envelope_id: envelopeId,
    event_type: "created",
    actor_user_id: params.assignedBy,
    summary: "Onboarding signing draft created during client creation.",
    metadata: {
      template_id: params.templateId,
      template_version_id: version.id,
      client_id: params.clientId,
      assignment_id: assignmentId,
      source: "client_creation",
    },
  });

  return { envelopeId, skipped: false as const };
}

export async function createClientAction(
  prevState: { error: string },
  formData: FormData
) {
  let createdClientId = "";
  let onboardingEnvelopeId: string | null = null;
  let onboardingWarning = "";

  try {
    const { supabase, studioId } = await getCurrentUserStudioContext();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "Your session expired. Sign in and try again." };
    }

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
    const clientPhoto = getOptionalUploadFile(formData, "clientPhoto");
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
    createdClientId = clientId;
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

    const selectedTemplateIds = Array.from(
      new Set(getStringList(formData, "onboardingDocumentTemplateIds")),
    ).filter((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
    );

    let firstEnvelopeId: string | null = null;
    const documentErrors: string[] = [];

    for (const templateId of selectedTemplateIds) {
      try {
        const result = await createOnboardingDocumentDraft({
          studioId,
          clientId,
          templateId,
          assignedBy: user.id,
        });

        if (!firstEnvelopeId && result.envelopeId) {
          firstEnvelopeId = result.envelopeId;
        }
      } catch (documentError) {
        documentErrors.push(
          documentError instanceof Error
            ? documentError.message
            : "An onboarding document could not be prepared.",
        );
      }
    }

    onboardingEnvelopeId = firstEnvelopeId;

    if (documentErrors.length > 0) {
      onboardingWarning = `Client created, but onboarding documents need attention: ${documentErrors.join(" ")}`;
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  if (onboardingEnvelopeId) {
    redirect(
      `/app/documents/sign/${onboardingEnvelopeId}/edit?source=client_onboarding&clientId=${encodeURIComponent(
        createdClientId,
      )}`,
    );
  }

  if (createdClientId && onboardingWarning) {
    redirect(
      `/app/clients/${createdClientId}?warning=${encodeURIComponent(
        onboardingWarning,
      )}`,
    );
  }

  redirect(createdClientId ? `/app/clients/${createdClientId}` : "/app/clients");
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
    const clientPhoto = getOptionalUploadFile(formData, "clientPhoto");

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
