export type SelfServiceAvailabilityWindow = {
  id?: string;
  instructor_id: string | null;
  room_id: string | null;
  lesson_type: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  effective_start_date: string | null;
  effective_end_date: string | null;
  active: boolean | null;
};

export type SelfServiceBlackout = {
  id?: string;
  instructor_id: string | null;
  room_id: string | null;
  starts_at: string;
  ends_at: string;
  active: boolean | null;
};

export type SelfServiceAppointmentHold = {
  id?: string;
  instructor_id: string | null;
  room_id: string | null;
  starts_at: string;
  ends_at: string;
  status?: string | null;
};

export type SelfServiceSlotSettings = {
  timezone: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  portal_self_scheduling_slot_interval_minutes?: number | null;
  portal_self_scheduling_default_duration_minutes?: number | null;
};

export type SelfServiceSlot = {
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

export type BuildSelfServiceSlotsParams = {
  settings: SelfServiceSlotSettings;
  windows: SelfServiceAvailabilityWindow[];
  blackouts?: SelfServiceBlackout[];
  appointmentHolds?: SelfServiceAppointmentHold[];
  lessonType?: string | null;
  instructorId?: string | null;
  roomId?: string | null;
  now?: Date;
};

const DEFAULT_TIME_ZONE = "America/New_York";
const BLOCKING_APPOINTMENT_STATUSES = new Set([
  "scheduled",
  "rescheduled",
]);

export function getStudioTimeZone(value: string | null | undefined) {
  return value?.trim() || DEFAULT_TIME_ZONE;
}

export function addMinutes(value: Date, minutes: number) {
  return new Date(value.getTime() + minutes * 60 * 1000);
}

export function overlaps(
  startsAt: Date,
  endsAt: Date,
  blockedStartsAt: Date,
  blockedEndsAt: Date
) {
  return startsAt < blockedEndsAt && endsAt > blockedStartsAt;
}

export function getZonedDateTimeParts(value: Date, timeZone: string) {
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

  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hour = part("hour");

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: hour === 24 ? 0 : hour,
    minute: part("minute"),
    second: part("second"),
  };
}

export function getZonedOffsetMs(value: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  const utcLike = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return utcLike - value.getTime();
}

export function zonedDateTimeToUtcDate(
  date: string,
  time: string,
  timeZone: string
) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.slice(0, 5).split(":").map(Number);
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let index = 0; index < 3; index += 1) {
    const offset = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset;
  }

  return new Date(utcMs);
}

export function getZonedDateKey(value: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return value.toISOString().slice(0, 10);
}

export function getZonedWeekday(dateKey: string, timeZone: string) {
  return getWeekdayIndex(dateKey, timeZone);
}

function getWeekdayIndex(dateKey: string, timeZone: string) {
  const value = zonedDateTimeToUtcDate(dateKey, "12:00", timeZone);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(value);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
}

function normalizeInterval(value: number | null | undefined) {
  return [5, 10, 15, 20, 30, 45, 60].includes(value ?? 0) ? value! : 15;
}

function normalizeDuration(value: number | null | undefined) {
  return [30, 45, 60, 75, 90, 120].includes(value ?? 0) ? value! : 45;
}

