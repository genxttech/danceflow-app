import { danceflowApiFetch } from "@/lib/danceflowApi";

export type LessonCheckinStatus = {
  appointmentId: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  canCheckIn: boolean;
  opensAt: string;
  closesAt: string;
  instructorNotified?: boolean;
};

export function loadLessonCheckinStatus(appointmentId: string) {
  return danceflowApiFetch<LessonCheckinStatus>(
    `/api/student/appointments/${encodeURIComponent(appointmentId)}/check-in`,
  );
}

export function checkInForLesson(appointmentId: string) {
  return danceflowApiFetch<LessonCheckinStatus>(
    `/api/student/appointments/${encodeURIComponent(appointmentId)}/check-in`,
    { method: "POST", body: JSON.stringify({}) },
  );
}
