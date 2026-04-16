type WeeklyOccurrenceInput = {
  startDate: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  occurrenceCount?: number;
  intervalCount?: number; // default 1
};

function toDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toDateString(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function generateWeeklyOccurrenceDates(
  input: WeeklyOccurrenceInput
): string[] {
  const interval = input.intervalCount && input.intervalCount > 0 ? input.intervalCount : 1;
  const start = toDateOnly(input.startDate);

  if (input.endDate) {
    const end = toDateOnly(input.endDate);

    if (end < start) {
      throw new Error("Recurrence end date must be on or after the start date.");
    }

    const dates: string[] = [];
    const cursor = new Date(start);

    while (cursor <= end) {
      dates.push(toDateString(cursor));
      cursor.setDate(cursor.getDate() + interval * 7);
    }

    return dates;
  }

  const count = input.occurrenceCount ?? 0;

  if (count < 2) {
    throw new Error("Recurring lessons must have at least 2 occurrences.");
  }

  const dates: string[] = [];
  const cursor = new Date(start);

  for (let i = 0; i < count; i += 1) {
    dates.push(toDateString(cursor));
    cursor.setDate(cursor.getDate() + interval * 7);
  }

  return dates;
}