"use client";

import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Filter,
  List,
  Plus,
  RotateCcw,
  Rows3,
} from "lucide-react";
import type { DrawerAppointment } from "./ScheduleEventDrawer";

export type CalendarView = "month" | "week" | "day" | "agenda";
export type CalendarSource = "all" | "appointments" | "events";

export type CalendarItem = {
  kind: "appointment" | "event";
  id: string;
  studio_id?: string | null;
  client_id?: string | null;
  instructor_id?: string | null;
  room_id?: string | null;
  appointment_type?: string | null;
  event_type?: string | null;
  title?: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  display_date?: string;
  is_all_day?: boolean;
  is_recurring?: boolean | null;
  notes?: string | null;
  price_amount?: number | null;
  payment_status?: string | null;
  clients?: PersonRelation;
  partner_client?: PersonRelation;
  instructors?: PersonRelation;
  rooms?: { name: string } | { name: string }[] | null;
  organizers?: { name: string } | { name: string }[] | null;
  name?: string | null;
  slug?: string | null;
  venue_name?: string | null;
  city?: string | null;
  state?: string | null;
};

type PersonRelation =
  | { first_name: string; last_name: string }
  | { first_name: string; last_name: string }[]
  | null;

export type InstructorOption = { id: string; first_name: string; last_name: string };
export type RoomOption = { id: string; name: string };

export type ScheduleFilters = {
  selectedInstructorId?: string;
  selectedRoomId?: string;
  selectedAppointmentType?: string;
  selectedStatus?: string;
  selectedSource?: CalendarSource;
  groupBy?: "none" | "instructor";
};

export type CommonViewProps = ScheduleFilters & {
  view: CalendarView;
  baseDate: string;
  days: string[];
  groupedAppointments: Record<string, CalendarItem[]>;
  instructors: InstructorOption[];
  rooms: RoomOption[];
  studioTimeZone?: string;
};

export const DEFAULT_STUDIO_TIME_ZONE = "America/New_York";

export function buildScheduleQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== "all" && value !== "none") search.set(key, value);
  });
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function addDaysToDateString(value: string, amount: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function addMonthsToDateString(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + amount, 1)).toISOString().slice(0, 10);
}

export function getTodayInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatStudioTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatPeriodLabel(view: CalendarView, baseDate: string, days: string[]) {
  const base = new Date(`${baseDate}T12:00:00Z`);
  if (view === "month") return base.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
  if (view === "day") return base.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const start = new Date(`${days[0]}T12:00:00Z`);
  const end = new Date(`${days[days.length - 1]}T12:00:00Z`);
  const startText = start.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const endText = end.toLocaleDateString("en-US", { timeZone: "UTC", month: start.getUTCMonth() === end.getUTCMonth() ? undefined : "short", day: "numeric", year: "numeric" });
  return `${startText} - ${endText}`;
}

function relation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function clientName(item: CalendarItem, short = false) {
  const client = relation(item.clients);
  if (!client) return item.kind === "appointment" ? "Unassigned client" : "Event";
  const primary = short ? `${client.first_name} ${client.last_name?.[0] ?? ""}.` : `${client.first_name} ${client.last_name}`;
  const partner = relation(item.partner_client);
  if (!partner) return primary;
  return short ? `${primary} + ${partner.first_name} ${partner.last_name?.[0] ?? ""}.` : `${primary} + ${partner.first_name} ${partner.last_name}`;
}

export function instructorName(item: CalendarItem) {
  const instructor = relation(item.instructors);
  return instructor ? `${instructor.first_name} ${instructor.last_name}` : "Unassigned instructor";
}

export function roomName(item: CalendarItem) {
  return relation(item.rooms)?.name ?? "No room";
}

