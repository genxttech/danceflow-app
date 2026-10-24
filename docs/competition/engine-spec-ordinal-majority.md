# Engine spec — `ordinal_majority` (Studio v1, K1)

Status: **DRAFT for owner approval** · Baseline: origin/main `973f36da` · Docs only (no code, no SQL).
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
| Mark per entry | Exactly one mark per entry per judge | NOT SPECIFIED IN PROVIDED SOURCE → **D-OM-5** (candidate: required, fail closed if missing) |
| Range | 1 … N where N = number of entries in the round | NOT SPECIFIED IN PROVIDED SOURCE → **D-OM-5** |
| Equal marks on one ballot (judge ties) | `@3` scheme has no `ties_allowed` value | NOT SPECIFIED IN PROVIDED SOURCE → **D-OM-4** |
| Per role marks | `scored_by: entry` only | S6 |
| Feedback grades/scores | Never engine input | S9 |

## 4. Outputs

K0 `EngineOutput` `rows[]`, one per entry:

| Field | Meaning | Basis |
|---|---|---|
| `placement` | integer ≥ 1, 1 = first | S6 (output `placement`, primary) |
| `tie_group` | set only if the owner allows shared placements (D-OM-3); otherwise never set | NOT SPECIFIED IN PROVIDED SOURCE |
| `advanced` | not set (a Final has no advancement; `advancement_method: none`) | S6 |
| `rating_band` | not set | S6 |
| `output` | per-entry working (e.g. counts per cutoff, or totals — per D-OM-1), copied from the trace | S2 |

Placements are dense and unique 1…N unless D-OM-3 allows shared placements. What the published result shows
(placement only, or the marks too) is an F3 publication decision, not an engine output.

## 5. Algorithm

Steps 1–4 and 7–8 are fixed by approved decisions. Steps 5–6 (how ordinals combine) are **not specified**: the
locked key name says the engine works on *ordinals* with a *majority* (S1), and the profile says "the best-ranked
dancer places first" (S6), but no approved source defines the computation. The owner chooses it (**D-OM-1**).

1. **Check engine availability.** `engine_key = ordinal_majority` and `engine_version = 1` with this spec
   approved; otherwise `COMP_ENGINE_NOT_AVAILABLE` (K0, S5).
2. **Check round type** is `final` (§2); otherwise `COMP_ENGINE_UNSPECIFIED_CASE`.
3. **Validate input** against §7 in the listed order; the first failure stops the calculation (no partial result).
4. **Build the mark table** `M[judge][entry] = ordinal`, judges ordered by `letter`, entries by `entry_id`
   (determinism, §7).
5. **Combine ordinals** — NOT SPECIFIED IN PROVIDED SOURCE (**D-OM-1**, with **D-OM-2** for the meaning of
   "majority" on an even panel). Candidate options for the owner:
   - **OM-A "majority at the lowest cutoff".** Let `J` = number of judges and `m` = the majority threshold
     (D-OM-2). For each place `p = 1, 2, …` in turn, among unplaced entries, find the smallest cutoff
     `c ≥ p` at which at least one entry has `≥ m` judges marking it `≤ c`. If exactly one entry qualifies at that
     cutoff it takes place `p`. If several qualify at the same cutoff, apply the tie-break chain (§6) to order
     them, and they take places `p, p+1, …`.
   - **OM-B "lowest ordinal total".** Sum each entry's ordinals; ascending order of totals gives the placements;
     equal totals go to the tie-break chain.
   - **Other** — the owner specifies a rule.
6. **Resolve ties** with the tie-break chain (§6). The chain is empty in `@3` (S6), so any tie fails closed
   until D-OM-3 is decided.
7. **Emit rows** (§4) and the trace (§8).
8. **Never** read the clock, the database, a random source, entry names, studio names or entry numbers
   (S2 deterministic; K0).

## 6. Tie-break chain

| Position | Rule | Basis |
|---|---|---|
| — | `@3` `placements.tie_break.chain = []` with the note "no tie-break rules are implemented yet" | S6 |
| 1…n | NOT SPECIFIED IN PROVIDED SOURCE → **D-OM-3** | — |
| Excluded | Random draw, coin toss, entry number, registration time, name order: none is deterministic from the ballots, so none may decide a placement | S2 (deterministic) |
| Excluded | UCWDC Rules #4–#8, NDCA Skating rules, WSDC Chief Judge tie-break — governing-body rules, not Studio rules | S10 rule 4, S11 |

If the chain is exhausted with entries still tied, the outcome is NOT SPECIFIED IN PROVIDED SOURCE → **D-OM-3**
(candidates: shared placement with `tie_group`, shared at the higher place; or fail closed for a manager action).
Until decided: `COMP_ENGINE_UNSPECIFIED_CASE`.

