import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EmbedFrame from "@/components/embed/EmbedFrame";
import { AvailabilityBadge } from "@/components/public/PublicClassCard";
import { createClient } from "@/lib/supabase/server";
import {
  addDays,
  addMonths,
  dayHeading,
  dayKeyInZone,
  filterByInstructor,
  groupByDay,
  monthWeeks,
  publicInstructorNames,
  weekDays,
  zoneLabel,
} from "@/lib/public/embedCalendar";
import {
  embedCalendarPath,
  EMBED_VIEWS,
  parseEmbedOptions,
  readableTextOn,
  type EmbedOptions,
  type EmbedView,
} from "@/lib/public/embedOptions";
import { fetchPublicGroupClasses, formatClassTimeRange, publicClassPath, type PublicGroupClass } from "@/lib/public/groupClasses";
import { appearanceDefaults, fetchEmbedGate } from "@/lib/public/embedSettings";
import { eventPublicPath, fetchPublicEmbedEvents, formatEventTimes, groupEventsByDay, type PublicEmbedEvent } from "@/lib/public/embedEvents";
import { fetchClassExtras, type ClassExtra } from "@/lib/public/embedClassExtras";

type Extras = Map<string, ClassExtra>;
type EventsByDay = Map<string, PublicEmbedEvent[]>;

type PageProps = {
  params: Promise<{ studioSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Class schedule", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type StudioRow = { id: string; slug: string; name: string; public_name: string | null; subscription_status: string | null };

const VIEW_LABEL: Record<EmbedView, string> = { agenda: "List", week: "Week", month: "Month" };

/**
 * Embeddable studio class calendar (list, week, month). Same public rule as the studio's public classes page: only
 * publicly_discoverable classes of a public, active/trialing studio, read through the public read model. Private lessons,
 * client names and staff notes are not in that model and cannot appear here.
 */
export default async function EmbedCalendarPage({ params, searchParams }: PageProps) {
  const { studioSlug } = await params;
  const rawParams = await searchParams;
  const supabase = await createClient();

  const { data: studio } = await supabase
    .from("studios")
    .select("id, slug, name, public_name, subscription_status")
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();
  const status = (studio?.subscription_status ?? "").trim().toLowerCase();
  if (!studio || (status !== "active" && status !== "trialing")) notFound();

  // The studio's kill switch. Switched off, or settings unreadable: the embed is not served at all (fails closed).
  const gate = await fetchEmbedGate(supabase, studio.slug);
  if (gate.state !== "ok") notFound();
  const { settings } = gate;
  const options = parseEmbedOptions(rawParams, appearanceDefaults(settings));

  const all = await fetchPublicGroupClasses(supabase, { studioSlug: studio.slug, limit: 100 });
  const instructors = publicInstructorNames(all);
  const items = filterByInstructor(all, options.instructor);
  const byDay = groupByDay(items);
  // Events have no instructor, so an instructor filter shows classes only. Studio setting can hide events entirely.
  const events = settings.showEvents && !options.instructor ? await fetchPublicEmbedEvents(supabase, studio.id) : [];
  const eventsByDay = groupEventsByDay(events);
  const extras: Extras =
    settings.showClassDescription || settings.showClassPrice ? await fetchClassExtras(supabase, studio.slug, items.map((c) => c.appointmentId)) : new Map();
  const studioName = studio.public_name?.trim() || studio.name;
  const tz = all[0]?.timeZone ?? "America/New_York";
  const today = dayKeyInZone(new Date(), tz);
  const anchor = options.date ?? today;

  const dark = options.theme === "dark";
  const muted = dark ? "text-slate-300" : "text-slate-600";
  const border = dark ? "border-slate-700" : "border-slate-200";
  // In-frame navigation keeps explicit options; the baseline keeps links short without changing what is shown.
  const link = (o: Partial<EmbedOptions>) => embedCalendarPath(studio.slug, { ...options, ...o }, appearanceDefaults(settings));
  const pill = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--embed-accent)] ${
      active ? "bg-[var(--embed-accent)] text-[var(--embed-accent-text)]" : dark ? "bg-slate-800 text-slate-100" : "bg-slate-100 text-slate-800"
    }`;

  const prev = options.view === "month" ? addMonths(anchor, -1) : addDays(anchor, options.view === "week" ? -7 : 0);
  const next = options.view === "month" ? addMonths(anchor, 1) : addDays(anchor, options.view === "week" ? 7 : 0);

  return (
    <EmbedFrame accent={options.accent} accentText={readableTextOn(options.accent)} theme={options.theme}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{studioName} {events.length ? "classes and events" : "classes"}</h1>
          <p className={`text-xs ${muted}`}>Times shown in {zoneLabel(new Date().toISOString(), tz) || tz}</p>
        </div>
        <nav aria-label="Calendar view" className="flex gap-1.5">
          {EMBED_VIEWS.map((v) => (
            <Link key={v} href={link({ view: v })} aria-current={options.view === v ? "page" : undefined} className={pill(options.view === v)}>
              {VIEW_LABEL[v]}
            </Link>
          ))}
        </nav>
      </header>

      {instructors.length > 1 ? (
        <nav aria-label="Filter by instructor" className="mt-3 flex flex-wrap gap-1.5">
          <Link href={link({ instructor: null })} className={pill(!options.instructor)}>
            All instructors
          </Link>
          {instructors.map((name) => (
            <Link key={name} href={link({ instructor: name })} className={pill(options.instructor === name)}>
              {name}
            </Link>
          ))}
        </nav>
      ) : null}

      {options.view !== "agenda" ? (
        <div className="mt-4 flex items-center justify-between">
          <Link href={link({ date: prev })} className={pill(false)} aria-label={options.view === "month" ? "Previous month" : "Previous week"}>
            ‹ Prev
          </Link>
          <h2 className="text-base font-semibold">
            {options.view === "month" ? dayHeading(anchor, { month: "long", year: "numeric" }) : `Week of ${dayHeading(weekDays(anchor)[0], { month: "short", day: "numeric" })}`}
          </h2>
          <Link href={link({ date: next })} className={pill(false)} aria-label={options.view === "month" ? "Next month" : "Next week"}>
            Next ›
          </Link>
        </div>
      ) : null}

      <div className="mt-4">
        {options.view === "agenda" ? (
          <Agenda byDay={byDay} eventsByDay={eventsByDay} extras={extras} dark={dark} muted={muted} border={border} />
        ) : options.view === "week" ? (
          <ul className="grid gap-3">
            {weekDays(anchor).map((day) => (
              <DayBlock key={day} day={day} today={today} classes={byDay.get(day) ?? []} events={eventsByDay.get(day) ?? []} extras={extras} dark={dark} muted={muted} border={border} showEmpty />
            ))}
          </ul>
        ) : (
          <MonthGrid anchor={anchor} today={today} byDay={byDay} eventsByDay={eventsByDay} extras={extras} dark={dark} muted={muted} border={border} />
        )}
      </div>

      {items.length === 0 && events.length === 0 ? (
        <p role="status" className={`mt-4 rounded-xl border border-dashed p-4 text-center text-sm ${border} ${muted}`}>
          {options.instructor ? "No upcoming classes for this instructor." : "Nothing is scheduled right now."}
        </p>
      ) : null}

      <p className={`mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>
        <a href={`/studios/${encodeURIComponent(studio.slug)}/classes`} target="_blank" rel="noopener" className="underline">
          Open the full class list
        </a>
        <span>
          Powered by{" "}
          <a href="https://www.idanceflow.com" target="_blank" rel="noopener" className="underline">
            DanceFlow
          </a>
        </span>
      </p>
    </EmbedFrame>
  );
}

