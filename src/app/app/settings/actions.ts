"use server";

import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildStudioLocationQuery, geocodeAddress } from "@/lib/geocoding";

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