"use server";

import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildStudioLocationQuery, geocodeAddress } from "@/lib/geocoding";
import { studioHasFeature } from "@/lib/billing/access";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getFirstString(formData: FormData, keys: string[]) {
  for (const key of keys) {
    const value = getString(formData, key);
    if (value) return value;
  }
  return "";
}

function getStringArray(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function normalizeTimeInput(value: string, fallback: string) {
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  return fallback;
}

function parseWeekdays(values: string[]) {
  const parsed = values
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6];
}

const STUDIO_PUBLIC_ASSETS_BUCKET = "studio-public-assets";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_HERO_SIZE_BYTES = 5 * 1024 * 1024;

function getFile(formData: FormData, key: string) {
  const value = formData.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

function validateImageFile(params: {
  file: File;
  label: string;
  maxSizeBytes: number;
}) {
  const { file, label, maxSizeBytes } = params;

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error(`${label} must be a PNG, JPG, JPEG, or WebP image.`);
  }

  if (file.size > maxSizeBytes) {
    const maxMb = Math.round(maxSizeBytes / 1024 / 1024);
    throw new Error(`${label} must be ${maxMb} MB or smaller.`);
  }
}

function getImageExtension(file: File) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

async function uploadStudioPublicImage(params: {
  studioId: string;
  file: File;
  imageType: "logo" | "hero";
}) {
  const adminSupabase = createAdminClient();
  const extension = getImageExtension(params.file);
  const path = `${params.studioId}/${params.imageType}-${Date.now()}.${extension}`;

  const { error: uploadError } = await adminSupabase.storage
    .from(STUDIO_PUBLIC_ASSETS_BUCKET)
    .upload(path, params.file, {
      contentType: params.file.type,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(
      `Could not upload ${
        params.imageType === "logo" ? "logo" : "hero image"
      }: ${uploadError.message}`
    );
  }

  const { data } = adminSupabase.storage
    .from(STUDIO_PUBLIC_ASSETS_BUCKET)
    .getPublicUrl(path);

  return data.publicUrl;
}

function parseBooleanString(
  raw: string,
  fallback: boolean,
  trueValues = ["true", "1", "on", "yes"]
) {
  if (!raw) return fallback;
  return trueValues.includes(raw.toLowerCase());
}

type ActionState = {
  error: string;
};

type ExistingNotificationSettingsRow = {
  public_intro_booking_enabled: boolean | null;
  follow_up_overdue_enabled: boolean | null;
  package_low_balance_enabled: boolean | null;
  package_depleted_enabled: boolean | null;
  floor_rental_upcoming_enabled: boolean | null;
};

export async function updateStudioSettingsAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();

    const studioName = getString(formData, "studioName");
    const publicCity = getString(formData, "publicCity");
    const publicState = getString(formData, "publicState");
    const publicPostalCode = getString(formData, "publicPostalCode");
    const timezone = getString(formData, "timezone");
    const currency = getString(formData, "currency");
    const cancellationWindowHoursRaw = getString(formData, "cancellationWindowHours");
    const bookingLeadTimeHoursRaw = getString(formData, "bookingLeadTimeHours");
    const noShowDeductsLesson = getString(formData, "noShowDeductsLesson");
    const allowNegativeBalance = getString(formData, "allowNegativeBalance");
    const blockDepletedPackageBooking = getString(formData, "blockDepletedPackageBooking");
    const warnLowPackageBalance = getString(formData, "warnLowPackageBalance");
    const lumiEnabled = getString(formData, "lumiEnabled");

    const publicName = getString(formData, "publicName");
    const publicShortDescription = getString(formData, "publicShortDescription");
    const publicAbout = getString(formData, "publicAbout");
    const publicPhone = getString(formData, "publicPhone");
    const publicEmail = getString(formData, "publicEmail").toLowerCase();
    const publicWebsiteUrl = getString(formData, "publicWebsiteUrl");

    const publicLeadEnabled = getString(formData, "publicLeadEnabled");
    const publicLeadHeadline = getString(formData, "publicLeadHeadline");
    const publicLeadDescription = getString(formData, "publicLeadDescription");
    const logoFile = getFile(formData, "publicLogoFile");
    const heroFile = getFile(formData, "publicHeroImageFile");
    const publicPrimaryColor = getString(formData, "publicPrimaryColor");
    const publicLeadCtaText = getString(formData, "publicLeadCtaText");

    const publicIntroBookingEnabled = getString(formData, "publicIntroBookingEnabled");
    const portalSelfSchedulingEnabled = getString(formData, "portalSelfSchedulingEnabled");
    const portalSelfSchedulingMode = getString(formData, "portalSelfSchedulingMode") || "request_only";
    const portalSelfSchedulingWindowDaysRaw = getString(formData, "portalSelfSchedulingWindowDays");
    const portalSelfSchedulingMinNoticeHoursRaw = getString(formData, "portalSelfSchedulingMinNoticeHours");
    const portalSelfSchedulingCancellationCutoffHoursRaw = getString(
      formData,
      "portalSelfSchedulingCancellationCutoffHours"
    );
    const introLessonDurationMinutesRaw = getString(formData, "introLessonDurationMinutes");
    const introBookingWindowDaysRaw = getString(formData, "introBookingWindowDays");
    const introDefaultInstructorId = getString(formData, "introDefaultInstructorId");
    const introDefaultRoomId = getString(formData, "introDefaultRoomId");
    const bookingRequestAllowedWeekdays = parseWeekdays(
      getStringArray(formData, "bookingRequestAllowedWeekdays")
    );
    const bookingRequestStartTime = normalizeTimeInput(
      getString(formData, "bookingRequestStartTime"),
      "09:00"
    );
    const bookingRequestEndTime = normalizeTimeInput(
      getString(formData, "bookingRequestEndTime"),
      "21:00"
    );
    const publicIntroBookableInstructorIds = getStringArray(
      formData,
      "publicIntroBookableInstructorIds"
    );
    const portalBookableInstructorIds = getStringArray(
      formData,
      "portalBookableInstructorIds"
    );
    const portalBookableLessonTypes = getStringArray(formData, "portalBookableLessonTypes").filter(
      (value) => ["private_lesson", "coaching", "practice_party", "group_class"].includes(value)
    );

    if (!studioName) return { error: "Studio name is required." };
    if (!timezone) return { error: "Timezone is required." };
    if (!currency) return { error: "Currency is required." };

    if (lumiEnabled === "true" && !(await studioHasFeature("ai_assistant"))) {
      return { error: "LUMI requires an active Growth or Pro plan." };
    }

    const cancellationWindowHours = Number.parseInt(cancellationWindowHoursRaw, 10);
    const bookingLeadTimeHours = Number.parseInt(bookingLeadTimeHoursRaw, 10);
    const introLessonDurationMinutes = Number.parseInt(introLessonDurationMinutesRaw, 10);
    const introBookingWindowDays = Number.parseInt(introBookingWindowDaysRaw, 10);
    const portalSelfSchedulingWindowDays = Number.parseInt(
      portalSelfSchedulingWindowDaysRaw || "14",
      10
    );
    const portalSelfSchedulingMinNoticeHours = Number.parseInt(
      portalSelfSchedulingMinNoticeHoursRaw || bookingLeadTimeHoursRaw || "24",
      10
    );
    const portalSelfSchedulingCancellationCutoffHours = Number.parseInt(
      portalSelfSchedulingCancellationCutoffHoursRaw || cancellationWindowHoursRaw || "24",
      10
    );

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
      Number.isNaN(portalSelfSchedulingWindowDays) ||
      portalSelfSchedulingWindowDays < 1
    ) {
      return { error: "Portal scheduling window must be at least 1 day." };
    }

    if (
      Number.isNaN(portalSelfSchedulingMinNoticeHours) ||
      portalSelfSchedulingMinNoticeHours < 0
    ) {
      return { error: "Portal minimum notice must be 0 hours or greater." };
    }

    if (
      Number.isNaN(portalSelfSchedulingCancellationCutoffHours) ||
      portalSelfSchedulingCancellationCutoffHours < 0
    ) {
      return { error: "Portal cancellation cutoff must be 0 hours or greater." };
    }

    if (!["request_only", "disabled"].includes(portalSelfSchedulingMode)) {
      return { error: "Portal scheduling mode must be request only or disabled." };
    }

    if (bookingRequestStartTime >= bookingRequestEndTime) {
      return { error: "The request start time must be earlier than the end time." };
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

    if (
      portalSelfSchedulingEnabled &&
      portalSelfSchedulingEnabled !== "true" &&
      portalSelfSchedulingEnabled !== "false"
    ) {
      return { error: "Portal scheduling setting must be enabled or disabled." };
    }


    const { data: existingStudio, error: existingStudioError } = await supabase
      .from("studios")
      .select("city, state, postal_code, latitude, longitude")
      .eq("id", studioId)
      .single();

    if (existingStudioError || !existingStudio) {
      return {
        error: `Studio location lookup failed: ${
          existingStudioError?.message ?? "Studio not found"
        }`,
      };
    }

    const locationChanged =
      publicCity !== (existingStudio.city ?? "") ||
      publicState !== (existingStudio.state ?? "") ||
      publicPostalCode !== (existingStudio.postal_code ?? "");

    const locationQuery = buildStudioLocationQuery({
      city: publicCity,
      state: publicState,
      postalCode: publicPostalCode,
    });

    let geocodedLocation: Awaited<ReturnType<typeof geocodeAddress>> = null;

    if (locationChanged && locationQuery) {
      geocodedLocation = await geocodeAddress(locationQuery);
    }

    const { data: existingNotificationSettings, error: existingNotificationSettingsError } =
      await supabase
        .from("studio_notification_settings")
        .select(`
          public_intro_booking_enabled,
          follow_up_overdue_enabled,
          package_low_balance_enabled,
          package_depleted_enabled,
          floor_rental_upcoming_enabled
        `)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (existingNotificationSettingsError) {
      return {
        error: `Notification settings lookup failed: ${existingNotificationSettingsError.message}`,
      };
    }

    const existing =
      (existingNotificationSettings as ExistingNotificationSettingsRow | null) ?? {
        public_intro_booking_enabled: true,
        follow_up_overdue_enabled: true,
        package_low_balance_enabled: true,
        package_depleted_enabled: true,
        floor_rental_upcoming_enabled: true,
      };

    const notificationPublicIntroBookingEnabledRaw = getFirstString(formData, [
      "notificationPublicIntroBookingEnabled",
      "notification_public_intro_booking_enabled",
      "publicIntroBookingNotificationEnabled",
    ]);

    const notificationFollowUpOverdueEnabledRaw = getFirstString(formData, [
      "notificationFollowUpOverdueEnabled",
      "notification_follow_up_overdue_enabled",
      "followUpOverdueNotificationEnabled",
    ]);

    const notificationPackageLowBalanceEnabledRaw = getFirstString(formData, [
      "notificationPackageLowBalanceEnabled",
      "notification_package_low_balance_enabled",
      "packageLowBalanceNotificationEnabled",
    ]);

    const notificationPackageDepletedEnabledRaw = getFirstString(formData, [
      "notificationPackageDepletedEnabled",
      "notification_package_depleted_enabled",
      "packageDepletedNotificationEnabled",
    ]);

    const notificationFloorRentalUpcomingEnabledRaw = getFirstString(formData, [
      "notificationFloorRentalUpcomingEnabled",
      "notification_floor_rental_upcoming_enabled",
      "floorRentalUpcomingNotificationEnabled",
    ]);

    let uploadedLogoUrl: string | null = null;
    let uploadedHeroImageUrl: string | null = null;

    if (logoFile) {
      validateImageFile({
        file: logoFile,
        label: "Logo",
        maxSizeBytes: MAX_LOGO_SIZE_BYTES,
      });

      uploadedLogoUrl = await uploadStudioPublicImage({
        studioId,
        file: logoFile,
        imageType: "logo",
      });
    }

    if (heroFile) {
      validateImageFile({
        file: heroFile,
        label: "Hero image",
        maxSizeBytes: MAX_HERO_SIZE_BYTES,
      });

      uploadedHeroImageUrl = await uploadStudioPublicImage({
        studioId,
        file: heroFile,
        imageType: "hero",
      });
    }

    const notificationSettingsPayload = {
      studio_id: studioId,
      public_intro_booking_enabled: parseBooleanString(
        notificationPublicIntroBookingEnabledRaw,
        existing.public_intro_booking_enabled ?? true
      ),
      follow_up_overdue_enabled: parseBooleanString(
        notificationFollowUpOverdueEnabledRaw,
        existing.follow_up_overdue_enabled ?? true
      ),
      package_low_balance_enabled: parseBooleanString(
        notificationPackageLowBalanceEnabledRaw,
        existing.package_low_balance_enabled ?? true
      ),
      package_depleted_enabled: parseBooleanString(
        notificationPackageDepletedEnabledRaw,
        existing.package_depleted_enabled ?? true
      ),
      floor_rental_upcoming_enabled: parseBooleanString(
        notificationFloorRentalUpcomingEnabledRaw,
        existing.floor_rental_upcoming_enabled ?? true
      ),
    };

    const studioUpdatePayload: {
      name: string;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      latitude?: number | null;
      longitude?: number | null;
      public_name: string | null;
      public_short_description: string | null;
      public_about: string | null;
      public_phone: string | null;
      public_email: string | null;
      public_website_url: string | null;
      public_lead_enabled: boolean;
      public_lead_headline: string | null;
      public_lead_description: string | null;
      public_primary_color: string | null;
      public_lead_cta_text: string | null;
      public_logo_url?: string;
      public_hero_image_url?: string;
    } = {
      name: studioName,
      public_name: publicName || studioName,
      public_short_description: publicShortDescription || null,
      public_about: publicAbout || null,
      public_phone: publicPhone || null,
      public_email: publicEmail || null,
      public_website_url: publicWebsiteUrl || null,
      city: publicCity || null,
      state: publicState || null,
      postal_code: publicPostalCode || null,
      public_lead_enabled: publicLeadEnabled === "true",
      public_lead_headline: publicLeadHeadline || null,
      public_lead_description: publicLeadDescription || null,
      public_primary_color: publicPrimaryColor || null,
      public_lead_cta_text: publicLeadCtaText || null,
    };

    if (locationChanged) {
      studioUpdatePayload.latitude = geocodedLocation?.latitude ?? null;
      studioUpdatePayload.longitude = geocodedLocation?.longitude ?? null;
    }

    if (uploadedLogoUrl) {
      studioUpdatePayload.public_logo_url = uploadedLogoUrl;
    }

    if (uploadedHeroImageUrl) {
      studioUpdatePayload.public_hero_image_url = uploadedHeroImageUrl;
    }

    const { error: studioError } = await supabase
      .from("studios")
      .update(studioUpdatePayload)
      .eq("id", studioId);

    if (studioError) {
      return { error: `Studio update failed: ${studioError.message}` };
    }

    const { error: settingsError } = await supabase
      .from("studio_settings")
      .update({
        lumi_enabled: lumiEnabled === "true",
        timezone,
        currency,
        cancellation_window_hours: cancellationWindowHours,
        booking_lead_time_hours: bookingLeadTimeHours,
        no_show_deducts_lesson: noShowDeductsLesson === "true",
        allow_negative_balance: allowNegativeBalance === "true",
        block_depleted_package_booking: blockDepletedPackageBooking === "true",
        warn_low_package_balance: warnLowPackageBalance === "true",
        public_intro_booking_enabled: publicIntroBookingEnabled === "true",
        portal_self_scheduling_enabled: portalSelfSchedulingEnabled === "true",
        portal_self_scheduling_mode: portalSelfSchedulingEnabled === "true"
          ? portalSelfSchedulingMode
          : "disabled",
        portal_self_scheduling_window_days: portalSelfSchedulingWindowDays,
        portal_self_scheduling_min_notice_hours: portalSelfSchedulingMinNoticeHours,
        portal_self_scheduling_cancellation_cutoff_hours:
          portalSelfSchedulingCancellationCutoffHours,
        intro_lesson_duration_minutes: introLessonDurationMinutes,
        intro_booking_window_days: introBookingWindowDays,
        intro_default_instructor_id: introDefaultInstructorId || null,
        intro_default_room_id: introDefaultRoomId || null,
        booking_request_allowed_weekdays: bookingRequestAllowedWeekdays,
        booking_request_start_time: bookingRequestStartTime,
        booking_request_end_time: bookingRequestEndTime,
        public_intro_bookable_instructor_ids: publicIntroBookableInstructorIds,
        portal_bookable_instructor_ids: portalBookableInstructorIds,
        portal_bookable_lesson_types: portalBookableLessonTypes.length
          ? portalBookableLessonTypes
          : ["private_lesson"],
      })
      .eq("studio_id", studioId);

    if (settingsError) {
      return { error: `Settings update failed: ${settingsError.message}` };
    }

    const { error: notificationSettingsError } = await supabase
      .from("studio_notification_settings")
      .upsert(notificationSettingsPayload, {
        onConflict: "studio_id",
      });

    if (notificationSettingsError) {
      return {
        error: `Notification settings update failed: ${notificationSettingsError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/settings?success=settings_saved");
}


export async function updateStudioMarketingFooterAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();

    const replyToEmail = getString(formData, "marketingReplyToEmail").toLowerCase();
    const addressLine1 = getString(formData, "marketingAddressLine1");
    const addressLine2 = getString(formData, "marketingAddressLine2");
    const city = getString(formData, "marketingCity");
    const state = getString(formData, "marketingState");
    const postalCode = getString(formData, "marketingPostalCode");
    const country = getString(formData, "marketingCountry") || "United States";

    if (replyToEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToEmail)) {
      redirect("/app/settings?marketing_footer_error=invalid_email");
    }

    const { error } = await supabase
      .from("studios")
      .update({
        email: replyToEmail || null,
        address_line_1: addressLine1 || null,
        address_line_2: addressLine2 || null,
        city: city || null,
        state: state || null,
        postal_code: postalCode || null,
        country: country || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", studioId);

    if (error) {
      redirect("/app/settings?marketing_footer_error=save_failed");
    }
  } catch {
    redirect("/app/settings?marketing_footer_error=save_failed");
  }

  redirect("/app/settings?success=marketing_footer_saved");
}
