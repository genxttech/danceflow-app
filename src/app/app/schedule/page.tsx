import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  bulkMarkDailyAppointmentsAttendedAction,
  markAppointmentAttendedAction,
  markAppointmentNoShowAction,
  recordPayAsYouGoLessonPaymentAction,
} from "./actions";
import {
  CalendarDays,
  ClipboardList,
  DoorOpen,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Repeat2,
  Sparkles,
} from "lucide-react";
import { summarizeClientPackageItems } from "@/lib/utils/packageSummary";
import {
  canCreateAppointments,
  canEditAppointments,
  canMarkAttendance,
} from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import AppointmentCancellationForm from "@/components/schedule/AppointmentCancellationForm";

type SearchParams = Promise<{
  q?: string;
  scope?: string;
  instructor?: string;
  room?: string;
  status?: string;
  source?: string;
  date?: string;
  success?: string;
  error?: string;
  bulkMarked?: string;
  bulkSkipped?: string;
  bulkPaymentRequired?: string;
  bulkFailed?: string;
}>;

type ClientPackageItem = {
  usage_type: string;
  quantity_remaining: number | null;
  quantity_total: number | null;
  is_unlimited: boolean;
};

type PackageHealth =
  | "healthy"
  | "low_balance"
  | "depleted"
  | "inactive"
  | "unknown";

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  client_id: string | null;
  starts_at: string;
  ends_at: string;
  client_package_id: string | null;
  price_amount: number | string | null;
  payment_status: string | null;
  billing_type: string | null;
  billing_note: string | null;
  is_recurring: boolean;
  recurrence_series_id: string | null;
  clients:
    | { first_name: string; last_name: string; referral_source?: string | null }
    | {
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null;
  instructors:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null;
  rooms: { id?: string; name: string } | { id?: string; name: string }[] | null;
  client_packages:
    | {
        name_snapshot: string;
        active: boolean | null;
        client_package_items: ClientPackageItem[];
      }
    | {
        name_snapshot: string;
        active: boolean | null;
        client_package_items: ClientPackageItem[];
      }[]
    | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  status: string;
  visibility: string;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  organizers: { name: string } | { name: string }[] | null;
};

type ClientAccountLedgerRow = {
  client_id: string;
  direction: string;
  amount: number | string | null;
};

type ScheduleListItem =
  | {
      kind: "appointment";
      sort_key: string;
      appointment: AppointmentRow;
    }
  | {
      kind: "event";
      occurrence_date?: string;
      sort_key: string;
      event: EventRow;
    };

const CLOSEOUT_TIME_ZONE = "America/New_York";

function startOfLocalDate(date: string) {
  return new Date(`${date}T00:00:00`);
}

function addDaysLocal(date: string, days: number) {
  const start = startOfLocalDate(date);
  return new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + days,
  );
}

function formatLocalDateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function maxLocalDate(a: Date, b: Date) {
  return a.getTime() >= b.getTime() ? a : b;
}

function minLocalDate(a: Date, b: Date) {
  return a.getTime() <= b.getTime() ? a : b;
}

function getWeeklyGroupClassOccurrenceDate(
  event: EventRow,
  rangeStartDate: string,
  rangeEndExclusiveDate: string,
) {
  const seriesStart = startOfLocalDate(event.start_date);
  const rangeStart = startOfLocalDate(rangeStartDate);
  const rangeEndExclusive = startOfLocalDate(rangeEndExclusiveDate);
  const seriesEndExclusive = event.end_date
    ? addDaysLocal(event.end_date, 1)
    : rangeEndExclusive;
  const effectiveStart = maxLocalDate(seriesStart, rangeStart);
  const effectiveEndExclusive = minLocalDate(seriesEndExclusive, rangeEndExclusive);

  if (effectiveStart >= effectiveEndExclusive) return null;

  const targetWeekday = seriesStart.getDay();
  const occurrence = new Date(effectiveStart);
  const daysUntilClass =
    (targetWeekday - occurrence.getDay() + 7) % 7;

  occurrence.setDate(occurrence.getDate() + daysUntilClass);

  if (occurrence >= effectiveEndExclusive) return null;

  return formatLocalDateKey(occurrence);
}

function getTimeZoneParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);

  const map = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: Number(map.get("hour")),
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  };
}

function getTimeZoneOffsetMs(value: Date, timeZone: string) {
  const parts = getTimeZoneParts(value, timeZone);

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - value.getTime();
}

function zonedDateTimeToUtc(
  date: string,
  time: string,
  timeZone = CLOSEOUT_TIME_ZONE,
) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone);

  return new Date(utcGuess.getTime() - offset);
}

