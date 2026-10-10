import type { ScoringEngine, ScoringModel, SourceReference } from "./types";

/**
 * 10C.5: source-grounded REFERENCE descriptions of how the supplied governing-body documents score.
 *
 * These are not rules profiles. They cannot be selected, they generate nothing, and no engine named here
 * is implemented. They exist so the profile contract is proven able to represent each body without
 * flattening it, and so later sanctioned-profile work (10F/10I/10J) starts from cited facts. Where a
 * supplied source is silent, the description says so instead of filling the gap.
 */

export const NOT_SPECIFIED = "NOT SPECIFIED IN PROVIDED SOURCE";

export const SOURCES = {
  ucwdcScoring: { document: "UCWDC Scoring Format", edition: "2026 v16.9b" },
  ucwdcCouples: { document: "UCWDC Rules, Contest Procedures and Scoring Format — Couples", edition: "2026 (v1-26-2026)" },
  ucwdcProAm: { document: "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm", edition: "2026 (v1-26-2026)" },
  wsdc: { document: "WSDC Registry Event Rules", edition: "Version 2026.1C" },
  ndca: { document: "NDCA Rule Book", edition: "June 2026 (compiled)" },
} as const;

const ref = (source: keyof typeof SOURCES, section: string, page?: string, quote?: string): SourceReference => ({
  ...SOURCES[source],
  section,
  ...(page ? { page } : {}),
  ...(quote ? { quote } : {}),
});

/** Every engine key and whether DanceFlow implements it today. Nothing beyond "none" is implemented. */
export const SCORING_ENGINES: Record<ScoringEngine, { implemented: boolean; label: string }> = {
  none: { implemented: true, label: "No scoring" },
  studio_placeholder: { implemented: false, label: "Studio / Custom placeholder" },
  callback_tally: { implemented: false, label: "Callback tally" },
  relative_placement: { implemented: false, label: "Relative Placement" },
  majority_rules_medal: { implemented: false, label: "Majority Rules (medal marks)" },
  majority_rules_overall: { implemented: false, label: "Majority Rules overall / multi-dance" },
  skating_single: { implemented: false, label: "Skating System (single dance)" },
  skating_multi: { implemented: false, label: "Skating System (multi-dance)" },
  cumulative_points: { implemented: false, label: "Cumulative points" },
  proficiency_rating: { implemented: false, label: "Proficiency rating" },
};

