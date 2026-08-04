import { danceflowApiFetch } from "@/lib/danceflowApi";

export type AppointmentConfirmationResult = {
  appointmentId: string;
  status: "confirmed";
  confirmedAt?: string;
  alreadyConfirmed?: boolean;
};

export async function confirmStudentAppointment(appointmentId: string) {
  return danceflowApiFetch<AppointmentConfirmationResult>(
    `/api/student/appointments/${encodeURIComponent(appointmentId)}/confirm`,
    { method: "POST" },
  );
}
