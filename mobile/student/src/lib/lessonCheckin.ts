import { danceflowApiFetch } from "@/lib/danceflowApi";

export type LessonCheckinStatus = {
  appointmentId: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  canCheckIn: boolean;
  opensAt: string;
  closesAt: string;
  // GC-1.4A: "eligible to perform self-check-in right now as a currently
  // enrolled participant" -- always true for a lesson (ownership already
  // implies eligibility there); for a class, reflects a current
  // status='booked' enrollment, distinct from GC-1.2's historical
  // eligibility rule used elsewhere for staff correction.
  eligible?: boolean;
  instructorNotified?: boolean;
};

// GC-1.4A: clientId is optional and ignored by the route for a lesson
// (ownership resolves from the appointment's own client_id there); it is
// required for a group_class request, since a class has no single client
// to resolve from -- always pass it for a class item.
export function loadLessonCheckinStatus(appointmentId: string, clientId?: string) {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return danceflowApiFetch<LessonCheckinStatus>(
    `/api/student/appointments/${encodeURIComponent(appointmentId)}/check-in${query}`,
  );
}

export function checkInForLesson(appointmentId: string, clientId?: string) {
  return danceflowApiFetch<LessonCheckinStatus>(
    `/api/student/appointments/${encodeURIComponent(appointmentId)}/check-in`,
    { method: "POST", body: JSON.stringify(clientId ? { clientId } : {}) },
  );
}
