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

function dateHeading(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function ScheduleCalendarView(props: CommonViewProps) {
  const { view, days, groupedAppointments, studioTimeZone = DEFAULT_STUDIO_TIME_ZONE } = props;
  if (view !== "day" && view !== "week") throw new Error("ScheduleCalendarView supports day and week views.");
  const [selected, setSelected] = useState<DrawerAppointment | null>(null);
  const today = getTodayInTimeZone(studioTimeZone);

  return <>
    <div className="space-y-4">
      <ScheduleToolbar {...props} />
      <ScheduleFilterBar {...props} />
      <ScheduleSummary days={days} groupedAppointments={groupedAppointments} />

      {view === "week" ? <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"><div className="grid min-w-[980px] grid-cols-7 divide-x divide-slate-200">
        {days.map((day) => {
          const items = groupedAppointments[day] ?? [];
          return <section key={day} className={day === today ? "bg-fuchsia-50/40" : "bg-white"}>
            <div className="border-b border-slate-200 px-3 py-3"><div className="flex items-center justify-between gap-2"><Link href={`/app/schedule/calendar${buildScheduleQuery({ view: "day", date: day, source: props.selectedSource, instructorId: props.selectedInstructorId, roomId: props.selectedRoomId, appointmentType: props.selectedAppointmentType, status: props.selectedStatus })}`} className="font-semibold text-slate-900 hover:text-fuchsia-700">{dateHeading(day)}</Link>{day === today ? <span className="rounded-full bg-[#5B197A] px-2 py-0.5 text-[10px] font-semibold text-white">Today</span> : null}</div><p className="mt-1 text-xs text-slate-500">{items.length} item{items.length === 1 ? "" : "s"}</p></div>
            <div className="min-h-52 space-y-2 p-2">{items.length ? items.map((item) => <CompactCalendarItem key={`${item.kind}-${item.id}-${day}`} item={item} onOpen={setSelected} studioTimeZone={studioTimeZone} dense />) : <Link href={`/app/schedule/new?date=${day}`} className="flex min-h-44 items-center justify-center rounded-md border border-dashed border-slate-300 text-xs font-medium text-slate-400 hover:border-fuchsia-300 hover:bg-fuchsia-50 hover:text-fuchsia-700"><Plus className="mr-1 h-3.5 w-3.5" />Schedule</Link>}</div>
          </section>;
        })}
      </div></div> : <section className="rounded-lg border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div><h3 className="font-semibold text-slate-950">{dateHeading(days[0])}</h3><p className="text-xs text-slate-500">{(groupedAppointments[days[0]] ?? []).length} scheduled item(s)</p></div><Link href={`/app/schedule/new?date=${days[0]}`} className="inline-flex items-center gap-2 rounded-md bg-[#F97316] px-3 py-2 text-sm font-semibold text-white"><Plus className="h-4 w-4" />Schedule</Link></div><div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">{(groupedAppointments[days[0]] ?? []).length ? (groupedAppointments[days[0]] ?? []).map((item) => <CompactCalendarItem key={`${item.kind}-${item.id}`} item={item} onOpen={setSelected} studioTimeZone={studioTimeZone} />) : <div className="col-span-full rounded-md border border-dashed border-slate-300 px-4 py-12 text-center text-sm text-slate-500">No scheduled activity. This day is open.</div>}</div></section>}
    </div>
    <ScheduleEventDrawer appointment={selected} open={selected !== null} onClose={() => setSelected(null)} studioTimeZone={studioTimeZone} />
  </>;
}
