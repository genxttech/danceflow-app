import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { loadDayOf } from "@/lib/competition/dayOfServer";
import {
  canCancelRound,
  canOfferHeatAction,
  floorPosition,
  heatStateLabel,
  nextHeatAction,
  nextRoundAction,
  roundStatusLabel,
  scratchHref,
  type DayOfFloorHeat,
} from "@/lib/competition/dayOf";
import { heatTransitionAction, roundTransitionAction } from "./actions";

/* O1: staff floor console. Mobile first (375px): one column, large buttons, no horizontal scroll. */

export const dynamic = "force-dynamic";

const primary = "inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto";
const secondary = "inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 sm:w-auto";
const chip = "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";

const STATE_CHIP: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-700",
  staging: "bg-amber-100 text-amber-900",
  active: "bg-emerald-100 text-emerald-900",
  complete: "bg-slate-200 text-slate-600",
  mixed: "bg-rose-100 text-rose-900",
};

export default async function DayOfPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { supabase } = await requireCompetitionWorkspace(id);
  const data = await loadDayOf(supabase, id);
  const roundStatusById = new Map(data.rounds.map((round) => [round.id, round.status]));
  const roundName = new Map(data.rounds.map((round) => [round.id, `${data.divisionName.get(round.division_id) ?? "Division"} · ${round.name}`]));
  const { current, next } = floorPosition(data.floorHeats);
  const scheduleHref = `/app/events/${id}/competition/schedule`;

  function HeatCard({ heat, title }: { heat: DayOfFloorHeat; title: string }) {
    const action = nextHeatAction(heat.state);
    const offer = canOfferHeatAction(heat, roundStatusById);
    const scoring = data.heatsByFloor.get(heat.id) ?? [];
    return (
      <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4" aria-label={title}>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h3 className="text-2xl font-semibold text-slate-950">Heat {heat.number}</h3>
          <span className={`${chip} ${STATE_CHIP[heat.state]}`}>{heatStateLabel(heat.state)}</span>
        </div>
        <ul className="mt-3 space-y-3">
          {scoring.map((scoringHeat) => (
            <li key={scoringHeat.id} className="min-w-0">
              <p className="break-words text-sm font-medium text-slate-900">{roundName.get(scoringHeat.round_id) ?? "Round"}</p>
              <ul className="mt-1 space-y-1">
                {(data.entriesByHeat.get(scoringHeat.id) ?? []).map((entry) => (
                  <li key={entry.entryId} className="flex min-w-0 items-center justify-between gap-2 text-sm text-slate-700">
                    <span className="min-w-0 break-words">
                      {entry.number ? `#${entry.number} ` : ""}
                      {entry.name}
                    </span>
                    <Link href={scratchHref(id, entry.entryId)} className="shrink-0 text-xs font-semibold text-slate-600 underline">
                      Scratch
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {action ? (
          <div className="mt-4">
            {offer.allowed ? (
              <form action={heatTransitionAction}>
                <input type="hidden" name="eventId" value={id} />
                <input type="hidden" name="targetId" value={heat.id} />
                <input type="hidden" name="to" value={action.to} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <button className={primary}>{action.label}</button>
              </form>
            ) : (
              <p className="text-sm text-slate-600">{offer.reason}</p>
            )}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-slate-950">Day-of</h2>
        <p className="mt-1 text-sm text-slate-600">
          {data.version ? `Running order: ${data.version.name} (published) · ${data.floorHeats.length} heats` : "Publish the running order to run the day."}
        </p>
      </header>

      {query.notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{query.notice}</p> : null}
      {query.error ? <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">{query.error}</p> : null}

      {!data.version ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-700">
          There is no published running order yet.{" "}
          <Link href={scheduleHref} className="font-semibold underline">
            Open Schedule &amp; Heats
          </Link>
          .
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {current ? <HeatCard heat={current} title="On the floor" /> : <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">No heat is on the floor.</p>}
            {next ? <HeatCard heat={next} title="Up next" /> : <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">No more heats waiting.</p>}
          </div>

          <section aria-label="Rounds" className="min-w-0 space-y-3">
            <h3 className="text-base font-semibold text-slate-950">Rounds</h3>
            <ul className="space-y-3">
              {data.rounds.map((round) => {
                const action = nextRoundAction(round.status);
                return (
                  <li key={round.id} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-medium text-slate-900">{roundName.get(round.id)}</p>
                      <span className={`${chip} bg-slate-100 text-slate-700`}>{roundStatusLabel(round.status)}</span>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      {action ? (
                        <form action={roundTransitionAction}>
                          <input type="hidden" name="eventId" value={id} />
                          <input type="hidden" name="targetId" value={round.id} />
                          <input type="hidden" name="kind" value={action.kind} />
                          <input type="hidden" name="requestId" value={randomUUID()} />
                          <button className={secondary}>{action.label}</button>
                        </form>
                      ) : null}
                      {canCancelRound(round.status) ? (
                        <form action={roundTransitionAction} className="flex min-w-0 flex-col gap-2 sm:flex-row">
                          <input type="hidden" name="eventId" value={id} />
                          <input type="hidden" name="targetId" value={round.id} />
                          <input type="hidden" name="kind" value="cancel" />
                          <input type="hidden" name="requestId" value={randomUUID()} />
                          <input name="reason" required minLength={3} maxLength={500} placeholder="Cancel reason" aria-label="Cancel reason" className="h-11 min-w-0 rounded-lg border border-slate-300 px-3 text-sm" />
                          <button className={secondary}>Cancel round</button>
                        </form>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-label="Running order" className="min-w-0 space-y-3">
            <h3 className="text-base font-semibold text-slate-950">Running order</h3>
            <ol className="space-y-2">
              {data.floorHeats.map((heat) => (
                <li key={heat.id} className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-950">Heat {heat.number}</p>
                    <p className="break-words text-xs text-slate-600">{heat.roundIds.map((roundId) => roundName.get(roundId) ?? "Round").join(" + ")}</p>
                  </div>
                  <span className={`${chip} ${STATE_CHIP[heat.state]}`}>{heatStateLabel(heat.state)}</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
