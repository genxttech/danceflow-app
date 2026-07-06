import type { StudentScheduleItem } from "@/lib/studentSchedule";

export function isLessonScheduleItem(item: StudentScheduleItem) {
  const type = (item.appointmentType ?? "").toLowerCase();
  const title = item.title.toLowerCase();
  const subtitle = item.subtitle.toLowerCase();

  return (
    type.includes("private") ||
    type.includes("intro") ||
    type.includes("coaching") ||
    title.includes("private") ||
    title.includes("intro") ||
    subtitle.includes("private")
  );
}

export function isClassScheduleItem(item: StudentScheduleItem) {
  return !isLessonScheduleItem(item);
}

export function displayScheduleTitle(item: StudentScheduleItem) {
  const typeLabel = item.appointmentType
    ? item.appointmentType.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase())
    : "Appointment";
  const title = item.title.trim();
  const normalizedTitle = title.toLowerCase();

  if (
    isLessonScheduleItem(item) &&
    (normalizedTitle.includes("self-service") || normalizedTitle.includes("booking"))
  ) {
    return typeLabel;
  }

  return title || typeLabel;
}

export function displayScheduleSubtitle(item: StudentScheduleItem) {
  const title = displayScheduleTitle(item).toLowerCase();
  const subtitle = item.subtitle.trim();

  if (!subtitle || subtitle.toLowerCase() === title) return null;
  return subtitle;
}