function ClassRow({ item, extra, muted }: { item: PublicGroupClass; extra?: ClassExtra; muted: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <a
          href={publicClassPath(item.studioSlug, item.appointmentId)}
          target="_blank"
          rel="noopener"
          className="font-semibold underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--embed-accent)]"
        >
          {item.title}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <p className={`text-xs ${muted}`}>
          {formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)}
          {item.instructorName ? ` · ${item.instructorName}` : ""}
          {item.locationLabel ? ` · ${item.locationLabel}` : ""}
          {extra?.priceLabel ? ` · ${extra.priceLabel}` : ""}
        </p>
        {extra?.description ? <p className={`mt-0.5 line-clamp-2 text-xs ${muted}`}>{extra.description}</p> : null}
      </div>
      <AvailabilityBadge item={item} />
    </li>
  );
}

function EventRow({ event, muted }: { event: PublicEmbedEvent; muted: string }) {
  const times = formatEventTimes(event);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <a
          href={eventPublicPath(event.slug)}
          target="_blank"
          rel="noopener"
          className="font-semibold underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--embed-accent)]"
        >
          {event.name}
          <span className="sr-only"> (event, opens in a new tab)</span>
        </a>
        <p className={`text-xs ${muted}`}>
          {event.typeLabel}
          {times ? ` · ${times}` : ""}
          {event.location ? ` · ${event.location}` : ""}
        </p>
      </div>
      <span className="rounded-full border border-current px-2 py-0.5 text-[11px] font-semibold">{event.registrationRequired ? "Register" : "Event"}</span>
    </li>
  );
}

