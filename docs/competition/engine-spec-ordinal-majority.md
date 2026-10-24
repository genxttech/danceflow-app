# Engine spec — `ordinal_majority` (Studio v1, K1)

Status: **DRAFT for owner approval** · Baseline: origin/main `973f36da` · Docs only (no code, no SQL). **Stage 1 (X-1…X-7) and Stage 3 (D-OM-1…5, D-OM-3b) APPROVED by the owner 2026-10-24. Engine code stays blocked until Stage 4 (proficiency rating) is also recorded.**

Scoring architecture (five independent dimensions, S4-1…S4-7) is recorded in `scoring-architecture-decisions.md`; Stages 1–3 apply to the Studio methods only.

Engine version on approval: `ordinal_majority@1`. No engine code may be written until the owner signs off this
spec and the decisions in §10 (owner decision 2026-10-23: engines are specified first, approved, then built).

Sibling specs: [engine-spec-proficiency-rating.md](engine-spec-proficiency-rating.md),
[engine-spec-callback-tally.md](engine-spec-callback-tally.md). The engine boundary (input/output envelope,
hashing, round state machine) is owned by the K0 scoring-to-results contract
(`docs/competition/scoring-results-contract.md`, draft on branch `competition-k0-results-contract`, not yet on
main). This spec aligns to that draft and does not redefine it.

## 0. How to read this spec

- Every rule cites a source key from §1. A rule with no approved source is written **NOT SPECIFIED IN PROVIDED
  SOURCE** and points to an owner decision (`D-OM-n`, or a cross-cutting `X-n` shared by all three specs).
- Where a decision is open, the spec lists **candidate options** so the owner can choose. Candidates are not rules,
  are not taken from any governing body, and carry no recommendation: the brief forbids filling gaps from general
  knowledge of the Skating System, Relative Placement or UCWDC Majority Rules, and this engine is explicitly *not*
  any of them (S6).
- Until a decision is made, the engine behaviour for that case is **fail closed** (X-2): no result, a trace entry,
  error `COMP_ENGINE_UNSPECIFIED_CASE`.

## 1. Approved basis (citation keys)

| Key | Source | What it establishes |
|---|---|---|
| S1 | Roadmap Phase 10 §LOCKED DECISIONS, "Studio v1 scoring defaults" (`DanceFlow_Master_Roadmap.md` l.1029) | `ordinal_majority` is the engine for placement contests; final-only unless entry volume requires a preliminary; v1 engines are exactly `ordinal_majority`, `proficiency_rating`, `callback_tally` |
| S2 | Roadmap Phase 10 §ARCHITECTURE, "Integrity" (l.930) | ballots immutable, corrections are new versions; engines deterministic and versioned; calculation preserves trace/evidence; finalized results never silently overwritten |
| S3 | Roadmap Phase 10 §ARCHITECTURE, "Rules/version lock" (l.927) | at publish the program locks profile key+version, engine version and a configuration snapshot; later rule changes never change locked competitions |
| S4 | Roadmap Phase 10 §LOCKED DECISIONS, "Judge access (studio v1)" (l.1028) | judges use authenticated accounts (web ballots); a scorer may enter paper ballots |
| S5 | Roadmap Phase 10 §REMAINING STUDIO v1 MILESTONES #2 (l.988) | 10F delivers the three engines plus calculate / review / approve / publish |
| S6 | `studio_simple@3` `judging.placements` (`src/lib/competition/setup/studioCustomV3.ts`, seeded by `20261114090000_phase10c5_profile_v3.sql`) | label "Placements"; description "Judges rank the dancers in each division and the best-ranked dancer places first."; ballot `input: placement_marks`, `scored_by: entry`; output `placement` (primary); tie-break chain **empty** ("no tie-break rules are implemented yet"); note "It is not NDCA Skating or WSDC Relative Placement."; storage engine `ordinal_majority@1`; one round `final` / "Final" / `scoring_method: ordinal_majority`; `competition_mode: relative` |
| S7 | `studio_simple@1` `judging.placements` and `judging.callbacks` (`src/lib/competition/simple/studioSimpleV1.ts`, seeded by `20261108090000`) | same Placements description; the "Callbacks + Final" option scores its Final with `ordinal_majority` |
| S8 | 10C.5 doc §"Scoring metadata: stages, not one method" (`phase10c5-competition-setup-wizard.md`) and `types.ts` `MarkScheme` / `EngineBinding` | values and scales are profile parameters, never engine constants; `ties_allowed` is a MarkScheme field; tie-break chain is per stage |
| S9 | 10C.5 doc §"Adjudication, feedback and the official result are separate" | feedback grades/scores never become a placement or official result; Non-Adjudicated produces no result |
| S10 | Source registry §"Rules for using a source", rules 2 and 4 (`governing-body-source-registry.md`) | silent source → `NOT SPECIFIED IN PROVIDED SOURCE`; Studio conveniences are never presented as governing-body rules |
| S11 | `scoringReference.ts` header | governing-body reference descriptions are not profiles and no engine in them is implemented; they are not inputs to Studio engines |
| S12 | `20260620_competition_foundation_v1.sql` (rounds, heats) and `20261108090000` (scoring_method checks) | the round is per division with `round_type`, `status`, `target_advancement_count`; a round has many heats; `ordinal_majority` is an allowed `scoring_method` |
| K0 | Scoring-to-results contract draft §5 "Engine boundary" (unmerged; alignment only, not an approved decision) | pure TS engine, `EngineInput` / `EngineOutput`, canonical JSON hashing, `COMP_ENGINE_NOT_AVAILABLE`, `COMP_ENGINE_UNSPECIFIED_CASE` |