export const UCWDC_REFERENCE: ScoringModel = {
  basis: "governing_body_reference",
  note: "UCWDC Majority Rules scoring. Prelims promote, semi-finals retire, finals use medal marks, overalls combine placements.",
  stages: [
    {
      key: "prelim",
      family: "advancement",
      round_types: ["preliminary", "quarterfinal"],
      direction: "promote",
      ballot: { input: "callback_yes_alternates", values: { yes: 10.0, alt1: 5.0, alt2: 4.6, alt3: 4.3, alt4: 4.1, alt5: 4.0 }, scored_by: "entry" },
      engine: { key: "callback_tally", status: "not_implemented", params: { cut: "set by the Contest Coordinator, plus ties", scope: "per dance at regionals; all dances together at the Country Dance World Championships" } },
      tie_break: { chain: ["ties at the cut advance"], sources: [ref("ucwdcScoring", "Rule #1.4")] },
      outputs: [{ type: "advancement_ranking", primary: true }],
      sources: [ref("ucwdcScoring", "Rule #1.2", "1-2"), ref("ucwdcScoring", "Rule #1.5", "2")],
    },
    {
      key: "semifinal",
      family: "advancement",
      round_types: ["semifinal"],
      direction: "retire",
      ballot: { input: "callback_retire", values: { no: 10.0 }, scored_by: "entry", note: "Judges mark the contestants to retire (inverted callback)." },
      engine: { key: "callback_tally", status: "not_implemented", params: { polarity: "retire" } },
      tie_break: { chain: [NOT_SPECIFIED] },
      outputs: [{ type: "advancement_ranking", primary: true }],
      sources: [ref("ucwdcScoring", "Rule #2.2", "2")],
    },
    {
      key: "final",
      family: "final",
      round_types: ["final"],
      ballot: {
        input: "medal_marks",
        scale: ["HM", "B", "S", "G", "GH", "GG"],
        values: { HM: 6, B: 5, S: 4, G: 3, GH: 2, GG: 1 },
        ties_allowed: false,
        scored_by: "entry",
        note: "Couples, Line, Teams, Spotlights and AllStars: Group and Rank within a medal. ProAm/ProPro use a 16-step +/star scale (HM=26 ... GG star=11) where ties are allowed (Rule #3.2).",
      },
      engine: { key: "majority_rules_medal", status: "not_implemented", params: { majority_mark: "middle mark; half+1 with an even panel" } },
      tie_break: {
        chain: ["R4 majority size", "R5 majority sum", "R6 look-ahead", "R7 look-behind", "R8 head-to-head", "shared tie announced at the higher place"],
        sources: [ref("ucwdcScoring", "Rules #4-#8", "3-4")],
      },
      outputs: [
        { type: "placement", primary: true },
        { type: "medal_threshold", primary: false, note: "ProAm/ProPro awards may announce only the medal threshold title." },
      ],
      sources: [ref("ucwdcScoring", "Preamble; Rules #3.1-#3.5", "1, 3")],
    },
    {
      key: "overall",
      family: "overall",
      round_types: ["final"],
      ballot: { input: "none", note: "Combines per-dance carry-forward placements; no new judge input." },
      engine: {
        key: "majority_rules_overall",
        status: "not_implemented",
        params: { carry_forward: "placement value; shared ties averaged", non_finalists: "finalists + rounds removed", ascension_weights: { waltz: 3, two_step: 3, solo_medley: 4 } },
      },
      tie_break: { chain: ["R10 head-to-head on placements", "R11 head-to-head on judges' marks (re-visits R10)", "shared tie"], sources: [ref("ucwdcScoring", "Rules #10-#11", "6-8")] },
      outputs: [{ type: "placement", primary: true }],
      sources: [ref("ucwdcScoring", "Rules #8.5-#9.2", "5-6")],
    },
  ],
  adjudication_stages: [
    { key: "disqualification", timing: "disqualification", description: "Disqualification from a division or dance category. No score penalty stage is specified in the scoring format.", sources: [ref("ucwdcCouples", "II.G.1.c; II.P.3.a", "5, 14")] },
  ],
  source_conflicts: [],
};

export const WSDC_REFERENCE: ScoringModel = {
  basis: "governing_body_reference",
  note: "Callback tally in preliminaries, Relative Placement in finals. Only the 2026.1C rules are used; the 2027 draft is not current behavior.",
  stages: [
    {
      key: "prelim",
      family: "advancement",
      round_types: ["preliminary", "quarterfinal", "semifinal"],
      direction: "promote",
      ballot: { input: "callback_yes_alternates", values: { yes: 10, alt1: 4.5, alt2: 4.3, alt3: 4.2, no: 0 }, scored_by: "role", note: "Leaders and followers are scored separately; at most three alternate levels." },
      engine: { key: "callback_tally", status: "not_implemented", params: { outcome: "sum of the values" } },
      tie_break: {
        chain: ["Chief Judge's unique raw scores, only after the original calculation"],
        note: "Applies to preliminary callbacks only; the source does not extend it to finals.",
        sources: [ref("wsdc", "Section 5", "23", "Only after the original calculations are complete, the Chief Judge's scores break the tie."), ref("wsdc", "3.4.9.c", "20")],
      },
      outputs: [{ type: "advancement_ranking", primary: true }],
      sources: [ref("wsdc", "Section 5", "22-23")],
    },
    {
      key: "final",
      family: "final",
      round_types: ["final"],
      ballot: { input: "raw_score", scored_by: "entry", note: "The ballot format is NOT SPECIFIED IN PROVIDED SOURCE (the rules refer to the WSDC website)." },
      engine: { key: "relative_placement", status: "not_implemented", params: { definition: "WSDC website (off-document)" } },
      tie_break: { chain: [NOT_SPECIFIED] },
      outputs: [
        { type: "placement", primary: true },
        { type: "registry_points", primary: false, note: "Per role and tier." },
      ],
      sources: [ref("wsdc", "3.4.9; 3.4.9.d", "20"), ref("wsdc", "3.2.9; 3.3.1", "14, 17")],
    },
  ],
  adjudication_stages: [],
  source_conflicts: [],
};

