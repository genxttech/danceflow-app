import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { checkScoringHeatMove, DEFAULT_SCORING_HEAT_CAPACITY, isSchedulableEntry, scoringHeatCapacity } from "@/lib/competition/floorPlanner";
import { loadFloorSchedule, loadPlannerInput, loadScheduleVersions, pickWorkingVersion } from "@/lib/competition/floorScheduleServer";
import {
  clearHeatsAction,
  deleteFloorHeatAction,
  editPublishedRunningOrderAction,
  generateHeatsAction,
  insertFloorHeatAction,
  moveFloorHeatAction,
  moveScoringHeatAction,
  publishRunningOrderAction,
  setHeatCapacityAction,
} from "./actions";

/*
  10D: Schedule & Heats -- the numbered running order ("Heat 12") for Simple competitions.
  Time-block scheduling lives under Advanced scheduling.
*/

const primaryButton = "inline-flex h-10 items-center justify-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800";
const secondaryButton = "inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50";
const selectClass = "h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900";

function versionLabel(status: string) {
  if (status === "draft") return "Draft — not published yet";
  if (status === "published" || status === "live") return "Published";
  return status;
}

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ heat?: string; notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { supabase } = await requireCompetitionWorkspace(id);
  const versions = await loadScheduleVersions(supabase, id);
  const version = pickWorkingVersion(versions);
  const view = version ? await loadFloorSchedule(supabase, id, version.id) : null;
  const planner = view?.planner ?? (await loadPlannerInput(supabase, id));
  const editable = version?.status === "draft";
  const summaries = view?.summaries ?? [];
  const problemCount = summaries.reduce((total, summary) => total + summary.problems.length, 0);
  const schedulableCount = planner.entries.filter(isSchedulableEntry).length;
  const selected = summaries.find((summary) => summary.floorHeat.id === query.heat) ?? null;
  const base = `/app/events/${id}/competition/schedule`;
  const publishedDraftExists = versions.some((item) => item.status === "draft") && version?.status !== "draft";

  const entryById = new Map(planner.entries.map((entry) => [entry.id, entry]));
  const peopleByEntry = new Map<string, string[]>();
  for (const participant of planner.participants) peopleByEntry.set(participant.entry_id, [...(peopleByEntry.get(participant.entry_id) ?? []), participant.display_name]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">Schedule &amp; Heats</h2>
          <p className="mt-1 text-sm text-slate-600">
            {version
              ? `${versionLabel(version.status)} · ${summaries.length} heats · ${summaries.reduce((total, summary) => total + summary.entryCount, 0)} entries on the floor`
              : `${schedulableCount} confirmed ${schedulableCount === 1 ? "entry is" : "entries are"} ready to schedule.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && summaries.length > 0 && problemCount === 0 ? (
            <form action={publishRunningOrderAction}>
              <input type="hidden" name="eventId" value={id} />
              <input type="hidden" name="versionId" value={version!.id} />
              <button className={primaryButton}>Publish running order</button>
            </form>
          ) : null}
          {(!version || (editable && summaries.length === 0)) ? (
            <form action={generateHeatsAction}>
              <input type="hidden" name="eventId" value={id} />
              <button className={primaryButton} disabled={schedulableCount === 0}>Generate heats</button>
            </form>
          ) : null}
          {version && !editable && !publishedDraftExists ? (
            <form action={editPublishedRunningOrderAction}>
              <input type="hidden" name="eventId" value={id} />
              <input type="hidden" name="versionId" value={version.id} />
              <button className={secondaryButton}>Edit running order</button>
            </form>
          ) : null}
        </div>
      </header>

      {query.notice ? <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{query.notice}</p> : null}
      {query.error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{query.error}</p> : null}
      {problemCount > 0 ? (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {problemCount === 1 ? "1 heat needs attention" : `${problemCount} heats need attention`} before you can publish. Open a heat to see what to move.
        </p>
      ) : null}
      {view?.usesTimeBlocks ? (
        <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
          This schedule uses time blocks. Manage it in <Link href={`/app/events/${id}/competition/advanced/schedule`} className="font-semibold underline">Advanced scheduling</Link>.
        </p>
      ) : null}

      {summaries.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <h3 className="text-base font-semibold text-slate-950">No heats yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            DanceFlow groups confirmed entries into numbered heats by dance, keeps anyone from being on the floor twice at once, and lets you adjust the order before you publish.
          </p>
        </section>
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6">
          <ol className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" aria-label="Running order">
            {summaries.map((summary) => {
              const isSelected = summary.floorHeat.id === selected?.floorHeat.id;
              const hasProblem = summary.problems.length > 0;
              return (
                <li key={summary.floorHeat.id}>
                  <Link
                    href={`${base}?heat=${summary.floorHeat.id}`}
                    aria-current={isSelected ? "true" : undefined}
                    className={`flex items-start gap-4 px-4 py-3 hover:bg-slate-50 ${isSelected ? "bg-slate-50" : ""}`}
                  >
                    <span className="w-16 shrink-0 text-base font-semibold tabular-nums text-slate-950">Heat {summary.floorHeat.heat_number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-900">{summary.musicLabel}</span>
                      <span className="block truncate text-xs text-slate-600">{summary.scoringHeats.map((heat) => heat.name ?? "Division").join(" · ") || "No divisions yet"}</span>
                      <span className="mt-1 block text-xs text-slate-500">
                        {summary.entryCount} {summary.entryCount === 1 ? "entry" : "entries"} · {summary.competitorCount} {summary.competitorCount === 1 ? "dancer" : "dancers"}
                        {summary.floorHeat.planned_start_at ? ` · ${new Date(summary.floorHeat.planned_start_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
                      </span>
                      {hasProblem ? <span className="mt-1 block text-xs font-semibold text-red-700">Conflict: {summary.problems[0].message}</span> : null}
                      {!hasProblem && summary.overRecommendation ? <span className="mt-1 block text-xs text-amber-700">More entries than recommended on the floor</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>

          {selected ? (
            <aside
              aria-label={`Heat ${selected.floorHeat.heat_number} details`}
              className="fixed inset-x-0 bottom-0 z-40 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-5 shadow-2xl lg:sticky lg:top-4 lg:z-auto lg:max-h-none lg:rounded-xl lg:border lg:shadow-none"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-950">Heat {selected.floorHeat.heat_number}</h3>
                  <p className="text-sm text-slate-600">{selected.musicLabel}</p>
                </div>
                <Link href={base} className="rounded-lg px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100">Close</Link>
              </div>

              {selected.problems.map((problem) => (
                <div key={problem.message} role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <p className="font-semibold">Conflict</p>
                  <p>{problem.message}</p>
                  <p className="mt-1 text-xs">Move one of the divisions below to another heat.</p>
                </div>
              ))}

              {editable ? (
                <form action={moveFloorHeatAction} className="mt-4 flex items-end gap-2">
                  <input type="hidden" name="eventId" value={id} />
                  <input type="hidden" name="floorHeatId" value={selected.floorHeat.id} />
                  <label className="flex-1 text-xs font-medium text-slate-600">
                    Position in the running order
                    <select name="position" defaultValue={selected.floorHeat.heat_number} className={`${selectClass} mt-1 w-full`}>
                      {summaries.map((summary) => <option key={summary.floorHeat.id} value={summary.floorHeat.heat_number}>Heat {summary.floorHeat.heat_number}</option>)}
                    </select>
                  </label>
                  <button className={secondaryButton}>Move heat</button>
                </form>
              ) : null}

              <div className="mt-5 space-y-5">
                {selected.scoringHeats.map((heat) => {
                  const fullHeat = view!.scoringHeats.find((item) => item.id === heat.id)!;
                  const entries = view!.heatEntries.filter((item) => item.heat_id === heat.id && item.status !== "scratched");
                  const round = planner.roundsById.get(fullHeat.round_id);
                  return (
                    <section key={heat.id} className="border-t border-slate-200 pt-4">
                      <h4 className="text-sm font-semibold text-slate-950">{heat.name ?? fullHeat.divisionName}</h4>
                      <p className="text-xs text-slate-500">{fullHeat.divisionName} · {fullHeat.roundName}{fullHeat.lock_state !== "open" ? " · Locked" : ""}</p>
                      <ul className="mt-2 space-y-1">
                        {entries.map((item) => {
                          const entry = entryById.get(item.entry_id);
                          return (
                            <li key={item.entry_id} className="text-sm text-slate-800">
                              {entry?.entry_number ? <span className="mr-2 font-semibold tabular-nums">#{entry.entry_number}</span> : null}
                              {(peopleByEntry.get(item.entry_id) ?? [entry?.display_name ?? "Entry"]).join(" & ")}
                            </li>
                          );
                        })}
                        {entries.length === 0 ? <li className="text-sm text-slate-500">No entries.</li> : null}
                      </ul>
                      {editable && fullHeat.lock_state === "open" ? (
                        <form action={moveScoringHeatAction} className="mt-3 flex items-end gap-2">
                          <input type="hidden" name="eventId" value={id} />
                          <input type="hidden" name="heatId" value={heat.id} />
                          <input type="hidden" name="floorHeatId" value={selected.floorHeat.id} />
                          <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
                            Move division to
                            <select name="target" defaultValue="" required className={`${selectClass} mt-1 w-full`}>
                              <option value="" disabled>Choose a heat</option>
                              {summaries.filter((summary) => summary.floorHeat.id !== selected.floorHeat.id).map((summary) => {
                                const check = checkScoringHeatMove({
                                  heat: fullHeat, target: summary.floorHeat, scoringHeats: view!.scoringHeats,
                                  heatEntries: view!.heatEntries, participants: planner.participants,
                                });
                                return (
                                  <option key={summary.floorHeat.id} value={summary.floorHeat.id} disabled={!check.ok}>
                                    Heat {summary.floorHeat.heat_number} — {check.ok ? (check.warning ? `${summary.musicLabel} (over recommended size)` : summary.musicLabel) : check.reason}
                                  </option>
                                );
                              })}
                              <option value={`new:${selected.floorHeat.heat_number + 1}`}>A new heat after Heat {selected.floorHeat.heat_number}</option>
                            </select>
                          </label>
                          <button className={secondaryButton}>Move</button>
                        </form>
                      ) : null}
                      {editable && round ? (
                        <form action={setHeatCapacityAction} className="mt-2 flex items-end gap-2">
                          <input type="hidden" name="eventId" value={id} />
                          <input type="hidden" name="roundId" value={round.id} />
                          <input type="hidden" name="floorHeatId" value={selected.floorHeat.id} />
                          <label className="text-xs font-medium text-slate-600">
                            Max entries per heat for this division
                            <input name="capacity" type="number" min={1} max={100} defaultValue={scoringHeatCapacity(round)} className={`${selectClass} mt-1 w-24`} />
                          </label>
                          <button className={secondaryButton}>Save</button>
                        </form>
                      ) : null}
                    </section>
                  );
                })}
              </div>

              {editable ? (
                <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
                  <form action={insertFloorHeatAction}>
                    <input type="hidden" name="eventId" value={id} />
                    <input type="hidden" name="versionId" value={version!.id} />
                    <input type="hidden" name="position" value={selected.floorHeat.heat_number + 1} />
                    <button className={secondaryButton}>Add empty heat after</button>
                  </form>
                  {selected.scoringHeats.length === 0 ? (
                    <form action={deleteFloorHeatAction}>
                      <input type="hidden" name="eventId" value={id} />
                      <input type="hidden" name="floorHeatId" value={selected.floorHeat.id} />
                      <button className={secondaryButton}>Remove empty heat</button>
                    </form>
                  ) : null}
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 text-sm text-slate-600">
        <p>New divisions start with up to {DEFAULT_SCORING_HEAT_CAPACITY} entries per heat. You can change it per division.</p>
        <div className="flex flex-wrap items-center gap-3">
          {editable && summaries.length > 0 ? (
            <form action={clearHeatsAction}>
              <input type="hidden" name="eventId" value={id} />
              <input type="hidden" name="versionId" value={version!.id} />
              <button className="font-semibold text-slate-700 underline">Start over</button>
            </form>
          ) : null}
          <Link href={`/app/events/${id}/competition/advanced/schedule`} className="font-semibold text-slate-700 underline">Advanced scheduling</Link>
        </div>
      </footer>
    </div>
  );
}
