"use client";

import { useMemo, useState } from "react";
import ScheduleEventDrawer, { type DrawerAppointment } from "./ScheduleEventDrawer";
import {
  CompactCalendarItem,
  DEFAULT_STUDIO_TIME_ZONE,
  ScheduleFilterBar,
  ScheduleSummary,
  ScheduleToolbar,
  instructorName,
  type CalendarItem,
  type CommonViewProps,
} from "./ScheduleCalendarShared";

function dateHeading(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

export default function ScheduleAgendaView(props: CommonViewProps) {
  const { days, groupedAppointments, studioTimeZone = DEFAULT_STUDIO_TIME_ZONE, groupBy } = props;
  const [selected, setSelected] = useState<DrawerAppointment | null>(null);
  const nonemptyDays = days.filter((day) => (groupedAppointments[day] ?? []).length > 0);

  return <>
    <div className="space-y-4">
      <ScheduleToolbar {...props} />
      <ScheduleFilterBar {...props} />
      <ScheduleSummary days={days} groupedAppointments={groupedAppointments} />
      {nonemptyDays.length ? <div className="space-y-4">{nonemptyDays.map((day) => <AgendaDay key={day} day={day} items={groupedAppointments[day] ?? []} groupBy={groupBy} onOpen={setSelected} studioTimeZone={studioTimeZone} />)}</div> : <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-16 text-center"><h3 className="font-semibold text-slate-900">No scheduled activity in this period</h3><p className="mt-1 text-sm text-slate-500">Change the date range or filters, or create a new appointment.</p></div>}
    </div>
    <ScheduleEventDrawer appointment={selected} open={selected !== null} onClose={() => setSelected(null)} studioTimeZone={studioTimeZone} />
  </>;
}

function AgendaDay({ day, items, groupBy, onOpen, studioTimeZone }: { day: string; items: CalendarItem[]; groupBy?: "none" | "instructor"; onOpen: (item: DrawerAppointment) => void; studioTimeZone: string }) {
  const groups = useMemo(() => {
    if (groupBy !== "instructor") return [{ label: "", items }];
    const grouped = new Map<string, CalendarItem[]>();
    items.forEach((item) => {
      const label = item.kind === "event" ? "Events" : instructorName(item);
      grouped.set(label, [...(grouped.get(label) ?? []), item]);
    });
    return Array.from(grouped, ([label, groupItems]) => ({ label, items: groupItems }));
  }, [groupBy, items]);
  return <section className="rounded-lg border border-slate-200 bg-white shadow-sm"><header className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><h3 className="font-semibold text-slate-950">{dateHeading(day)}</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{items.length}</span></header><div className="space-y-4 p-4">{groups.map((group) => <div key={group.label || "all"}>{group.label ? <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fuchsia-700">{group.label}</h4> : null}<div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{group.items.map((item) => <CompactCalendarItem key={`${item.kind}-${item.id}-${day}`} item={item} onOpen={onOpen} studioTimeZone={studioTimeZone} />)}</div></div>)}</div></section>;
}
