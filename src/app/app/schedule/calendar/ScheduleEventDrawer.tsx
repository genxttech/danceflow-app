"use client";

import Link from "next/link";
import {
  cancelAppointmentAction,
  markAppointmentAttendedAction,
  markAppointmentNoShowAction,
} from "../actions";

export type DrawerAppointment = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  is_recurring?: boolean;
  recurrence_series_id?: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  instructors:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms:
    | { name: string }
    | { name: string }[]
    | null;
};

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function formatStatusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function appointmentTypeBadgeClass(value: string) {
  if (value === "floor_space_rental") {
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100";
  }
  if (value === "intro_lesson") {
    return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
  }
  if (value === "group_class") {
    return "bg-green-50 text-green-700 ring-1 ring-green-100";
  }
  if (value === "coaching") {
    return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
  }
  if (value === "practice_party") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  }
  if (value === "event") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-100";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getInstructorName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor ? `${instructor.first_name} ${instructor.last_name}` : "No instructor";
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTimeRange(startsAt: string, endsAt: string) {
  const start = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startsAt));

  const end = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(endsAt));

  return `${start} – ${end}`;
}

type Props = {
  appointment: DrawerAppointment | null;
  onClose: () => void;
};

export default function ScheduleEventDrawer({ appointment, onClose }: Props) {
  if (!appointment) return null;

  const clientName = getClientName(appointment.clients);
  const instructorName = getInstructorName(appointment.instructors);
  const roomName = getRoomName(appointment.rooms);

  const isFloorRental = appointment.appointment_type === "floor_space_rental";
  const isFinalStatus =
    appointment.status === "attended" ||
    appointment.status === "cancelled" ||
    appointment.status === "no_show";

  const canShowAttendanceActions = !isFinalStatus && !isFloorRental;
  const canShowCancelAction = !isFinalStatus;

  return (
    <>
      <button
        type="button"
        aria-label="Close drawer overlay"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px]"
      />

      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-500">Schedule Item</p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
                {appointment.title || appointmentTypeLabel(appointment.appointment_type)}
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                {formatDateTime(appointment.starts_at)}
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Close
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                appointment.status
              )}`}
            >
              {formatStatusLabel(appointment.status)}
            </span>

            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${appointmentTypeBadgeClass(
                appointment.appointment_type
              )}`}
            >
              {appointmentTypeLabel(appointment.appointment_type)}
            </span>

            {appointment.is_recurring ? (
              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                Recurring
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="text-sm font-semibold text-slate-900">At a glance</h4>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Client</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{clientName}</p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Instructor</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {isFloorRental ? "Independent instructor rental" : instructorName}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Time</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {formatTimeRange(appointment.starts_at, appointment.ends_at)}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Room</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{roomName}</p>
              </div>
            </div>
          </section>

          <section className="grid gap-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Starts</p>
              <p className="mt-1 text-sm font-medium text-slate-900">
                {formatDateTime(appointment.starts_at)}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Ends</p>
              <p className="mt-1 text-sm font-medium text-slate-900">
                {formatDateTime(appointment.ends_at)}
              </p>
            </div>
          </section>

          {isFloorRental ? (
            <section className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
              Floor space rentals do not use the standard lesson attendance flow and do not deduct from lesson packages.
            </section>
          ) : null}

          {canShowAttendanceActions ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-semibold text-slate-900">Attendance Actions</h4>
              <div className="mt-4 grid gap-3">
                <form action={markAppointmentAttendedAction}>
                  <input type="hidden" name="appointmentId" value={appointment.id} />
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700"
                  >
                    Mark Attended
                  </button>
                </form>

                <form action={markAppointmentNoShowAction}>
                  <input type="hidden" name="appointmentId" value={appointment.id} />
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600"
                  >
                    Mark No Show
                  </button>
                </form>
              </div>
            </section>
          ) : null}

          {canShowCancelAction ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-semibold text-slate-900">Appointment Action</h4>
              <div className="mt-4">
                <form action={cancelAppointmentAction}>
                  <input type="hidden" name="appointmentId" value={appointment.id} />
                  <button
                    type="submit"
                    className="w-full rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    {isFloorRental ? "Cancel Rental" : "Cancel Appointment"}
                  </button>
                </form>
              </div>
            </section>
          ) : null}
        </div>

        <div className="border-t border-slate-200 px-5 py-4 sm:px-6">
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/app/schedule/${appointment.id}`}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View Details
            </Link>

            <Link
              href={`/app/schedule/${appointment.id}/edit`}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Edit
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