function DayBlock({
  day,
  today,
  classes,
  events,
  extras,
  dark,
  muted,
  border,
  showEmpty,
}: {
  day: string;
  today: string;
  classes: PublicGroupClass[];
  events: PublicEmbedEvent[];
  extras: Extras;
  dark: boolean;
  muted: string;
  border: string;
  showEmpty?: boolean;
}) {
  if (!classes.length && !events.length && !showEmpty) return null;
  return (
    <li className={`rounded-xl border p-3 ${border} ${dark ? "bg-slate-800" : "bg-white"}`}>
      <h3 className="text-sm font-semibold">
        {dayHeading(day)}
        {day === today ? <span className={`ml-2 text-xs font-medium ${muted}`}>Today</span> : null}
      </h3>
      {classes.length || events.length ? (
        <ul className="mt-2 grid gap-2">
          {classes.map((c) => (
            <ClassRow key={c.appointmentId} item={c} extra={extras.get(c.appointmentId)} muted={muted} />
          ))}
          {events.map((e) => (
            <EventRow key={e.id} event={e} muted={muted} />
          ))}
        </ul>
      ) : (
        <p className={`mt-1 text-xs ${muted}`}>Nothing scheduled</p>
      )}
    </li>
  );
}

function Agenda({
  byDay,
  eventsByDay,
  extras,
  dark,
  muted,
  border,
}: {
  byDay: Map<string, PublicGroupClass[]>;
  eventsByDay: EventsByDay;
  extras: Extras;
  dark: boolean;
  muted: string;
  border: string;
}) {
  const days = [...new Set([...byDay.keys(), ...eventsByDay.keys()])].sort();
  return (
    <ul className="grid gap-3">
      {days.map((day) => (
        <DayBlock key={day} day={day} today="" classes={byDay.get(day) ?? []} events={eventsByDay.get(day) ?? []} extras={extras} dark={dark} muted={muted} border={border} />
      ))}
    </ul>
  );
}

function MonthGrid({
  anchor,
  today,
  byDay,
  eventsByDay,
  extras,
  dark,
  muted,
  border,
}: {
  anchor: string;
  today: string;
  byDay: Map<string, PublicGroupClass[]>;
  eventsByDay: EventsByDay;
  extras: Extras;
  dark: boolean;
  muted: string;
  border: string;
}) {
  const month = anchor.slice(0, 7);
  const weeks = monthWeeks(anchor);
  return (
    <>
      {/* Wide screens: a real month grid. */}
      <div className="hidden sm:block" role="table" aria-label={dayHeading(anchor, { month: "long", year: "numeric" })}>
        <div role="row" className={`grid grid-cols-7 text-center text-xs font-semibold ${muted}`}>
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} role="columnheader" className="py-1">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7">
            {week.map((day) => {
              const list = byDay.get(day) ?? [];
              const inMonth = day.startsWith(month);
              return (
                <div
                  key={day}
                  role="cell"
                  className={`min-h-20 border p-1 text-xs ${border} ${inMonth ? "" : "opacity-40"} ${day === today ? "ring-2 ring-inset ring-[var(--embed-accent)]" : ""}`}
                >
                  <div className="font-semibold">{Number(day.slice(8))}</div>
                  {list.map((c) => (
                    <a
                      key={c.appointmentId}
                      href={publicClassPath(c.studioSlug, c.appointmentId)}
                      target="_blank"
                      rel="noopener"
                      className={`mt-0.5 block truncate rounded px-1 py-0.5 ${c.publicState === "cancelled" ? "line-through opacity-60" : ""} ${dark ? "bg-slate-800" : "bg-slate-100"}`}
                      title={`${c.title}, ${formatClassTimeRange(c.startsAt, c.endsAt, c.timeZone)}`}
                    >
                      {c.title}
                      <span className="sr-only">, {formatClassTimeRange(c.startsAt, c.endsAt, c.timeZone)}, {c.availability === "full" ? "full" : "open"} (opens in a new tab)</span>
                    </a>
                  ))}
                  {(eventsByDay.get(day) ?? []).map((e) => (
                    <a
                      key={e.id}
                      href={eventPublicPath(e.slug)}
                      target="_blank"
                      rel="noopener"
                      className="mt-0.5 block truncate rounded border border-[var(--embed-accent)] px-1 py-0.5"
                      title={`${e.name} (${e.typeLabel})`}
                    >
                      {e.name}
                      <span className="sr-only">, event (opens in a new tab)</span>
                    </a>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* Phones: the same month as a day list (a 7-column grid is unreadable at 320px). */}
      <ul className="grid gap-3 sm:hidden">
        {weeks
          .flat()
          .filter((d) => d.startsWith(month))
          .filter((d) => (byDay.get(d) ?? []).length > 0 || (eventsByDay.get(d) ?? []).length > 0)
          .map((day) => (
            <DayBlock key={day} day={day} today={today} classes={byDay.get(day) ?? []} events={eventsByDay.get(day) ?? []} extras={extras} dark={dark} muted={muted} border={border} />
          ))}
      </ul>
    </>
  );
}
