import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";

type Round = { id: string; name: string; status: string; scoring_method: string; sequence_number: number; division_id: string };

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Ballots overview (E2). Lists the event's rounds with their ballot state; the detail page per round holds the status
 * board and the lock / reopen / attendance / paper-entry controls. Manager only (workspace layout + RPC authority).
 */
export default async function CompetitionBallotsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireCompetitionWorkspace(id);

  const [roundResult, divisionResult] = await Promise.all([
    supabase.from("event_competition_rounds").select("id, name, status, scoring_method, sequence_number, division_id").eq("event_id", id).neq("status", "cancelled").order("sequence_number"),
    supabase.from("event_competition_divisions").select("id, name").eq("event_id", id),
  ]);
  if (roundResult.error || divisionResult.error) throw new Error(`Could not load rounds: ${(roundResult.error ?? divisionResult.error)?.message}`);
  const rounds = (roundResult.data ?? []) as Round[];
  const divisions = new Map((divisionResult.data ?? []).map((division: { id: string; name: string }) => [division.id, division.name]));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">
          Ballots
          <Link href={`/app/events/${id}/competition/results`} className="ml-3 text-sm font-medium text-slate-600 underline hover:text-slate-950">
            Results
          </Link>
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Judges submit ballots from their own account; a submitted ballot is never edited, only corrected with a new version. Open a round to see who has
          submitted, enter paper ballots, record an absent judge and lock the ballots.
        </p>
      </div>
      {rounds.length === 0 ? (
        <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">This event has no rounds yet.</p>
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
                {round.status === "scheduled" || round.status === "active" || round.status === "ballots_locked" ? (
                  <Link href={`/app/events/${id}/competition/ballots/${round.id}`} className="text-sm font-semibold text-slate-950 underline">
                    Open
                  </Link>
                ) : (
                  <span className="text-xs text-slate-500">Not started</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
