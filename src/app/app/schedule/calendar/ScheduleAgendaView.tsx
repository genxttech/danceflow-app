"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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

type GroupedAgendaItems = {
  key: string;
  label: string;
  items: CalendarItem[];
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
  return value.replaceAll("_", " ");
}

function appointmentTypeShortLabel(value: string) {
  if (value === "private_lesson") return "Private";
  if (value === "group_class") return "Group";
  if (value === "intro_lesson") return "Intro";
  if (value === "coaching") return "Coach";
  if (value === "practice_party") return "Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Rental";
  return value.replaceAll("_", " ");
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
  return value.replaceAll("_", " ");
}

function eventTypeShortLabel(value: string) {
  if (value === "group_class") return "Class";
  if (value === "practice_party") return "Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special";
  return "Event";
}

function appointmentTypeBadgeClass(value: string) {
  if (value === "private_lesson") {
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
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

function eventTypeBadgeClass(value: string) {
  if (value === "group_class") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (value === "practice_party") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (value === "workshop") return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (value === "social_dance") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (value === "competition") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (value === "showcase") return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-100";
  if (value === "festival") return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
  if (value === "special_event") return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function agendaRowClass(item: CalendarItem) {
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

function getClient(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  return Array.isArray(value) ? value[0] : value;
}

function getInstructor(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  return Array.isArray(value) ? value[0] : value;
}

function getRoom(value: { name: string } | { name: string }[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getOrganizer(value: { name: string } | { name: string }[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const client = getClient(value);
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getInstructorName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const instructor = getInstructor(value);
  return instructor ? `${instructor.first_name} ${instructor.last_name}` : "Unassigned";
}

function getRoomName(value: { name: string } | { name: string }[] | null | undefined) {
  const room = getRoom(value);
  return room?.name ?? "No room";
}

function getOrganizerName(value: { name: string } | { name: string }[] | null | undefined) {
  const organizer = getOrganizer(value);
  return organizer?.name ?? "Organizer";
}

function formatRangeLabel(days: string[]) {
  if (days.length === 0) return "";

  const start = new Date(`${days[0]}T00:00:00`);
  const end = new Date(`${days[days.length - 1]}T00:00:00`);

  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();

  if (sameMonth && sameYear) {
    return `${start.toLocaleDateString([], {
      month: "long",
    })} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`;
  }

  if (sameYear) {
    return `${start.toLocaleDateString([], {
      month: "long",
      day: "numeric",
    })} - ${end.toLocaleDateString([], {
      month: "long",
      day: "numeric",
    })}, ${start.getFullYear()}`;
  }

  return `${start.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: "numeric",
  })} - ${end.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatAgendaItemTime(item: CalendarItem) {
  if (item.kind === "event" && item.is_all_day) {
    return "All day";
  }
  return `${formatTime(item.starts_at)} - ${formatTime(item.ends_at)}`;
}

function getGroupKey(item: CalendarItem) {
  if (item.kind === "event") return "events";
  if (item.appointment_type === "floor_space_rental") return "floor_rentals";

  const instructor = getInstructor(item.instructors);
  if (!instructor) return "unassigned";

  return `${instructor.first_name}-${instructor.last_name}`;
}

function getGroupLabel(item: CalendarItem) {
  if (item.kind === "event") return "Events";
  if (item.appointment_type === "floor_space_rental") return "Floor Rentals";

  const instructor = getInstructor(item.instructors);
  if (!instructor) return "Unassigned";

  return `${instructor.first_name} ${instructor.last_name}`;
}

function groupItemsForAgenda(items: CalendarItem[]): GroupedAgendaItems[] {
  const map = new Map<string, GroupedAgendaItems>();

  for (const item of items) {
    const key = getGroupKey(item);
    const label = getGroupLabel(item);

    if (!map.has(key)) {
      map.set(key, { key, label, items: [] });
    }

    map.get(key)!.items.push(item);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.key === "events") return -1;
    if (b.key === "events") return 1;
    if (a.key === "floor_rentals") return -1;
    if (b.key === "floor_rentals") return 1;
    if (a.key === "unassigned") return 1;
    if (b.key === "unassigned") return -1;
    return a.label.localeCompare(b.label);
  });
}

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}

type RowProps = {
  item: CalendarItem;
  onOpen: (appointment: DrawerAppointment) => void;
};

function AgendaItemRow({ item, onOpen }: RowProps) {
  const rowClass = agendaRowClass(item);

  if (item.kind === "event") {
    const location =
      item.venue_name ||
      [item.city, item.state].filter(Boolean).join(", ") ||
      "No location";

    return (
      <Link
        href={`/app/events/${item.id}`}
        className={`block w-full rounded-2xl border p-4 text-left transition ${rowClass}`}
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-slate-900">
                {item.title || eventTypeLabel(item.event_type ?? "other")}
              </p>

              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusBadgeClass(
                  item.status
                )}`}
              >
                {item.status.replaceAll("_", " ")}
              </span>

              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${eventTypeBadgeClass(
                  item.event_type ?? "other"
                )}`}
              >
                {eventTypeShortLabel(item.event_type ?? "other")}
              </span>
            </div>

            <p className="mt-2 text-sm text-slate-900">
              {getOrganizerName(item.organizers)}
            </p>

            <p className="mt-1 text-sm text-slate-600">{formatAgendaItemTime(item)}</p>
            <p className="mt-1 text-sm text-slate-600">{location}</p>
          </div>
        </div>
      </Link>
    );
  }

  const clientName = getClientName(item.clients);
  const instructorName = getInstructorName(item.instructors);
  const roomName = getRoomName(item.rooms);
  const isFloorRental = item.appointment_type === "floor_space_rental";

  return (
    <button
      type="button"
      onClick={() => onOpen(item as DrawerAppointment)}
      className={`block w-full rounded-2xl border p-4 text-left transition ${rowClass}`}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-900">
              {item.title || appointmentTypeLabel(item.appointment_type ?? "")}
            </p>

            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusBadgeClass(
                item.status
              )}`}
            >
              {item.status.replaceAll("_", " ")}
            </span>

            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${appointmentTypeBadgeClass(
                item.appointment_type ?? ""
              )}`}
            >
              {isFloorRental
                ? "Floor Rental"
                : appointmentTypeShortLabel(item.appointment_type ?? "")}
            </span>

            {item.is_recurring ? (
              <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
                Recurring
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-sm text-slate-900">{clientName}</p>

          <p className="mt-1 text-sm text-slate-600">{formatAgendaItemTime(item)}</p>

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
        </div>
      </div>
    </button>
  );
}

export default function ScheduleAgendaView({
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
  groupBy,
}: {
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
  groupBy: "instructor" | "none";
}) {
  const [selectedAppointment, setSelectedAppointment] =
    useState<DrawerAppointment | null>(null);

  const currentDate = new Date(`${baseDate}T00:00:00`);
  const previousDate = addDays(currentDate, -7).toISOString().slice(0, 10);
  const nextDate = addDays(currentDate, 7).toISOString().slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  const totalItems = days.reduce(
    (sum, day) => sum + (groupedAppointments[day] ?? []).length,
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

  const recurringCount = days.reduce(
    (sum, day) =>
      sum +
      (groupedAppointments[day] ?? []).filter(
        (item) => item.kind === "appointment" && item.is_recurring
      ).length,
    0
  );

  const scheduledCount = days.reduce(
    (sum, day) =>
      sum +
      (groupedAppointments[day] ?? []).filter(
        (item) => item.kind === "appointment" && item.status === "scheduled"
      ).length,
    0
  );

  const eventCount = days.reduce(
    (sum, day) =>
      sum + (groupedAppointments[day] ?? []).filter((item) => item.kind === "event").length,
    0
  );

  const rangeLabel = useMemo(() => formatRangeLabel(days), [days]);

  return (
    <>
      <div className="space-y-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-slate-900">
              Agenda
            </h2>
            <p className="mt-2 max-w-3xl text-slate-600">
              Detailed weekly schedule grouped by day, with optional instructor sections.
              Colors and filters now match the calendar so appointments and public events behave consistently.
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

        <div className="grid gap-4 md:grid-cols-5">
          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Visible Items</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{totalItems}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Scheduled</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{scheduledCount}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Recurring</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{recurringCount}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Floor Rentals</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{floorRentalCount}</p>
          </div>

          <div className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-slate-500">Events</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{eventCount}</p>
          </div>
        </div>

        <form className="rounded-2xl border bg-white p-5">
          <input type="hidden" name="view" value="agenda" />
          <input type="hidden" name="date" value={baseDate} />
          <input type="hidden" name="groupBy" value={groupBy} />

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
                view: "agenda",
                date: baseDate,
                groupBy,
              })}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset Filters
            </Link>

            <Link
              href={`/app/schedule/calendar${buildQuery({
                view: "agenda",
                date: todayDate,
                source: selectedSource,
                instructorId: selectedInstructorId,
                roomId: selectedRoomId,
                appointmentType: selectedAppointmentType,
                status: selectedStatus,
                groupBy,
              })}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Today
            </Link>

            <Link
              href={`/app/schedule/calendar${buildQuery({
                view: "agenda",
                date: baseDate,
                source: "appointments",
                appointmentType: "floor_space_rental",
                instructorId: selectedInstructorId,
                roomId: selectedRoomId,
                status: selectedStatus,
                groupBy,
              })}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Floor Rentals
            </Link>

            <Link
              href={`/app/schedule/calendar${buildQuery({
                view: "agenda",
                date: baseDate,
                appointmentType: "intro_lesson",
                source: "appointments",
                instructorId: selectedInstructorId,
                roomId: selectedRoomId,
                status: selectedStatus,
                groupBy,
              })}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Intro Lessons
            </Link>

            <Link
              href={`/app/schedule/calendar${buildQuery({
                view: "agenda",
                date: baseDate,
                source: "events",
                status: "published",
                groupBy,
              })}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Published Events
            </Link>
          </div>
        </form>

        <div className="rounded-2xl border bg-white p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-slate-400">
                Agenda View
              </p>
              <h3 className="mt-1 text-2xl font-semibold text-slate-900">
                {rangeLabel}
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Rich operational view grouped by day. Best for detail, grouping, and scanning full schedules.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view: "agenda",
                  date: previousDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                  groupBy,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Previous
              </Link>

              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view: "agenda",
                  date: nextDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                  groupBy,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Next
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
                  groupBy: "instructor",
                })}`}
                className={`rounded-xl px-4 py-2 ${
                  groupBy === "instructor"
                    ? "bg-slate-900 text-white hover:bg-slate-800"
                    : "border hover:bg-slate-50"
                }`}
              >
                By Instructor
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
                  groupBy: "none",
                })}`}
                className={`rounded-xl px-4 py-2 ${
                  groupBy === "none"
                    ? "bg-slate-900 text-white hover:bg-slate-800"
                    : "border hover:bg-slate-50"
                }`}
              >
                Flat List
              </Link>

              <Link
                href={`/app/schedule/calendar${buildQuery({
                  view: "week",
                  date: baseDate,
                  source: selectedSource,
                  instructorId: selectedInstructorId,
                  roomId: selectedRoomId,
                  appointmentType: selectedAppointmentType,
                  status: selectedStatus,
                })}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Switch to Week View
              </Link>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {days.map((day) => {
            const items = groupedAppointments[day] ?? [];
            const dayDate = new Date(`${day}T00:00:00`);
            const grouped = groupItemsForAgenda(items);
            const isToday = day === todayDate;

            return (
              <details key={day} open className="rounded-2xl border bg-white p-5">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                        {formatDateHeading(dayDate)}
                      </p>
                      <h3 className="mt-1 text-xl font-semibold text-slate-900">
                        {formatShortDate(dayDate)}
                      </h3>
                      <p className="mt-1 text-sm text-slate-500">
                        {items.length === 0
                          ? "No items"
                          : `${items.length} item${items.length === 1 ? "" : "s"}`}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {isToday ? (
                        <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white">
                          Today
                        </span>
                      ) : null}

                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                        {items.length}
                      </span>
                    </div>
                  </div>
                </summary>

                {items.length === 0 ? (
                  <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
                    <p className="text-sm font-medium text-slate-600">No items</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Open availability for this date.
                    </p>
                  </div>
                ) : groupBy === "instructor" ? (
                  <div className="mt-5 space-y-4">
                    {grouped.map((group) => (
                      <details
                        key={group.key}
                        open
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <summary className="cursor-pointer list-none">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h4 className="text-base font-semibold text-slate-900">
                                {group.label}
                              </h4>
                              <p className="mt-1 text-xs text-slate-500">
                                {group.items.length} item{group.items.length === 1 ? "" : "s"}
                              </p>
                            </div>

                            <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                              {group.items.length}
                            </span>
                          </div>
                        </summary>

                        <div className="mt-4 space-y-3">
                          {group.items.map((item) => (
                            <AgendaItemRow
                              key={`${item.kind}-${item.id}-${item.display_date ?? day}`}
                              item={item}
                              onOpen={setSelectedAppointment}
                            />
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                ) : (
                  <div className="mt-5 space-y-3">
                    {items.map((item) => (
                      <AgendaItemRow
                        key={`${item.kind}-${item.id}-${item.display_date ?? day}`}
                        item={item}
                        onOpen={setSelectedAppointment}
                      />
                    ))}
                  </div>
                )}
              </details>
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