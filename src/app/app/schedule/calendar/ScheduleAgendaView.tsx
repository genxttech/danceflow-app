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

type Props = {
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
  groupBy?: "none" | "instructor";
};

type AgendaItemRowProps = {
  item: CalendarItem;
  onOpen: (appointment: DrawerAppointment) => void;
};

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });

  const query = search.toString();
  return query ? `?${query}` : "";
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

function getPartnerClient(
  item: CalendarItem & {
    partner_client?:
      | { first_name: string; last_name: string }
      | { first_name: string; last_name: string }[]
      | null;
  }
) {
  const partner = item.partner_client;
  return Array.isArray(partner) ? partner[0] : partner;
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

function getClientShortName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const client = getClient(value);
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
  const instructor = getInstructor(value);
  if (!instructor) return "Unassigned";

  const lastInitial = instructor.last_name?.trim()?.[0];
  return lastInitial ? `${instructor.first_name} ${lastInitial}.` : instructor.first_name;
}

function getRoomName(value: { name: string } | { name: string }[] | null | undefined) {
  return getRoom(value)?.name ?? "No room";
}

function getOrganizerName(value: { name: string } | { name: string }[] | null | undefined) {
  return getOrganizer(value)?.name ?? "Organizer";
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Internal Event";
  if (value === "floor_space_rental") return "Floor Rental";
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
    if (item.event_type === "showcase") return "Showcase";
    if (item.event_type === "festival") return "Festival";
    if (item.event_type === "special_event") return "Special";
    return "Event";
  }

  if (item.appointment_type === "private_lesson") return "Private";
  if (item.appointment_type === "group_class") return "Group";
  if (item.appointment_type === "intro_lesson") return "Intro";
  if (item.appointment_type === "coaching") return "Coaching";
  if (item.appointment_type === "practice_party") return "Party";
  if (item.appointment_type === "event") return "Event";
  if (item.appointment_type === "floor_space_rental") return "Rental";
  return "Appointment";
}

