"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type PublicLeadFormState = {
  error: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function intentLabel(value: string) {
  return value === "intro_lesson"
    ? "Public Intro Lesson Request"
    : "Public Studio Inquiry";
}

export async function submitPublicLeadAction(
  _prevState: PublicLeadFormState,
  formData: FormData
): Promise<PublicLeadFormState> {
  const studioSlug = getString(formData, "studioSlug");
  const successRedirect = getString(formData, "successRedirect");
  const inquiryIntent = getString(formData, "inquiryIntent") || "general_inquiry";
  const firstName = getString(formData, "firstName");
  const lastName = getString(formData, "lastName");
  const email = getString(formData, "email").toLowerCase();
  const phone = getString(formData, "phone");
  const danceInterests = getString(formData, "danceInterests");
  const skillLevel = getString(formData, "skillLevel");
  const referralSource = getString(formData, "referralSource");
  const preferredContactMethod = getString(formData, "preferredContactMethod");
  const notes = getString(formData, "notes");

  if (!studioSlug) {
    return { error: "Missing studio." };
  }

  if (!firstName || !lastName) {
    return { error: "First name and last name are required." };
  }

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
      email: email || null,
      phone: phone || null,
      status: "lead",
      skill_level: skillLevel || null,
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

  redirect(
    successRedirect ||
      `/lead/${encodeURIComponent(studioSlug)}?success=1`
  );
}