function getLocalDayUtcRange(date: string, timeZone = CLOSEOUT_TIME_ZONE) {
  const start = zonedDateTimeToUtc(date, "00:00:00", timeZone);

  const [year, month, day] = date.split("-").map(Number);
  const nextLocalDate = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDate = nextLocalDate.toISOString().slice(0, 10);

  const end = zonedDateTimeToUtc(nextDate, "00:00:00", timeZone);

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function getDateInTimeZone(value: string, timeZone = CLOSEOUT_TIME_ZONE) {
  const parts = getTimeZoneParts(new Date(value), timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getBaseDate(raw?: string, timeZone = CLOSEOUT_TIME_ZONE) {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return getDateInTimeZone(new Date().toISOString(), timeZone);
}

function formatDateTime(value: string, timeZone = CLOSEOUT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatEventDateRange(event: EventRow, occurrenceDate?: string) {
  const hasTimes = Boolean(event.start_time && event.end_time);

  if (event.event_type === "group_class" && occurrenceDate) {
    const occurrenceLabel = hasTimes
      ? `${formatDate(occurrenceDate)} • ${event.start_time} – ${event.end_time}`
      : `${formatDate(occurrenceDate)} • Weekly class`;
    const seriesLabel =
      event.end_date && event.end_date !== event.start_date
        ? `Series ${formatDate(event.start_date)} – ${formatDate(event.end_date)}`
        : null;

    return [occurrenceLabel, seriesLabel].filter(Boolean).join(" · ");
  }

  if ((!event.end_date || event.start_date === event.end_date) && hasTimes) {
    return `${formatDate(event.start_date)} • ${event.start_time} – ${event.end_time}`;
  }

  if (!event.end_date || event.start_date === event.end_date) {
    return `${formatDate(event.start_date)} • All day`;
  }

  return `${formatDate(event.start_date)} – ${formatDate(event.end_date)}`;
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ");
}

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  if (value === "other") return "Other";
  return value.replaceAll("_", " ");
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
  if (status === "published") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (status === "draft") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function appointmentTypeBadgeClass(type: string) {
  if (type === "floor_space_rental") return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100";
  if (type === "intro_lesson") return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
  if (type === "group_class") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (type === "coaching") return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
  if (type === "practice_party") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (type === "event") return "bg-rose-50 text-rose-700 ring-1 ring-rose-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function eventTypeBadgeClass(type: string) {
  if (type === "group_class") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (type === "practice_party") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (type === "workshop") return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (type === "social_dance") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (type === "competition") return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-100";
  return "bg-rose-50 text-rose-700 ring-1 ring-rose-100";
}

function eventCardClass(type: string) {
  if (type === "group_class") {
    return "border-blue-200 bg-gradient-to-br from-blue-50 via-white to-white shadow-sm ring-1 ring-blue-100/70";
  }
  if (type === "practice_party") {
    return "border-amber-200 bg-gradient-to-br from-amber-50 via-white to-white shadow-sm ring-1 ring-amber-100/70";
  }
  if (type === "workshop") {
    return "border-violet-200 bg-gradient-to-br from-violet-50 via-white to-white shadow-sm ring-1 ring-violet-100/70";
  }
  if (type === "social_dance") {
    return "border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white shadow-sm ring-1 ring-emerald-100/70";
  }
  if (type === "competition") {
    return "border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 via-white to-white shadow-sm ring-1 ring-fuchsia-100/70";
  }

  return "border-rose-200 bg-gradient-to-br from-rose-50 via-white to-white shadow-sm ring-1 ring-rose-100/70";
}

function eventAccentClass(type: string) {
  if (type === "group_class") return "from-blue-500 to-cyan-400";
  if (type === "practice_party") return "from-amber-500 to-orange-400";
  if (type === "workshop") return "from-violet-500 to-purple-400";
  if (type === "social_dance") return "from-emerald-500 to-teal-400";
  if (type === "competition") return "from-fuchsia-500 to-pink-400";
  return "from-rose-500 to-pink-400";
}

function getClientName(
  value:
    | { first_name: string; last_name: string; referral_source?: string | null }
    | {
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getClientReferralSource(
  value:
    | { first_name: string; last_name: string; referral_source?: string | null }
    | {
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client?.referral_source ?? null;
}

function getInstructorName(
  value:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null,
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor
    ? `${instructor.first_name} ${instructor.last_name}`
    : "Unassigned";
}

function getRoomName(
  value: { id?: string; name: string } | { id?: string; name: string }[] | null,
) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function getOrganizerName(value: { name: string } | { name: string }[] | null) {
  const organizer = Array.isArray(value) ? value[0] : value;
  return organizer?.name ?? "Organizer";
}

function getLowestRemainingValue(items: ClientPackageItem[]) {
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number",
  );

  if (finiteItems.length === 0) return null;

  return Math.min(
    ...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)),
  );
}

function getPackageHealth(
  pkg: {
    active?: boolean | null;
    client_package_items?: ClientPackageItem[] | null;
  } | null,
): PackageHealth {
  if (!pkg) return "unknown";
  if (pkg.active === false) return "inactive";

  const items = pkg.client_package_items ?? [];
  const lowestRemaining = getLowestRemainingValue(items);

  if (lowestRemaining === null) return "healthy";
  if (lowestRemaining <= 0) return "depleted";
  if (lowestRemaining === 1) return "low_balance";

  return "healthy";
}

function packageHealthLabel(health: PackageHealth) {
  if (health === "healthy") return "Pkg Active";
  if (health === "low_balance") return "Pkg Low";
  if (health === "depleted") return "Pkg Empty";
  if (health === "inactive") return "Pkg Inactive";
  return "Pkg Unknown";
}

function packageHealthClass(health: PackageHealth) {
  if (health === "healthy") return "bg-green-50 text-green-700";
  if (health === "low_balance") return "bg-amber-50 text-amber-700";
  if (health === "depleted") return "bg-red-50 text-red-700";
  if (health === "inactive") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function isCloseoutCandidate(appointment: AppointmentRow) {
  return (
    appointment.appointment_type !== "floor_space_rental" &&
    appointment.status === "scheduled"
  );
}

function normalizeBillingType(value: string | null | undefined) {
  if (
    value === "package_credit" ||
    value === "membership" ||
    value === "pay_as_you_go" ||
    value === "free_comped"
  ) {
    return value;
  }

  return "package_credit";
}

function hasPaymentCleared(appointment: AppointmentRow) {
  const status = (appointment.payment_status ?? "").toLowerCase();
  return ["paid", "waived", "comped", "free", "included"].includes(status);
}

function isSameLocalDate(value: string, date: string, timeZone = CLOSEOUT_TIME_ZONE) {
  return getDateInTimeZone(value, timeZone) === date;
}

function mayNeedPaymentReview(appointment: AppointmentRow) {
  return getCloseoutReviewReason(appointment) !== null;
}

function getCloseoutReviewReason(appointment: AppointmentRow) {
  if (!isCloseoutCandidate(appointment)) return null;
  if (hasPaymentCleared(appointment)) return null;

  const billingType = normalizeBillingType(appointment.billing_type);

  if (billingType === "free_comped") return null;

  if (billingType === "pay_as_you_go") {
    return "Payment has not been recorded for this pay-as-you-go lesson.";
  }

  if (billingType === "membership") {
    return "Membership coverage should be reviewed before bulk closeout.";
  }

  const pkg = Array.isArray(appointment.client_packages)
    ? appointment.client_packages[0]
    : appointment.client_packages;

  if (!pkg) {
    return "No valid package credit is linked to this lesson.";
  }

  const packageHealth = getPackageHealth(pkg);

  if (packageHealth === "depleted") {
    return "The selected package has no remaining credits.";
  }

  if (packageHealth === "inactive") {
    return "The selected package is inactive.";
  }

  if (packageHealth === "unknown") {
    return "Package credit could not be verified.";
  }

  return null;
}

function billingTypeLabel(value: string | null | undefined) {
  const billingType = normalizeBillingType(value ?? null);

  if (billingType === "membership") return "Membership";
  if (billingType === "pay_as_you_go") return "Pay-as-you-go";
  if (billingType === "free_comped") return "Free / Comped";
  return "Package Credit";
}

function getPaymentAmountDefault(appointment: AppointmentRow) {
  const amount = Number(appointment.price_amount ?? 0);
  return amount > 0 ? amount.toFixed(2) : "";
}

function getBanner(search: {
  success?: string;
  error?: string;
  bulkMarked?: string;
  bulkSkipped?: string;
  bulkPaymentRequired?: string;
  bulkFailed?: string;
}) {
  if (search.success === "appointment_created") {
    return {
      kind: "success" as const,
      message: "Appointment created successfully.",
    };
  }

  if (search.success === "floor_rentals_created") {
    return {
      kind: "success" as const,
      message: "Floor rentals created successfully.",
    };
  }

  if (search.success === "appointment_cancelled") {
    return {
      kind: "success" as const,
      message: "Appointment cancelled.",
    };
  }

  if (search.success === "appointment_attended") {
    return {
      kind: "success" as const,
      message: "Appointment marked attended.",
    };
  }

  if (search.success === "appointment_no_show") {
    return {
      kind: "success" as const,
      message: "Appointment marked no show.",
    };
  }

  if (search.success === "payment_recorded") {
    return {
      kind: "success" as const,
      message: "Lesson payment recorded and linked to the lesson.",
    };
  }

  if (search.success === "bulk_attended") {
    const marked = Number(search.bulkMarked ?? 0);
    const skipped = Number(search.bulkSkipped ?? 0);
    const paymentRequired = Number(search.bulkPaymentRequired ?? 0);
    const failed = Number(search.bulkFailed ?? 0);
    const skippedParts = [
      paymentRequired > 0 ? `${paymentRequired} need payment or review` : null,
      failed > 0 ? `${failed} could not be updated` : null,
    ].filter(Boolean);

    return {
      kind: "success" as const,
      message:
        skipped > 0
          ? `${marked} lessons marked attended. ${skippedParts.join("; ") || `${skipped} skipped`}.`
          : `${marked} lessons marked attended.`,
    };
  }

  if (search.error === "appointment_missing") {
    return {
      kind: "error" as const,
      message: "Appointment not found.",
    };
  }

  if (search.error === "appointment_cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel the appointment.",
    };
  }

  if (search.error === "appointment_series_cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel the recurring appointment series.",
    };
  }

  if (search.error === "appointment_attended_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark the appointment attended.",
    };
  }

  if (search.error === "appointment_no_show_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark the appointment no show.",
    };
  }

  if (search.error === "payment_required") {
    return {
      kind: "error" as const,
      message:
        "Payment, package credit, membership coverage, or a comped status is needed before this lesson can be marked attended.",
    };
  }

  if (search.error === "invalid_payment_amount") {
    return {
      kind: "error" as const,
      message: "Enter a payment amount, account credit amount, or both before recording the lesson payment.",
    };
  }

  if (search.error === "payment_still_short") {
    return {
      kind: "error" as const,
      message: "The payment and account credit applied do not cover the lesson price yet.",
    };
  }

  if (search.error === "credit_exceeds_available") {
    return {
      kind: "error" as const,
      message: "The account credit applied is higher than the available client credit.",
    };
  }

  if (search.error === "credit_exceeds_lesson_price") {
    return {
      kind: "error" as const,
      message: "The account credit applied cannot be more than the lesson price.",
    };
  }

  if (search.error === "invalid_payment_method") {
    return {
      kind: "error" as const,
      message: "Use the account credit field for credit-only payments. Choose a collection method only for money collected today.",
    };
  }

  if (search.error === "lesson_already_paid") {
    return {
      kind: "error" as const,
      message: "This lesson is already marked paid. Open the lesson or payment history to review it.",
    };
  }

  if (search.error === "payment_record_failed") {
    return {
      kind: "error" as const,
      message: "Could not record the lesson payment. Please review the amount and try again.",
    };
  }

  if (search.error === "bulk_attendance_failed") {
    return {
      kind: "error" as const,
      message:
        "Could not complete daily closeout. Please try again or mark lessons individually.",
    };
  }

  if (search.error === "unknown") {
    return {
      kind: "error" as const,
      message: "Something went wrong.",
    };
  }

  return null;
}

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== "all") search.set(key, value);
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}


