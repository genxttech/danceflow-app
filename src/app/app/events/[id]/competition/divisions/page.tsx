import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import DivisionsBoard, { type BoardCategory } from "./DivisionsBoard";

type Row = Record<string, string>;

export default async function CompetitionDivisionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireCompetitionWorkspace(id);

  const [programResult, contestResult, divisionResult, roundResult, offeringResult, entryResult] = await Promise.all([
    supabase.from("event_competition_programs").select("id, name, status").eq("event_id", id).order("sort_order").order("created_at"),
    supabase.from("event_competition_contests").select("id, program_id, name, entry_format").eq("event_id", id).order("sort_order").order("created_at"),
    supabase.from("event_competition_divisions").select("id, program_id, contest_id, name, skill_label, age_label").eq("event_id", id).order("sort_order").order("created_at"),
    supabase.from("event_competition_rounds").select("division_id, name, round_type, sequence_number").eq("event_id", id).order("sequence_number"),
    supabase.from("event_competition_division_dances").select("division_id").eq("event_id", id).eq("active", true),
    supabase.from("event_competition_entries").select("division_id").eq("event_id", id),
  ]);
  const loadError = programResult.error || contestResult.error || divisionResult.error || roundResult.error || offeringResult.error || entryResult.error;
  if (loadError) throw new Error("Could not load divisions.");

  const programs = (programResult.data ?? []) as Row[];
  if (programs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <h2 className="text-base font-semibold text-slate-950">No divisions yet</h2>
        <p className="mt-1 text-sm text-slate-600">Create the competition first and DanceFlow builds the divisions for you.</p>
        <Link href={`/app/events/${id}/competition/new`} className="mt-4 inline-flex h-11 items-center rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800">
          Create competition
        </Link>
      </div>
    );
  }

  const count = (rows: Row[], key: string) => {
    const result = new Map<string, number>();
    for (const row of rows) result.set(row[key], (result.get(row[key]) ?? 0) + 1);
    return result;
  };
  const roundsByDivision = new Map<string, string[]>();
  for (const round of (roundResult.data ?? []) as Row[]) {
    roundsByDivision.set(round.division_id, [...(roundsByDivision.get(round.division_id) ?? []), round.name]);
  }
  const offerings = count(offeringResult.data ?? [], "division_id");
  const entries = count(entryResult.data ?? [], "division_id");
  const statusByProgram = new Map(programs.map((program) => [program.id as string, program.status as string]));

  const categories: BoardCategory[] = ((contestResult.data ?? []) as Row[]).map((contest) => ({
    id: contest.id,
    name: contest.name,
    editable: ["draft", "configured"].includes(statusByProgram.get(contest.program_id) ?? ""),
    divisions: ((divisionResult.data ?? []) as Row[])
      .filter((division) => division.contest_id === contest.id)
      .map((division) => ({
        id: division.id,
        name: division.name,
        skillLabel: division.skill_label,
        ageLabel: division.age_label,
        rounds: roundsByDivision.get(division.id) ?? [],
        dances: offerings.get(division.id) ?? 0,
        entries: entries.get(division.id) ?? 0,
      })),
  }));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">Divisions</h2>
        <p className="mt-1 text-sm text-slate-600">Select a division to rename it or change its labels. New divisions copy the round and dances of the others in the category.</p>
      </div>
      {categories.length === 0 ? <p className="text-sm text-slate-600">This competition has no categories yet. Add them in Advanced settings.</p> : <DivisionsBoard eventId={id} categories={categories} />}
    </div>
  );
}