## 2. Scope

| Item | Rule | Basis |
|---|---|---|
| Purpose | Produce placements for an Adjudicated placement contest | S1, S6 |
| Round types | `final` (Placements, S6/S7) — including the Final that follows a callback round (S7) | S6, S7 |
| Other round types (`preliminary`, `semifinal`, …) | Not an `ordinal_majority` round in any approved profile → `COMP_ENGINE_UNSPECIFIED_CASE` | S6, S7 |
| Profiles | `studio_simple@1` and `@3` programs whose round `scoring_method = ordinal_majority` | S6, S7, S12 |
| Not this engine | Medal Marks (`studio_placeholder`, Studio input `medal_marks`); UCWDC Majority Rules; NDCA Skating; WSDC Relative Placement; Non-Adjudicated | S6 note, S8, S9, S11 |
| Multi-Dance overall | Out of v1 (Multi-Dance registration hold) | 10C.5 §NDCA Multi-Dance |

## 3. Inputs

The engine receives the K0 `EngineInput` envelope for one round. Fields this engine reads:

| Field | Shape | Basis |
|---|---|---|
| `engine_key`, `engine_version` | `"ordinal_majority"`, `1` | S2, S3 |
| `profile` | `{key, version}` from the program lock | S3 |
| `round` | `{id, round_type, target_advancement_count, advancement_method}` | S12 |
| `mark_scheme` | locked `MarkScheme` of the final stage: `{input: "placement_marks", scored_by: "entry", ties_allowed?}` | S6, S8 |
| `tie_break_chain` | locked stage `tie_break.chain` (empty in `@3`) | S6 |
| `entries[]` | `{entry_id}` — the entries danced in the round | K0 |
| `judges[]` | `{official_id, letter}` — the panel | S4, K0 |
| `marks[]` | `{official_id, entry_id, value}`; `value` is the judge's placement mark (ordinal) for that entry | S6 ("judges rank the dancers") |

**Ballot shape per judge.** One current ballot per judge (superseded versions are never input, S2). The ballot
ranks the entries of the round: `value` is a positive integer, 1 = best (S6: "the best-ranked dancer places first").

| Ballot property | Rule | Basis |
|---|---|---|
| Mark per entry | Exactly one mark per calculated entry per judge: a **full 1…N ranking, each value once** | **D-OM-5**, approved 2026-10-24 |
| Range | 1 … N where N = number of calculated entries in the round (scratched and no-show entries excluded, X-5) | D-OM-5, approved |
| Equal marks on one ballot (judge ties) | Not allowed; the ballot blocks it and the engine rejects it (`judge_tie`) | **D-OM-4**, approved 2026-10-24 |
| Per role marks | `scored_by: entry` only | S6 |
| Feedback grades/scores | Never engine input | S9 |

