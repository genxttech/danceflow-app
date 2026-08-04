"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import ScheduleEventDrawer, {
  type DrawerAppointment,
} from "./ScheduleEventDrawer";
import {
  DEFAULT_STUDIO_TIME_ZONE,
  ScheduleFilterBar,
  ScheduleSummary,
  ScheduleToolbar,
  buildScheduleQuery,
  clientName,
  getTodayInTimeZone,
  instructorName,
  itemAccent,
  itemTypeLabel,
  roomName,
  statusDot,
  type CalendarItem,
  type CommonViewProps,
} from "./ScheduleCalendarShared";

const DEFAULT_GRID_START_MINUTES = 7 * 60;
const DEFAULT_GRID_END_MINUTES = 23 * 60;
const SLOT_MINUTES = 15;
const SLOT_HEIGHT = 24;

function dateHeading(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(totalMinutes: number) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function timeValue(totalMinutes: number) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function localMinutes(
  value: string,
  item: CalendarItem,
  timeZone: string,
) {
  if (item.kind === "event" && !/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    const match = value.match(/T(\d{2}):(\d{2})/);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const hour = values.hour === "24" ? 0 : Number(values.hour);
  return hour * 60 + Number(values.minute);
}

function itemStyle(
  item: CalendarItem,
  timeZone: string,
  gridStart: number,
  gridEnd: number,
) {
  const startsAt = Math.max(localMinutes(item.starts_at, item, timeZone), gridStart);
  const endsAt = Math.min(localMinutes(item.ends_at, item, timeZone), gridEnd);
  const duration = Math.max(endsAt - startsAt, SLOT_MINUTES);

  return {
    top: ((startsAt - gridStart) / SLOT_MINUTES) * SLOT_HEIGHT,
    height: Math.max((duration / SLOT_MINUTES) * SLOT_HEIGHT - 4, 40),
  };
}

function itemTime(item: CalendarItem, timeZone: string) {
  return `${timeLabel(localMinutes(item.starts_at, item, timeZone))}–${timeLabel(
    localMinutes(item.ends_at, item, timeZone),
  )}`;
}

function buildCreateHref(day: string, slotMinutes: number) {
  const endMinutes = slotMinutes + 60;
  const query = new URLSearchParams({
    date: day,
    startTime: timeValue(slotMinutes),
    endTime: timeValue(endMinutes),
  });
  return `/app/schedule/new?${query.toString()}`;
}

function buildBlockHref(
  day: string,
  slotMinutes: number,
  instructorId?: string,
) {
  const endMinutes = slotMinutes + 60;
  const query = new URLSearchParams({
    date: day,
    startTime: timeValue(slotMinutes),
    endTime: timeValue(endMinutes),
  });

  if (instructorId) query.set("instructorId", instructorId);
  return `/app/schedule/blocks/new?${query.toString()}`;
}

function TimeGridItem({
  item,
  studioTimeZone,
  onOpen,
  gridStartMinutes,
  gridEndMinutes,
}: {
  item: CalendarItem;
  studioTimeZone: string;
  onOpen: (appointment: DrawerAppointment) => void;
  gridStartMinutes: number;
  gridEndMinutes: number;
}) {
  const position = itemStyle(
    item,
    studioTimeZone,
    gridStartMinutes,
    gridEndMinutes,
  );
  const className = `absolute left-1 right-1 z-20 overflow-hidden rounded-lg border-l-4 px-2 py-1.5 text-left shadow-sm transition hover:z-30 hover:brightness-95 ${itemAccent(
    item,
  )}`;

  const durationMinutes = Math.max(
    localMinutes(item.ends_at, item, studioTimeZone) -
      localMinutes(item.starts_at, item, studioTimeZone),
    SLOT_MINUTES,
  );
  const isScheduleBlock =
    item.kind === "appointment" &&
    item.appointment_type === "instructor_unavailable";
  const primaryLabel =
    item.kind === "event"
      ? item.title || itemTypeLabel(item)
      : isScheduleBlock
        ? item.title || "Blocked time"
        : clientName(item);
  const showSupportingDetails =
    item.kind === "appointment" &&
    !isScheduleBlock &&
    durationMinutes >= 45;

  const content = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${statusDot(item.status)}`}
        />
        <p className="min-w-0 truncate text-[11px] font-bold">
          {itemTime(item, studioTimeZone)} · {itemTypeLabel(item)}
        </p>
      </div>

      <p className="mt-0.5 truncate text-xs font-semibold">
        {primaryLabel}
      </p>

      {showSupportingDetails ? (
        <p className="mt-0.5 truncate text-[11px] opacity-70">
          {instructorName(item)} · {roomName(item)}
        </p>
      ) : null}
    </>
  );

  if (item.kind === "event") {
    return (
      <Link
        href={`/app/events/${item.id}`}
        className={className}
        style={position}
      >
        {content}
      </Link>
    );
  }

  if (item.appointment_type === "instructor_unavailable") {
    return (
      <Link
        href={`/app/schedule/blocks/${item.id}/edit`}
        className={className}
        style={position}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(item as DrawerAppointment)}
      className={className}
      style={position}
    >
      {content}
    </button>
  );
}

function DayColumn({
  day,
  items,
  instructorId,
  studioTimeZone,
  onOpen,
  gridStartMinutes,
  gridEndMinutes,
}: {
  day: string;
  items: CalendarItem[];
  instructorId?: string;
  studioTimeZone: string;
  onOpen: (appointment: DrawerAppointment) => void;
  gridStartMinutes: number;
  gridEndMinutes: number;
}) {
  const [selectedSlotMinutes, setSelectedSlotMinutes] = useState<number | null>(
    null,
  );
  const slotCount =
    (gridEndMinutes - gridStartMinutes) / SLOT_MINUTES;

  return (
    <div
      className="relative min-w-0 border-l border-slate-200"
      style={{ height: slotCount * SLOT_HEIGHT }}
    >
      {Array.from({ length: slotCount }, (_, index) => {
        const slotMinutes = gridStartMinutes + index * SLOT_MINUTES;
        const isHour = slotMinutes % 60 === 0;

        return (
          <div
            key={slotMinutes}
            className={`group absolute left-0 right-0 border-t ${
              isHour ? "border-slate-200" : "border-slate-100"
            }`}
            style={{ top: index * SLOT_HEIGHT, height: SLOT_HEIGHT }}
          >
            <button
              type="button"
              aria-label={`Open actions for ${timeLabel(slotMinutes)}`}
              aria-expanded={selectedSlotMinutes === slotMinutes}
              onClick={() =>
                setSelectedSlotMinutes((current) =>
                  current === slotMinutes ? null : slotMinutes,
                )
              }
              className="absolute inset-0 z-10 block w-full touch-manipulation md:hidden"
            />

            {selectedSlotMinutes === slotMinutes ? (
              <div className="absolute left-2 right-2 top-1/2 z-40 flex -translate-y-1/2 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white p-2 shadow-xl md:hidden">
                <Link
                  href={buildCreateHref(day, slotMinutes)}
                  className="min-h-10 flex-1 rounded-lg bg-[var(--brand-primary)] px-3 py-2 text-center text-xs font-semibold text-white"
                >
                  Appointment
                </Link>
                <Link
                  href={buildBlockHref(day, slotMinutes, instructorId)}
                  className="min-h-10 flex-1 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-center text-xs font-semibold text-orange-800"
                >
                  Block time
                </Link>
                <button
                  type="button"
                  aria-label="Close time actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedSlotMinutes(null);
                  }}
                  className="min-h-10 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600"
                >
                  ×
                </button>
              </div>
            ) : null}

            <div className="absolute inset-0 hidden items-center justify-center gap-1 bg-violet-50/80 px-1 group-hover:flex group-focus-within:flex md:flex md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              <Link
                href={buildCreateHref(day, slotMinutes)}
                className="rounded-md bg-[var(--brand-primary)] px-2 py-1 text-[10px] font-semibold text-white"
              >
                Appointment
              </Link>
              <Link
                href={buildBlockHref(day, slotMinutes, instructorId)}
                className="rounded-md border border-orange-300 bg-white px-2 py-1 text-[10px] font-semibold text-orange-800"
              >
                Block time
              </Link>
            </div>
          </div>
        );
      })}

      {items.map((item) => (
        <TimeGridItem
          key={`${item.kind}-${item.id}-${day}`}
          item={item}
          studioTimeZone={studioTimeZone}
          onOpen={onOpen}
          gridStartMinutes={gridStartMinutes}
          gridEndMinutes={gridEndMinutes}
        />
      ))}
    </div>
  );
}


function CalendarLegend() {
  const typeItems = [
    { label: "Private lesson", className: "border-blue-500 bg-blue-50" },
    { label: "Intro lesson", className: "border-cyan-500 bg-cyan-50" },
    { label: "Group / social", className: "border-emerald-500 bg-emerald-50" },
    { label: "Coaching / workshop", className: "border-violet-500 bg-violet-50" },
    { label: "Practice party", className: "border-amber-500 bg-amber-50" },
    { label: "Rental", className: "border-indigo-500 bg-indigo-50" },
    { label: "Blocked time", className: "border-slate-500 bg-slate-200" },
    { label: "Other event", className: "border-orange-500 bg-orange-50" },
  ];

  const statusItems = [
    { label: "Scheduled", className: "bg-blue-500" },
    { label: "Confirmed", className: "bg-cyan-500" },
    { label: "Attended", className: "bg-emerald-500" },
    { label: "Cancelled", className: "bg-red-500" },
    { label: "No-show / draft", className: "bg-amber-500" },
    { label: "Rescheduled", className: "bg-violet-500" },
  ];

  return (
    <details className="group rounded-2xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-900">
        <span>Calendar color legend</span>
        <span
          aria-hidden="true"
          className="text-xl leading-none text-violet-600 transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="grid gap-5 border-t border-slate-200 px-4 py-4 lg:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Background and left border — item type
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {typeItems.map((item) => (
              <span
                key={item.label}
                className={`inline-flex items-center rounded-lg border-l-4 px-2.5 py-1.5 text-xs font-medium text-slate-800 ${item.className}`}
              >
                {item.label}
              </span>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Dot — status
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {statusItems.map((item) => (
              <span
                key={item.label}
                className="inline-flex items-center gap-2 text-xs font-medium text-slate-700"
              >
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 rounded-full ${item.className}`}
                />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

type ScheduleCalendarViewProps = CommonViewProps & {
  gridStartMinutes?: number;
  gridEndMinutes?: number;
};

export default function ScheduleCalendarView(
  props: ScheduleCalendarViewProps,
) {
  const {
    view,
    days,
    groupedAppointments,
    studioTimeZone = DEFAULT_STUDIO_TIME_ZONE,
    gridStartMinutes = DEFAULT_GRID_START_MINUTES,
    gridEndMinutes = DEFAULT_GRID_END_MINUTES,
  } = props;

  if (view !== "day" && view !== "week") {
    throw new Error("ScheduleCalendarView supports day and week views.");
  }

  const [selected, setSelected] = useState<DrawerAppointment | null>(null);
  const today = getTodayInTimeZone(studioTimeZone);
  const slotCount =
    (gridEndMinutes - gridStartMinutes) / SLOT_MINUTES;

  const visibleDays = useMemo(
    () => (view === "day" ? days.slice(0, 1) : days),
    [days, view],
  );

  return (
    <>
      <div className="space-y-4">
        <ScheduleToolbar {...props} />
        <ScheduleFilterBar {...props} />
        <ScheduleSummary
          days={days}
          groupedAppointments={groupedAppointments}
        />
        <CalendarLegend />

        <section className="overflow-hidden rounded-2xl border border-violet-200/80 bg-white shadow-[0_18px_45px_rgba(76,29,149,0.09)]">
          <div className="overflow-x-auto">
            <div
              className={
                view === "week" ? "min-w-[1120px]" : "min-w-[720px]"
              }
            >
              <div
                className="sticky top-0 z-40 grid border-b border-violet-100 bg-white"
                style={{
                  gridTemplateColumns: `84px repeat(${visibleDays.length}, minmax(0, 1fr))`,
                }}
              >
                <div className="border-r border-slate-200 p-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Time
                </div>

                {visibleDays.map((day) => (
                  <div
                    key={day}
                    className={`border-l border-slate-200 px-3 py-3 ${
                      day === today
                        ? "bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)]"
                        : "bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/app/schedule/calendar${buildScheduleQuery({
                          view: "day",
                          date: day,
                          source: props.selectedSource,
                          instructorId: props.selectedInstructorId,
                          roomId: props.selectedRoomId,
                          appointmentType: props.selectedAppointmentType,
                          status: props.selectedStatus,
                        })}`}
                        className="font-semibold text-slate-900 hover:text-violet-700"
                      >
                        {dateHeading(day)}
                      </Link>
                      {day === today ? (
                        <span className="rounded-full bg-[linear-gradient(135deg,#4c1d95_0%,#f97316_130%)] px-2 py-0.5 text-[10px] font-semibold text-white">
                          Today
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {(groupedAppointments[day] ?? []).length} scheduled item
                      {(groupedAppointments[day] ?? []).length === 1 ? "" : "s"}
                    </p>
                  </div>
                ))}
              </div>

              <div
                className="grid"
                style={{
                  gridTemplateColumns: `84px repeat(${visibleDays.length}, minmax(0, 1fr))`,
                }}
              >
                <div
                  className="relative border-r border-slate-200 bg-slate-50"
                  style={{ height: slotCount * SLOT_HEIGHT }}
                >
                  {Array.from({ length: slotCount }, (_, index) => {
                    const slotMinutes =
                      gridStartMinutes + index * SLOT_MINUTES;
                    return (
                      <div
                        key={slotMinutes}
                        className="absolute right-2 -translate-y-2 text-[11px] font-medium text-slate-500"
                        style={{ top: index * SLOT_HEIGHT }}
                      >
                        {slotMinutes % 60 === 0
                          ? timeLabel(slotMinutes)
                          : ""}
                      </div>
                    );
                  })}
                </div>

                {visibleDays.map((day) => (
                  <DayColumn
                    key={day}
                    day={day}
                    items={groupedAppointments[day] ?? []}
                    instructorId={props.selectedInstructorId}
                    studioTimeZone={studioTimeZone}
                    onOpen={setSelected}
                    gridStartMinutes={gridStartMinutes}
                    gridEndMinutes={gridEndMinutes}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] px-4 py-3 text-xs text-slate-600">
            Tap an open 15-minute interval on mobile, or hover/focus it on
            desktop, to schedule an appointment or block instructor time. New
            items default to one hour and can be adjusted before saving.
          </div>
        </section>
      </div>

      <ScheduleEventDrawer
        appointment={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
        studioTimeZone={studioTimeZone}
      />
    </>
  );
}
