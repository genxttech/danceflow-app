"use server";

import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function updateStudioSettingsAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();

    const studioName = getString(formData, "studioName");
    const timezone = getString(formData, "timezone");
    const currency = getString(formData, "currency");
    const cancellationWindowHoursRaw = getString(formData, "cancellationWindowHours");
    const bookingLeadTimeHoursRaw = getString(formData, "bookingLeadTimeHours");
    const noShowDeductsLesson = getString(formData, "noShowDeductsLesson");
    const allowNegativeBalance = getString(formData, "allowNegativeBalance");
    const blockDepletedPackageBooking = getString(formData, "blockDepletedPackageBooking");
    const warnLowPackageBalance = getString(formData, "warnLowPackageBalance");

    const publicLeadEnabled = getString(formData, "publicLeadEnabled");
    const publicLeadHeadline = getString(formData, "publicLeadHeadline");
    const publicLeadDescription = getString(formData, "publicLeadDescription");
    const publicLogoUrl = getString(formData, "publicLogoUrl");
    const publicPrimaryColor = getString(formData, "publicPrimaryColor");
    const publicLeadCtaText = getString(formData, "publicLeadCtaText");

    const publicIntroBookingEnabled = getString(formData, "publicIntroBookingEnabled");
    const introLessonDurationMinutesRaw = getString(formData, "introLessonDurationMinutes");
    const introBookingWindowDaysRaw = getString(formData, "introBookingWindowDays");
    const introDefaultInstructorId = getString(formData, "introDefaultInstructorId");
    const introDefaultRoomId = getString(formData, "introDefaultRoomId");

    if (!studioName) return { error: "Studio name is required." };
    if (!timezone) return { error: "Timezone is required." };
    if (!currency) return { error: "Currency is required." };

    const cancellationWindowHours = Number.parseInt(cancellationWindowHoursRaw, 10);
    const bookingLeadTimeHours = Number.parseInt(bookingLeadTimeHoursRaw, 10);
    const introLessonDurationMinutes = Number.parseInt(introLessonDurationMinutesRaw, 10);
    const introBookingWindowDays = Number.parseInt(introBookingWindowDaysRaw, 10);

    if (Number.isNaN(cancellationWindowHours) || cancellationWindowHours < 0) {
      return { error: "Cancellation window hours must be 0 or greater." };
    }

    if (Number.isNaN(bookingLeadTimeHours) || bookingLeadTimeHours < 0) {
      return { error: "Booking lead time hours must be 0 or greater." };
    }

    if (Number.isNaN(introLessonDurationMinutes) || introLessonDurationMinutes < 15) {
      return { error: "Intro lesson duration must be at least 15 minutes." };
    }

    if (Number.isNaN(introBookingWindowDays) || introBookingWindowDays < 1) {
      return { error: "Intro booking window must be at least 1 day." };
    }

    if (
      publicPrimaryColor &&
      !/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.test(publicPrimaryColor)
    ) {
      return { error: "Primary color must be a valid hex color like #0f172a." };
    }

    if (publicLeadEnabled && publicLeadEnabled !== "true" && publicLeadEnabled !== "false") {
      return { error: "Public lead setting must be enabled or disabled." };
    }

    if (
      publicIntroBookingEnabled &&
      publicIntroBookingEnabled !== "true" &&
      publicIntroBookingEnabled !== "false"
    ) {
      return { error: "Intro booking setting must be enabled or disabled." };
    }

    const { error: studioError } = await supabase
      .from("studios")
      .update({
        name: studioName,
        public_lead_enabled: publicLeadEnabled === "true",
        public_lead_headline: publicLeadHeadline || null,
        public_lead_description: publicLeadDescription || null,
        public_logo_url: publicLogoUrl || null,
        public_primary_color: publicPrimaryColor || null,
        public_lead_cta_text: publicLeadCtaText || null,
      })
      .eq("id", studioId);

    if (studioError) {
      return { error: `Studio update failed: ${studioError.message}` };
    }

    const { error: settingsError } = await supabase
      .from("studio_settings")
      .update({
        timezone,
        currency,
        cancellation_window_hours: cancellationWindowHours,
        booking_lead_time_hours: bookingLeadTimeHours,
        no_show_deducts_lesson: noShowDeductsLesson === "true",
        allow_negative_balance: allowNegativeBalance === "true",
        block_depleted_package_booking: blockDepletedPackageBooking === "true",
        warn_low_package_balance: warnLowPackageBalance === "true",
        public_intro_booking_enabled: publicIntroBookingEnabled === "true",
        intro_lesson_duration_minutes: introLessonDurationMinutes,
        intro_booking_window_days: introBookingWindowDays,
        intro_default_instructor_id: introDefaultInstructorId || null,
        intro_default_room_id: introDefaultRoomId || null,
      })
      .eq("studio_id", studioId);

    if (settingsError) {
      return { error: `Settings update failed: ${settingsError.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/settings?success=settings_saved");
}