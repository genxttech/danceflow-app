import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { BallotBoard } from "@/lib/competition/ballots/status";
import BallotDesk from "@/app/app/events/[id]/competition/ballots/BallotDesk";
import NoShowPanel, { type FloorEntries } from "./NoShowPanel";
import { friendlyNoShowError } from "@/lib/competition/noShow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Scorer / chair desk (E2): the ballot status board with paper entry (scorer) and attendance + lock (chair). The
 * competition workspace itself is manager-only, so officials reach the same board here. The RPC decides who is a
 * manager, the designated chair or an assigned scorer, and refuses everyone else (this page then 404s).
 */
export default async function BallotDeskPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string; roundId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { eventId, roundId } = await params;
  const query = await searchParams;
  if (!UUID.test(eventId) || !UUID.test(roundId)) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The RPC is the authority: it resolves the caller as manager, designated chair or assigned scorer, or refuses.
  const { data, error } = await supabase.rpc("competition_round_ballot_status", { p_round_id: roundId });
  if (error || !data) notFound();
  const board = data as BallotBoard;
  // NS1: the designated chair (and managers) mark no-shows here; scorers do not, so they do not load the floor view.
  const floor = board.viewer_role === "scorer" ? null : await supabase.rpc("competition_round_floor_entries", { p_round_id: roundId });
  const floorEntries = floor && !floor.error ? (floor.data as FloorEntries) : null;
  const floorError = floor?.error ? friendlyNoShowError(floor.error) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-5">
      <Link href="/app/judging" className="text-sm font-medium text-slate-600 hover:text-slate-950">
        &larr; Judging
      </Link>
      {query.saved ? <p role="status" className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">{query.saved}</p> : null}
      {query.error ? <p role="alert" className="mt-3 rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">{query.error}</p> : null}
      <div className="mt-3">
        <BallotDesk board={board} returnTo={`/app/judging/${eventId}/rounds/${roundId}/ballot/desk`} />
      </div>
      {floorError ? <p role="alert" className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">Couldn&apos;t load no-shows: {floorError}</p> : null}
      {floorEntries ? (
        <div className="mt-4">
          <NoShowPanel floor={floorEntries} returnTo={`/app/judging/${eventId}/rounds/${roundId}/ballot/desk`} />
        </div>
      ) : null}
    </div>
  );
}
