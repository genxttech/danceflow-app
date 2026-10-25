/**
 * `studio_callback_tally@1` (scoring_method `callback_tally`): engine-spec-callback-tally.md, Stage 1 (X-1…X-7) and
 * Stage 2 (D-CT-1…10) approved by the owner 2026-10-24.
 *
 * Yes-only marks; every judge gives exactly T eligible callbacks across the whole round; tally = count of yes;
 * the T-th highest tally is the cutoff and every entry at or above it advances when the count fits the final's
 * configured heat capacity. Over capacity: advancement is blocked (`tie_over_capacity`), with no manager pick and no
 * runoff (that process is not specified). T >= eligible: everyone advances and the round is not danced.
 * Entries not called back get the label "Semi-final" and no placement. Nothing carries into the Final.
 *
 * Ballot format: callback_yes@1 (round scope, one boolean `true` per selected entry).
 * Not implemented (no approved spec): alternates, retire/inverted callbacks, per-role callbacks, runoff, UCWDC/NDCA/WSDC.
 */

import type { EngineResultRow } from "../contract";
import {
  checkPanelStructure,
  cmp,
  engineVersionIs1,
  orderedJudges,
  runEngine,
  sortedUnique,
  splitEntries,
  type ValidationLog,
} from "./common";
import type { EngineRun, ScoringEngine, StudioEngineInput, TraceRecord } from "./types";

export const CALLBACK_TALLY_SPEC = "engine-spec-callback-tally.md";
/** D-CT-6, wording as the owner gave it. */
export const NOT_CALLED_BACK_LABEL = "Semi-final";

export function runStudioCallbackTally(input: StudioEngineInput): EngineRun {
  return runEngine({ key: "callback_tally", specRef: CALLBACK_TALLY_SPEC }, input, (trace, v) => body(input, trace, v));
}

