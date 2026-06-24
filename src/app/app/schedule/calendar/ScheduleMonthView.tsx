"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useState } from "react";
import ScheduleEventDrawer, { type DrawerAppointment } from "./ScheduleEventDrawer";
import {
  CompactCalendarItem,
  DEFAULT_STUDIO_TIME_ZONE,
  ScheduleFilterBar,
  ScheduleSummary,
  ScheduleToolbar,
  buildScheduleQuery,
  getTodayInTimeZone,
  type CommonViewProps,
} from "./ScheduleCalendarShared";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ScheduleMonthView(props: CommonViewProps) {
  const { baseDate, days, groupedAppointments, studioTimeZone = DEFAULT_STUDIO_TIME_ZONE } = props;
  const [selected, setSelected] = useState<DrawerAppointment | null>(null);
  const today = getTodayInTimeZone(studioTimeZone);
  const selectedMonth = baseDate.slice(0, 7);

  return <>
    <div className="space-y-4">
      <ScheduleToolbar {...props} />
      <ScheduleFilterBar {...props} />
      <ScheduleSummary days={days} groupedAppointments={groupedAppointments} />
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="min-w-[840px]">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">{WEEKDAYS.map((day) => <div key={day} className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">{day}</div>)}</div>
          <div className="grid grid-cols-7">{days.map((day) => {
            const items = groupedAppointments[day] ?? [];
            const inMonth = day.startsWith(selectedMonth);
            const visible = items.slice(0, 3);
            return <section key={day} className={`min-h-36 border-b border-r border-slate-200 p-2 ${inMonth ? "bg-white" : "bg-slate-50/80"} ${day === today ? "ring-2 ring-inset ring-fuchsia-500" : ""}`}>
              <div className="mb-2 flex items-center justify-between"><Link href={`/app/schedule/calendar${buildScheduleQuery({ view: "day", date: day, source: props.selectedSource, instructorId: props.selectedInstructorId, roomId: props.selectedRoomId, appointmentType: props.selectedAppointmentType, status: props.selectedStatus })}`} className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold ${day === today ? "bg-[#5B197A] text-white" : inMonth ? "text-slate-900 hover:bg-fuchsia-50" : "text-slate-400"}`}>{Number(day.slice(-2))}</Link><Link aria-label={`Schedule appointment on ${day}`} href={`/app/schedule/new?date=${day}`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-orange-50 hover:text-orange-600"><Plus className="h-4 w-4" /></Link></div>
              <div className="space-y-1.5">{visible.map((item) => <CompactCalendarItem key={`${item.kind}-${item.id}-${day}`} item={item} onOpen={setSelected} studioTimeZone={studioTimeZone} dense />)}{items.length > visible.length ? <Link href={`/app/schedule/calendar${buildScheduleQuery({ view: "day", date: day, source: props.selectedSource, instructorId: props.selectedInstructorId, roomId: props.selectedRoomId, appointmentType: props.selectedAppointmentType, status: props.selectedStatus })}`} className="block px-1 text-xs font-semibold text-fuchsia-700">+{items.length - visible.length} more</Link> : null}</div>
            </section>;
          })}</div>
        </div>
      </div>
    </div>
    <ScheduleEventDrawer appointment={selected} open={selected !== null} onClose={() => setSelected(null)} studioTimeZone={studioTimeZone} />
  </>;
}
