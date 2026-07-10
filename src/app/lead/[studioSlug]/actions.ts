"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  cleanFormText,
  normalizeOptionalEmail,
  normalizeOptionalEnum,
  normalizeOptionalPhone,
  normalizeRequiredSlug,
  rawFormString,
  safeLocalRedirectPath,
  getValidationError,
  getValidatedValue,
} from "@/lib/validation/forms";

export type PublicLeadFormState = {
  error: string;
};

function intentLabel(value: string) {
  return value === "intro_lesson"
    ? "Public Intro Lesson Request"
    : "Public Studio Inquiry";
}

export async function submitPublicLeadAction(
  _prevState: PublicLeadFormState,
  formData: FormData
): Promise<PublicLeadFormState> {
  const studioSlugResult = normalizeRequiredSlug(
    rawFormString(formData, "studioSlug"),
    "Studio"
  );
  const inquiryIntentResult = normalizeOptionalEnum(
    rawFormString(formData, "inquiryIntent") || "general_inquiry",
    ["general_inquiry", "intro_lesson"] as const,
    "Inquiry type"
  );
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
  const danceInterestsResult = cleanFormText(formData, "danceInterests", {
    fieldLabel: "Dance interests",
    maxLength: 250,
  });
  const skillLevelResult = normalizeOptionalEnum(
    rawFormString(formData, "skillLevel"),
    ["beginner", "returning", "intermediate", "advanced"] as const,
    "Skill level"
  );
  const referralSourceResult = cleanFormText(formData, "referralSource", {
    fieldLabel: "Referral source",
    maxLength: 120,
  });
  const preferredContactMethodResult = normalizeOptionalEnum(
    rawFormString(formData, "preferredContactMethod"),
    ["phone", "text", "email"] as const,
    "Preferred contact method"
  );
  const notesResult = cleanFormText(formData, "notes", {
    fieldLabel: "Notes",
    maxLength: 2000,
    allowNewlines: true,
  });

  const validationResults = [
    studioSlugResult,
    inquiryIntentResult,
    firstNameResult,
    lastNameResult,
    emailResult,
    phoneResult,
    danceInterestsResult,
    skillLevelResult,
    referralSourceResult,
    preferredContactMethodResult,
    notesResult,
  ];

  const validationError = getValidationError(validationResults);
  if (validationError) {
    return { error: validationError };
  }

  const studioSlug = getValidatedValue(studioSlugResult);
  const successRedirect = safeLocalRedirectPath(
    rawFormString(formData, "successRedirect"),
    `/lead/${encodeURIComponent(studioSlug)}?success=1`
  );
  const inquiryIntent = getValidatedValue(inquiryIntentResult) || "general_inquiry";
  const firstName = getValidatedValue(firstNameResult);
  const lastName = getValidatedValue(lastNameResult);
  const email = getValidatedValue(emailResult);
  const phone = getValidatedValue(phoneResult);
  const danceInterests = getValidatedValue(danceInterestsResult);
  const skillLevel = getValidatedValue(skillLevelResult);
  const referralSource = getValidatedValue(referralSourceResult);
  const preferredContactMethod = getValidatedValue(preferredContactMethodResult);
  const notes = getValidatedValue(notesResult);

  if (!email && !phone) {
    return { error: "Please provide at least an email or phone number." };
  }

  if (inquiryIntent === "intro_lesson" && !danceInterests) {
    return {
      error: "Please tell the studio what kind of dance lesson you are interested in.",
    };
  }

  try {
    const supabase = await createClient();

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, name, slug, public_lead_enabled")
      .eq("slug", studioSlug)
      .eq("public_lead_enabled", true)
      .single();

    if (studioError || !studio) {
      return { error: "This inquiry form is not available." };
    }

    const { data: introSettings } = await supabase
      .from("studio_settings")
      .select(
        "public_intro_booking_enabled, intro_lesson_duration_minutes, intro_booking_window_days"
      )
      .eq("studio_id", studio.id)
      .maybeSingle();

    const introBookingEnabled = Boolean(
      introSettings?.public_intro_booking_enabled
    );

    const normalizedIntent =
      inquiryIntent === "intro_lesson" && introBookingEnabled
        ? "intro_lesson"
        : "general_inquiry";

    const sourceLabel = intentLabel(normalizedIntent);

    const combinedNotes = [
      normalizedIntent === "intro_lesson" ? "Intent: Intro Lesson Request" : null,
      normalizedIntent === "intro_lesson" && introSettings?.intro_lesson_duration_minutes
        ? `Intro Lesson Duration: ${introSettings.intro_lesson_duration_minutes} minutes`
        : null,
      normalizedIntent === "intro_lesson" && introSettings?.intro_booking_window_days
        ? `Intro Booking Window: ${introSettings.intro_booking_window_days} days`
        : null,
      notes ? `Inquiry: ${notes}` : null,
      preferredContactMethod
        ? `Preferred Contact Method: ${preferredContactMethod}`
        : null,
      `Source: ${sourceLabel}`,
      `Studio Slug: ${studioSlug}`,
    ]
      .filter(Boolean)
      .join("\n");

    const { error: insertError } = await supabase.from("clients").insert({
      studio_id: studio.id,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      status: "lead",
      skill_level: skillLevel,
      dance_interests: danceInterests || null,
      referral_source: referralSource || sourceLabel,
      notes: combinedNotes || null,
    });

    if (insertError) {
      return { error: `Lead submission failed: ${insertError.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(successRedirect);
}
