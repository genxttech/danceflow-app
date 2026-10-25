"use server";

import { revalidatePath } from "next/cache";
import { requireCompetitionManager } from "@/lib/competition/workspaceServer";
import { planStudioScoring, type SetupOp, type SetupRound } from "@/lib/competition/scoring/studioSetup";

export type ScoringActionState = { ok: boolean; error?: string; message?: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Database guards (REG) raise plain messages with 42501; anything else is not shown to organizers. */
function friendly(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return GENERIC_ERROR;
  if (error.code === "42501" || error.code === "P0001") return (error.message || GENERIC_ERROR).replace(/^COMP_[A-Z_]+:\s*/, "");
  return GENERIC_ERROR;
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}`);
  revalidatePath(`/app/events/${eventId}/competition`, "layout");
}

/**
 * SS1: configures the scoring of studio divisions from the approved registry methods. `presetKey` is resolved against the
 * registry on the server (never trusted from the browser): only a preset whose every method is approved and selectable can be
 * applied, so UCWDC, proficiency, NDCA and WSDC cannot be reached from here. The REG guard trigger re-checks every selection in
 * the database (approved + unlocked draft), and the pin is written by REG when the competition is published.
 *
 * `divisionId` configures one division; `programId` (without a division) configures every division of that draft competition
 * and skips none silently: a division that cannot be configured is reported.
 */
export async function configureStudioScoringAction(_previous: ScoringActionState, formData: FormData): Promise<ScoringActionState> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const divisionId = text(formData, "divisionId");
  const presetKey = text(formData, "presetKey");
  if (!eventId || !programId || !presetKey) return { ok: false, error: "Choose a scoring setup." };
  const { supabase } = await requireCompetitionManager(eventId);

  const { data: program } = await supabase
    .from("event_competition_programs")
    .select("id, status, profile_locked_at, rules_profile_key")
    .eq("id", programId)
    .eq("event_id", eventId)
    .maybeSingle();
  if (!program) return { ok: false, error: "Competition not found." };

  let divisionQuery = supabase
    .from("event_competition_divisions")
    .select("id, name, scoring_method_key, scoring_method_version")
    .eq("event_id", eventId)
    .eq("program_id", programId)
    .neq("status", "cancelled")
    .order("sort_order");
  if (divisionId) divisionQuery = divisionQuery.eq("id", divisionId);
  const { data: divisions, error: divisionError } = await divisionQuery;
  if (divisionError) return { ok: false, error: GENERIC_ERROR };
  if (!divisions || divisions.length === 0) return { ok: false, error: "Division not found." };

  // Plan everything first, so a refused division changes nothing in the whole request.
  const plans: Array<{ division: (typeof divisions)[number]; ops: SetupOp[] }> = [];
  for (const division of divisions) {
    const [{ data: rounds, error: roundError }, { count, error: countError }] = await Promise.all([
      supabase
        .from("event_competition_rounds")
        .select("id, name, round_type, sequence_number, scoring_method, status, pairing_mode, scoring_override_key, scoring_override_version")
        .eq("event_id", eventId)
        .eq("division_id", division.id)
        .order("sequence_number"),
      supabase.from("event_competition_entries").select("id", { count: "exact", head: true }).eq("event_id", eventId).eq("division_id", division.id),
    ]);
    if (roundError || countError) return { ok: false, error: GENERIC_ERROR };
    const plan = planStudioScoring({
      presetKey,
      program,
      division,
      rounds: ((rounds ?? []) as SetupRound[]).filter((r) => r.status !== "cancelled"),
      cancelledSequences: ((rounds ?? []) as SetupRound[]).filter((r) => r.status === "cancelled").map((r) => r.sequence_number),
      entryCount: count ?? 0,
    });
    if (!plan.ok) return { ok: false, error: divisions.length > 1 ? `${division.name}: ${plan.message}` : plan.message };
    plans.push({ division, ops: plan.ops });
  }

  for (const { division, ops } of plans) {
    for (const op of ops) {
      // Narrow the publish race: re-read the program right before every write (the database guard still refuses selections on a locked program).
      const { data: current } = await supabase.from("event_competition_programs").select("status, profile_locked_at").eq("id", programId).eq("event_id", eventId).maybeSingle();
      if (!current || current.status !== "draft" || current.profile_locked_at !== null) {
        refresh(eventId);
        return { ok: false, error: "The competition was published while scoring was being set up. Check the scoring notices on the Advanced page." };
      }
      let error: { code?: string; message?: string } | null = null;
      let rowsChanged = 1;
      if (op.op === "set_division_selection") {
        ({ error } = await supabase
          .from("event_competition_divisions")
          .update({ scoring_method_key: op.key, scoring_method_version: op.version })
          .eq("id", division.id)
          .eq("event_id", eventId)
          .select("id")
          .then((r) => { rowsChanged = r.data?.length ?? 0; return r; }));
      } else if (op.op === "update_round") {
        ({ error } = await supabase.from("event_competition_rounds").update(op.patch).eq("id", op.roundId).eq("event_id", eventId).select("id").then((r) => { rowsChanged = r.data?.length ?? 0; return r; }));
      } else {
        ({ error } = await supabase
          .from("event_competition_rounds")
          .insert({ ...op.row, event_id: eventId, program_id: programId, division_id: division.id }));
      }
      if (!error && rowsChanged === 0) error = { code: "42501", message: "A scoring change was not saved." };
      if (error) {
        refresh(eventId);
        return { ok: false, error: `${friendly(error)} ${divisions.length > 1 ? `(${division.name}) ` : ""}Apply the scoring setup again to finish.` };
      }
    }
  }

  refresh(eventId);
  const changed = plans.filter((p) => p.ops.length > 0).length;
  return { ok: true, message: changed === 0 ? "Scoring was already set up." : `Scoring set up for ${changed} division${changed === 1 ? "" : "s"}.` };
}