function formatCurrency(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}


export default async function SchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().toLowerCase();
  const scope = params.scope ?? "today";
  const instructorFilter = params.instructor ?? "all";
  const roomFilter = params.room ?? "all";
  const statusFilter = params.status ?? "all";
  const sourceFilter = params.source ?? "all";
  const banner = getBanner(params);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const role = context.studioRole ?? "";
  const studioId = context.studioId;

  const { data: studioTimeZoneRow } = await supabase
    .from("studios")
    .select("timezone")
    .eq("id", studioId)
    .maybeSingle();

  const studioTimeZone =
    typeof studioTimeZoneRow?.timezone === "string" && studioTimeZoneRow.timezone.trim()
      ? studioTimeZoneRow.timezone.trim()
      : CLOSEOUT_TIME_ZONE;

  const baseDate = getBaseDate(params.date, studioTimeZone);
  const { startIso: todayStart, endIso: todayEnd } =
    getLocalDayUtcRange(baseDate, studioTimeZone);
  const next7LocalDate = formatLocalDateKey(addDaysLocal(baseDate, 7));
  const tomorrowLocalDate = formatLocalDateKey(addDaysLocal(baseDate, 1));
  const next7End = getLocalDayUtcRange(next7LocalDate, studioTimeZone).startIso;

  let appointmentsQuery = supabase
    .from("appointments")
    .select(
      `
      id,
      title,
      appointment_type,
      status,
      client_id,
      starts_at,
      ends_at,
      client_package_id,
      price_amount,
      payment_status,
      billing_type,
      billing_note,
      is_recurring,
      recurrence_series_id,
      clients:clients!appointments_client_id_fkey ( first_name, last_name, referral_source ),
      instructors ( id, first_name, last_name ),
      rooms ( id, name ),
      client_packages (
        name_snapshot,
        active,
        client_package_items (
          usage_type,
          quantity_remaining,
          quantity_total,
          is_unlimited
        )
      )
    `,
    )
    .eq("studio_id", studioId)
    .order("starts_at", { ascending: true });

  if (scope === "today") {
    appointmentsQuery = appointmentsQuery
      .gte("starts_at", todayStart)
      .lt("starts_at", todayEnd);
  } else if (scope === "next7") {
    appointmentsQuery = appointmentsQuery
      .gte("starts_at", todayStart)
      .lt("starts_at", next7End);
  }

  if (statusFilter !== "all") {
    if (
      statusFilter === "scheduled" ||
      statusFilter === "attended" ||
      statusFilter === "cancelled" ||
      statusFilter === "no_show" ||
      statusFilter === "rescheduled"
    ) {
      appointmentsQuery = appointmentsQuery.eq("status", statusFilter);
    } else {
      appointmentsQuery = appointmentsQuery.eq(
        "id",
        "00000000-0000-0000-0000-000000000000",
      );
    }
  }

  if (instructorFilter !== "all") {
    appointmentsQuery = appointmentsQuery.eq("instructor_id", instructorFilter);
  }

  if (roomFilter !== "all") {
    appointmentsQuery = appointmentsQuery.eq("room_id", roomFilter);
  }

  let eventsQuery = supabase
    .from("events")
    .select(
      `
      id,
      name,
      slug,
      event_type,
      status,
      visibility,
      start_date,
      end_date,
      start_time,
      end_time,
      venue_name,
      city,
      state,
      organizers ( name )
    `,
    )
    .eq("studio_id", studioId)
    .in("status", ["draft", "published"])
    .not("visibility", "eq", "private")
    .order("start_date", { ascending: true });

  const todayDate = baseDate;
  const next7Date = next7LocalDate;

  if (scope === "today") {
    eventsQuery = eventsQuery
      .lte("start_date", todayDate)
      .or(`end_date.gte.${todayDate},end_date.is.null`);
  } else if (scope === "next7") {
    eventsQuery = eventsQuery
      .lte("start_date", next7Date)
      .or(`end_date.gte.${todayDate},end_date.is.null`);
  }

  if (statusFilter !== "all") {
    if (
      statusFilter === "scheduled" ||
      statusFilter === "attended" ||
      statusFilter === "cancelled" ||
      statusFilter === "no_show" ||
      statusFilter === "rescheduled"
    ) {
      eventsQuery = eventsQuery.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      eventsQuery = eventsQuery.eq("status", statusFilter);
    }
  }

  const [
    { data: appointments, error: appointmentsError },
    { data: events, error: eventsError },
    { data: instructors },
    { data: rooms },
  ] = await Promise.all([
    appointmentsQuery,
    eventsQuery,
    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),
    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),
  ]);

  if (appointmentsError) {
    throw new Error(
      `Failed to load appointments: ${appointmentsError.message}`,
    );
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  const typedAppointments = ((appointments ?? []) as AppointmentRow[])
    .filter((appointment) => {
      const referralSource = getClientReferralSource(appointment.clients);
      const isPublicIntro =
        appointment.appointment_type === "intro_lesson" &&
        referralSource === "public_intro_booking";
      const isFloorRental =
        appointment.appointment_type === "floor_space_rental";

      if (sourceFilter === "public_intro" && !isPublicIntro) return false;
      if (
        sourceFilter === "intro_lessons" &&
        appointment.appointment_type !== "intro_lesson"
      ) {
        return false;
      }
      if (sourceFilter === "floor_rentals" && !isFloorRental) return false;
      if (sourceFilter === "events") return false;

      return true;
    })
    .filter((appointment) => {
      if (!q) return true;

      const referralSource = getClientReferralSource(appointment.clients);
      const clientName = getClientName(appointment.clients).toLowerCase();
      const instructorName = getInstructorName(
        appointment.instructors,
      ).toLowerCase();
      const roomName = getRoomName(appointment.rooms).toLowerCase();
      const typeLabel = appointmentTypeLabel(
        appointment.appointment_type,
      ).toLowerCase();
      const title = (appointment.title ?? "").toLowerCase();
      const recurringLabel = appointment.is_recurring ? "recurring" : "";
      const publicIntroLabel =
        appointment.appointment_type === "intro_lesson" &&
        referralSource === "public_intro_booking"
          ? "public intro"
          : "";
      const floorRentalLabel =
        appointment.appointment_type === "floor_space_rental"
          ? "floor rental floor space rental rental"
          : "";

      return (
        clientName.includes(q) ||
        instructorName.includes(q) ||
        roomName.includes(q) ||
        typeLabel.includes(q) ||
        title.includes(q) ||
        recurringLabel.includes(q) ||
        publicIntroLabel.includes(q) ||
        floorRentalLabel.includes(q)
      );
    });

  const closeoutClientIds = Array.from(
    new Set(
      typedAppointments
        .filter((appointment) => isSameLocalDate(appointment.starts_at, baseDate, studioTimeZone))
        .map((appointment) => appointment.client_id)
        .filter((clientId): clientId is string => Boolean(clientId)),
    ),
  );

  let accountCreditByClientId = new Map<string, number>();

  if (closeoutClientIds.length > 0) {
    const { data: clientLedgerRows, error: clientLedgerError } = await supabase
      .from("client_account_ledger")
      .select("client_id, direction, amount")
      .eq("studio_id", studioId)
      .in("client_id", closeoutClientIds);

    if (clientLedgerError) {
      throw new Error(
        `Failed to load client account balances: ${clientLedgerError.message}`,
      );
    }

    accountCreditByClientId = ((clientLedgerRows ?? []) as ClientAccountLedgerRow[]).reduce(
      (balances, entry) => {
        const current = balances.get(entry.client_id) ?? 0;
        const amount = Number(entry.amount ?? 0);
        const next =
          entry.direction === "credit" ? current + amount : current - amount;
        balances.set(entry.client_id, next);
        return balances;
      },
      new Map<string, number>(),
    );
  }

  const eventOccurrenceRange =
    scope === "today"
      ? { endExclusive: tomorrowLocalDate, start: baseDate }
      : scope === "next7"
        ? { endExclusive: next7LocalDate, start: baseDate }
        : null;

  const typedEvents = ((events ?? []) as EventRow[])
    .filter((event) => {
      if (sourceFilter === "public_intro") return false;
      if (sourceFilter === "intro_lessons") return false;
      if (sourceFilter === "floor_rentals") return false;
      if (instructorFilter !== "all") return false;
      if (roomFilter !== "all") return false;

      if (event.event_type === "group_class" && eventOccurrenceRange) {
        return Boolean(
          getWeeklyGroupClassOccurrenceDate(
            event,
            eventOccurrenceRange.start,
            eventOccurrenceRange.endExclusive,
          ),
        );
      }

      return true;
    })
    .filter((event) => {
      if (!q) return true;

      const name = event.name.toLowerCase();
      const type = eventTypeLabel(event.event_type).toLowerCase();
      const organizer = getOrganizerName(event.organizers).toLowerCase();
      const location = [event.venue_name, event.city, event.state]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        name.includes(q) ||
        type.includes(q) ||
        organizer.includes(q) ||
        location.includes(q) ||
        "event class party workshop".includes(q)
      );
    });

  const mixedItems: ScheduleListItem[] = [
    ...typedAppointments.map((appointment) => ({
      kind: "appointment" as const,
      sort_key: appointment.starts_at,
      appointment,
    })),
    ...typedEvents.map((event) => {
      const occurrenceDate =
        event.event_type === "group_class" && eventOccurrenceRange
          ? getWeeklyGroupClassOccurrenceDate(
              event,
              eventOccurrenceRange.start,
              eventOccurrenceRange.endExclusive,
            ) ?? undefined
          : undefined;

      return {
        kind: "event" as const,
        occurrence_date: occurrenceDate,
        sort_key: `${occurrenceDate ?? event.start_date}T${event.start_time || "00:00:00"}`,
        event,
      };
    }),
  ].sort((a, b) => a.sort_key.localeCompare(b.sort_key));

  const scheduledCount = typedAppointments.filter(
    (a) => a.status === "scheduled",
  ).length;
  const attendedCount = typedAppointments.filter(
    (a) => a.status === "attended",
  ).length;
  const recurringCount = typedAppointments.filter((a) => a.is_recurring).length;
  const floorRentalCount = typedAppointments.filter(
    (a) => a.appointment_type === "floor_space_rental",
  ).length;
  const dailyCloseoutAppointments = typedAppointments.filter(
    (appointment) =>
      isSameLocalDate(appointment.starts_at, baseDate, studioTimeZone) &&
      isCloseoutCandidate(appointment),
  );
  const dailyCloseoutNeedsReview =
    dailyCloseoutAppointments.filter(mayNeedPaymentReview);
  const dailyCloseoutReadyCount = Math.max(
    dailyCloseoutAppointments.length - dailyCloseoutNeedsReview.length,
    0,
  );
  const currentScheduleHref = `/app/schedule${buildQuery({
    q: params.q || undefined,
    scope,
    source: sourceFilter !== "all" ? sourceFilter : undefined,
    instructor: instructorFilter !== "all" ? instructorFilter : undefined,
    room: roomFilter !== "all" ? roomFilter : undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    date: baseDate,
  })}`;
  const eventCount = typedEvents.length;
  const calendarViews = [
    { view: "month", label: "Month" },
    { view: "week", label: "Week" },
    { view: "day", label: "Day" },
    { view: "agenda", label: "Agenda" },
  ] as const;

  return (
    <div className="space-y-6 rounded-[2rem] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.09),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.10),transparent_26%),linear-gradient(180deg,#fff7ed_0%,#ffffff_30%)] p-1">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm shadow-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[30px] border border-violet-200/80 bg-white shadow-[0_20px_55px_rgba(76,29,149,0.12)]">
        <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-5 py-6 text-white sm:px-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-orange-200">
                DanceFlow Schedule
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                Schedule workspace
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
                Manage lessons, events, attendance, booking requests, floor rentals, and daily closeout from one operating view.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/app/schedule/requests"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur hover:bg-white/15"
              >
                Booking Requests
              </Link>

              {canCreateAppointments(role) ? (
                <Link
                  href="/app/schedule/new"
                  className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-sm hover:bg-orange-50"
                >
                  New Appointment
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_55%,#ffffff_100%)] p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
              Open calendar
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Switch to a full calendar view while preserving the selected date and filters.
            </p>
          </div>

          <div className="grid grid-cols-4 rounded-xl border border-violet-200 bg-white p-1 shadow-sm">
            {calendarViews.map((item) => (
              <Link
                key={item.view}
                href={`/app/schedule/calendar${buildQuery({
                  view: item.view,
                  date: baseDate,
                  instructor:
                    instructorFilter !== "all" ? instructorFilter : undefined,
                  room: roomFilter !== "all" ? roomFilter : undefined,
                  status: statusFilter !== "all" ? statusFilter : undefined,
                  source:
                    sourceFilter !== "all" ? sourceFilter : undefined,
                })}`}
                className="rounded-lg px-3 py-2 text-center text-xs font-semibold text-slate-700 hover:bg-violet-50 hover:text-violet-800 sm:text-sm"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-orange-200/70 bg-white shadow-sm">
        <div className="grid grid-cols-2 divide-x divide-y divide-orange-100 sm:grid-cols-3 sm:divide-y-0 xl:grid-cols-6">
          {[
            { label: "Visible", value: mixedItems.length, icon: ClipboardList },
            { label: "Appointments", value: typedAppointments.length, icon: CalendarDays },
            { label: "Events", value: eventCount, icon: Sparkles },
            { label: "Scheduled", value: scheduledCount, icon: CalendarDays },
            { label: "Recurring", value: recurringCount, icon: Repeat2 },
            { label: "Floor rentals", value: floorRentalCount, icon: DoorOpen },
          ].map((item) => {
            const Icon = item.icon;

            return (
              <div key={item.label} className="flex items-center gap-3 px-4 py-4">
                <span className="rounded-xl bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] p-2 text-violet-800 ring-1 ring-violet-200">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    {item.label}
                  </p>
                  <p className="mt-0.5 text-xl font-semibold text-slate-950">
                    {item.value}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="rounded-[28px] border border-emerald-200 bg-[linear-gradient(135deg,#ffffff_0%,#ecfdf5_48%,#fff7ed_100%)] p-5 shadow-[0_18px_45px_rgba(5,150,105,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-green-50 p-3 text-green-700">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-green-700">
                Daily Closeout
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                Mark eligible lessons attended for {formatDate(baseDate)}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Use this at the end of the day to quickly close out lessons.
                Lessons that need payment, package credit, membership coverage,
                or review are skipped instead of being marked attended.
              </p>
            </div>
          </div>

          {canMarkAttendance(role) ? (
            <form
              action={bulkMarkDailyAppointmentsAttendedAction}
              className="shrink-0"
            >
              <input type="hidden" name="date" value={baseDate} />
              <input
                type="hidden"
                name="returnTo"
                value={currentScheduleHref}
              />
              <button
                type="submit"
                disabled={dailyCloseoutAppointments.length === 0}
                className="rounded-xl bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Mark Eligible Lessons Attended
              </button>
            </form>
          ) : null}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
            <p className="text-sm font-medium text-green-800">
              Ready to close out
            </p>
            <p className="mt-2 text-3xl font-semibold text-green-950">
              {dailyCloseoutReadyCount}
            </p>
            <p className="mt-1 text-xs text-green-800">
              Lessons that appear ready based on this page. The server checks
              payment and credit rules again before updating.
            </p>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              <p className="text-sm font-medium">May need review</p>
            </div>
            <p className="mt-2 text-3xl font-semibold text-amber-950">
              {dailyCloseoutNeedsReview.length}
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Pay-as-you-go or missing-credit lessons should be reviewed before
              attendance is completed.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-700">
              Included in today's closeout
            </p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {dailyCloseoutAppointments.length}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Scheduled lessons for the selected date. Floor rentals, cancelled
              lessons, no-shows, and already attended lessons are not included.
            </p>
          </div>
        </div>

        {dailyCloseoutNeedsReview.length > 0 ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-amber-100 p-2 text-amber-700">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-amber-950">
                  Lessons that need review
                </h3>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  These lessons are skipped by bulk closeout until payment,
                  package credit, membership coverage, or billing details are
                  corrected.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {dailyCloseoutNeedsReview.map((appointment) => {
                const reason =
                  getCloseoutReviewReason(appointment) ??
                  "This lesson needs review before closeout.";
                const billingType = normalizeBillingType(appointment.billing_type);
                const isPayAsYouGo = billingType === "pay_as_you_go";
                const clientName = getClientName(appointment.clients);
                const lessonPriceDefault = getPaymentAmountDefault(appointment);
                const availableAccountCredit = appointment.client_id
                  ? Math.max(
                      accountCreditByClientId.get(appointment.client_id) ?? 0,
                      0,
                    )
                  : 0;

                return (
                  <div
                    key={appointment.id}
                    className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
                          <span>{formatDateTime(appointment.starts_at, studioTimeZone)}</span>
                          <span>•</span>
                          <span>{appointmentTypeLabel(appointment.appointment_type)}</span>
                          <span>•</span>
                          <span>{billingTypeLabel(appointment.billing_type)}</span>
                        </div>
                        <h4 className="mt-1 text-base font-semibold text-slate-950">
                          {clientName}
                        </h4>
                        <p className="mt-1 text-sm text-amber-800">{reason}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Instructor: {getInstructorName(appointment.instructors)} • Room: {getRoomName(appointment.rooms)}
                        </p>
                      </div>

                      <div className="flex flex-col gap-3 xl:min-w-[360px]">
                        {isPayAsYouGo && appointment.client_id ? (
                          <form
                            action={recordPayAsYouGoLessonPaymentAction}
                            className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                          >
                            <input
                              type="hidden"
                              name="appointmentId"
                              value={appointment.id}
                            />
                            <input
                              type="hidden"
                              name="clientId"
                              value={appointment.client_id}
                            />
                            <input
                              type="hidden"
                              name="returnTo"
                              value={currentScheduleHref}
                            />
                            <input
                              type="hidden"
                              name="lessonPrice"
                              value={lessonPriceDefault}
                            />

                            <div className="mb-3">
                              <p className="text-sm font-semibold text-slate-900">
                                Pay now for this lesson
                              </p>
                              <p className="mt-1 text-xs leading-5 text-slate-500">
                                This records a payment directly against the selected pay-as-you-go lesson.
                              </p>
                            </div>

                            <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span>Available account credit</span>
                                <span className="font-semibold text-slate-900">
                                  {formatCurrency(availableAccountCredit)}
                                </span>
                              </div>
                              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                                Apply credit first, then record only the remaining money collected today.
                              </p>
                            </div>

                            <div className="grid gap-2 sm:grid-cols-2">
                              <label className="block text-xs font-medium text-slate-600">
                                Lesson price
                                <input
                                  name="lessonPriceDisplay"
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  defaultValue={lessonPriceDefault}
                                  placeholder="0.00"
                                  className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm"
                                  disabled
                                />
                              </label>

                              <label className="block text-xs font-medium text-slate-600">
                                Apply account credit
                                <input
                                  name="accountCreditToApply"
                                  type="number"
                                  min="0"
                                  max={availableAccountCredit || undefined}
                                  step="0.01"
                                  defaultValue=""
                                  placeholder="0.00"
                                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                />
                              </label>

                              <label className="block text-xs font-medium text-slate-600">
                                Money collected today
                                <input
                                  name="amount"
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  defaultValue={lessonPriceDefault}
                                  placeholder="0.00"
                                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                  required
                                />
                              </label>

                              <label className="block text-xs font-medium text-slate-600">
                                Collection method
                                <select
                                  name="paymentMethod"
                                  defaultValue="cash"
                                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                >
                                  <option value="cash">Cash</option>
                                  <option value="card">Card outside DanceFlow</option>
                                  <option value="check">Check</option>
                                  <option value="venmo">Venmo</option>
                                  <option value="zelle">Zelle</option>
                                  <option value="other">Other</option>
                                </select>
                              </label>

                              <button
                                type="submit"
                                className="sm:col-span-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
                              >
                                Record Lesson Payment
                              </button>
                            </div>
                          </form>
                        ) : null}

                        <div className="flex flex-wrap gap-2 xl:justify-end">
                          <Link
                            href={`/app/schedule/${appointment.id}/edit`}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Edit lesson
                          </Link>
                          {appointment.client_id ? (
                            <Link
                              href={`/app/clients/${appointment.client_id}`}
                              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Client details
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      <form className="rounded-[28px] border border-violet-200/80 bg-white/95 p-5 shadow-[0_18px_45px_rgba(76,29,149,0.09)]">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-2xl bg-[linear-gradient(135deg,#4c1d95_0%,#f97316_130%)] p-3 text-white shadow-sm">
            <Filter className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Filter the schedule
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Narrow the view by date scope, source, instructor, room, and
              status to get the right operational picture quickly.
            </p>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1.3fr_repeat(6,minmax(0,1fr))]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Client, instructor, room, type, event..."
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            />
          </div>

          <div>
            <label htmlFor="date" className="mb-1 block text-sm font-medium">
              Date
            </label>
            <input
              id="date"
              name="date"
              type="date"
              defaultValue={baseDate}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            />
          </div>

          <div>
            <label htmlFor="scope" className="mb-1 block text-sm font-medium">
              Date Scope
            </label>
            <select
              id="scope"
              name="scope"
              defaultValue={scope}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            >
              <option value="today">Today</option>
              <option value="next7">Next 7 Days</option>
              <option value="all">All</option>
            </select>
          </div>

          <div>
            <label htmlFor="source" className="mb-1 block text-sm font-medium">
              Source
            </label>
            <select
              id="source"
              name="source"
              defaultValue={sourceFilter}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            >
              <option value="all">All</option>
              <option value="events">Events Only</option>
              <option value="intro_lessons">Intro Lessons</option>
              <option value="public_intro">Public Intro</option>
              <option value="floor_rentals">Floor Rentals</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="instructor"
              className="mb-1 block text-sm font-medium"
            >
              Instructor
            </label>
            <select
              id="instructor"
              name="instructor"
              defaultValue={instructorFilter}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            >
              <option value="all">All</option>
              {(instructors ?? []).map((instructor) => (
                <option key={instructor.id} value={instructor.id}>
                  {instructor.first_name} {instructor.last_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="room" className="mb-1 block text-sm font-medium">
              Room
            </label>
            <select
              id="room"
              name="room"
              defaultValue={roomFilter}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            >
              <option value="all">All</option>
              {(rooms ?? []).map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            >
              <option value="all">All</option>
              <option value="scheduled">Scheduled</option>
              <option value="attended">Attended</option>
              <option value="cancelled">Cancelled</option>
              <option value="no_show">No Show</option>
              <option value="rescheduled">Rescheduled</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="submit"
            className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2 font-semibold text-white shadow-sm hover:brightness-110"
          >
            Apply Filters
          </button>
          <Link
            href="/app/schedule"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Reset
          </Link>
        </div>
      </form>

      <section className="rounded-3xl border border-orange-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#fff7ed_55%,#faf5ff_100%)] px-5 py-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
              Operating schedule
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {scope === "today"
                ? `Items for ${formatDate(baseDate)}`
                : scope === "next7"
                  ? "Next 7 days"
                  : "All visible schedule items"}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Appointments and studio events are ordered by start time. Open an item for full details.
            </p>
          </div>
          <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-orange-200">
            {mixedItems.length} item{mixedItems.length === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      <div className="space-y-4">
        {mixedItems.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-10 text-center text-slate-500 shadow-sm">
            <p className="text-base font-medium text-slate-900">
              No schedule items match your current filters.
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Adjust the filters above to broaden the schedule view.
            </p>
          </div>
        ) : (
          mixedItems.map((item) => {
            if (item.kind === "event") {
              const event = item.event;

              return (
                <div
                  key={`event-${event.id}`}
                  className={`relative overflow-hidden rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-md sm:p-5 ${eventCardClass(event.event_type)}`}
                >
                  <div className={`absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b ${eventAccentClass(event.event_type)}`} />
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 pl-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <Link
                          href={`/app/events/${event.id}`}
                          className="text-lg font-semibold text-slate-950 hover:text-[var(--brand-primary)]"
                        >
                          {event.name}
                        </Link>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            event.status,
                          )}`}
                        >
                          {event.status}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${eventTypeBadgeClass(
                            event.event_type,
                          )}`}
                        >
                          {eventTypeLabel(event.event_type)}
                        </span>

                        <span className="inline-flex rounded-full bg-white/80 px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                          Event listing
                        </span>
                      </div>

                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Staffing, room planning, registration, and check-in visibility.
                      </p>

                      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="min-w-0 rounded-xl border border-white/70 bg-white/75 p-3 shadow-sm">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            When
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {formatEventDateRange(event, item.occurrence_date)}
                          </p>
                        </div>

                        <div className="min-w-0 rounded-xl border border-white/70 bg-white/75 p-3 shadow-sm">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            Organizer
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {getOrganizerName(event.organizers)}
                          </p>
                        </div>

                        <div className="min-w-0 rounded-xl border border-white/70 bg-white/75 p-3 shadow-sm">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            Location
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {event.venue_name ||
                              [event.city, event.state]
                                .filter(Boolean)
                                .join(", ") ||
                              "No location"}
                          </p>
                        </div>

                        <div className="min-w-0 rounded-xl border border-white/70 bg-white/75 p-3 shadow-sm">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                            Visibility
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {event.visibility}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 xl:min-w-[220px] xl:justify-end">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                      >
                        View Event
                      </Link>

                      <Link
                        href={`/app/events/${event.id}`}
                        className="rounded-xl border border-violet-200 bg-white/85 px-4 py-2 text-sm font-semibold text-violet-800 shadow-sm hover:bg-violet-50"
                      >
                        Check-In / Roster
                      </Link>
                    </div>
                  </div>
                </div>
              );
            }

            const appointment = item.appointment;
            const pkg = Array.isArray(appointment.client_packages)
              ? appointment.client_packages[0]
              : appointment.client_packages;

            const packageHealth = pkg ? getPackageHealth(pkg) : null;
            const referralSource = getClientReferralSource(appointment.clients);
            const isPublicIntro =
              appointment.appointment_type === "intro_lesson" &&
              referralSource === "public_intro_booking";
            const isFloorRental =
              appointment.appointment_type === "floor_space_rental";

            const isFinalStatus =
              appointment.status === "attended" ||
              appointment.status === "cancelled" ||
              appointment.status === "no_show";

            const showAttendanceActions =
              !isFinalStatus && canMarkAttendance(role) && !isFloorRental;

            return (
              <div
                key={`appointment-${appointment.id}`}
                className="relative overflow-hidden rounded-2xl border border-orange-100 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-[0_16px_40px_rgba(76,29,149,0.10)] sm:p-5"
              >
                <div className="absolute inset-y-0 left-0 w-1 bg-[linear-gradient(180deg,#4c1d95_0%,#f97316_100%)]" />
                <div className="flex flex-col gap-4 pl-2 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={`/app/schedule/${appointment.id}`}
                        className="text-lg font-semibold text-slate-900 hover:underline"
                      >
                        {getClientName(appointment.clients)}
                      </Link>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          appointment.status,
                        )}`}
                      >
                        {appointment.status}
                      </span>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${appointmentTypeBadgeClass(
                          appointment.appointment_type,
                        )}`}
                      >
                        {isFloorRental
                          ? "Floor Rental"
                          : appointmentTypeLabel(appointment.appointment_type)}
                      </span>

                      {appointment.is_recurring ? (
                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          Recurring
                        </span>
                      ) : null}

                      {isPublicIntro ? (
                        <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                          Public Intro
                        </span>
                      ) : null}

                      {!isFloorRental && pkg && packageHealth ? (
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                            packageHealth,
                          )}`}
                        >
                          {packageHealthLabel(packageHealth)}
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-2 text-sm text-slate-600">
                      {appointment.title ||
                        appointmentTypeLabel(appointment.appointment_type)}
                    </p>

                    {appointment.is_recurring ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Attendance applies per lesson. Cancellation can affect
                        this lesson or this and future.
                      </p>
                    ) : null}

                    {isFloorRental ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Independent instructor floor rental. No package
                        deduction. Instructor and room may be optionally
                        assigned for internal tracking.
                      </p>
                    ) : null}

                    <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Start
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {formatDateTime(appointment.starts_at, studioTimeZone)}
                        </p>
                      </div>

                      <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Instructor
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {getInstructorName(appointment.instructors)}
                        </p>
                      </div>

                      <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Room
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {getRoomName(appointment.rooms)}
                        </p>
                      </div>

                      <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Package
                        </p>
                        <p className="mt-1 break-words text-sm font-medium text-slate-900">
                          {isFloorRental
                            ? "No package deduction"
                            : pkg
                              ? `${pkg.name_snapshot} — ${summarizeClientPackageItems(
                                  pkg.client_package_items ?? [],
                                )}`
                              : "—"}
                        </p>

                        {!isFloorRental &&
                        pkg &&
                        packageHealth &&
                        packageHealth !== "healthy" ? (
                          <p className="mt-1 text-xs text-slate-500">
                            {packageHealth === "low_balance"
                              ? "Linked package is running low."
                              : packageHealth === "depleted"
                                ? "Linked package has no remaining balance."
                                : packageHealth === "inactive"
                                  ? "Linked package is inactive."
                                  : ""}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 xl:min-w-[150px] xl:justify-end">
                    <Link
                      href={`/app/schedule/${appointment.id}`}
                      className="rounded-xl border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50"
                    >
                      View
                    </Link>

                    {!isFinalStatus && canEditAppointments(role) ? (
                      <Link
                        href={`/app/schedule/${appointment.id}/edit`}
                        className="rounded-xl border border-orange-200 bg-white px-4 py-2 text-sm font-semibold text-orange-800 hover:bg-orange-50"
                      >
                        Edit
                      </Link>
                    ) : null}
                  </div>
                </div>

                {showAttendanceActions ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-orange-100 bg-[linear-gradient(90deg,rgba(255,247,237,0.7),rgba(250,245,255,0.7))] px-3 py-3">
                    <form action={markAppointmentAttendedAction}>
                      <input
                        type="hidden"
                        name="appointmentId"
                        value={appointment.id}
                      />
                      <input
                        type="hidden"
                        name="returnTo"
                        value={currentScheduleHref}
                      />
                      <button
                        type="submit"
                        className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                      >
                        Mark Attended
                      </button>
                    </form>

                    <form action={markAppointmentNoShowAction}>
                      <input
                        type="hidden"
                        name="appointmentId"
                        value={appointment.id}
                      />
                      <input
                        type="hidden"
                        name="returnTo"
                        value={currentScheduleHref}
                      />
                      <button
                        type="submit"
                        className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-600"
                      >
                        Mark No Show
                      </button>
                    </form>

                    <div className="w-full sm:w-auto sm:min-w-[320px]">
                      <AppointmentCancellationForm
                        appointmentId={appointment.id}
                        returnTo={currentScheduleHref}
                        isRecurring={appointment.is_recurring}
                        compact
                      />
                    </div>
                  </div>
                ) : null}

                {isFloorRental &&
                !isFinalStatus &&
                canEditAppointments(role) ? (
                  <div className="mt-4 border-t pt-4">
                    <p className="text-xs text-slate-500">
                      Floor space rentals are shown on the schedule for
                      visibility, but they do not use standard lesson attendance
                      and package workflows.
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}



