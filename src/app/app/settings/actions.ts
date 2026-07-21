"use server";

import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";
import { studioHasFeature } from "@/lib/billing/access";

type ActionState = { error: string };

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getStringArray(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function parseNonNegativeInteger(raw: string, label: string) {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`${label} must be 0 or greater.`);
  }
  return value;
}

function parseAllowedInteger(raw: string, fallback: number, allowed: number[], label: string) {
  const value = Number.parseInt(raw || String(fallback), 10);
  if (!allowed.includes(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export async function updateStudioSettingsAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();
    const studioName = getString(formData, "studioName");
    const timezone = getString(formData, "timezone");
    const currency = getString(formData, "currency");
    const lumiEnabled = getString(formData, "lumiEnabled") === "true";

    if (!studioName) return { error: "Studio name is required." };
    if (!timezone) return { error: "Timezone is required." };
    if (!currency) return { error: "Currency is required." };
    if (lumiEnabled && !(await studioHasFeature("ai_assistant"))) {
      return { error: "LUMI requires an active Growth or Pro plan." };
    }

    const cancellationWindowHours = parseNonNegativeInteger(
      getString(formData, "cancellationWindowHours"),
      "Cancellation window"
    );
    const bookingLeadTimeHours = parseNonNegativeInteger(
      getString(formData, "bookingLeadTimeHours"),
      "Booking lead time"
    );
    const portalWindowDays = parseNonNegativeInteger(
      getString(formData, "portalSelfSchedulingWindowDays") || "14",
      "Portal scheduling window"
    );
    const portalMinNoticeHours = parseNonNegativeInteger(
      getString(formData, "portalSelfSchedulingMinNoticeHours") || "24",
      "Portal minimum notice"
    );
    const portalCancellationCutoffHours = parseNonNegativeInteger(
      getString(formData, "portalSelfSchedulingCancellationCutoffHours") || "24",
      "Portal cancellation cutoff"
    );
    if (portalWindowDays < 1) {
      return { error: "Portal scheduling window must be at least 1 day." };
    }

    const portalEnabled =
      getString(formData, "portalSelfSchedulingEnabled") === "true";
    const portalMode =
      getString(formData, "portalSelfSchedulingMode") || "request_only";
    const portalRescheduleMode =
      getString(formData, "portalSelfSchedulingRescheduleMode") || "request_only";
    const portalCancellationMode =
      getString(formData, "portalSelfSchedulingCancellationMode") || "request_only";
    const allowedModes = ["disabled", "request_only", "approval_required", "instant"];
    if (!allowedModes.includes(portalMode)) {
      return { error: "Portal booking mode is invalid." };
    }
    if (!allowedModes.includes(portalRescheduleMode)) {
      return { error: "Portal reschedule mode is invalid." };
    }
    if (!allowedModes.includes(portalCancellationMode)) {
      return { error: "Portal cancellation mode is invalid." };
    }

    const portalSlotIntervalMinutes = parseAllowedInteger(
      getString(formData, "portalSelfSchedulingSlotIntervalMinutes"),
      15,
      [5, 10, 15, 20, 30, 45, 60],
      "Portal slot interval"
    );
    const portalDefaultDurationMinutes = parseAllowedInteger(
      getString(formData, "portalSelfSchedulingDefaultDurationMinutes"),
      45,
      [30, 45, 60, 75, 90, 120],
      "Portal default duration"
    );

    const portalBookableLessonTypes = getStringArray(
      formData,
      "portalBookableLessonTypes"
    ).filter((value) =>
      ["private_lesson", "coaching", "practice_party", "group_class"].includes(
        value
      )
    );

    const [{ error: studioError }, { error: settingsError }] = await Promise.all([
      supabase.from("studios").update({ name: studioName }).eq("id", studioId),
      supabase
        .from("studio_settings")
        .update({
          lumi_enabled: lumiEnabled,
          timezone,
          currency,
          cancellation_window_hours: cancellationWindowHours,
          booking_lead_time_hours: bookingLeadTimeHours,
          no_show_deducts_lesson:
            getString(formData, "noShowDeductsLesson") === "true",
          allow_negative_balance:
            getString(formData, "allowNegativeBalance") === "true",
          block_depleted_package_booking:
            getString(formData, "blockDepletedPackageBooking") === "true",
          block_depleted_membership_booking:
            getString(formData, "blockDepletedMembershipBooking") === "true",
          block_unpaid_membership_booking:
            getString(formData, "blockUnpaidMembershipBooking") === "true",
          warn_low_package_balance:
            getString(formData, "warnLowPackageBalance") === "true",
          portal_self_scheduling_enabled: portalEnabled,
          portal_self_scheduling_mode: portalEnabled ? portalMode : "disabled",
          portal_self_scheduling_reschedule_mode: portalEnabled
            ? portalRescheduleMode
            : "disabled",
          portal_self_scheduling_cancellation_mode: portalEnabled
            ? portalCancellationMode
            : "disabled",
          portal_self_scheduling_window_days: portalWindowDays,
          portal_self_scheduling_min_notice_hours: portalMinNoticeHours,
          portal_self_scheduling_cancellation_cutoff_hours:
            portalCancellationCutoffHours,
          portal_self_scheduling_slot_interval_minutes: portalSlotIntervalMinutes,
          portal_self_scheduling_default_duration_minutes:
            portalDefaultDurationMinutes,
          portal_self_scheduling_require_active_credit:
            getString(formData, "portalSelfSchedulingRequireActiveCredit") === "on",
          portal_self_scheduling_allow_unlinked_requests:
            getString(formData, "portalSelfSchedulingAllowUnlinkedRequests") === "on",
          portal_self_scheduling_auto_assign_room:
            getString(formData, "portalSelfSchedulingAutoAssignRoom") === "on",
          portal_self_scheduling_requires_payment_method:
            getString(formData, "portalSelfSchedulingRequiresPaymentMethod") === "on",
          portal_self_scheduling_updated_at: new Date().toISOString(),
          portal_bookable_instructor_ids: getStringArray(
            formData,
            "portalBookableInstructorIds"
          ),
          portal_bookable_lesson_types: portalBookableLessonTypes.length
            ? portalBookableLessonTypes
            : ["private_lesson"],
        })
        .eq("studio_id", studioId),
    ]);

    if (studioError) return { error: `Studio update failed: ${studioError.message}` };
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

export async function updateStudioMarketingFooterAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();
    const replyToEmail = getString(formData, "marketingReplyToEmail").toLowerCase();

    if (replyToEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToEmail)) {
      redirect("/app/settings?marketing_footer_error=invalid_email");
    }

    const { error } = await supabase
      .from("studios")
      .update({
        email: replyToEmail || null,
        address_line_1: getString(formData, "marketingAddressLine1") || null,
        address_line_2: getString(formData, "marketingAddressLine2") || null,
        city: getString(formData, "marketingCity") || null,
        state: getString(formData, "marketingState") || null,
        postal_code: getString(formData, "marketingPostalCode") || null,
        country: getString(formData, "marketingCountry") || "United States",
        updated_at: new Date().toISOString(),
      })
      .eq("id", studioId);

    if (error) redirect("/app/settings?marketing_footer_error=save_failed");
  } catch {
    redirect("/app/settings?marketing_footer_error=save_failed");
  }

  redirect("/app/settings?success=marketing_footer_saved");
}
