import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { COMPETITION_EVENT_TYPES, NEW_COMPETITION_HREF } from "@/lib/competition/workspaceLink";
import {
  canSeeCompetitionsList,
  describeCompetitionRow,
  type CompetitionsListProgram,
  type CompetitionsListRow,
} from "@/lib/competition/competitionsList";

/*
  10C.1: top-level Competition OS entry. A thin list over the canonical model -- each competition is
  an event plus its competition workspace -- with one primary action, New Competition, which opens
  the existing Create Event form preselected to Competition and continues into setup.
*/

type EventRow = {
  id: string;
  name: string;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  event_type: string | null;
};

type ProgramRow = CompetitionsListProgram & { event_id: string };

const TONE: Record<CompetitionsListRow["tone"], string> = {
  neutral: "bg-slate-100 text-slate-700",
  progress: "bg-amber-100 text-amber-800",
  ready: "bg-sky-100 text-sky-800",
  live: "bg-emerald-100 text-emerald-800",
  done: "bg-slate-100 text-slate-500",
};

function formatDate(value: string | null) {
  if (!value) return "Date to be set";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function CompetitionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  if (!canSeeCompetitionsList(context.studioRole, Boolean(context.isPlatformAdmin))) redirect("/app");

  const [eventResult, programResult] = await Promise.all([
    supabase
      .from("events")
      .select("id, name, status, start_date, end_date, event_type")
      .eq("studio_id", context.studioId)
      .order("start_date", { ascending: false, nullsFirst: false }),
    supabase
      .from("event_competition_programs")
      .select("event_id, status, rules_profile_key, profile_locked_at, registration_status, registration_opened_at, created_at")
      .eq("studio_id", context.studioId)
      .order("created_at"),
  ]);
  if (eventResult.error || programResult.error) throw new Error("Could not load competitions.");

  const programsByEvent = new Map<string, ProgramRow>();
  for (const program of (programResult.data ?? []) as ProgramRow[]) {
    if (!programsByEvent.has(program.event_id)) programsByEvent.set(program.event_id, program);
  }
  const events = ((eventResult.data ?? []) as EventRow[]).filter(
    (event) => programsByEvent.has(event.id) || (COMPETITION_EVENT_TYPES as readonly string[]).includes(event.event_type ?? ""),
  );

  const entryCounts = new Map<string, number>();
  if (events.length > 0) {
    const { data: entries } = await supabase
      .from("event_competition_entries")
      .select("event_id")
      .in("event_id", events.map((event) => event.id))
      .in("status", ["pending", "confirmed"]);
    for (const entry of (entries ?? []) as Array<{ event_id: string }>) {
      entryCounts.set(entry.event_id, (entryCounts.get(entry.event_id) ?? 0) + 1);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Competitions</h1>
          <p className="mt-1 text-sm text-slate-600">Set up, open registration and run your competitions.</p>
        </div>
        <Link
          href={NEW_COMPETITION_HREF}
          className="inline-flex h-11 items-center rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800"
        >
          New Competition
        </Link>
      </header>

      {events.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <h2 className="text-base font-semibold text-slate-950">No competitions yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            Start with the event basics, then DanceFlow walks you through categories, divisions and entry prices.
          </p>
        </section>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {events.map((event) => {
            const row = describeCompetitionRow({ eventId: event.id, eventStatus: event.status, program: programsByEvent.get(event.id) ?? null });
            const entries = entryCounts.get(event.id) ?? 0;
            return (
              <li key={event.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-950">{event.name}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span>{formatDate(event.start_date)}</span>
                    <span aria-hidden="true">·</span>
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${TONE[row.tone]}`}>{row.stateLabel}</span>
                    {programsByEvent.has(event.id) ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{entries} {entries === 1 ? "entry" : "entries"}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <Link
                  href={row.href}
                  className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                >
                  {row.actionLabel}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