A tie-break chain chosen by the owner is profile data (S8): it belongs in a new profile version's stage
`tie_break.chain`, not in engine code. See X-1 for programs already locked to `@1` / `@3`.

## 7. Invalid-input handling

Checked in this order; the first failure stops the calculation. No partial result is ever written (S2). Error
codes below are the proposed `reason` values under one engine error `COMP_ENGINE_INVALID_INPUT` (naming to be
mirrored by the K0 contract owner; this spec does not edit `contract.ts`).

| # | Condition | Result | Basis |
|---|---|---|---|
| V1 | Engine key/version unknown or spec not approved | `COMP_ENGINE_NOT_AVAILABLE` | K0, S5 |
| V2 | `mark_scheme.input ≠ placement_marks` or `scored_by ≠ entry` | invalid `scheme_mismatch` | S6 |
| V3 | No judges, or fewer judges than the minimum panel | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-3** | NOT SPECIFIED |
| V4 | A mark from an official not in `judges[]` | invalid `official_not_on_panel` | S4, K0 §9 #2 |
| V5 | A mark for an entry not in `entries[]` | invalid `entry_not_in_round` | K0 §9 #3 |
| V6 | More than one mark for the same (judge, entry) | invalid `duplicate_mark` | S2 (one current ballot) |
| V7 | A judge has no mark for some entry | invalid `incomplete_ballot` (pending **D-OM-5**) | NOT SPECIFIED |
| V8 | Mark not an integer, < 1 or > N | invalid `mark_out_of_range` (pending **D-OM-5**) | NOT SPECIFIED |
| V9 | Two entries share an ordinal on one ballot | invalid `judge_tie` until **D-OM-4** | NOT SPECIFIED |
| V10 | An assigned judge has no ballot at all | handled before the engine by the lock step (K0 O1); if it reaches the engine: `COMP_ENGINE_UNSPECIFIED_CASE` | K0 O1 |
| V11 | Round contains more than one scoring heat | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-7** (a judge's ranking of one heat does not rank entries in another heat) | NOT SPECIFIED |
| V12 | Round's heats cover more than one dance | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-6** | NOT SPECIFIED |
| V13 | A scratched / no-show entry (10D) is in `entries[]` | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-5** | NOT SPECIFIED |
| V14 | Any unresolved tie (§6) | `COMP_ENGINE_UNSPECIFIED_CASE` until **D-OM-3** | S6 |

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
4. `combine` — per place `p`: the working table of the chosen D-OM-1 option (e.g. per entry, per cutoff, the count
   of judges `≤ c`; or per entry, the ordinal total).
5. `tie_break` — every invocation: tied entries, the chain position applied, its working, its outcome.
6. `result` — final placements (and `tie_group` if allowed).
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

**F-OM-02 — the candidate options disagree.**

| Entry | J1 | J2 | J3 | Total |
|---|---|---|---|---|
| 11 | 1 | 1 | 4 | 6 |
| 12 | 2 | 2 | 1 | 5 |
| 13 | 3 | 3 | 2 | 8 |
| 14 | 4 | 4 | 3 | 11 |

- OM-A (m = 2 of 3): place 1, cutoff 1: 11 has 2 judges → 11 first. Place 2, cutoff 2: 12 has 3 → 12 second.
  Place 3, cutoff 3: 13 has 3, 14 has 1 → 13 third. 14 fourth. **11, 12, 13, 14.**
- OM-B: totals 5, 6, 8, 11 → **12, 11, 13, 14.**

This fixture exists so the owner sees that D-OM-1 changes who wins.

**F-OM-03 — circular preferences (full tie).**

| Entry | J1 | J2 | J3 | Total |
|---|---|---|---|---|
| 11 | 1 | 3 | 2 | 6 |
| 12 | 2 | 1 | 3 | 6 |
| 13 | 3 | 2 | 1 | 6 |

- OM-A: cutoff 1 — every entry has 1 judge (no majority); cutoff 2 — every entry has 2 → three-way tie.
- OM-B: all totals 6 → three-way tie.
- Expected (all options, until D-OM-3): `COMP_ENGINE_UNSPECIFIED_CASE`, trace shows the tie.

**F-OM-04 — even panel.**

| Entry | J1 | J2 | J3 | J4 | Total |
|---|---|---|---|---|---|
| 11 | 1 | 1 | 2 | 3 | 7 |
| 12 | 2 | 2 | 1 | 1 | 6 |
| 13 | 3 | 3 | 3 | 2 | 11 |

- OM-A with m = 3 (more than half of 4): cutoff 1 — 11 has 2, 12 has 2 (none); cutoff 2 — 11 has 3, 12 has 4 →
  two entries qualify → tie-break chain → `COMP_ENGINE_UNSPECIFIED_CASE` until D-OM-3.
- OM-B: totals 6, 7, 11 → **12, 11, 13.**
- Depends on D-OM-2 (majority on an even panel) and X-3 (are even panels allowed).

**F-OM-05 — one entry.** One entry 11, J1–J3 all mark 1. Expected (all options): 11 → 1. Whether a one-entry
final is awarded is a results/awards question, not an engine one.

**F-OM-06 — one judge.** J1 marks 11 = 1, 12 = 2, 13 = 3. Expected (all options): 11, 12, 13 — **if** X-3 allows a
one-judge panel; otherwise `COMP_ENGINE_UNSPECIFIED_CASE`.

**F-OM-07 — invalid inputs** (each starts from F-OM-01 with one change):

| Case | Change | Expected |
|---|---|---|
| a | J2 marks 11 = 1 and 12 = 1 | `judge_tie` (V9) until D-OM-4 |
| b | J3 has no mark for 14 | `incomplete_ballot` (V7) |
| c | J1 marks 14 = 5 (4 entries) / 0 / 2.5 | `mark_out_of_range` (V8) |
| d | A mark for entry 99 not in the round | `entry_not_in_round` (V5) |
| e | A mark from official J9 not on the panel | `official_not_on_panel` (V4) |
| f | J1 appears twice for entry 11 | `duplicate_mark` (V6) |
| g | `mark_scheme.input = medal_marks` | `scheme_mismatch` (V2) |
| h | Round has heats 1 and 2 | `COMP_ENGINE_UNSPECIFIED_CASE` (V11) until X-7 |
| i | Entry 14 is marked scratched in 10D | `COMP_ENGINE_UNSPECIFIED_CASE` (V13) until X-5 |

**F-OM-08 — determinism.** F-OM-02 input with the `marks[]` array shuffled → identical output and trace hash.

## 10. Owner decisions needed

Engine-specific:

| ID | Question | Candidates (no recommendation, see §0) | Until decided |
|---|---|---|---|
| D-OM-1 | How are judges' ordinals combined into placements? | OM-A majority at the lowest cutoff; OM-B lowest ordinal total; other | Engine not available (`COMP_ENGINE_NOT_AVAILABLE`) |
| D-OM-2 | What is a "majority" (the word is in the locked key, S1), especially on an even panel? | more than half of judges; at least half; other | as D-OM-1 |
| D-OM-3 | Tie-break chain (empty in `@3`), and what happens when it is exhausted | ordered list of rules the owner states; then shared placement (`tie_group`) or manager decision or fail closed | Any tie fails closed |
| D-OM-4 | May a judge give two entries the same ordinal? If yes, how does it count? | not allowed (ballot UI blocks it); allowed with a stated rule | Rejected (`judge_tie`) |
| D-OM-5 | Must every judge rank every entry, 1…N, each value once? | yes; partial rankings allowed with a stated rule | Rejected |

Cross-cutting (same IDs and wording in all three specs — decide once):

| ID | Question | Until decided |
|---|---|---|
| X-1 | Where do decided values live? S8 says scales, values and tie-break chains are profile parameters, so they belong in a new `studio_simple@4`. Programs already locked to `@1`/`@3` (S3: never silently changed) then either (a) score with `@1`/`@3` metadata plus engine `@1` defaults written in this spec, or (b) cannot be scored and must be re-created under `@4`. | Fail closed for locked `@1`/`@3` programs |
| X-2 | Confirm fail-closed for every case this spec marks unspecified (no guessed result; manager sees the reason). | Fail closed (this draft's rule) |
| X-3 | Minimum panel size; are one-judge and even-sized panels allowed? (Rounds already carry `minimum_panel_size`, nullable, from `20260622_west_coast_swing_foundation_v1`; no Studio value is specified. The same migration added `chief_judge_tiebreak` and `score_roles_separately`: Studio engines refuse a round with either set to true, since both are WSDC concepts.) | `COMP_ENGINE_UNSPECIFIED_CASE` |
| X-4 | A judge assigned but absent (K0 O1). | Round cannot lock (K0 default) |
| X-5 | Scratched / no-show entries (10D) at calculation time: excluded, placed last, or other? | `COMP_ENGINE_UNSPECIFIED_CASE` |
| X-6 | A round whose heats cover several dances: one result per dance, or one combined result? | `COMP_ENGINE_UNSPECIFIED_CASE` |
| X-7 | A placement round split across several scoring heats (10D default capacity 8 per heat). | `COMP_ENGINE_UNSPECIFIED_CASE` |

## 11. Explicitly not in this spec

- No UCWDC, NDCA or WSDC rule is used (S6 note, S10, S11).
- Medal Marks scoring (Studio `medal_marks`) stays a `studio_placeholder`; this engine does not score it.
- Feedback (critique, grade, score) never enters the calculation (S9).
- Approval (second person), publication (portal always, public page opt-in per program) and corrections are the
  K0 lifecycle, not engine behaviour.
