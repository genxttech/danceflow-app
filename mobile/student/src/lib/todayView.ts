/*
  Presentation helpers for the Today screen. Pure functions over data the screen already loads
  (the schedule overview); no new queries.
*/

type Dated = { startsAt: string; timeZone?: string | null };

function dayKey(date: Date, timeZone?: string | null) {
  // en-CA formats as YYYY-MM-DD, which sorts and compares as a key.
  return date.toLocaleDateString("en-CA", { timeZone: timeZone || undefined });
}

function timeLabel(date: Date, timeZone?: string | null) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone || undefined });
}

/** "Today at 6:00 PM", "Tomorrow at 6:00 PM" or "Tue, Nov 11 at 6:00 PM", in the studio's time zone. */
export function momentLabel(startsAt: string, timeZone?: string | null, now = new Date()) {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "Time to be confirmed";

  const startKey = dayKey(start, timeZone);
  const todayKey = dayKey(now, timeZone);
  const tomorrowKey = dayKey(new Date(now.getTime() + 86_400_000), timeZone);
  const time = timeLabel(start, timeZone);

  if (startKey === todayKey) return `Today at ${time}`;
  if (startKey === tomorrowKey) return `Tomorrow at ${time}`;

  const day = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timeZone || undefined });
  return `${day} at ${time}`;
}

export type WeekDay = {
  key: string;
  weekday: string;
  dayOfMonth: string;
  isToday: boolean;
  count: number;
};

/** The next seven days starting today, with how many schedule items fall on each. */
export function weekStrip(items: Dated[], now = new Date(), timeZone?: string | null): WeekDay[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const start = new Date(item.startsAt);
    if (Number.isNaN(start.getTime())) continue;
    const key = dayKey(start, item.timeZone ?? timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now.getTime() + offset * 86_400_000);
    const key = dayKey(date, timeZone);
    return {
      key,
      weekday: date.toLocaleDateString("en-US", { weekday: "short", timeZone: timeZone || undefined }),
      dayOfMonth: date.toLocaleDateString("en-US", { day: "numeric", timeZone: timeZone || undefined }),
      isToday: offset === 0,
      count: counts.get(key) ?? 0
    };
  });
}

/** What a screen reader hears for the week strip. */
export function weekStripLabel(days: WeekDay[]) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const busy = days.filter((day) => day.count > 0).map((day) => day.weekday);
  if (total === 0) return "Nothing scheduled in the next seven days. Opens your full schedule.";
  return `${total} scheduled in the next seven days, on ${busy.join(", ")}. Opens your full schedule.`;
}
