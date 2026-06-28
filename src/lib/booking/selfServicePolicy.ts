export type SelfServiceMode =
  | "disabled"
  | "request_only"
  | "approval_required"
  | "instant";

export type BookingActionType = "book" | "reschedule" | "cancel";

export type BookingActionDecision = {
  action: BookingActionType;
  allowed: boolean;
  mode: Exclude<SelfServiceMode, "disabled"> | null;
  reason: string | null;
};

export type SelfServiceBookingSettings = {
  portal_self_scheduling_enabled: boolean | null;
  portal_self_scheduling_mode: string | null;
  portal_self_scheduling_reschedule_mode?: string | null;
  portal_self_scheduling_cancellation_mode?: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  portal_self_scheduling_cancellation_cutoff_hours: number | null;
  portal_self_scheduling_require_active_credit?: boolean | null;
  portal_self_scheduling_requires_payment_method?: boolean | null;
  portal_bookable_lesson_types: string[] | null;
  portal_bookable_instructor_ids: string[] | null;
};

export type StudentBookingEligibility = {
  hasLinkedClient: boolean;
  hasActiveCredit: boolean;
  hasPaymentMethod: boolean;
};

const ACTIVE_MODES = new Set<SelfServiceMode>([
  "request_only",
  "approval_required",
  "instant"
]);

function normalizeMode(
  value: string | null | undefined,
  fallback: SelfServiceMode = "disabled"
): SelfServiceMode {
  if (
    value === "request_only" ||
    value === "approval_required" ||
    value === "instant"
  ) {
    return value;
  }

  return fallback;
}

function modeForAction(
  action: BookingActionType,
  settings: SelfServiceBookingSettings
) {
  if (action === "reschedule") {
    return normalizeMode(settings.portal_self_scheduling_reschedule_mode);
  }

  if (action === "cancel") {
    return normalizeMode(settings.portal_self_scheduling_cancellation_mode);
  }

  return normalizeMode(settings.portal_self_scheduling_mode, "request_only");
}

function activeMode(value: SelfServiceMode) {
  return ACTIVE_MODES.has(value) ? (value as Exclude<SelfServiceMode, "disabled">) : null;
}

export function getAllowedLessonTypes(settings: SelfServiceBookingSettings) {
  return settings.portal_bookable_lesson_types?.length
    ? settings.portal_bookable_lesson_types
    : ["private_lesson"];
}

export function getAllowedInstructorIds(settings: SelfServiceBookingSettings) {
  return settings.portal_bookable_instructor_ids ?? [];
}

export function canUseSelfServiceBooking(params: {
  action: BookingActionType;
  eligibility: StudentBookingEligibility;
  lessonType?: string | null;
  settings: SelfServiceBookingSettings;
}): BookingActionDecision {
  const { action, eligibility, lessonType, settings } = params;

  if (settings.portal_self_scheduling_enabled !== true) {
    return {
      action,
      allowed: false,
      mode: null,
      reason: "Self-service scheduling is disabled for this studio."
    };
  }

  if (!eligibility.hasLinkedClient) {
    return {
      action,
      allowed: false,
      mode: null,
      reason: "A linked student profile is required for this action."
    };
  }

  const selectedMode = modeForAction(action, settings);
  const mode = activeMode(selectedMode);

  if (!mode) {
    return {
      action,
      allowed: false,
      mode: null,
      reason: "This scheduling action is not available for this studio."
    };
  }

  if (action !== "cancel" && lessonType) {
    const allowedTypes = getAllowedLessonTypes(settings);
    if (!allowedTypes.includes(lessonType)) {
      return {
        action,
        allowed: false,
        mode: null,
        reason: "That lesson type is not available for self-service scheduling."
      };
    }
  }

  if (
    action !== "cancel" &&
    settings.portal_self_scheduling_require_active_credit &&
    !eligibility.hasActiveCredit
  ) {
    return {
      action,
      allowed: false,
      mode: null,
      reason: "An active lesson credit or eligible membership is required."
    };
  }

  if (
    action !== "cancel" &&
    settings.portal_self_scheduling_requires_payment_method &&
    !eligibility.hasPaymentMethod
  ) {
    return {
      action,
      allowed: false,
      mode: null,
      reason: "A payment method is required before this action can be completed."
    };
  }

  return {
    action,
    allowed: true,
    mode,
    reason: null
  };
}

export function getSelfServiceActionLabel(decision: BookingActionDecision) {
  if (!decision.allowed || !decision.mode) return "Unavailable";

  if (decision.mode === "request_only") {
    if (decision.action === "book") return "Request lesson";
    if (decision.action === "reschedule") return "Request reschedule";
    return "Request cancellation";
  }

  if (decision.mode === "approval_required") {
    if (decision.action === "book") return "Submit for approval";
    if (decision.action === "reschedule") return "Submit reschedule";
    return "Submit cancellation";
  }

  if (decision.action === "book") return "Book lesson";
  if (decision.action === "reschedule") return "Reschedule";
  return "Cancel lesson";
}
