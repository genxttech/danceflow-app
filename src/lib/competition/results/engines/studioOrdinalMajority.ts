/**
 * `studio_ordinal_majority@1` (scoring_method `ordinal_majority`): engine-spec-ordinal-majority.md, Stage 1 (X-1…X-7)
 * and Stage 3 (D-OM-1…5, D-OM-3b) approved by the owner 2026-10-24.
 *
 * OM-A: for each place p, the smallest cutoff c >= p at which an unplaced entry has >= m judges marking it <= c
 * (m = floor(J/2)+1, strict majority). Several qualifiers are ordered by (1) more judges <= c, (2) lower sum of
 * the ordinals <= c, (3) still tied: shared placement, numbering skips (2, 2, 4).
 *
 * Ballot format: ordinal_rank@1 (a full 1…N ranking of one heat, each value once).
 * Not implemented (no approved spec): Skating System, NDCA, UCWDC, WSDC, medal marks, multi-heat combination.
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
  traceMarks,
  type ValidationLog,
} from "./common";
import type { EngineRun, ScoringEngine, StudioEngineInput, TraceRecord } from "./types";

export const ORDINAL_MAJORITY_SPEC = "engine-spec-ordinal-majority.md";

export function runStudioOrdinalMajority(input: StudioEngineInput): EngineRun {
  return runEngine({ key: "ordinal_majority", specRef: ORDINAL_MAJORITY_SPEC }, input, (trace, v) => body(input, trace, v));
}

function body(input: StudioEngineInput, trace: TraceRecord[], v: ValidationLog): { rows: EngineResultRow[]; warnings: string[] } {
  const rule = ORDINAL_MAJORITY_SPEC;
  const NA = "COMP_ENGINE_NOT_AVAILABLE" as const;
  const UC = "COMP_ENGINE_UNSPECIFIED_CASE" as const;
  const INV = "COMP_ENGINE_INVALID_INPUT" as const;

  // V1 and the round type are checked before anything else is read.
  if (input.engineKey !== "ordinal_majority" || !engineVersionIs1(input.engineVersion)) {
    v.fail("V1", "engine key/version available", NA, "engine_not_available");
  }
  v.pass("V1", "engine key/version available");
  if (input.round.roundType !== "final") v.fail("RT", "round type is final", UC, "round_type_not_final", [input.round.id]);
  v.pass("RT", "round type is final");

  const { calculated, excluded, all } = splitEntries(input, v);
  const ordered = orderedJudges([...input.judges], v, "S3");
  const letterOf = new Map(ordered.map((j) => [j.officialId, j.letter]));

  trace.push({
    step: "inputs",
    rule,
    data: {
      profile: input.profile,
      round: input.round,
      judges: ordered.map((j) => j.letter),
      entries: all,
      excluded: input.context.excludedEntries.map((e) => ({ entryId: e.entryId, reason: e.reason })).sort((a, b) => cmp(a.entryId, b.entryId)),
      marks: traceMarks(input, letterOf),
    },
  });

  // V2 mark scheme: none stored for @1 (engine default); a stored scheme must be placement_marks by entry, no ties.
  const scheme = input.markScheme as Record<string, unknown> | null | undefined;
  if (scheme !== null && scheme !== undefined) {
    const ok =
      typeof scheme === "object" &&
      !Array.isArray(scheme) &&
      scheme.input === "placement_marks" &&
      scheme.scored_by === "entry" &&
      scheme.ties_allowed !== true;
    if (!ok) v.fail("V2", "mark scheme is placement_marks by entry", INV, "scheme_mismatch");
  }
  v.pass("V2", "mark scheme is placement_marks by entry");

  // V3 / X-3 / V11 (X-7) / V12 (X-6). Structural checks run before the per-mark checks: a multi-heat round carries one
  // ballot per heat, which per-mark checks would misreport as incomplete ballots.
  checkPanelStructure(input, ordered, v, { x3: "V3", x3Flags: "V3a", x7: "V11", x6: "V12" });
  if (input.context.heats.length > 1) {
    // X-7 fixes the panel but not how rankings of different heats combine: NOT SPECIFIED, fail closed.
    v.fail("V11", "one heat per run (combination across heats not specified)", UC, "multi_heat_combination_unspecified", input.context.heats.map((h) => h.heatId));
  }

  const N = calculated.length;
  if (N === 0) v.fail("N", "at least one calculated entry", UC, "no_calculated_entries");
  v.pass("N", "at least one calculated entry");

  // Per-mark checks, phase by phase over all marks; offenders are collected per phase.
  const known = new Set(all);
  const panelIds = new Set(ordered.map((j) => j.officialId));

  const notOnPanel = input.marks.filter((m) => !panelIds.has(m.officialId));
  if (notOnPanel.length > 0) v.fail("V4", "marks come from panel officials", INV, "official_not_on_panel", notOnPanel.map((m) => m.officialId));
  v.pass("V4", "marks come from panel officials");

  const notInRound = input.marks.filter((m) => !known.has(m.entryId));
  if (notInRound.length > 0) v.fail("V5", "marks are for entries of the round", INV, "entry_not_in_round", notInRound.map((m) => m.entryId));
  v.pass("V5", "marks are for entries of the round");

  const roleMarks = input.marks.filter((m) => m.role !== undefined && m.role !== null);
  if (roleMarks.length > 0) v.fail("V5a", "no per-role marks (scored_by entry)", INV, "role_not_allowed", roleMarks.map((m) => m.entryId));
  v.pass("V5a", "no per-role marks (scored_by entry)");

  const byJudge = new Map<string, Map<string, unknown>>();
  const dups: string[] = [];
  for (const m of input.marks) {
    const per = byJudge.get(m.officialId) ?? new Map<string, unknown>();
    if (per.has(m.entryId)) dups.push(m.entryId);
    per.set(m.entryId, m.value);
    byJudge.set(m.officialId, per);
  }
  if (dups.length > 0) v.fail("V6", "one mark per (judge, entry)", INV, "duplicate_mark", dups);
  v.pass("V6", "one mark per (judge, entry)");

  // V10 before V7: a judge with no ballot at all is the lock step's case (K0 O1), not an incomplete ballot.
  const noBallot = ordered.filter((j) => !byJudge.has(j.officialId));
  if (noBallot.length > 0) v.fail("V10", "every assigned judge has a ballot", UC, "judge_without_ballot", noBallot.map((j) => j.officialId));
  v.pass("V10", "every assigned judge has a ballot");

  const incomplete = ordered.filter((j) => calculated.some((e) => !byJudge.get(j.officialId)!.has(e)));
  if (incomplete.length > 0) v.fail("V7", "every judge ranks every calculated entry", INV, "incomplete_ballot", incomplete.map((j) => j.officialId));
  v.pass("V7", "every judge ranks every calculated entry");

  // V8 over every mark of the ballot (a mark on an excluded entry counts: the ballot is then not a 1…N ranking).
  const outOfRange: string[] = [];
  for (const j of ordered) {
    for (const [entryId, value] of byJudge.get(j.officialId)!) {
      if (!(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= N)) outOfRange.push(entryId);
    }
  }
  if (outOfRange.length > 0) v.fail("V8", "marks are integers 1…N", INV, "mark_out_of_range", outOfRange);
  v.pass("V8", "marks are integers 1…N");

  const tied: string[] = [];
  for (const j of ordered) {
    const seen = new Map<number, string[]>();
    for (const [entryId, value] of byJudge.get(j.officialId)!) seen.set(value as number, [...(seen.get(value as number) ?? []), entryId]);
    for (const ids of seen.values()) if (ids.length > 1) tied.push(...ids);
  }
  if (tied.length > 0) v.fail("V9", "no equal marks on one ballot", INV, "judge_tie", tied);
  v.pass("V9", "no equal marks on one ballot");
  v.pass("V13", "scratched / no-show entries excluded before ranking (X-5)");
  v.pass("V14", "entries still tied after the chain share a placement (not a failure)");

  // ---- OM-A placement ---------------------------------------------------------------------------------------
  const J = ordered.length;
  const m = Math.floor(J / 2) + 1;
  const ordinals = new Map<string, number[]>();
  for (const e of calculated) ordinals.set(e, ordered.map((j) => byJudge.get(j.officialId)!.get(e) as number));

  const placements = new Map<string, { placement: number; tieGroup: string | null; cutoff: number; judgesAtCutoff: number; ordinalSum: number }>();
  let unplaced = [...calculated];
  let p = 1;
  while (unplaced.length > 0) {
    let chosen: { cutoff: number; qualifiers: Array<{ entryId: string; count: number; sum: number }> } | null = null;
    for (let c = p; c <= N; c++) {
      const counts = unplaced.map((entryId) => {
        const within = ordinals.get(entryId)!.filter((o) => o <= c);
        return { entryId, count: within.length, sum: within.reduce((a, b) => a + b, 0) };
      });
      trace.push({ step: "combine", rule: `${rule} §5 step 5`, data: { place: p, cutoff: c, majority: m, counts } });
      const qualifiers = counts.filter((x) => x.count >= m);
      if (qualifiers.length > 0) {
        chosen = { cutoff: c, qualifiers };
        break;
      }
    }
    // At cutoff N every judge marks every entry <= N, so a qualifier always exists (J >= m).
    if (!chosen) throw new Error("ordinal_majority: no qualifier found (unreachable for valid input)");

    const ranked = [...chosen.qualifiers].sort((a, b) => b.count - a.count || a.sum - b.sum || cmp(a.entryId, b.entryId));
    if (ranked.length > 1) {
      trace.push({
        step: "tie_break",
        rule: `${rule} §6`,
        data: {
          place: p,
          cutoff: chosen.cutoff,
          tied: ranked.map((x) => x.entryId),
          chain: [
            { step: 1, rule: "more judges <= cutoff", values: ranked.map((x) => ({ entryId: x.entryId, judges: x.count })) },
            { step: 2, rule: "lower sum of ordinals <= cutoff", values: ranked.map((x) => ({ entryId: x.entryId, sum: x.sum })) },
            { step: 3, rule: "share the placement" },
          ],
        },
      });
    }
    let pos = p;
    let i = 0;
    while (i < ranked.length) {
      let j = i + 1;
      while (j < ranked.length && ranked[j].count === ranked[i].count && ranked[j].sum === ranked[i].sum) j++;
      const group = ranked.slice(i, j);
      for (const q of group) {
        placements.set(q.entryId, {
          placement: pos,
          tieGroup: group.length > 1 ? `tie-${pos}` : null,
          cutoff: chosen.cutoff,
          judgesAtCutoff: q.count,
          ordinalSum: q.sum,
        });
      }
      pos += group.length;
      i = j;
    }
    const done = new Set(ranked.map((x) => x.entryId));
    unplaced = unplaced.filter((e) => !done.has(e));
    p = pos;
  }

  const rows: EngineResultRow[] = calculated.map((entryId) => {
    const r = placements.get(entryId)!;
    return {
      entryId,
      placement: r.placement,
      tieGroup: r.tieGroup,
      output: { cutoff: r.cutoff, judges_at_cutoff: r.judgesAtCutoff, ordinal_sum_at_cutoff: r.ordinalSum },
    };
  });
  trace.push({
    step: "result",
    rule: `${rule} §4`,
    data: { placements: rows.map((r) => ({ entryId: r.entryId, placement: r.placement, tieGroup: r.tieGroup })) },
  });

  const warnings = excluded.length > 0 ? [`excluded_entries:${sortedUnique(excluded).join(",")}`] : [];
  return { rows, warnings };
}

export const studioOrdinalMajority: ScoringEngine = {
  id: "studio_ordinal_majority@1",
  key: "ordinal_majority",
  version: "1",
  specRef: ORDINAL_MAJORITY_SPEC,
  ballotFormat: { id: "ordinal_rank", version: 1 },
  run: runStudioOrdinalMajority,
};
