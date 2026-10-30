import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import type { BallotBoard } from "@/lib/competition/ballots/status";
import { type HeatFloorInfo } from "@/lib/competition/ballots/heatLock";
import BallotDesk from "../BallotDesk";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CompetitionRoundBallotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; roundId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id, roundId } = await params;
  const query = await searchParams;
  if (!UUID.test(roundId)) notFound();
  const { supabase } = await requireCompetitionWorkspace(id);

  // The round must belong to this event: the RPC alone is not told which event the URL named.
  const { data: round } = await supabase.from("event_competition_rounds").select("id").eq("id", roundId).eq("event_id", id).maybeSingle();
  if (!round) notFound();
  const { data, error } = await supabase.rpc("competition_round_ballot_status", { p_round_id: roundId });
  if (error || !data) notFound();
  const board = data as BallotBoard;
  // HL1: floor status per heat (the board carries only lock_state); read fresh on every render, never cached.
  const heatIds = board.heats.map((heat) => heat.heat_id);
  const heatFloor: Record<string, HeatFloorInfo> = {};
  if (heatIds.length > 0) {
    const { data: heatRows, error: heatError } = await supabase.from("event_competition_heats").select("id, status, lock_state").in("id", heatIds);
    if (heatError) throw new Error(`Could not load heats: ${heatError.message}`);
    for (const row of (heatRows ?? []) as Array<{ id: string; status: string; lock_state: string }>) heatFloor[row.id] = { status: row.status, lock_state: row.lock_state };
    const { data: dancedRows } = await supabase.from("event_competition_heat_entries").select("heat_id").in("heat_id", heatIds).in("status", ["danced", "disqualified"]);
    for (const row of (dancedRows ?? []) as Array<{ heat_id: string }>) if (heatFloor[row.heat_id]) heatFloor[row.heat_id].has_danced_entry = true;
  }

  return (
    <div className="space-y-4">
      <Link href={`/app/events/${id}/competition/ballots`} className="text-sm font-medium text-slate-600 hover:text-slate-950">
        &larr; All rounds
      </Link>
      {query.saved ? <p role="status" className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">{query.saved}</p> : null}
      {query.error ? <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">{query.error}</p> : null}
      <BallotDesk board={board} heatFloor={heatFloor} returnTo={`/app/events/${id}/competition/ballots/${roundId}`} />
    </div>
  );
}