## 4. Outputs

K0 `EngineOutput` `rows[]`, one per entry:

| Field | Meaning | Basis |
|---|---|---|
| `placement` | integer ≥ 1, 1 = first | S6 (output `placement`, primary) |
| `tie_group` | set for entries that share a placement after chain step (3) (D-OM-3, approved 2026-10-24); otherwise not set | D-OM-3 |
| `advanced` | not set (a Final has no advancement; `advancement_method: none`) | S6 |
| `rating_band` | not set | S6 |
| `output` | per-entry working (e.g. counts per cutoff, or totals — per D-OM-1), copied from the trace | S2 |

Placements are 1…N and unique except for shared placements; after a shared placement the numbering skips (2, 2, 4) (D-OM-3b, approved 2026-10-24). What the published result shows
(placement only, or the marks too) is an F3 publication decision, not an engine output.

## 5. Algorithm

Stage 3 (owner, 2026-10-24) approved D-OM-1…5, so every step below is fixed. The locked key name says the engine
works on *ordinals* with a *majority* (S1), and the profile says "the best-ranked dancer places first" (S6); the
computation is the owner-approved OM-A rule with strict majority.

1. **Check engine availability.** `engine_key = ordinal_majority` and `engine_version = 1` with this spec
   approved; otherwise `COMP_ENGINE_NOT_AVAILABLE` (K0, S5).
2. **Check round type** is `final` (§2); otherwise `COMP_ENGINE_UNSPECIFIED_CASE`.
3. **Validate input** against §7 in the listed order; the first failure stops the calculation (no partial result).
4. **Build the mark table** `M[judge][entry] = ordinal`, judges ordered by `letter`, entries by `entry_id`
   (determinism, §7).
5. **Place entries (OM-A, D-OM-1 and D-OM-2).** Let `J` = number of judges and `m = floor(J/2) + 1` (strict
   majority). Let `N` = number of calculated entries (scratched and no-show entries are excluded, X-5). For each
   place `p = 1, 2, …` in turn, among the unplaced entries, find the smallest cutoff `c ≥ p` at which at least one
   unplaced entry has `≥ m` judges marking it `≤ c`. The entries that qualify at that cutoff `c` are the *qualifiers*.
   - If exactly one entry qualifies, it takes place `p`.
   - If several qualify at the same cutoff, apply the tie-break chain (§6) to order them; the ordered entries take
     places `p, p+1, …`, except that entries still tied after the whole chain share a placement (§6 step 3).
   Continue with the next unplaced place until every entry is placed.
6. **Shared placements (D-OM-3, D-OM-3b).** Entries sharing a placement get the same `placement` and a common
   `tie_group`. The next placement number skips the places the group used: a two-way tie for 2nd is numbered
   2, 2, then 4.
7. **Emit rows** (§4) and the trace (§8).
8. **Never** read the clock, the database, a random source, entry names, studio names or entry numbers
   (S2 deterministic; K0).

## 6. Tie-break chain

| Step | Rule (applies when several unplaced entries qualify at the same cutoff `c`) | Basis |
|---|---|---|
| (1) | The entry with **more** judges marking it `≤ c` places higher | D-OM-3, approved 2026-10-24 |
| (2) | If still tied, the entry with the **lower sum** of those of its ordinals that are `≤ c` places higher | D-OM-3, approved 2026-10-24 |
| (3) | If still tied, the entries **share the placement** (`tie_group`); numbering then skips (2, 2, 4) | D-OM-3 / D-OM-3b, approved 2026-10-24 |
| Excluded | Random draw, coin toss, entry number, registration time, name order: none is deterministic from the ballots, so none may decide a placement | S2 (deterministic) |
| Excluded | UCWDC Rules #4–#8, NDCA Skating rules, WSDC Chief Judge tie-break — governing-body rules, not Studio rules | S10 rule 4, S11 |

