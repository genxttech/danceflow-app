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
  if (error.code === "42501" || error.code === "P0001" || error.code === "22023") return (error.message || GENERIC_ERROR).replace(/^COMP_[A-Z_]+:\s*/, "");
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
    .select("id, status, profile_locked_at, rules_profile_key, advancement_method")
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
  let programAdvancement: string | null = null;
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
    programAdvancement = programAdvancement ?? plan.programAdvancement;
  }

  // One database transaction for the whole request: the RPC holds the program row FOR SHARE, so a publish cannot land between
  // the steps, and a refused step rolls everything back (no half-applied setup).
  const payload = plans.flatMap(({ division, ops }) =>
    ops.map((op) =>
      op.op === "set_division_selection"
        ? { op: op.op, division_id: division.id, key: op.key, version: op.version }
        : op.op === "update_round"
          ? { op: op.op, division_id: division.id, round_id: op.roundId, patch: op.patch }
          : { op: op.op, division_id: division.id, row: op.row },
    ),
  );
  if (payload.length > 0) {
    const { error } = await supabase.rpc("apply_competition_scoring_setup", { p_program_id: programId, p_ops: payload });
    if (error) {
      refresh(eventId);
      return { ok: false, error: friendly(error) };
    }
  }

  // The callback engine reads advancement_method from the PROGRAM row (F2). Set it after the rounds, only on an unlocked draft,
  // and also when no round changed (a retry after a failed first attempt must still complete it).
  if (programAdvancement) {
    const { data: updated, error: advancementError } = await supabase
      .from("event_competition_programs")
      .update({ advancement_method: programAdvancement })
      .eq("id", programId)
      .eq("event_id", eventId)
      .eq("status", "draft")
      .is("profile_locked_at", null)
      .select("id");
    if (advancementError || !updated || updated.length !== 1) {
      refresh(eventId);
      return { ok: false, error: "The rounds were set up, but the competition could not be marked for callbacks. Apply the scoring setup again." };
    }
  }

  refresh(eventId);
  const changed = plans.filter((p) => p.ops.length > 0).length + (programAdvancement && plans.every((p) => p.ops.length === 0) ? 1 : 0);
  return { ok: true, message: changed === 0 ? "Scoring was already set up." : `Scoring set up for ${changed} division${changed === 1 ? "" : "s"}.` };
}
