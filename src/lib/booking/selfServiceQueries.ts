import {
  addDaysToDateKey,
  buildSelfServiceSlots,
  getStudioTimeZone,
  getZonedDateKey,
  type SelfServiceAppointmentHold,
  type SelfServiceAvailabilityWindow,
  type SelfServiceBlackout,
  type SelfServiceSlot,
  zonedDateTimeToUtcDate,
} from "@/lib/booking/selfServiceAvailability";
import {
  canUseSelfServiceBooking,
  type BookingActionType,
  type BookingActionDecision,
  type SelfServiceBookingSettings,
  type StudentBookingEligibility,
} from "@/lib/booking/selfServicePolicy";

type QueryResult<T> = PromiseLike<{
  data: T | null;
  error: { message: string } | null;
}>;

type QueryListResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

type SupabaseFilterBuilder = {
  eq(column: string, value: unknown): SupabaseFilterBuilder;
  gt(column: string, value: unknown): SupabaseFilterBuilder;
  gte(column: string, value: unknown): SupabaseFilterBuilder;
  lt(column: string, value: unknown): SupabaseFilterBuilder;
  in(column: string, values: unknown[]): SupabaseFilterBuilder;
  order(column: string, options?: { ascending?: boolean }): SupabaseFilterBuilder;
  limit(count: number): SupabaseFilterBuilder;
  maybeSingle<T>(): QueryResult<T>;
  single<T>(): QueryResult<T>;
  then<TResult1 = { data: unknown[] | null; error: { message: string } | null }>(
    onfulfilled?:
      | ((value: { data: unknown[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null
  ): PromiseLike<TResult1>;
};

export type SupabaseQueryClient = {
  from(table: string): {
    select(columns?: string): SupabaseFilterBuilder;
  };
};

type StudioRow = {
  id: string;
  name: string;
  slug: string;
};

type ClientRow = {
  id: string;
  portal_user_id: string | null;
};

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

export type StudentSelfServiceInstructor = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
};

type SelfServiceSettingsRow = SelfServiceBookingSettings & {
  timezone: string | null;
  portal_self_scheduling_slot_interval_minutes: number | null;
  portal_self_scheduling_default_duration_minutes: number | null;
};

type LoadStudentSelfServiceSlotsParams = {
  supabase: SupabaseQueryClient;
  studioSlug: string;
  portalUserId: string;
  lessonType?: string | null;
  instructorId?: string | null;
  roomId?: string | null;
  action?: BookingActionType;
  now?: Date;
};

export type StudentSelfServiceSlotsResult = {
  studio: StudioRow;
  client: ClientRow;
  settings: SelfServiceSettingsRow;
  eligibility: StudentBookingEligibility;
  bookingDecision: BookingActionDecision;
  instructors: StudentSelfServiceInstructor[];
  slots: SelfServiceSlot[];
};

function getRangeForSettings(settings: SelfServiceSettingsRow, now: Date) {
  const timeZone = getStudioTimeZone(settings.timezone);
  const todayKey = getZonedDateKey(now, timeZone);
  const windowDays = Math.max(settings.portal_self_scheduling_window_days ?? 14, 1);
  const endDateKey = addDaysToDateKey(todayKey, windowDays + 1);

  return {
    startIso: zonedDateTimeToUtcDate(todayKey, "00:00", timeZone).toISOString(),
    endIso: zonedDateTimeToUtcDate(endDateKey, "00:00", timeZone).toISOString(),
  };
}

async function queryList<T>(
  query: SupabaseFilterBuilder,
  label: string
): Promise<T[]> {
  const { data, error } = (await query) as Awaited<QueryListResult<T>>;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

async function hasActiveCredit(
  supabase: SupabaseQueryClient,
  clientId: string,
  required: boolean | null | undefined
) {
  if (!required) return true;

  const { data, error } = await supabase
    .from("client_packages")
    .select("id")
    .eq("client_id", clientId)
    .eq("active", true)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) throw new Error(`Active credit lookup failed: ${error.message}`);
  return Boolean(data?.id);
}

async function hasPaymentMethod(
  supabase: SupabaseQueryClient,
  clientId: string,
  required: boolean | null | undefined
) {
  if (!required) return true;

  const { data, error } = await supabase
    .from("client_payment_methods")
    .select("id")
    .eq("client_id", clientId)
    .eq("active", true)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) throw new Error(`Payment method lookup failed: ${error.message}`);
  return Boolean(data?.id);
}

function formatInstructorName(instructor: InstructorRow) {
  const fullName = `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim();
  return fullName || "Unnamed instructor";
}

export async function loadStudentSelfServiceSlots(
  params: LoadStudentSelfServiceSlotsParams
): Promise<StudentSelfServiceSlotsResult> {
  const now = params.now ?? new Date();

  const { data: studio, error: studioError } = await params.supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", params.studioSlug)
    .maybeSingle<StudioRow>();

  if (studioError || !studio) {
    throw new Error(studioError?.message ?? "Studio not found.");
  }

  const { data: client, error: clientError } = await params.supabase
    .from("clients")
    .select("id, portal_user_id")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", params.portalUserId)
    .maybeSingle<ClientRow>();

  if (clientError || !client) {
    throw new Error(clientError?.message ?? "Linked student profile not found.");
  }

  const { data: settings, error: settingsError } = await params.supabase
    .from("studio_settings")
    .select(`
      timezone,
      portal_self_scheduling_enabled,
      portal_self_scheduling_mode,
      portal_self_scheduling_reschedule_mode,
      portal_self_scheduling_cancellation_mode,
      portal_self_scheduling_window_days,
      portal_self_scheduling_min_notice_hours,
      portal_self_scheduling_cancellation_cutoff_hours,
      portal_self_scheduling_slot_interval_minutes,
      portal_self_scheduling_default_duration_minutes,
      portal_self_scheduling_require_active_credit,
      portal_self_scheduling_requires_payment_method,
      portal_bookable_lesson_types,
      portal_bookable_instructor_ids
    `)
    .eq("studio_id", studio.id)
    .maybeSingle<SelfServiceSettingsRow>();

  if (settingsError || !settings) {
    throw new Error(settingsError?.message ?? "Self-service settings not found.");
  }

  const eligibility: StudentBookingEligibility = {
    hasLinkedClient: true,
    hasActiveCredit: await hasActiveCredit(
      params.supabase,
      client.id,
      settings.portal_self_scheduling_require_active_credit
    ),
    hasPaymentMethod: await hasPaymentMethod(
      params.supabase,
      client.id,
      settings.portal_self_scheduling_requires_payment_method
    ),
  };

  const bookingDecision = canUseSelfServiceBooking({
    action: params.action ?? "book",
    eligibility,
    lessonType: params.lessonType ?? "private_lesson",
    settings,
  });

  const allowedInstructorIds = settings.portal_bookable_instructor_ids ?? [];
  let instructorsQuery = params.supabase
    .from("instructors")
    .select("id, first_name, last_name")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .order("first_name", { ascending: true });

  if (allowedInstructorIds.length > 0) {
    instructorsQuery = instructorsQuery.in("id", allowedInstructorIds);
  }

  const instructors = (
    await queryList<InstructorRow>(instructorsQuery, "Instructor lookup failed")
  ).map((instructor) => ({
    id: instructor.id,
    firstName: instructor.first_name,
    lastName: instructor.last_name,
    name: formatInstructorName(instructor),
  }));

  const selectedInstructorId = params.instructorId?.trim() || null;

  if (
    selectedInstructorId &&
    !instructors.some((instructor) => instructor.id === selectedInstructorId)
  ) {
    throw new Error("That instructor is not available for self-service scheduling.");
  }

  if (!bookingDecision.allowed) {
    return {
      studio,
      client,
      settings,
      eligibility,
      bookingDecision,
      instructors,
      slots: [],
    };
  }

  if (!selectedInstructorId) {
    return {
      studio,
      client,
      settings,
      eligibility,
      bookingDecision,
      instructors,
      slots: [],
    };
  }

  const range = getRangeForSettings(settings, now);

  const windowsQuery = params.supabase
    .from("studio_booking_availability_windows")
    .select(`
      id,
      instructor_id,
      room_id,
      lesson_type,
      weekday,
      start_time,
      end_time,
      effective_start_date,
      effective_end_date,
      active
    `)
    .eq("studio_id", studio.id)
    .eq("active", true);

  const blackoutsQuery = params.supabase
    .from("studio_booking_blackouts")
    .select("id, instructor_id, room_id, starts_at, ends_at, active")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .lt("starts_at", range.endIso)
    .gt("ends_at", range.startIso);

  const appointmentsQuery = params.supabase
    .from("appointments")
    .select("id, instructor_id, room_id, starts_at, ends_at, status")
    .eq("studio_id", studio.id)
    .lt("starts_at", range.endIso)
    .gt("ends_at", range.startIso)
    .in("status", ["scheduled", "rescheduled"]);

  const [windows, blackouts, appointmentHolds] = await Promise.all([
    queryList<SelfServiceAvailabilityWindow>(windowsQuery, "Availability lookup failed"),
    queryList<SelfServiceBlackout>(blackoutsQuery, "Blackout lookup failed"),
    queryList<SelfServiceAppointmentHold>(appointmentsQuery, "Appointment lookup failed"),
  ]);

  const slots = buildSelfServiceSlots({
    settings,
    windows,
    blackouts,
    appointmentHolds,
    lessonType: params.lessonType ?? "private_lesson",
    instructorId: selectedInstructorId,
    roomId: params.roomId,
    now,
  });

  console.info("Self-service slot diagnostics", {
    studioId: studio.id,
    studioSlug: studio.slug,
    selectedInstructorId,
    lessonType: params.lessonType ?? "private_lesson",
    roomId: params.roomId ?? null,
    timezone: settings.timezone,
    windowDays: settings.portal_self_scheduling_window_days,
    minNoticeHours: settings.portal_self_scheduling_min_notice_hours,
    slotIntervalMinutes: settings.portal_self_scheduling_slot_interval_minutes,
    defaultDurationMinutes: settings.portal_self_scheduling_default_duration_minutes,
    availabilityWindowCount: windows.length,
    blackoutCount: blackouts.length,
    appointmentHoldCount: appointmentHolds.length,
    generatedSlotCount: slots.length,
    firstAvailabilityWindow: windows[0]
      ? {
          id: windows[0].id ?? null,
          instructorId: windows[0].instructor_id,
          roomId: windows[0].room_id,
          lessonType: windows[0].lesson_type,
          weekday: windows[0].weekday,
          weekdayType: typeof windows[0].weekday,
          startTime: windows[0].start_time,
          endTime: windows[0].end_time,
          effectiveStartDate: windows[0].effective_start_date,
          effectiveEndDate: windows[0].effective_end_date,
          active: windows[0].active,
        }
      : null,
    firstGeneratedSlot: slots[0] ?? null,
  });

  return {
    studio,
    client,
    settings,
    eligibility,
    bookingDecision,
    instructors,
    slots,
  };
}
