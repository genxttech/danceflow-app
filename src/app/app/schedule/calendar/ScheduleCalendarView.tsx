"use client";

import Link from "next/link";
import { useState } from "react";
import {
  addDays,
  formatDateHeading,
  formatShortDate,
  formatTime,
} from "@/lib/utils/schedule";
import ScheduleEventDrawer, {
  type DrawerAppointment,
} from "./ScheduleEventDrawer";
import type { CalendarItem } from "./page";

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type RoomOption = {
  id: string;
  name: string;
};

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
  if (status === "published") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "draft") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Internal Event Appointment";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  if (value === "other") return "Other";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function typeShortLabel(item: CalendarItem) {
  if (item.kind === "event") {
    if (item.event_type === "group_class") return "Class";
    if (item.event_type === "practice_party") return "Party";
    if (item.event_type === "workshop") return "Workshop";
    if (item.event_type === "social_dance") return "Social";
    if (item.event_type === "competition") return "Competition";
    return "Event";
  }

  const value = item.appointment_type ?? "";
  if (value === "private_lesson") return "Private";
  if (value === "group_class") return "Group";
  if (value === "intro_lesson") return "Intro";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Rental";
  return value.replaceAll("_", " ");
}

function typeBadgeClass(item: CalendarItem) {
  if (item.kind === "event") {
    if (item.event_type === "group_class") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
    if (item.event_type === "practice_party") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
    if (item.event_type === "workshop") return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
    if (item.event_type === "social_dance") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
    if (item.event_type === "competition") return "bg-red-50 text-red-700 ring-1 ring-red-100";
    if (item.event_type === "showcase") return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-100";
    if (item.event_type === "festival") return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
    if (item.event_type === "special_event") return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-100";
  }

  if (item.appointment_type === "private_lesson") {
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
  if (item.appointment_type === "floor_space_rental") {
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100";
  }
  if (item.appointment_type === "intro_lesson") {
    return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
  }
  if (item.appointment_type === "group_class") {
    return "bg-green-50 text-green-700 ring-1 ring-green-100";
  }
  if (item.appointment_type === "coaching") {
    return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
  }
  if (item.appointment_type === "practice_party") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  }
  if (item.appointment_type === "event") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-100";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function calendarCardClass(item: CalendarItem) {
  if (item.kind === "event") {
    if (item.event_type === "group_class") {
      return "border-blue-200 bg-blue-50 hover:border-blue-300 hover:bg-blue-100/60";
    }
    if (item.event_type === "practice_party") {
      return "border-amber-200 bg-amber-50 hover:border-amber-300 hover:bg-amber-100/60";
    }
    if (item.event_type === "workshop") {
      return "border-violet-200 bg-violet-50 hover:border-violet-300 hover:bg-violet-100/60";
    }
    if (item.event_type === "social_dance") {
      return "border-emerald-200 bg-emerald-50 hover:border-emerald-300 hover:bg-emerald-100/60";
    }
    if (item.event_type === "competition") {
      return "border-red-200 bg-red-50 hover:border-red-300 hover:bg-red-100/60";
    }
    if (item.event_type === "showcase") {
      return "border-fuchsia-200 bg-fuchsia-50 hover:border-fuchsia-300 hover:bg-fuchsia-100/60";
    }
    if (item.event_type === "festival") {
      return "border-cyan-200 bg-cyan-50 hover:border-cyan-300 hover:bg-cyan-100/60";
    }
    if (item.event_type === "special_event") {
      return "border-orange-200 bg-orange-50 hover:border-orange-300 hover:bg-orange-100/60";
    }
    return "border-rose-200 bg-rose-50 hover:border-rose-300 hover:bg-rose-100/60";
  }

  if (item.appointment_type === "private_lesson") {
    return "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-white";
  }
  if (item.appointment_type === "intro_lesson") {
    return "border-cyan-200 bg-cyan-50 hover:border-cyan-300 hover:bg-cyan-100/60";
  }
  if (item.appointment_type === "group_class") {
    return "border-green-200 bg-green-50 hover:border-green-300 hover:bg-green-100/60";
  }
  if (item.appointment_type === "coaching") {
    return "border-purple-200 bg-purple-50 hover:border-purple-300 hover:bg-purple-100/60";
  }
  if (item.appointment_type === "practice_party") {
    return "border-amber-200 bg-amber-50 hover:border-amber-300 hover:bg-amber-100/60";
  }
  if (item.appointment_type === "floor_space_rental") {
    return "border-indigo-200 bg-indigo-50 hover:border-indigo-300 hover:bg-indigo-100/60";
  }
  if (item.appointment_type === "event") {
    return "border-rose-200 bg-rose-50 hover:border-rose-300 hover:bg-rose-100/60";
  }

  return "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-white";
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getClientShortName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const client = Array.isArray(value) ? value[0] : value;
  if (!client) return "Unknown";
  const lastInitial = client.last_name?.trim()?.[0];
  return lastInitial ? `${client.first_name} ${lastInitial}.` : client.first_name;
}