function typeBadgeClass(item: CalendarItem) {
  if (item.kind === "event") {
    if (item.event_type === "group_class") return "bg-blue-50 text-blue-700 ring-blue-100";
    if (item.event_type === "practice_party")
      return "bg-amber-50 text-amber-700 ring-amber-100";
    if (item.event_type === "workshop") return "bg-violet-50 text-violet-700 ring-violet-100";
    if (item.event_type === "social_dance")
      return "bg-emerald-50 text-emerald-700 ring-emerald-100";
    if (item.event_type === "competition") return "bg-red-50 text-red-700 ring-red-100";
    if (item.event_type === "showcase") return "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-100";
    if (item.event_type === "festival") return "bg-cyan-50 text-cyan-700 ring-cyan-100";
    if (item.event_type === "special_event")
      return "bg-orange-50 text-orange-700 ring-orange-100";
    return "bg-rose-50 text-rose-700 ring-rose-100";
  }

  if (item.appointment_type === "private_lesson")
    return "bg-slate-100 text-slate-700 ring-slate-200";
  if (item.appointment_type === "floor_space_rental")
    return "bg-indigo-50 text-indigo-700 ring-indigo-100";
  if (item.appointment_type === "intro_lesson")
    return "bg-cyan-50 text-cyan-700 ring-cyan-100";
  if (item.appointment_type === "group_class")
    return "bg-green-50 text-green-700 ring-green-100";
  if (item.appointment_type === "coaching")
    return "bg-purple-50 text-purple-700 ring-purple-100";
  if (item.appointment_type === "practice_party")
    return "bg-amber-50 text-amber-700 ring-amber-100";
  if (item.appointment_type === "event") return "bg-rose-50 text-rose-700 ring-rose-100";

  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function leftAccentClass(item: CalendarItem) {
  if (item.kind === "event") {
    if (item.event_type === "group_class") return "border-l-blue-500";
    if (item.event_type === "practice_party") return "border-l-amber-500";
    if (item.event_type === "workshop") return "border-l-violet-500";
    if (item.event_type === "social_dance") return "border-l-emerald-500";
    if (item.event_type === "competition") return "border-l-red-500";
    if (item.event_type === "showcase") return "border-l-fuchsia-500";
    if (item.event_type === "festival") return "border-l-cyan-500";
    if (item.event_type === "special_event") return "border-l-orange-500";
    return "border-l-rose-500";
  }

  if (item.appointment_type === "private_lesson") return "border-l-slate-500";
  if (item.appointment_type === "floor_space_rental") return "border-l-indigo-500";
  if (item.appointment_type === "intro_lesson") return "border-l-cyan-500";
  if (item.appointment_type === "group_class") return "border-l-green-500";
  if (item.appointment_type === "coaching") return "border-l-purple-500";
  if (item.appointment_type === "practice_party") return "border-l-amber-500";
  if (item.appointment_type === "event") return "border-l-rose-500";

  return "border-l-slate-400";
}

function statusDotClass(status: string) {
  if (status === "scheduled") return "bg-blue-500";
  if (status === "attended") return "bg-green-500";
  if (status === "cancelled") return "bg-red-500";
  if (status === "no_show") return "bg-amber-500";
  if (status === "rescheduled") return "bg-purple-500";
  if (status === "published") return "bg-green-500";
  if (status === "draft") return "bg-amber-500";
  return "bg-slate-400";
}

function formatAgendaItemTime(item: CalendarItem) {
  if (item.kind === "event" && item.is_all_day) return "All day";
  return `${formatTime(item.starts_at)} - ${formatTime(item.ends_at)}`;
}

function getGroupKey(item: CalendarItem) {
  if (item.kind === "event") return "events";
  if (item.appointment_type === "floor_space_rental") return "floor_rentals";

  const instructor = getInstructor(item.instructors);
  if (!instructor) return "unassigned";

  return `instructor-${instructor.first_name}-${instructor.last_name}`;
}

function getGroupLabel(item: CalendarItem) {
  if (item.kind === "event") return "Events";
  if (item.appointment_type === "floor_space_rental") return "Floor Rentals";

  const instructor = getInstructor(item.instructors);
  if (!instructor) return "Unassigned";

  return `${instructor.first_name} ${instructor.last_name}`;
}

function sortItemsForDisplay(items: CalendarItem[]) {
  return [...items].sort((a, b) => {
    if ((a.is_all_day ?? false) !== (b.is_all_day ?? false)) {
      return a.is_all_day ? -1 : 1;
    }
    return a.starts_at.localeCompare(b.starts_at);
  });
}

function AgendaItemRow({ item, onOpen }: AgendaItemRowProps) {
  const accent = leftAccentClass(item);
  const typeBadge = typeBadgeClass(item);

  if (item.kind === "event") {
    const title = item.title || eventTypeLabel(item.event_type ?? "other");
    const organizer = getOrganizerName(item.organizers);
    const location =
      [item.city, item.state].filter(Boolean).join(", ") || item.venue_name || "No location";

    return (
      <Link
        href={`/app/events/${item.id}`}
        className={`block rounded-2xl border border-slate-200 border-l-4 bg-white p-4 text-left shadow-sm transition hover:border-slate-300 hover:shadow-md ${accent}`}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass(item.status)}`} />
              <p className="text-xs font-medium text-slate-600">{formatAgendaItemTime(item)}</p>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${typeBadge}`}
              >
                {typeShortLabel(item)}
              </span>
            </div>

            <p className="mt-2 text-sm font-semibold text-slate-900 md:text-base">{title}</p>
            <p className="mt-1 text-sm text-slate-600">{organizer}</p>
            <p className="mt-1 text-xs text-slate-500 md:text-sm">{location}</p>
          </div>
        </div>
      </Link>
    );
  }

  const client = getClientShortName(item.clients);
  const partner = getPartnerClient(item as CalendarItem & { partner_client?: any });
  const partnerShort = partner ? getClientShortName(partner) : "";
  const displayClient = partnerShort ? `${client} + ${partnerShort}` : client;

  const fullClient = getClientName(item.clients);
  const instructor = getInstructorShortName(item.instructors);
  const room = getRoomName(item.rooms);
  const isFloorRental = item.appointment_type === "floor_space_rental";
  const subtitle = isFloorRental
    ? "Independent instructor rental"
    : item.title || appointmentTypeLabel(item.appointment_type ?? "");

  return (
    <button
      type="button"
      onClick={() => onOpen(item as DrawerAppointment)}
      className={`block w-full rounded-2xl border border-slate-200 border-l-4 bg-white p-4 text-left shadow-sm transition hover:border-slate-300 hover:shadow-md ${accent}`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass(item.status)}`} />
            <p className="text-xs font-medium text-slate-600">{formatTime(item.starts_at)}</p>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${typeBadge}`}
            >
              {isFloorRental ? "Rental" : typeShortLabel(item)}
            </span>
            {item.is_recurring ? (
              <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700 ring-1 ring-slate-200">
                Recurring
              </span>
            ) : null}
          </div>

          <p
            className="mt-2 text-sm font-semibold text-slate-900 md:text-base"
            title={fullClient}
          >
            {displayClient}
          </p>

          <p className="mt-1 text-sm text-slate-700">{subtitle}</p>
          <p className="mt-1 text-xs text-slate-500 md:text-sm">{formatAgendaItemTime(item)}</p>
          <p className="mt-1 text-xs text-slate-500 md:text-sm">
            {isFloorRental ? "Floor rental" : instructor}
            {!isFloorRental && room !== "No room" ? ` • ${room}` : ""}
          </p>
        </div>
      </div>
    </button>
  );
}