function formatLocalTime(value: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function windowMatches(
  window: SelfServiceAvailabilityWindow,
  params: {
    dateKey: string;
    weekday: number;
    lessonType?: string | null;
    instructorId?: string | null;
    roomId?: string | null;
  }
) {
  if (window.active === false) return false;
  if (Number(window.weekday) !== params.weekday) return false;

  const effectiveStartDate = window.effective_start_date?.slice(0, 10) ?? null;
  const effectiveEndDate = window.effective_end_date?.slice(0, 10) ?? null;

  if (effectiveStartDate && params.dateKey < effectiveStartDate) return false;
  if (effectiveEndDate && params.dateKey > effectiveEndDate) return false;
  if (
    params.lessonType &&
    window.lesson_type &&
    window.lesson_type !== params.lessonType
  ) {
    return false;
  }
  if (
    params.instructorId &&
    window.instructor_id &&
    window.instructor_id !== params.instructorId
  ) {
    return false;
  }
  if (params.roomId && window.room_id && window.room_id !== params.roomId) {
    return false;
  }

  return true;
}

function holdMatches(
  hold: SelfServiceAppointmentHold | SelfServiceBlackout,
  params: { instructorId: string | null; roomId: string | null }
) {
  const sameInstructor =
    !hold.instructor_id ||
    !params.instructorId ||
    hold.instructor_id === params.instructorId;
  const sameRoom = !hold.room_id || !params.roomId || hold.room_id === params.roomId;

  return sameInstructor && sameRoom;
}

function appointmentBlocks(hold: SelfServiceAppointmentHold) {
  if (!hold.status) return true;
  return BLOCKING_APPOINTMENT_STATUSES.has(hold.status);
}

function isBlocked(params: {
  startsAt: Date;
  endsAt: Date;
  instructorId: string | null;
  roomId: string | null;
  blackouts: SelfServiceBlackout[];
  appointmentHolds: SelfServiceAppointmentHold[];
}) {
  for (const blackout of params.blackouts) {
    if (blackout.active === false) continue;
    if (!holdMatches(blackout, params)) continue;
    if (
      overlaps(
        params.startsAt,
        params.endsAt,
        new Date(blackout.starts_at),
        new Date(blackout.ends_at)
      )
    ) {
      return true;
    }
  }

  for (const hold of params.appointmentHolds) {
    if (!appointmentBlocks(hold)) continue;
    if (!holdMatches(hold, params)) continue;
    if (
      overlaps(
        params.startsAt,
        params.endsAt,
        new Date(hold.starts_at),
        new Date(hold.ends_at)
      )
    ) {
      return true;
    }
  }

  return false;
}

export function buildSelfServiceSlots(params: BuildSelfServiceSlotsParams) {
  const timeZone = getStudioTimeZone(params.settings.timezone);
  const now = params.now ?? new Date();
  const windowDays = Math.max(params.settings.portal_self_scheduling_window_days ?? 14, 1);
  const minNoticeHours = Math.max(params.settings.portal_self_scheduling_min_notice_hours ?? 24, 0);
  const intervalMinutes = normalizeInterval(
    params.settings.portal_self_scheduling_slot_interval_minutes
  );
  const durationMinutes = normalizeDuration(
    params.settings.portal_self_scheduling_default_duration_minutes
  );
  const minStart = new Date(now.getTime() + minNoticeHours * 60 * 60 * 1000);
  const firstDateKey = getZonedDateKey(now, timeZone);
  const slots: SelfServiceSlot[] = [];

  for (let dayOffset = 0; dayOffset <= windowDays; dayOffset += 1) {
    const dateKey = addDaysToDateKey(firstDateKey, dayOffset);
    const weekday = getWeekdayIndex(dateKey, timeZone);
    const matchingWindows = params.windows.filter((window) =>
      windowMatches(window, {
        dateKey,
        weekday,
        lessonType: params.lessonType,
        instructorId: params.instructorId,
        roomId: params.roomId,
      })
    );

    for (const window of matchingWindows) {
      const windowStart = zonedDateTimeToUtcDate(dateKey, window.start_time, timeZone);
      const windowEnd = zonedDateTimeToUtcDate(dateKey, window.end_time, timeZone);

      for (
        let startsAt = windowStart;
        addMinutes(startsAt, durationMinutes) <= windowEnd;
        startsAt = addMinutes(startsAt, intervalMinutes)
      ) {
        const endsAt = addMinutes(startsAt, durationMinutes);
        const instructorId = params.instructorId ?? window.instructor_id;
        const roomId = params.roomId ?? window.room_id;

        if (startsAt < minStart) continue;
        if (
          isBlocked({
            startsAt,
            endsAt,
            instructorId,
            roomId,
            blackouts: params.blackouts ?? [],
            appointmentHolds: params.appointmentHolds ?? [],
          })
        ) {
          continue;
        }

        slots.push({
          date: dateKey,
          startTime: formatLocalTime(startsAt, timeZone),
          endTime: formatLocalTime(endsAt, timeZone),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          instructorId,
          roomId,
        });
      }
    }
  }

  return slots;
}