function getInstructorShortName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  if (!instructor) return "No instructor";
  const lastInitial = instructor.last_name?.trim()?.[0];
  return lastInitial ? `${instructor.first_name} ${lastInitial}.` : instructor.first_name;
}

function getRoomName(value: { name: string } | { name: string }[] | null | undefined) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function getOrganizerName(
  value: { name: string } | { name: string }[] | null | undefined
) {
  const organizer = Array.isArray(value) ? value[0] : value;
  return organizer?.name ?? "Organizer";
}

function formatCalendarItemTime(item: CalendarItem) {
  if (item.kind === "event" && item.is_all_day) {
    return "All day";
  }

  return `${formatTime(item.starts_at)} - ${formatTime(item.ends_at)}`;
}

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}

type CardProps = {
  item: CalendarItem;
  onOpen: (appointment: DrawerAppointment) => void;
};

function CompactCalendarCard({ item, onOpen }: CardProps) {
  const cardClass = calendarCardClass(item);

  if (item.kind === "event") {
    return (
      <Link
        href={`/app/events/${item.id}`}
        className={`block w-full rounded-xl border p-3 text-left transition ${cardClass}`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-slate-600">
            {formatCalendarItemTime(item)}
          </p>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${typeBadgeClass(
              item
            )}`}
          >
            {typeShortLabel(item)}
          </span>
        </div>

        <p className="mt-2 truncate text-sm font-semibold text-slate-900">
          {item.title || eventTypeLabel(item.event_type ?? "other")}
        </p>

        <p className="mt-1 truncate text-xs text-slate-600">
          {getOrganizerName(item.organizers)}
        </p>
      </Link>
    );
  }

  const clientName = getClientShortName(item.clients ?? null);
  const isFloorRental = item.appointment_type === "floor_space_rental";

  return (
    <button
      type="button"
      onClick={() => onOpen(item as DrawerAppointment)}
      className={`block w-full rounded-xl border p-3 text-left transition ${cardClass}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-600">
          {formatTime(item.starts_at)}
        </p>

        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${typeBadgeClass(
            item
          )}`}
        >
          {typeShortLabel(item)}
        </span>
      </div>

      <p className="mt-2 truncate text-sm font-semibold text-slate-900">
        {clientName}
      </p>

      <p className="mt-1 truncate text-xs text-slate-700">
        {isFloorRental
          ? "Floor Rental"
          : item.title || appointmentTypeLabel(item.appointment_type ?? "")}
      </p>

      {item.is_recurring ? (
        <p className="mt-1 text-[11px] text-slate-500">Recurring</p>
      ) : null}
    </button>
  );
}

function ComfortableCalendarCard({ item, onOpen }: CardProps) {
  const cardClass = calendarCardClass(item);

  if (item.kind === "event") {
    const location =
      [item.city, item.state].filter(Boolean).join(", ") ||
      item.venue_name ||
      "No location";

    return (
      <Link
        href={`/app/events/${item.id}`}
        className={`block w-full rounded-2xl border p-4 text-left transition ${cardClass}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-slate-900">
                {item.title || eventTypeLabel(item.event_type ?? "other")}
              </p>

              <span
                className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${statusBadgeClass(
                  item.status
                )}`}
              >
                {item.status}
              </span>

              <span
                className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${typeBadgeClass(
                  item
                )}`}
              >
                {eventTypeLabel(item.event_type ?? "other")}
              </span>
            </div>

            <p className="mt-2 text-sm text-slate-700">
              {getOrganizerName(item.organizers)}
            </p>
          </div>
        </div>

        <p className="mt-2 text-sm text-slate-600">{formatCalendarItemTime(item)}</p>
        <p className="mt-1 text-sm text-slate-600">{location}</p>
      </Link>
    );
  }

  const clientName = getClientName(item.clients ?? null);
  const instructorName = getInstructorShortName(item.instructors ?? null);
  const roomName = getRoomName(item.rooms ?? null);
  const isFloorRental = item.appointment_type === "floor_space_rental";

  return (
    <button
      type="button"
      onClick={() => onOpen(item as DrawerAppointment)}
      className={`block w-full rounded-2xl border p-4 text-left transition ${cardClass}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">
              {item.title || appointmentTypeLabel(item.appointment_type ?? "")}
            </p>

            <span
              className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${statusBadgeClass(
                item.status
              )}`}
            >
              {item.status}
            </span>

            <span
              className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${typeBadgeClass(
                item
              )}`}
            >
              {isFloorRental ? "Floor Rental" : typeShortLabel(item)}
            </span>

            {item.is_recurring ? (
              <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200">
                Recurring
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-sm text-slate-800">{clientName}</p>
        </div>
      </div>

      <p className="mt-2 text-sm text-slate-600">
        {formatCalendarItemTime(item)}
      </p>

      <p className="mt-1 text-sm text-slate-600">
        {isFloorRental ? "Independent instructor rental" : instructorName}
        {!isFloorRental && roomName !== "No room" ? ` • ${roomName}` : ""}
      </p>

      {isFloorRental ? (
        <p className="mt-1 text-xs text-slate-500">
          {roomName !== "No room" ? `${roomName} • ` : ""}
          No package deduction
        </p>
      ) : null}
    </button>
  );
}

export default function ScheduleCalendarView({
  view,
  baseDate,
  days,
  groupedAppointments,
  instructors,
  rooms,
  selectedInstructorId,
  selectedRoomId,
  selectedAppointmentType,
  selectedStatus,
  selectedSource,
}: {
  view: "day" | "week";
  baseDate: string;
  days: string[];
  groupedAppointments: Record<string, CalendarItem[]>;
  instructors: InstructorOption[];
  rooms: RoomOption[];
  selectedInstructorId?: string;
  selectedRoomId?: string;
  selectedAppointmentType?: string;
  selectedStatus?: string;
  selectedSource?: "all" | "appointments" | "events";
}) {
  const [selectedAppointment, setSelectedAppointment] =
    useState<DrawerAppointment | null>(null);

  const currentDate = new Date(`${baseDate}T00:00:00`);

  const previousDate =
    view === "day"
      ? addDays(currentDate, -1).toISOString().slice(0, 10)
      : addDays(currentDate, -7).toISOString().slice(0, 10);

  const nextDate =
    view === "day"
      ? addDays(currentDate, 1).toISOString().slice(0, 10)
      : addDays(currentDate, 7).toISOString().slice(0, 10);

  const todayDate = new Date().toISOString().slice(0, 10);

  const totalItems = days.reduce(
    (sum, day) => sum + (groupedAppointments[day] ?? []).length,
    0
  );

  const appointmentCount = days.reduce(
    (sum, day) =>
      sum +
      (groupedAppointments[day] ?? []).filter((item) => item.kind === "appointment").length,
    0
  );

  const floorRentalCount = days.reduce(
    (sum, day) =>
      sum +
      (groupedAppointments[day] ?? []).filter(
        (item) =>
          item.kind === "appointment" &&
          item.appointment_type === "floor_space_rental"
      ).length,
    0
  );

  const eventCount = days.reduce(
    (sum, day) =>
      sum + (groupedAppointments[day] ?? []).filter((item) => item.kind === "event").length,
    0
  );

  return (
    <>
      <div className="space-y-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">Calendar</h2>
            <p className="mt-2 text-slate-600">
              View appointments and published event offerings together. Colors and filters now align across operational appointments and public-facing events.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/app/schedule"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              List View
            </Link>

            <Link
              href="/app/events/new"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              New Event
            </Link>

            <Link
              href="/app/schedule/new"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              New Appointment
            </Link>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Visible Items</p>
            <p className="mt-2 text-3xl font-semibold">{totalItems}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Appointments</p>
            <p className="mt-2 text-3xl font-semibold">{appointmentCount}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Floor Rentals</p>
            <p className="mt-2 text-3xl font-semibold">{floorRentalCount}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Events</p>
            <p className="mt-2 text-3xl font-semibold">{eventCount}</p>
          </div>
        </div>

        <form className="rounded-2xl border bg-white p-5">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={baseDate} />

          <div className="grid gap-4 md:grid-cols-5">
            <div>
              <label htmlFor="source" className="mb-1 block text-sm font-medium">
                Source
              </label>
              <select
                id="source"
                name="source"
                defaultValue={selectedSource ?? "all"}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="all">All items</option>
                <option value="appointments">Appointments only</option>
                <option value="events">Events only</option>
              </select>
            </div>

            <div>
              <label htmlFor="instructorId" className="mb-1 block text-sm font-medium">
                Instructor
              </label>
              <select
                id="instructorId"
                name="instructorId"
                defaultValue={selectedInstructorId ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.first_name} {instructor.last_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="roomId" className="mb-1 block text-sm font-medium">
                Room
              </label>
              <select
                id="roomId"
                name="roomId"
                defaultValue={selectedRoomId ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="appointmentType" className="mb-1 block text-sm font-medium">
                Type
              </label>
              <select
                id="appointmentType"
                name="appointmentType"
                defaultValue={selectedAppointmentType ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All types</option>
                <option value="private_lesson">Private Lesson</option>
                <option value="group_class">Group Class</option>
                <option value="intro_lesson">Intro Lesson</option>
                <option value="coaching">Coaching</option>
                <option value="practice_party">Practice Party</option>
                <option value="floor_space_rental">Floor Space Rental</option>
                <option value="event">Internal Event Appointment</option>
                <option value="workshop">Workshop</option>
                <option value="social_dance">Social Dance</option>
                <option value="competition">Competition</option>
                <option value="showcase">Showcase</option>
                <option value="festival">Festival</option>
                <option value="special_event">Special Event</option>
                <option value="other">Other Event</option>
              </select>
            </div>

            <div>
              <label htmlFor="status" className="mb-1 block text-sm font-medium">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={selectedStatus ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All</option>
                <option value="scheduled">Scheduled</option>
                <option value="attended">Attended</option>
                <option value="cancelled">Cancelled</option>
                <option value="no_show">No Show</option>
                <option value="rescheduled">Rescheduled</option>
                <option value="published">Published</option>
                <option value="draft">Draft</option>
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Apply Filters
            </button>

            <Link
              href={`/app/schedule/calendar${buildQuery({
                view,
                date: baseDate,
              })}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset Filters
            </Link>
          </div>
        </form>

        <div className="rounded-2xl border bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">
                {view === "day" ? "Day View" : "Week View"}
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Navigate appointments, floor rentals, and event offerings by date.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view,
                  date: previousDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Previous
              </Link>

              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view,
                  date: todayDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Today
              </Link>

              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view,
                  date: nextDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Next
              </Link>

              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view: view === "day" ? "week" : "day",
                  date: baseDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Switch to {view === "day" ? "Week" : "Day"} View
              </Link>

              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view: "agenda",
                  date: baseDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                })}`}
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Agenda View
              </Link>
            </div>
          </div>
        </div>

        <div
          className={
            view === "day"
              ? "space-y-6"
              : "grid gap-4 md:grid-cols-2 xl:grid-cols-7"
          }
        >
          {days.map((day) => {
            const items = groupedAppointments[day] ?? [];
            const dayDate = new Date(`${day}T00:00:00`);

            return (
              <div key={day} className="rounded-2xl border bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      {formatDateHeading(dayDate)}
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {formatShortDate(dayDate)} • {items.length} item
                      {items.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>

                {items.length === 0 ? (
                  <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                    <p className="text-sm font-medium text-slate-600">No items</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Open availability for this date.
                    </p>
                  </div>
                ) : (
                  <div className={view === "day" ? "mt-5 space-y-4" : "mt-5 space-y-3"}>
                    {items.map((item) =>
                      view === "week" ? (
                        <CompactCalendarCard
                          key={`${item.kind}-${item.id}-${item.display_date ?? day}`}
                          item={item}
                          onOpen={setSelectedAppointment}
                        />
                      ) : (
                        <ComfortableCalendarCard
                          key={`${item.kind}-${item.id}-${item.display_date ?? day}`}
                          item={item}
                          onOpen={setSelectedAppointment}
                        />
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ScheduleEventDrawer
        appointment={selectedAppointment}
        onClose={() => setSelectedAppointment(null)}
      />
    </>
  );
}