The owner adopted steps (1)–(3) as **DanceFlow Studio rules**. They resemble steps of the Skating System, but
DanceFlow makes **no Skating System, NDCA or UCWDC compliance claim**. The chain is the same for every program using
`ordinal_majority@1`; it is engine `@1` default behavior (X-1 option (a)), and the `@3` profile's empty
`tie_break.chain` is not read for this engine. A different chain ships as `ordinal_majority@2`.

## 7. Invalid-input handling

Checked in this order; the first failure stops the calculation. No partial result is ever written (S2). Error
codes below are the proposed `reason` values under one engine error `COMP_ENGINE_INVALID_INPUT` (naming to be
mirrored by the K0 contract owner; this spec does not edit `contract.ts`).

| # | Condition | Result | Basis |
|---|---|---|---|
| V1 | Engine key/version unknown or spec not approved | `COMP_ENGINE_NOT_AVAILABLE` | K0, S5 |
| V2 | `mark_scheme.input ≠ placement_marks` or `scored_by ≠ entry` | invalid `scheme_mismatch` | S6 |
| V3 | Fewer than 3 judges, or an even panel size | `COMP_ENGINE_UNSPECIFIED_CASE` (**X-3**, approved 2026-10-24) | X-3 |
| V4 | A mark from an official not in `judges[]` | invalid `official_not_on_panel` | S4, K0 §9 #2 |
| V5 | A mark for an entry not in `entries[]` | invalid `entry_not_in_round` | K0 §9 #3 |
| V6 | More than one mark for the same (judge, entry) | invalid `duplicate_mark` | S2 (one current ballot) |
| V7 | A judge does not rank every calculated entry (full ranking required, **D-OM-5** approved 2026-10-24) | invalid `incomplete_ballot` | D-OM-5 |
| V8 | Mark not an integer, < 1 or > N (each value 1…N used once) | invalid `mark_out_of_range` | D-OM-5 |
| V9 | Two entries share an ordinal on one ballot (**D-OM-4** approved 2026-10-24: not allowed) | invalid `judge_tie` | D-OM-4 |
| V10 | An assigned judge has no ballot at all | handled before the engine by the lock step (K0 O1); if it reaches the engine: `COMP_ENGINE_UNSPECIFIED_CASE` | K0 O1 |
| V11 | Heats of the round do not all have the same panel | `COMP_ENGINE_UNSPECIFIED_CASE` (**X-7**, approved 2026-10-24). How rankings in different heats of one round combine is not covered by X-7 and stays NOT SPECIFIED (fail closed) | X-7 |
| V12 | Input spans more than one dance | The engine is run once per dance (**X-6**, approved 2026-10-24); a combined result across dances is not supported and fails closed (`COMP_ENGINE_UNSPECIFIED_CASE`) | X-6 |
| V13 | A scratched / no-show entry (10D) is in `entries[]` | Excluded from the calculation before ranking and recorded in the trace (**X-5**, approved 2026-10-24); never placed last. A ballot that still ranks an excluded entry is no longer a full 1…N ranking (D-OM-5, approved), so V7/V8 reject it until a corrected ballot version is entered | X-5 |
| V14 | Entries still tied after chain step (3) | Not a failure: they share the placement (`tie_group`) per **D-OM-3** | D-OM-3 |

## 8. Determinism and trace

| Requirement | Basis |
|---|---|
| Same `EngineInput` → byte-identical `EngineOutput` and trace; no clock, network, database or randomness | S2, K0 §5 |
| Iteration order fixed: judges by `letter`, entries by `entry_id`, marks by `(official_id, entry_id)` | K0 §5 canonical JSON |
| Engine version is part of the output; any behaviour change ships as `ordinal_majority@2`, never as an edit to `@1`, and locked programs keep their version | S2, S3 |
| `input_hash` and `trace_hash` are computed by the server per K0; the engine returns the trace only | K0 §5 |

**Trace content** (every step is a record `{step, rule, data}` where `rule` names the section of this spec):

1. `engine` — key, version, spec reference (`engine-spec-ordinal-majority.md` at the approving commit).
2. `inputs` — profile key/version, round id/type, judge letters, entry ids, the full mark table.
3. `validation` — each check V1…V14 with pass/fail.
4. `combine` — per place `p`: for each unplaced entry and each cutoff `c`, the count of judges marking it `≤ c` against `m`, and the qualifiers at the chosen cutoff (for example per entry, per cutoff, the count of judges `≤ c`).
   of judges `≤ c`; or per entry, the ordinal total).
