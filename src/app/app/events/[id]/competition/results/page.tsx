import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";

type Round = { id: string; name: string; status: string; scoring_method: string; sequence_number: number; division_id: string };

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

const RESULT_STATES = new Set(["ballots_locked", "calculated", "approved", "published", "complete"]);

/** Results overview (F2). Manager only: lists rounds whose ballots are locked or later. Nothing here is visible to entrants or the public. */
export default async function CompetitionResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireCompetitionWorkspace(id);

  const [roundResult, divisionResult] = await Promise.all([
    supabase.from("event_competition_rounds").select("id, name, status, scoring_method, sequence_number, division_id").eq("event_id", id).neq("status", "cancelled").order("sequence_number"),
    supabase.from("event_competition_divisions").select("id, name").eq("event_id", id),
  ]);
  if (roundResult.error || divisionResult.error) throw new Error(`Could not load rounds: ${(roundResult.error ?? divisionResult.error)?.message}`);
  const rounds = ((roundResult.data ?? []) as Round[]).filter((round) => RESULT_STATES.has(round.status));
  const divisions = new Map((divisionResult.data ?? []).map((division: { id: string; name: string }) => [division.id, division.name]));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">Results</h2>
        <p className="mt-1 text-sm text-slate-600">
          Calculate a round once its ballots are locked, review the result, and have a second manager approve it. Calculated and approved results are visible to
          result managers only; publishing to dancers is a separate step.
        </p>
      </div>
      {rounds.length === 0 ? (
        <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">No round has locked ballots yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
          {rounds.map((round) => (
            <li key={round.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <span className="font-medium text-slate-950">{round.name}</span>
                <span className="ml-2 text-xs text-slate-600">
                  {divisions.get(round.division_id) ?? "Division"} - {label(round.scoring_method)}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-slate-600">{label(round.status)}</span>
                <Link href={`/app/events/${id}/competition/results/${round.id}`} className="text-sm font-semibold text-slate-950 underline">
                  Review
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