function TopToolbar({
  baseDate,
  previousDate,
  nextDate,
  todayDate,
  selectedInstructorId,
  selectedRoomId,
  selectedAppointmentType,
  selectedStatus,
  selectedSource,
  groupBy,
  rangeLabel,
}: {
  baseDate: string;
  previousDate: string;
  nextDate: string;
  todayDate: string;
  selectedInstructorId?: string;
  selectedRoomId?: string;
  selectedAppointmentType?: string;
  selectedStatus?: string;
  selectedSource?: "all" | "appointments" | "events";
  groupBy?: "none" | "instructor";
  rangeLabel: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-sm ring-1 ring-black/[0.02] md:p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
            Agenda View
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
            {rangeLabel}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Dense management view for appointments, events, and floor rentals.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
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
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Previous
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
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Today
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
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Next
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
            className="inline-flex items-center justify-center rounded-xl bg-[var(--brand-accent-dark)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
          >
            Week View
          </Link>
        </div>
      </div>
    </div>
  );
}

function FilterBar({
  baseDate,
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
  instructors: InstructorOption[];
  rooms: RoomOption[];
  selectedInstructorId?: string;
  selectedRoomId?: string;
  selectedAppointmentType?: string;
  selectedStatus?: string;
  selectedSource?: "all" | "appointments" | "events";
  groupBy?: "none" | "instructor";
}) {
  return (
    <form className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-black/[0.02] md:p-5">
      <input type="hidden" name="view" value="agenda" />
      <input type="hidden" name="date" value={baseDate} />

      <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
        <div className="grid flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <div>
            <label htmlFor="source" className="mb-1.5 block text-sm font-medium text-slate-700">
              Source
            </label>
            <select
              id="source"
              name="source"
              defaultValue={selectedSource ?? "all"}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
            >
              <option value="all">All items</option>
              <option value="appointments">Appointments only</option>
              <option value="events">Events only</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="instructorId"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Instructor
            </label>
            <select
              id="instructorId"
              name="instructorId"
              defaultValue={selectedInstructorId ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
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
            <label htmlFor="roomId" className="mb-1.5 block text-sm font-medium text-slate-700">
              Room
            </label>
            <select
              id="roomId"
              name="roomId"
              defaultValue={selectedRoomId ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
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
            <label
              htmlFor="appointmentType"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Type
            </label>
            <select
              id="appointmentType"
              name="appointmentType"
              defaultValue={selectedAppointmentType ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
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
            <label htmlFor="status" className="mb-1.5 block text-sm font-medium text-slate-700">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={selectedStatus ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
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

          <div>
            <label htmlFor="groupBy" className="mb-1.5 block text-sm font-medium text-slate-700">
              Group by
            </label>
            <select
              id="groupBy"
              name="groupBy"
              defaultValue={groupBy ?? "none"}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
            >
              <option value="none">None</option>
              <option value="instructor">Instructor</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 xl:flex xl:flex-shrink-0 xl:gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-xl bg-[var(--brand-accent-dark)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
          >
            Apply
          </button>

          <Link
            href={`/app/schedule/calendar${buildQuery({
              view: "agenda",
              date: baseDate,
            })}`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Reset
          </Link>
        </div>
      </div>
    </form>
  );
}

function DaySection({
  day,
  items,
  todayDate,
  groupBy,
  onOpen,
}: {
  day: string;
  items: CalendarItem[];
  todayDate: string;
  groupBy?: "none" | "instructor";
  onOpen: (appointment: DrawerAppointment) => void;
}) {
  const sortedItems = useMemo(() => sortItemsForDisplay(items), [items]);

  const grouped = useMemo(() => {
    if (groupBy !== "instructor") return [];

    const groups = new Map<string, { key: string; label: string; items: CalendarItem[] }>();

    for (const item of sortedItems) {
      const key = getGroupKey(item);
      const label = getGroupLabel(item);

      if (!groups.has(key)) {
        groups.set(key, { key, label, items: [] });
      }

      groups.get(key)?.items.push(item);
    }

    return Array.from(groups.values());
  }, [groupBy, sortedItems]);

  const isToday = day === todayDate;

  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${
        isToday ? "ring-2 ring-[var(--brand-accent-dark)]/10" : ""
      }`}
    >
      <div className="border-b border-slate-200 px-4 py-4 md:px-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-slate-900 md:text-lg">
                {formatDateHeading(new Date(`${day}T00:00:00`))}
              </h3>
              {isToday ? (
                <span className="rounded-full bg-[var(--brand-accent-dark)] px-2.5 py-0.5 text-[11px] font-medium text-white">
                  Today
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-slate-500 md:text-sm">
              {formatShortDate(new Date(`${day}T00:00:00`))} • {items.length} item
              {items.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </div>

      <div className="p-4 md:p-5">
        {sortedItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
            <p className="text-sm font-medium text-slate-600">No items</p>
            <p className="mt-1 text-xs text-slate-500">Open availability for this date.</p>
          </div>
        ) : groupBy === "instructor" ? (
          <div className="space-y-4">
            {grouped.map((group) => (
              <div
                key={group.key}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">{group.label}</h4>
                    <p className="mt-1 text-xs text-slate-500">
                      {group.items.length} item{group.items.length === 1 ? "" : "s"}
                    </p>
                  </div>

                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                    {group.items.length}
                  </span>
                </div>

                <div className="space-y-3">
                  {group.items.map((item) => (
                    <AgendaItemRow
                      key={`${item.kind}-${item.id}-${item.display_date ?? day}`}
                      item={item}
                      onOpen={onOpen}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {sortedItems.map((item) => (
              <AgendaItemRow
                key={`${item.kind}-${item.id}-${item.display_date ?? day}`}
                item={item}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
    </section>
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
}: Props) {
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

  const floorRentalCount = days.reduce(
    (sum, day) =>
      sum +
      (groupedAppointments[day] ?? []).filter(
        (item) =>
          item.kind === "appointment" && item.appointment_type === "floor_space_rental"
      ).length,
    0
  );

  const rangeLabel = useMemo(() => formatRangeLabel(days), [days]);

  return (
    <>
      <div className="space-y-4 md:space-y-5">
        <TopToolbar
          baseDate={baseDate}
          previousDate={previousDate}
          nextDate={nextDate}
          todayDate={todayDate}
          selectedInstructorId={selectedInstructorId}
          selectedRoomId={selectedRoomId}
          selectedAppointmentType={selectedAppointmentType}
          selectedStatus={selectedStatus}
          selectedSource={selectedSource}
          groupBy={groupBy}
          rangeLabel={rangeLabel}
        />

        <FilterBar
          baseDate={baseDate}
          instructors={instructors}
          rooms={rooms}
          selectedInstructorId={selectedInstructorId}
          selectedRoomId={selectedRoomId}
          selectedAppointmentType={selectedAppointmentType}
          selectedStatus={selectedStatus}
          selectedSource={selectedSource}
          groupBy={groupBy}
        />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm ring-1 ring-black/[0.02]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
              Visible
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900 md:text-2xl">{totalItems}</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm ring-1 ring-black/[0.02]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
              Scheduled
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900 md:text-2xl">
              {scheduledCount}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm ring-1 ring-black/[0.02]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
              Events
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900 md:text-2xl">{eventCount}</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm ring-1 ring-black/[0.02]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
              Rentals
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900 md:text-2xl">
              {floorRentalCount}
            </p>
          </div>

          <div className="col-span-2 grid gap-3 lg:col-span-1">
            <Link
              href="/app/schedule/new"
              className="inline-flex items-center justify-center rounded-2xl bg-[var(--brand-accent-dark)] px-4 py-3 text-sm font-medium text-white shadow-sm hover:opacity-95"
            >
              New Appointment
            </Link>

            <Link
              href="/app/events/new"
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              New Event
            </Link>
          </div>
        </div>

        <div className="space-y-4">
          {days.map((day) => (
            <DaySection
              key={day}
              day={day}
              items={groupedAppointments[day] ?? []}
              todayDate={todayDate}
              groupBy={groupBy}
              onOpen={setSelectedAppointment}
            />
          ))}
        </div>
      </div>

      <ScheduleEventDrawer
        appointment={selectedAppointment}
        open={selectedAppointment !== null}
        onClose={() => setSelectedAppointment(null)}
      />
    </>
  );
}