5. `tie_break` — every invocation: tied entries, the chain position applied, its working, its outcome.
6. `result` — final placements (`tie_group` for shared placements, with the skipped numbering).
7. On failure: `failure` — the code, reason and the offending ids. No `result` record.

## 9. Worked examples (golden-fixture candidates)

Judges are J1, J2, J3 (J4 when four). Entries are 11, 12, 13, 14. A cell is the judge's ordinal for the entry.
"All options" means every candidate in D-OM-1 gives the same answer. A fixture becomes golden only after the owner
decides the referenced decisions; its expected output is then frozen with the spec.

**F-OM-01 — unanimous.**

| Entry | J1 | J2 | J3 |
|---|---|---|---|
| 11 | 1 | 1 | 1 |
| 12 | 2 | 2 | 2 |
| 13 | 3 | 3 | 3 |
| 14 | 4 | 4 | 4 |

Expected (all options): 11 → 1, 12 → 2, 13 → 3, 14 → 4. Directly satisfies S6.

**F-OM-02 — majority at the lowest cutoff (OM-A).** `J = 3`, `m = 2`.

| Entry | J1 | J2 | J3 |
|---|---|---|---|
| 11 | 1 | 1 | 4 |
| 12 | 2 | 2 | 1 |
| 13 | 3 | 3 | 2 |
| 14 | 4 | 4 | 3 |