export const NDCA_REFERENCE: ScoringModel = {
  basis: "governing_body_reference",
  note: "Skating System required. The supplied rulebook references but does not define the Skating algorithm; 10F needs an authoritative Skating specification.",
  stages: [
    {
      key: "prelim",
      family: "advancement",
      round_types: ["preliminary", "quarterfinal", "semifinal"],
      direction: "promote",
      ballot: { input: "recall_marks", scored_by: "entry", note: "Ballot format otherwise NOT SPECIFIED IN PROVIDED SOURCE." },
      engine: { key: "callback_tally", status: "not_implemented", params: { minimum_recall: "at least 50%", multi_dance: "accumulated marks of all dances, except nine- and ten-dance events", repechage: false } },
      tie_break: { chain: ["ties may advance"], sources: [ref("ndca", "IV.C.1.f", "27")] },
      outputs: [{ type: "advancement_ranking", primary: true }],
      sources: [ref("ndca", "IV.C.1.a", "27"), ref("ndca", "III.D.44", "24")],
    },
    {
      key: "final",
      family: "final",
      round_types: ["final"],
      ballot: { input: "placement_marks", scored_by: "entry" },
      engine: { key: "skating_single", status: "not_implemented", params: { specification: "authoritative Skating System specification required (not defined in the rulebook)" } },
      tie_break: { chain: [NOT_SPECIFIED] },
      outputs: [{ type: "placement", primary: true }],
      sources: [ref("ndca", "III.D.11", "21")],
    },
    {
      key: "overall",
      family: "overall",
      round_types: ["final"],
      ballot: { input: "none" },
      engine: { key: "skating_multi", status: "not_implemented", params: { ten_dance: "all ten dances together; non-finalists by semi-final callbacks" } },
      tie_break: { chain: [NOT_SPECIFIED] },
      outputs: [{ type: "placement", primary: true, label: "Raw Skating result before penalties" }],
      sources: [ref("ndca", "III.D.36", "23"), ref("ndca", "III.C.3.b(1)(d)", "17")],
    },
  ],
  adjudication_stages: [
    { key: "recall_erasure", timing: "ballot_or_recall_alteration", description: "Repeat infringement: all recalls or marks for that dance erased.", sources: [ref("ndca", "III.D.3.a", "20")] },
    { key: "final_markdown", timing: "per_dance_final_adjustment", description: "In a final: marked down one or more places, or placed last, in that dance.", sources: [ref("ndca", "III.D.3.a", "20"), ref("ndca", "IX.A.1.g(3)(e)", "40")] },
    {
      key: "multi_dance_adjustment",
      timing: "post_multi_dance_adjustment",
      description: "Multi-dance: compute the raw Skating result, then adjust it to reflect penalties (penalty-adjusted result).",
      sources: [ref("ndca", "III.C.3.b(1)(d)", "17", "perform all calculations ... and then adjust the result to reflect any penalties")],
    },
    { key: "showdance_position", timing: "post_result_adjustment", description: "Showdance: loss of one position in the final placements.", sources: [ref("ndca", "XI.B.11", "47")] },
  ],
  source_conflicts: [
    {
      key: "ndca_formation_scoring",
      description: "Formation teams: one section allows a cumulative point system; another requires the Skating System. Needs NDCA-profile research before any NDCA profile can be activated.",
      references: [
        ref("ndca", "III.D.11", "21", "with the exception of Formation Teams and Team Matches, which may be judged on a cumulative point system"),
        ref("ndca", "XII.N.3", "52", "The Skating System of Scrutineering must be used"),
      ],
      status: "unresolved",
      material: true,
    },
  ],
};

export const GOVERNING_BODY_REFERENCES = { ucwdc: UCWDC_REFERENCE, wsdc: WSDC_REFERENCE, ndca: NDCA_REFERENCE } as const;

/** A sanctioned profile may only be activated when none of its material source conflicts are unresolved. */
export function blockingConflicts(model: ScoringModel) {
  return model.source_conflicts.filter((conflict) => conflict.material && conflict.status === "unresolved");
}
