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

type PageProps = {
  params: Promise<{ studioSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Class schedule", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type StudioRow = { slug: string; name: string; public_name: string | null; subscription_status: string | null };

const VIEW_LABEL: Record<EmbedView, string> = { agenda: "List", week: "Week", month: "Month" };

/**
 * Embeddable studio class calendar (list, week, month). Same public rule as the studio's public classes page: only
 * publicly_discoverable classes of a public, active/trialing studio, read through the public read model. Private lessons,
 * client names and staff notes are not in that model and cannot appear here.
 */
export default async function EmbedCalendarPage({ params, searchParams }: PageProps) {
  const { studioSlug } = await params;
  const options = parseEmbedOptions(await searchParams);
  const supabase = await createClient();

  const { data: studio } = await supabase
    .from("studios")
    .select("slug, name, public_name, subscription_status")
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();
  const status = (studio?.subscription_status ?? "").trim().toLowerCase();
  if (!studio || (status !== "active" && status !== "trialing")) notFound();

  const all = await fetchPublicGroupClasses(supabase, { studioSlug: studio.slug, limit: 100 });
  const instructors = publicInstructorNames(all);
  const items = filterByInstructor(all, options.instructor);
  const byDay = groupByDay(items);
  const studioName = studio.public_name?.trim() || studio.name;
  const tz = all[0]?.timeZone ?? "America/New_York";
  const today = dayKeyInZone(new Date(), tz);
  const anchor = options.date ?? today;

  const dark = options.theme === "dark";
  const muted = dark ? "text-slate-300" : "text-slate-600";
  const border = dark ? "border-slate-700" : "border-slate-200";
  const link = (o: Partial<EmbedOptions>) => embedCalendarPath(studio.slug, { ...options, ...o });
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
          <h1 className="text-lg font-semibold tracking-tight">{studioName} classes</h1>
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
          <Agenda byDay={byDay} dark={dark} muted={muted} border={border} />
        ) : options.view === "week" ? (
          <ul className="grid gap-3">
            {weekDays(anchor).map((day) => (
              <DayBlock key={day} day={day} today={today} classes={byDay.get(day) ?? []} dark={dark} muted={muted} border={border} showEmpty />
            ))}
          </ul>
        ) : (
          <MonthGrid anchor={anchor} today={today} byDay={byDay} dark={dark} muted={muted} border={border} />
        )}
      </div>

      {items.length === 0 ? (
        <p role="status" className={`mt-4 rounded-xl border border-dashed p-4 text-center text-sm ${border} ${muted}`}>
          {options.instructor ? "No upcoming classes for this instructor." : "No upcoming classes are listed right now."}
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

function ClassRow({ item, dark, muted }: { item: PublicGroupClass; dark: boolean; muted: string }) {
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
        </p>
      </div>
      <AvailabilityBadge item={item} />
    </li>
  );
}

function DayBlock({
  day,
  today,
  classes,
  dark,
  muted,
  border,
  showEmpty,
}: {
  day: string;
  today: string;
  classes: PublicGroupClass[];
  dark: boolean;
  muted: string;
  border: string;
  showEmpty?: boolean;
}) {
  if (!classes.length && !showEmpty) return null;
  return (
    <li className={`rounded-xl border p-3 ${border} ${dark ? "bg-slate-800" : "bg-white"}`}>
      <h3 className="text-sm font-semibold">
        {dayHeading(day)}
        {day === today ? <span className={`ml-2 text-xs font-medium ${muted}`}>Today</span> : null}
      </h3>
      {classes.length ? (
        <ul className="mt-2 grid gap-2">
          {classes.map((c) => (
            <ClassRow key={c.appointmentId} item={c} dark={dark} muted={muted} />
          ))}
        </ul>
      ) : (
        <p className={`mt-1 text-xs ${muted}`}>No classes</p>
      )}
    </li>
  );
}

function Agenda({ byDay, dark, muted, border }: { byDay: Map<string, PublicGroupClass[]>; dark: boolean; muted: string; border: string }) {
  const days = [...byDay.keys()].sort();
  return (
    <ul className="grid gap-3">
      {days.map((day) => (
        <DayBlock key={day} day={day} today="" classes={byDay.get(day) ?? []} dark={dark} muted={muted} border={border} />
      ))}
    </ul>
  );
}

function MonthGrid({
  anchor,
  today,
  byDay,
  dark,
  muted,
  border,
}: {
  anchor: string;
  today: string;
  byDay: Map<string, PublicGroupClass[]>;
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
          .filter((d) => (byDay.get(d) ?? []).length > 0)
          .map((day) => (
            <DayBlock key={day} day={day} today={today} classes={byDay.get(day) ?? []} dark={dark} muted={muted} border={border} />
          ))}
      </ul>
    </>
  );
}
