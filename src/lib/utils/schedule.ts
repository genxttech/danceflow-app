export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

export function startOfWeek(date: Date) {
  const day = date.getDay(); // 0 Sunday
  const diff = date.getDate() - day;
  return new Date(date.getFullYear(), date.getMonth(), diff);
}

export function endOfWeek(date: Date) {
  const start = startOfWeek(date);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function formatDateHeading(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function formatShortDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatTime(dateString: string) {
  return new Date(dateString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}