export function itemTypeLabel(item: CalendarItem) {
  const value = item.kind === "event" ? item.event_type ?? "event" : item.appointment_type ?? "appointment";
  const labels: Record<string, string> = {
    private_lesson: "Private",
    group_class: "Group class",
    intro_lesson: "Intro",
    coaching: "Coaching",
    practice_party: "Practice party",
    floor_space_rental: "Rental",
    room_unavailable: "Unavailable",
    social_dance: "Social",
    competition: "Competition",
    showcase: "Showcase",
    special_event: "Special event",
  };
  return labels[value] ?? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function itemAccent(item: CalendarItem) {
  const value = item.kind === "event" ? item.event_type : item.appointment_type;
  if (value === "intro_lesson" || value === "festival") return "border-cyan-500 bg-cyan-50 text-cyan-950";
  if (value === "group_class" || value === "social_dance") return "border-emerald-500 bg-emerald-50 text-emerald-950";
  if (value === "coaching" || value === "workshop") return "border-violet-500 bg-violet-50 text-violet-950";
  if (value === "practice_party") return "border-amber-500 bg-amber-50 text-amber-950";
  if (value === "floor_space_rental") return "border-indigo-500 bg-indigo-50 text-indigo-950";
  if (value === "competition") return "border-red-500 bg-red-50 text-red-950";
  if (value === "showcase") return "border-fuchsia-500 bg-fuchsia-50 text-fuchsia-950";
  if (item.kind === "event") return "border-orange-500 bg-orange-50 text-orange-950";
  return "border-slate-500 bg-slate-50 text-slate-950";
}

export function statusDot(status: string) {
  if (status === "scheduled" || status === "published") return "bg-blue-500";
  if (status === "attended") return "bg-emerald-500";
  if (status === "cancelled") return "bg-red-500";
  if (status === "no_show" || status === "draft") return "bg-amber-500";
  if (status === "rescheduled") return "bg-violet-500";
  return "bg-slate-400";
}

function filterParams(filters: ScheduleFilters) {
  return {
    source: filters.selectedSource,
    instructorId: filters.selectedInstructorId,
    roomId: filters.selectedRoomId,
    appointmentType: filters.selectedAppointmentType,
    status: filters.selectedStatus,
    groupBy: filters.groupBy,
  };
}

export function ScheduleToolbar({ view, baseDate, days, studioTimeZone, ...filters }: CommonViewProps) {
  const today = getTodayInTimeZone(studioTimeZone ?? DEFAULT_STUDIO_TIME_ZONE);
  const previous = view === "month" ? addMonthsToDateString(baseDate, -1) : addDaysToDateString(baseDate, view === "day" ? -1 : -7);
  const next = view === "month" ? addMonthsToDateString(baseDate, 1) : addDaysToDateString(baseDate, view === "day" ? 1 : 7);
  const label = formatPeriodLabel(view, baseDate, days);
  const preserved = filterParams(filters);
  const viewOptions: { value: CalendarView; label: string; icon: typeof CalendarDays }[] = [
    { value: "month", label: "Month", icon: CalendarDays },
    { value: "week", label: "Week", icon: Rows3 },
    { value: "day", label: "Day", icon: CalendarDays },
    { value: "agenda", label: "Agenda", icon: List },
  ];

  return <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-col gap-4 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-fuchsia-700">{view} view</p><h2 className="mt-1 text-2xl font-semibold text-slate-950">{label}</h2></div>
      <div className="flex flex-wrap items-center gap-2">
        <Link aria-label="Previous period" href={`/app/schedule/calendar${buildScheduleQuery({ view, date: previous, ...preserved })}`} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"><ChevronLeft className="h-4 w-4" /></Link>
        <Link href={`/app/schedule/calendar${buildScheduleQuery({ view, date: today, ...preserved })}`} className="inline-flex h-10 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Today</Link>
        <Link aria-label="Next period" href={`/app/schedule/calendar${buildScheduleQuery({ view, date: next, ...preserved })}`} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"><ChevronRight className="h-4 w-4" /></Link>
        <form className="flex items-center gap-1"><input type="hidden" name="view" value={view} />{Object.entries(preserved).map(([key,value]) => value ? <input key={key} type="hidden" name={key} value={value} /> : null)}<input aria-label="Jump to date" type="date" name="date" defaultValue={baseDate} className="h-10 rounded-md border border-slate-300 px-2 text-sm" /><button className="h-10 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700">Go</button></form>
      </div>
    </div>
    <nav aria-label="Calendar views" className="grid grid-cols-4 p-2">
      {viewOptions.map(({ value, label: optionLabel, icon: Icon }) => <Link key={value} href={`/app/schedule/calendar${buildScheduleQuery({ view: value, date: baseDate, ...preserved })}`} className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${value === view ? "bg-[#2D0B45] text-white" : "text-slate-600 hover:bg-slate-100"}`}><Icon className="hidden h-4 w-4 sm:block" />{optionLabel}</Link>)}
    </nav>
  </section>;
}

export function ScheduleFilterBar({ view, baseDate, instructors, rooms, ...filters }: CommonViewProps) {
  return <details className="group rounded-lg border border-slate-200 bg-white shadow-sm" open={Boolean(filters.selectedInstructorId || filters.selectedRoomId || filters.selectedAppointmentType || filters.selectedStatus || (filters.selectedSource && filters.selectedSource !== "all"))}>
    <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3"><span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900"><Filter className="h-4 w-4 text-fuchsia-700" />Filters</span><span className="text-xs text-slate-500 group-open:hidden">Show</span><span className="hidden text-xs text-slate-500 group-open:inline">Hide</span></summary>
    <form className="border-t border-slate-200 p-4"><input type="hidden" name="view" value={view} /><input type="hidden" name="date" value={baseDate} /><div className={`grid gap-3 sm:grid-cols-2 ${view === "agenda" ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>
      <label className="text-xs font-semibold text-slate-600">Source<select name="source" defaultValue={filters.selectedSource ?? "all"} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><option value="all">All items</option><option value="appointments">Appointments</option><option value="events">Events</option></select></label>
      <label className="text-xs font-semibold text-slate-600">Instructor<select name="instructorId" defaultValue={filters.selectedInstructorId ?? ""} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><option value="">All instructors</option>{instructors.map((item) => <option key={item.id} value={item.id}>{item.first_name} {item.last_name}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Room<select name="roomId" defaultValue={filters.selectedRoomId ?? ""} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><option value="">All rooms</option>{rooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Type<select name="appointmentType" defaultValue={filters.selectedAppointmentType ?? ""} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><option value="">All types</option><option value="private_lesson">Private lesson</option><option value="group_class">Group class</option><option value="intro_lesson">Intro lesson</option><option value="coaching">Coaching</option><option value="practice_party">Practice party</option><option value="floor_space_rental">Floor rental</option><option value="room_unavailable">Room unavailable</option><option value="workshop">Workshop</option><option value="social_dance">Social dance</option><option value="competition">Competition</option><option value="showcase">Showcase</option></select></label>
      <label className="text-xs font-semibold text-slate-600">Status<select name="status" defaultValue={filters.selectedStatus ?? ""} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><option value="">All statuses</option><option value="scheduled">Scheduled</option><option value="attended">Attended</option><option value="cancelled">Cancelled</option><option value="no_show">No show</option><option value="rescheduled">Rescheduled</option><option value="published">Published</option><option value="draft">Draft</option></select></label>
      {view === "agenda" ? <label className="text-xs font-semibold text-slate-600">Group by<select name="groupBy" defaultValue={filters.groupBy ?? "none"} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"><option value="none">None</option><option value="instructor">Instructor</option></select></label> : null}
    </div><div className="mt-4 flex gap-2"><button className="rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white">Apply filters</button><Link href={`/app/schedule/calendar${buildScheduleQuery({ view, date: baseDate })}`} className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"><RotateCcw className="h-4 w-4" />Reset</Link></div></form>
  </details>;
}

export function ScheduleSummary({ days, groupedAppointments }: Pick<CommonViewProps, "days" | "groupedAppointments">) {
  const items = Array.from(
    new Map(
      days
        .flatMap((day) => groupedAppointments[day] ?? [])
        .map((item) => [`${item.kind}-${item.id}`, item] as const),
    ).values(),
  );
  const appointments = items.filter((item) => item.kind === "appointment").length;
  const events = items.filter((item) => item.kind === "event").length;
  const needsAttention = items.filter((item) => ["no_show", "cancelled"].includes(item.status)).length;
  return <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between"><div className="grid grid-cols-3 divide-x divide-slate-200"><div className="px-4"><p className="text-lg font-semibold text-slate-950">{appointments}</p><p className="text-xs text-slate-500">Appointments</p></div><div className="px-4"><p className="text-lg font-semibold text-slate-950">{events}</p><p className="text-xs text-slate-500">Events</p></div><div className="px-4"><p className="text-lg font-semibold text-slate-950">{needsAttention}</p><p className="text-xs text-slate-500">Needs review</p></div></div><div className="flex flex-wrap gap-2"><Link href="/app/schedule/self-service" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Self-service requests</Link><Link href="/app/schedule/requests" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Booking requests</Link><Link href="/app/schedule/new" className="inline-flex items-center gap-2 rounded-md bg-[#F97316] px-4 py-2 text-sm font-semibold text-white"><Plus className="h-4 w-4" />New appointment</Link></div></div>;
}

export function CompactCalendarItem({ item, onOpen, studioTimeZone, dense = false }: { item: CalendarItem; onOpen: (appointment: DrawerAppointment) => void; studioTimeZone: string; dense?: boolean }) {
  const accent = itemAccent(item);
  const time = item.is_all_day ? "All day" : formatStudioTime(item.starts_at, studioTimeZone);
  const title = item.kind === "event" ? item.title || itemTypeLabel(item) : clientName(item, dense);
  const content = <><div className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${statusDot(item.status)}`} /><span className="truncate text-[11px] font-semibold">{time} · {itemTypeLabel(item)}</span></div><p className={`mt-1 truncate font-semibold ${dense ? "text-xs" : "text-sm"}`}>{title}</p>{!dense && item.kind === "appointment" ? <p className="mt-1 truncate text-xs opacity-70">{instructorName(item)} · {roomName(item)}</p> : null}</>;
  const className = `block w-full rounded-md border-l-4 p-2 text-left transition hover:brightness-95 ${accent}`;
  if (item.kind === "event") return <Link href={`/app/events/${item.id}`} className={className}>{content}</Link>;
  return <button type="button" onClick={() => onOpen(item as DrawerAppointment)} className={className}>{content}</button>;
}