- Place 1, cutoff 1: 11 has 2 judges ≤ 1 (J1, J2); 12 has 1; 13, 14 have 0 → 11 alone qualifies → **1st**.
- Place 2, cutoff 2: 12 has 3 (2, 2, 1); 13 has 1 (J3's 2); 14 has 0 → 12 alone → **2nd**.
- Place 3, cutoff 3: 13 has 3 (3, 3, 2); 14 has 1 (J3's 3) → 13 alone → **3rd**. Place 4, cutoff 4: 14 has 3 → **4th**.
- Expected: **11 → 1, 12 → 2, 13 → 3, 14 → 4.** A lowest-total ordering (totals 12 = 5, 11 = 6) would put 12 first;
  that rule (OM-B) is not adopted.

**F-OM-03 — circular preferences (full tie).** `J = 3`, `m = 2`.

| Entry | J1 | J2 | J3 |
|---|---|---|---|
| 11 | 1 | 3 | 2 |
| 12 | 2 | 1 | 3 |
| 13 | 3 | 2 | 1 |

- Place 1, cutoff 1: each entry has 1 judge ≤ 1 (< 2) → none.
- Cutoff 2: 11 has 2 (J1's 1, J3's 2); 12 has 2 (J1's 2, J2's 1); 13 has 2 (J2's 2, J3's 1) → all three qualify.
- Chain (1): 2, 2, 2 → tied. Chain (2): sums of ordinals ≤ 2: 11 = 1+2 = 3; 12 = 2+1 = 3; 13 = 2+1 = 3 → tied.
- Chain (3): the three entries share the placement.
- Expected: **11 → 1, 12 → 1, 13 → 1** (one `tie_group`).

**F-OM-04 — four judges (reachable only through X-4 panel reduction; see note).** `J = 4`, `m = floor(4/2) + 1 = 3`.

| Entry | J1 | J2 | J3 | J4 |
|---|---|---|---|---|
| 11 | 1 | 1 | 2 | 3 |
| 12 | 2 | 2 | 1 | 1 |
| 13 | 3 | 3 | 3 | 2 |

- Place 1, cutoff 1: 11 has 2 (J1, J2); 12 has 2 (J3, J4); 13 has 0 → none reaches 3.
- Cutoff 2: 11 has 3 (1, 1, 2); 12 has 4 (2, 2, 1, 1); 13 has 1 (J4's 2) → 11 and 12 qualify.
- Chain (1): 12 has 4 judges ≤ 2, 11 has 3 → **12 places higher.** Ordered: 12 → place 1, 11 → place 2.
- Place 3, cutoff 3: 13 has 4 (3, 3, 3, 2) ≥ 3 → **3rd**.
- Expected: **12 → 1, 11 → 2, 13 → 3.**
- Note: X-3 (approved) requires an odd panel of at least 3, and X-4 requires a reduced panel to satisfy X-3, so an
  even panel is not accepted input today. This fixture records the arithmetic for `m = 3` as the owner asked; the
  engine would refuse the input (V3) unless the owner relaxes X-3/X-4. The conflict between "only reachable through
  X-4 reduction" and X-3 is raised with the coordinator.

**F-OM-05 — one entry.** One entry 11, J1–J3 all mark 1 (a full ranking of one entry, D-OM-5). `m = 2`. Place 1,
cutoff 1: 11 has 3 judges ≥ 2 → **11 → 1.** Whether a one-entry final is awarded is a results/awards question, not
an engine one.

**F-OM-06 — one judge.** J1 marks 11 = 1, 12 = 2, 13 = 3. Expected: `COMP_ENGINE_UNSPECIFIED_CASE` (V3): X-3 (approved) requires at least 3 judges and an odd panel.

**F-OM-07 — invalid inputs** (each starts from F-OM-01 with one change):

| Case | Change | Expected |
|---|---|---|
| a | J2 marks 11 = 1 and 12 = 1 | `judge_tie` (V9, D-OM-4 approved) |
| b | J3 has no mark for 14 | `incomplete_ballot` (V7, D-OM-5 approved) |
| c | J1 marks 14 = 5 (4 entries) / 0 / 2.5 | `mark_out_of_range` (V8, D-OM-5 approved) |
| d | A mark for entry 99 not in the round | `entry_not_in_round` (V5) |
| e | A mark from official J9 not on the panel | `official_not_on_panel` (V4) |
| f | J1 appears twice for entry 11 | `duplicate_mark` (V6) |
| g | `mark_scheme.input = medal_marks` | `scheme_mismatch` (V2) |
| h | Heats 1 and 2 have different panels | `COMP_ENGINE_UNSPECIFIED_CASE` (V11, X-7 approved). Same panel in both heats: how rankings combine is not specified (fail closed) |
| i | Entry 14 is marked scratched in 10D | Excluded before ranking, noted in the trace (V13, X-5 approved); J1–J3 ballots that still rank 14 are no longer a full 1…3 ranking, so V7/V8 reject them until corrected by a new ballot version (the engine never renumbers) |

**F-OM-08 — determinism.** F-OM-02 input with the `marks[]` array shuffled → identical output and trace hash.

**F-OM-09 — shared placement skips the number.** `J = 3`, `m = 2`.

| Entry | J1 | J2 | J3 |
|---|---|---|---|
| 11 | 1 | 2 | 4 |
| 12 | 2 | 1 | 3 |
| 13 | 3 | 3 | 1 |
| 14 | 4 | 4 | 2 |

- Cutoff 1: 11, 12, 13 have 1 judge each; 14 has 0 → none. Cutoff 2: 11 has 2 (J1's 1, J2's 2); 12 has 2 (J1's 2,
  J2's 1); 13 has 1; 14 has 1 → 11 and 12 qualify.
- Chain (1): 2 and 2 → tied. Chain (2): sums of ordinals ≤ 2: 11 = 1+2 = 3; 12 = 2+1 = 3 → tied. Chain (3): share.
- 11 and 12 share 1st (they used places 1 and 2). Place 3, cutoff 3: 13 has 3 (3, 3, 1) ≥ 2; 14 has 1 → 13 **3rd**;
  14 **4th**.
- Expected: **11 → 1, 12 → 1, 13 → 3, 14 → 4** (the same skip rule gives 2, 2, 4 for a tie at 2nd).

**F-OM-10 — chain step (2) decides.** `J = 3`, `m = 2`.

| Entry | J1 | J2 | J3 |
|---|---|---|---|
| 11 | 1 | 2 | 3 |
| 12 | 2 | 3 | 2 |
| 13 | 3 | 4 | 1 |
| 14 | 4 | 1 | 4 |

- Cutoff 1: 11 has 1 (J1); 12 has 0; 13 has 1 (J3); 14 has 1 (J2) → none.
- Cutoff 2: 11 has 2 (1, 2); 12 has 2 (J1's 2, J3's 2); 13 has 1; 14 has 1 → 11 and 12 qualify.
- Chain (1): 2 and 2 → tied. Chain (2): 11 = 1+2 = 3; 12 = 2+2 = 4 → **11 places higher.** 11 → place 1, 12 → place 2.
- Place 3, cutoff 3: 13 has 2 (J1's 3, J3's 1); 14 has 1 → 13 **3rd**; 14 **4th**.
- Expected: **11 → 1, 12 → 2, 13 → 3, 14 → 4.**

## 10. Owner decisions needed

Engine-specific:

| ID | Question | Candidates (no recommendation, see §0) | Until decided |
|---|---|---|---|
| D-OM-1 | How are judges' ordinals combined into placements? | **APPROVED 2026-10-24 (Stage 3): OM-A**, majority at the lowest cutoff, exactly as §5 defines it. OM-B (lowest ordinal total) is not adopted. | Rule (approved) |
| D-OM-2 | What is a "majority"? | **APPROVED 2026-10-24: strict majority**, `m = floor(J/2) + 1` (more than half of the judges). | Rule (approved) |
| D-OM-3 | Tie-break chain, and what happens when it is exhausted | **APPROVED 2026-10-24** (adopted as DanceFlow Studio rules, §6): (1) more judges marking the entry ≤ c; (2) lower sum of its ordinals ≤ c; (3) share the placement (`tie_group`). **D-OM-3b:** after a shared placement the numbering skips (2, 2, 4). | Rule (approved) |
| D-OM-4 | May a judge give two entries the same ordinal? | **APPROVED 2026-10-24: no.** The ballot blocks it; the engine rejects it (`judge_tie`). | Rule (approved) |
| D-OM-5 | Must every judge rank every entry, 1…N, each value once? | **APPROVED 2026-10-24: yes**, a full ranking is required. | Rule (approved) |

Cross-cutting X-1…X-7 (same IDs in all three specs): **APPROVED by the owner 2026-10-24 ("Approve K1 Stage 1 (X-1..X-7) as recommended")**. D-OM items: see the table above (Stage 3, approved).

| ID | Rule | Status |
|---|---|---|
| X-1 | **APPROVED 2026-10-24: option (a).** Programs locked to `@1`/`@3` are scored with the profile metadata plus the engine `@1` defaults written in this spec. No `@4` re-creation is required. | Rule (approved) |
| X-2 | **APPROVED 2026-10-24.** Fail closed on every unspecified case: no guessed result, a trace entry, and the manager sees the reason. | Rule (approved) |
| X-3 | **APPROVED 2026-10-24.** This engine needs at least 3 judges and an odd panel size; any other panel fails closed (`COMP_ENGINE_UNSPECIFIED_CASE`). Studio engines also refuse a round with `chief_judge_tiebreak` or `score_roles_separately` set to true. | Rule (approved) |
| X-4 | **APPROVED 2026-10-24, consistent with K0 O1.** A round cannot lock with an absent assigned judge. A manager removes the judge from the panel (audited), and the reduced panel must still satisfy X-3. | Rule (approved) |
| X-5 | **APPROVED 2026-10-24.** Scratched and no-show entries are excluded from calculation. They are not placed last. | Rule (approved) |
| X-6 | **APPROVED 2026-10-24.** A multi-dance round yields one result per dance. A combined result is not supported in v1 and fails closed. | Rule (approved) |
| X-7 | **APPROVED 2026-10-24.** Every heat in a round must have the same panel; otherwise the round fails closed. | Rule (approved) |

## 11. Explicitly not in this spec

- No UCWDC, NDCA or WSDC rule is used (S6 note, S10, S11).
- Medal Marks scoring (Studio `medal_marks`) stays a `studio_placeholder`; this engine does not score it.
- Feedback (critique, grade, score) never enters the calculation (S9).
- Approval (second person), publication (portal always, public page opt-in per program) and corrections are the
  K0 lifecycle, not engine behaviour.