function body(input: StudioEngineInput, trace: TraceRecord[], v: ValidationLog): { rows: EngineResultRow[]; warnings: string[] } {
  const rule = CALLBACK_TALLY_SPEC;
  const NA = "COMP_ENGINE_NOT_AVAILABLE" as const;
  const UC = "COMP_ENGINE_UNSPECIFIED_CASE" as const;
  const INV = "COMP_ENGINE_INVALID_INPUT" as const;

  // V1, V2
  if (input.engineKey !== "callback_tally" || !engineVersionIs1(input.engineVersion)) {
    v.fail("V1", "engine key/version available", NA, "engine_not_available");
  }
  v.pass("V1", "engine key/version available");
  if (input.round.roundType !== "preliminary" || input.round.advancementMethod !== "promote_callback") {
    v.fail("V2", "round is a preliminary promote_callback round", UC, "round_not_callback", [input.round.id]);
  }
  v.pass("V2", "round is a preliminary promote_callback round");

  const { calculated, excluded, all } = splitEntries(input, v);
  const ordered = orderedJudges([...input.judges], v, "S3");
  const letterOf = new Map(ordered.map((j) => [j.officialId, j.letter]));
  const T = input.round.targetAdvancementCount;

  trace.push({
    step: "inputs",
    rule,
    data: {
      profile: input.profile,
      round: input.round,
      target: T,
      finalCapacity: input.context.finalCapacity ?? null,
      judges: ordered.map((j) => j.letter),
      entries: all,
      excluded: input.context.excludedEntries.map((e) => ({ entryId: e.entryId, reason: e.reason })).sort((a, b) => cmp(a.entryId, b.entryId)),
      marks: input.marks
        .map((m) => ({ judge: letterOf.get(m.officialId) ?? m.officialId, entryId: m.entryId, value: m.value }))
        .sort((a, b) => cmp(a.judge, b.judge) || cmp(a.entryId, b.entryId)),
    },
  });

  // V3 (D-CT-5): the organizer sets T before ballots open.
  if (T === null || T === undefined) v.fail("V3", "target advancement count is set", UC, "target_unset", [input.round.id]);
  if (typeof T !== "number" || !Number.isInteger(T) || T < 1) v.fail("V3", "target advancement count is a positive integer", UC, "target_invalid", [input.round.id]);
  v.pass("V3", "target advancement count is set");

  // V5 (D-CT-7, D-CT-1): by entry only, yes-only. No stored scheme is required for @1.
  const scheme = input.markScheme as Record<string, unknown> | null | undefined;
  if (scheme !== null && scheme !== undefined) {
    const ok =
      typeof scheme === "object" &&
      !Array.isArray(scheme) &&
      (scheme.scored_by === undefined || scheme.scored_by === "entry") &&
      (scheme.input === undefined || scheme.input === "callback_yes");
    if (!ok) v.fail("V5", "mark scheme is yes-only by entry", UC, "scheme_unspecified");
  }
  v.pass("V5", "mark scheme is yes-only by entry");
  const roleMarks = input.marks.filter((m) => m.role !== undefined && m.role !== null);
  if (roleMarks.length > 0) v.fail("V5a", "no per-role marks", UC, "role_marks_not_supported", roleMarks.map((m) => m.entryId));
  v.pass("V5a", "no per-role marks");

  // V14 (X-6)
  if (input.context.danceIds.length !== 1) {
    v.fail("V14", "exactly one dance per run (X-6)", UC, "multi_dance_unsupported", input.context.danceIds, { dances: input.context.danceIds.length });
  }
  v.pass("V14", "exactly one dance per run (X-6)");

  // X-5, then T >= eligible: everyone advances, the round is not danced, no ballots required (D-CT-5).
  const E = calculated.length;
  if (E === 0) v.fail("E", "at least one eligible entry", UC, "no_eligible_entries");
  v.pass("E", "at least one eligible entry");
  const warnings = excluded.length > 0 ? [`excluded_entries:${sortedUnique(excluded).join(",")}`] : [];

  if (T >= E) {
    v.skip("V6", "panel checks (round is not danced)");
    trace.push({ step: "cut", rule: `${rule} §5 step 4`, data: { target: T, eligible: E, outcome: "all_advance_not_danced" } });
    const rows: EngineResultRow[] = calculated.map((entryId) => ({ entryId, advanced: true, output: { not_danced: true } }));
    trace.push({ step: "result", rule: `${rule} §4`, data: { advanced: calculated, notAdvanced: [] } });
    if (input.marks.length > 0) warnings.push("marks_ignored_round_not_danced");
    return { rows, warnings };
  }

  // V6 (X-3, X-7)
  checkPanelStructure(input, ordered, v, { x3: "V6", x3Flags: "V6a", x7: "V6b", x6: "V14b" });

  // V7, V8, V9, V10 over all marks
  const panelIds = new Set(ordered.map((j) => j.officialId));
  const notOnPanel = input.marks.filter((m) => !panelIds.has(m.officialId));
  if (notOnPanel.length > 0) v.fail("V7", "marks come from panel officials", INV, "official_not_on_panel", notOnPanel.map((m) => m.officialId));
  v.pass("V7", "marks come from panel officials");

  const known = new Set(all);
  const notInRound = input.marks.filter((m) => !known.has(m.entryId));
  if (notInRound.length > 0) v.fail("V8", "marks are for entries of the round", INV, "entry_not_in_round", notInRound.map((m) => m.entryId));
  v.pass("V8", "marks are for entries of the round");

  const byJudge = new Map<string, Map<string, unknown>>();
  const dups: string[] = [];
  for (const m of input.marks) {
    const per = byJudge.get(m.officialId) ?? new Map<string, unknown>();
    if (per.has(m.entryId)) dups.push(m.entryId);
    per.set(m.entryId, m.value);
    byJudge.set(m.officialId, per);
  }
  if (dups.length > 0) v.fail("V9", "one mark per (judge, entry)", INV, "duplicate_mark", dups);
  v.pass("V9", "one mark per (judge, entry)");

  const badValue = input.marks.filter((m) => m.value !== true);
  if (badValue.length > 0) v.fail("V10", "marks are yes (true) only", INV, "mark_not_in_scheme", badValue.map((m) => m.entryId));
  v.pass("V10", "marks are yes (true) only");

  // V12 before V11: a judge with no ballot at all is the lock step's case (K0 O1).
  const noBallot = ordered.filter((j) => !byJudge.has(j.officialId));
  if (noBallot.length > 0) v.fail("V12", "every assigned judge has a ballot", UC, "judge_without_ballot", noBallot.map((j) => j.officialId));
  v.pass("V12", "every assigned judge has a ballot");

  // V11 / V13: exactly T yes marks on eligible entries per judge; marks on excluded entries are not counted.
  const eligible = new Set(calculated);
  const wrongCount = ordered.filter((j) => [...byJudge.get(j.officialId)!.keys()].filter((e) => eligible.has(e)).length !== T);
  if (wrongCount.length > 0) {
    v.fail("V11", "each judge selects exactly T eligible entries across the round", INV, "callback_count", wrongCount.map((j) => j.officialId), {
      target: T,
      counts: wrongCount.map((j) => ({ judge: j.letter, count: [...byJudge.get(j.officialId)!.keys()].filter((e) => eligible.has(e)).length })),
    });
  }
  v.pass("V11", "each judge selects exactly T eligible entries across the round");
  v.pass("V13", "scratched / no-show entries excluded and their marks not counted (X-5)");

  // ---- tally and cut ------------------------------------------------------------------------------------------
  const calledBy = new Map<string, string[]>();
  for (const e of calculated) calledBy.set(e, []);
  for (const j of ordered) for (const e of byJudge.get(j.officialId)!.keys()) if (eligible.has(e)) calledBy.get(e)!.push(j.letter);
  const tally = new Map(calculated.map((e) => [e, calledBy.get(e)!.length]));
  trace.push({ step: "tally", rule: `${rule} §5 step 6`, data: calculated.map((entryId) => ({ entryId, calledBackBy: calledBy.get(entryId), tally: tally.get(entryId) })) });

  const sorted = [...calculated].sort((a, b) => tally.get(b)! - tally.get(a)! || cmp(a, b));
  const position = new Map(calculated.map((e) => [e, 1 + calculated.filter((o) => tally.get(o)! > tally.get(e)!).length]));
  trace.push({ step: "order", rule: `${rule} §5 step 7`, data: sorted.map((entryId) => ({ entryId, tally: tally.get(entryId), position: position.get(entryId) })) });

  const cutTally = tally.get(sorted[T - 1])!;
  const above = sorted.filter((e) => tally.get(e)! >= cutTally);
  const tiedAtCut = sorted.filter((e) => tally.get(e) === cutTally);
  const cap = input.context.finalCapacity;
  const cutData = { target: T, eligible: E, cutTally, atOrAbove: above, finalCapacity: cap ?? null };

  if (above.length > T) {
    const capOk = typeof cap === "number" && Number.isInteger(cap) && cap >= 1;
    if (!capOk || above.length > cap) {
      trace.push({ step: "cut", rule: `${rule} §6`, data: { ...cutData, outcome: "blocked_tie_over_capacity", tiedAtCut } });
      // D-CT-4: no manager pick; blocked until a separately approved, auditable tie-break process exists. V15.
      v.fail("V15", "tie at the cutoff fits the final capacity", UC, "tie_over_capacity", tiedAtCut, { capacityMissing: !capOk, advancing: above.length, finalCapacity: cap ?? null });
    }
  }
  trace.push({ step: "cut", rule: `${rule} §6`, data: { ...cutData, outcome: above.length === T ? "exact_cut" : "advance_all_tied" } });

  const advancing = new Set(above);
  const rows: EngineResultRow[] = calculated.map((entryId) => {
    const adv = advancing.has(entryId);
    return {
      entryId,
      advanced: adv,
      output: { tally: tally.get(entryId), callback_rank: position.get(entryId), ...(adv ? {} : { label: NOT_CALLED_BACK_LABEL }) },
    };
  });
  trace.push({ step: "result", rule: `${rule} §4`, data: { advanced: [...advancing].sort(cmp), notAdvanced: calculated.filter((e) => !advancing.has(e)) } });
  return { rows, warnings };
}

export const studioCallbackTally: ScoringEngine = {
  key: "callback_tally",
  version: "1",
  specRef: CALLBACK_TALLY_SPEC,
  ballotFormat: { id: "callback_yes", version: 1 },
  run: runStudioCallbackTally,
};
