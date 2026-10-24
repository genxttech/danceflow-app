# Engine spec — `proficiency_rating` (Studio v1, K1)

Status: **DRAFT for owner approval** · Baseline: origin/main `973f36da` · Docs only (no code, no SQL). **Stage 1 (X-1…X-7) APPROVED by the owner 2026-10-24; every D-* item below remains open.**

Scoring architecture (five independent dimensions, S4-1…S4-7) is recorded in `scoring-architecture-decisions.md`; Stages 1–3 apply to the Studio methods only.

Engine version on approval: `proficiency_rating@1`. No engine code may be written until the owner signs off this
spec and the decisions in §10 (owner decision 2026-10-23: engines are specified first, approved, then built).

**REJECTED 2026-10-24:** the three-band median proposal as a universal studio method. This key stays fail-closed (`COMP_ENGINE_NOT_AVAILABLE`) and is not deleted; no method is approved (see the architecture file §1.6). The candidates below are not adopted.
Sibling specs: [engine-spec-ordinal-majority.md](engine-spec-ordinal-majority.md),
[engine-spec-callback-tally.md](engine-spec-callback-tally.md). The engine boundary (input/output envelope,
hashing, round state machine) is owned by the K0 scoring-to-results contract
(`docs/competition/scoring-results-contract.md`, draft on branch `competition-k0-results-contract`, not yet on
main). This spec aligns to that draft and does not redefine it.

## 0. How to read this spec

- Every rule cites a source key from §1. A rule with no approved source is written **NOT SPECIFIED IN PROVIDED
  SOURCE** and points to an owner decision (`D-PR-n`, or a cross-cutting `X-n` shared by all three specs).
- Where a decision is open, the spec lists **candidate options** so the owner can choose. Candidates are not rules,
  are not taken from any governing body, and carry no recommendation.
- **These rating bands are not UCWDC medal scoring** (S1). No UCWDC medal mark (HM, B, S, G, GH, GG, the ProAm
  +/star scale), medal value, majority-mark rule or medal threshold is used. The shared words "Gold", "Silver" and
  "Bronze" are Studio band labels only.
- Until a decision is made, the engine behaviour for that case is **fail closed** (X-2): no result, a trace entry,
  error `COMP_ENGINE_UNSPECIFIED_CASE`.

## 1. Approved basis (citation keys)

| Key | Source | What it establishes |
|---|---|---|
| S1 | Roadmap Phase 10 §LOCKED DECISIONS, "Studio v1 scoring defaults" (`DanceFlow_Master_Roadmap.md` l.1029) | "Gold / Silver / Bronze simple rating bands for studio showcase/rating use (explicitly not UCWDC's formal medal scoring vocabulary)"; `proficiency_rating` is a v1 engine |
| S2 | Roadmap Phase 10 §ARCHITECTURE, "Integrity" (l.930) | ballots immutable, corrections are new versions; engines deterministic and versioned; trace preserved; finalized results never silently overwritten |
| S3 | Roadmap Phase 10 §ARCHITECTURE, "Rules/version lock" (l.927) | profile, engine version and configuration snapshot locked at publish |
| S4 | Roadmap Phase 10 §LOCKED DECISIONS, "Judge access (studio v1)" (l.1028) | judges use authenticated accounts; a scorer may enter paper ballots |
| S5 | Roadmap Phase 10 §REMAINING STUDIO v1 MILESTONES #2 (l.988) | 10F delivers the three engines |
| S6 | `studio_simple@3` `judging.ratings` (`src/lib/competition/setup/studioCustomV3.ts`, seeded by `20261114090000_phase10c5_profile_v3.sql`) | label "Gold / Silver / Bronze"; description "Judges rate each performance, so every dancer can earn a Gold, Silver or Bronze rating instead of a place."; `input_label: Ratings`, `result_label: Rating`; `official_result: true`; ballot `input: rating`, `scored_by: entry`, `scale: ["Bronze","Silver","Gold"]`; output `rating` (primary); tie-break chain **empty**; storage engine `proficiency_rating@1`; `competition_mode: proficiency`; `bands: ["Gold","Silver","Bronze"]`; one round `final` / "Final" / `scoring_method: proficiency_rating` |
| S7 | `studio_simple@1` `judging.ratings` (`src/lib/competition/simple/studioSimpleV1.ts`, seeded by `20261108090000`) | label "Ratings"; "every dancer can earn a rating instead of a place"; same bands, engine and round; no `MarkScheme` (schema 1) |
| S8 | `types.ts` `MarkScheme.scale` ("Ordered labels from lowest to highest") and 10C.5 doc §"Scoring metadata" | scale order is Bronze < Silver < Gold; values and scales are profile parameters, never engine constants |
| S9 | 10C.5 doc §"Adjudication, feedback and the official result are separate" | a grade or score given as feedback never becomes an official result; Non-Adjudicated produces none |
| S10 | 10C.5 doc §"Wizard flow" step 3 | ratings are offered as the "Other" style's alternative to Placements |
| S11 | Source registry §"Rules for using a source", rules 2 and 4; `scoringReference.ts` header | silent source → `NOT SPECIFIED IN PROVIDED SOURCE`; governing-body references are not Studio inputs |
| S12 | `20260620_competition_foundation_v1.sql` and `20261108090000` | round per division; `proficiency_rating` is an allowed `scoring_method`; a `proficiency` round type exists in the check but no approved profile uses it |
| K0 | Scoring-to-results contract draft §5 (unmerged; alignment only) | `EngineInput` / `EngineOutput`, hashing, `COMP_ENGINE_NOT_AVAILABLE`, `COMP_ENGINE_UNSPECIFIED_CASE` |

## 2. Scope

| Item | Rule | Basis |
|---|---|---|
| Purpose | Give each entry a Gold, Silver or Bronze rating "instead of a place" | S1, S6 |
| Round types | `final` (the only round of both profiles' ratings option) | S6, S7 |
| `proficiency` round type, or any other | Not used by any approved profile → `COMP_ENGINE_UNSPECIFIED_CASE` | S12 |
| Inter-entry comparison | None: each entry is rated on its own ("every dancer can earn…") | S6, S7 |
| Not this engine | UCWDC medal marks / thresholds (`majority_rules_medal`); `proficiency_score` / `proficiency_percentage` (not in any Studio profile); feedback grades | S1, S9, S11 |

## 3. Inputs

The K0 `EngineInput` envelope for one round. Fields this engine reads:

| Field | Shape | Basis |
|---|---|---|
| `engine_key`, `engine_version` | `"proficiency_rating"`, `1` | S2, S3 |
| `profile` | `{key, version}` from the program lock | S3 |
| `round` | `{id, round_type}` | S12 |
| `mark_scheme` | `{input: "rating", scored_by: "entry", scale: ["Bronze","Silver","Gold"]}` (`@3`); `@1` has none (X-1) | S6, S7 |
| `tie_break_chain` | empty in `@3`; unused (no inter-entry ties exist) | S6 |
| `entries[]` | `{entry_id}` | K0 |
| `judges[]` | `{official_id, letter}` | S4, K0 |
| `marks[]` | `{official_id, entry_id, value}`; `value` is one label of `mark_scheme.scale` | S6 |

**Ballot shape per judge.** One current ballot per judge (S2). For each entry the judge gives one band label from
the scale, compared exactly (`"Gold"`, not `"gold"` or `"G"`).

| Ballot property | Rule | Basis |
|---|---|---|
| Allowed values | exactly the labels in `mark_scheme.scale` | S6, S8 |
| A "no rating" / below-Bronze mark | NOT SPECIFIED IN PROVIDED SOURCE → **D-PR-3** | — |
| Mark per entry | one per entry the judge is assigned to | NOT SPECIFIED IN PROVIDED SOURCE → **D-PR-5** (candidate: required) |
| Per role marks | `scored_by: entry` only | S6 |
| Feedback grade / score | never engine input, even if its words match a band | S9 |

## 4. Outputs

K0 `EngineOutput` `rows[]`, one per entry:

| Field | Meaning | Basis |
|---|---|---|
| `rating_band` | `"Gold"`, `"Silver"` or `"Bronze"` (or the D-PR-3 outcome, if the owner adds one) | S6 (output `rating`, primary; `bands`) |
| `placement` | **never set** — ratings are "instead of a place" | S6, S7 |
| `tie_group`, `advanced` | never set | S6 (`advancement_method: none`) |
| `output` | the entry's per-judge bands and the D-PR-1 working, copied from the trace | S2 |

## 5. Algorithm

Steps 1–4 and 6–7 are fixed by approved decisions. Step 5 (how several judges' bands become one rating) is
**not specified** by any approved source (**D-PR-1**).

1. **Check engine availability.** `proficiency_rating@1` with this spec approved; otherwise
   `COMP_ENGINE_NOT_AVAILABLE` (K0, S5).
2. **Check round type** is `final` (§2); otherwise `COMP_ENGINE_UNSPECIFIED_CASE`.
3. **Validate input** against §7; the first failure stops the calculation.
4. **Map labels to scale positions** using the locked scale order (S8): Bronze = 1, Silver = 2, Gold = 3. Positions
   are an ordering only; they are not points, are never summed into a published number, and are not UCWDC values.
5. **Combine each entry's bands** — NOT SPECIFIED IN PROVIDED SOURCE (**D-PR-1**, with **D-PR-2**). Candidate
   options for the owner:
   - **PR-A "majority band".** The band given by a majority of the entry's judges (majority as defined in D-PR-2).
     If no band has a majority, D-PR-2's fallback applies.
   - **PR-B "lowest band".** The lowest band any of the entry's judges gave.
   - **PR-C "median band".** Order the entry's bands by scale position and take the middle one. An even number of
     judges has no single middle: lower or upper middle is part of D-PR-2.
   - **PR-D "points and thresholds".** Owner supplies a numeric value per band and the thresholds; the source
     gives neither.
   - **Other** — the owner specifies a rule.
6. **Each entry independently.** No entry's marks affect another entry's rating; there is no inter-entry
   ranking or tie-break (S6, S7).
7. **Emit rows** (§4) and the trace (§8). Never read the clock, database, randomness, names or entry numbers (S2).

## 6. Tie-break chain

| Situation | Rule | Basis |
|---|---|---|
| Two entries with the same rating | Not a tie: both receive that rating | S6 ("every dancer can earn…") |
| One entry's judges split with no deciding rule under the chosen D-PR-1 option (e.g. PR-A with no majority, PR-C on an even panel) | NOT SPECIFIED IN PROVIDED SOURCE → **D-PR-2** | — |
| `@3` `ratings.tie_break.chain` | `[]` ("no tie-break rules are implemented yet") | S6 |
| Excluded | Random choice; entry number; UCWDC majority-mark or medal-threshold rules | S2, S1, S11 |

Until D-PR-2 is decided, an unresolved split fails closed with `COMP_ENGINE_UNSPECIFIED_CASE` for the whole round
(no partial result, S2).

## 7. Invalid-input handling

Checked in this order; the first failure stops the calculation (no partial result). Proposed `reason` values under
`COMP_ENGINE_INVALID_INPUT` (to be mirrored by the K0 contract owner).

| # | Condition | Result | Basis |
|---|---|---|---|
| V1 | Engine key/version unknown or spec not approved | `COMP_ENGINE_NOT_AVAILABLE` | K0, S5 |
| V2 | `mark_scheme.input ≠ rating`, `scored_by ≠ entry`, or scale ≠ the locked scale | invalid `scheme_mismatch` | S6 |
| V3 | `mark_scheme` absent (`@1` programs) | Scored with the engine `@1` default scheme written in this spec (**X-1**, approved 2026-10-24: option (a)); the default scheme content is not defined in the provided sources and stays NOT SPECIFIED, so fail closed (`COMP_ENGINE_UNSPECIFIED_CASE`) until the owner supplies it | S7, X-1 |
| V4 | No judges (fewer than 1) | `COMP_ENGINE_UNSPECIFIED_CASE` (**X-3**, approved 2026-10-24: 1 or more judges, any size) | X-3 |
| V5 | Mark from an official not on the panel | invalid `official_not_on_panel` | S4, K0 §9 #2 |
| V6 | Mark for an entry not in the round | invalid `entry_not_in_round` | K0 §9 #3 |
| V7 | More than one mark for (judge, entry) | invalid `duplicate_mark` | S2 |
| V8 | Value not exactly a scale label (e.g. `"Platinum"`, `"GH"`, `"gold"`, `3`) | invalid `mark_not_in_scale` | S6, S8 |
| V9 | A "no rating" mark | invalid `mark_not_in_scale` until **D-PR-3** | NOT SPECIFIED |
| V10 | A judge has no mark for an entry they were assigned | invalid `incomplete_ballot` (pending **D-PR-5**) | NOT SPECIFIED |
| V11 | Assigned judge with no ballot | handled by the lock step (K0 O1); if it reaches the engine: `COMP_ENGINE_UNSPECIFIED_CASE` | K0 O1 |
| V12 | Input spans more than one dance | Run once per dance (**X-6**, approved 2026-10-24); combined result not supported, fails closed (`COMP_ENGINE_UNSPECIFIED_CASE`) | X-6 |
| V13 | Scratched / no-show entry in `entries[]` | Excluded from the calculation and recorded in the trace (**X-5**, approved 2026-10-24); never placed last | X-5 |
| V14 | Unresolved split (§6) | `COMP_ENGINE_UNSPECIFIED_CASE` until **D-PR-2** | NOT SPECIFIED |

Several scoring heats in one round do not by themselves block this engine, because entries are not compared
(S6). X-7 (approved 2026-10-24) still applies: every heat in a round must have the same panel, otherwise the round
fails closed (`COMP_ENGINE_UNSPECIFIED_CASE`).

## 8. Determinism and trace

| Requirement | Basis |
|---|---|
| Same input → identical output and trace; no clock, network, database or randomness | S2, K0 §5 |
| Fixed order: judges by `letter`, entries by `entry_id` | K0 §5 |
| Behaviour change ships as `proficiency_rating@2`; locked programs keep `@1` | S2, S3 |
| Hashes computed by the server per K0 | K0 §5 |

**Trace content** (`{step, rule, data}` records):

1. `engine` — key, version, spec reference.
2. `inputs` — profile, round, scale, judge letters, entry ids, full mark table.
3. `validation` — V1…V14 pass/fail.
4. `combine` — per entry: its judges' bands, scale positions, the D-PR-1 working, the resulting band.
5. `split` — per entry where D-PR-2 was applied: the split and the rule used.
6. `result` — band per entry.
7. On failure: `failure` with code, reason and offending ids.

## 9. Worked examples (golden-fixture candidates)

Judges J1–J3 (J4 when four); G = Gold, S = Silver, B = Bronze. "All options" = PR-A, PR-B and PR-C agree. PR-D
cannot be computed until the owner supplies values and thresholds.

| Fixture | Entry | Judges' bands | PR-A majority | PR-B lowest | PR-C median |
|---|---|---|---|---|---|
| F-PR-01 unanimous | 11 | G, G, G | Gold | Gold | Gold |
| F-PR-02 | 11 | G, G, S | Gold | Silver | Gold |
| F-PR-03 three-way split | 11 | G, S, B | no majority → D-PR-2 (fail closed) | Bronze | Silver |
| F-PR-04 even panel | 11 | G, G, S, S | no majority (2 of 4) → D-PR-2 | Silver | no single middle → D-PR-2 |
| F-PR-05 | 11 | S, S, B | Silver | Bronze | Silver |
| F-PR-06 independence | 11 and 12 | both G, G, G | both Gold; no placement; no tie-break | same | same |

F-PR-02 and F-PR-05 exist so the owner sees that D-PR-1 changes the rating dancers receive.

**F-PR-07 — invalid inputs** (each starts from F-PR-01 with one change):

| Case | Change | Expected |
|---|---|---|
| a | J2 marks `"Platinum"` | `mark_not_in_scale` (V8) |
| b | J2 marks `"GH"` (a UCWDC medal mark) | `mark_not_in_scale` (V8) |
| c | J2 marks `"gold"` | `mark_not_in_scale` (V8) |
| d | J2 marks `"No rating"` | `mark_not_in_scale` (V9) until D-PR-3 |
| e | J3 has no mark for 11 | `incomplete_ballot` (V10) |
| f | Mark from official J9 not on the panel | `official_not_on_panel` (V5) |
| g | A feedback grade "Gold" arrives as a mark | not engine input (S9): the K0 input builder never passes feedback; if it did, `scheme_mismatch` |
| h | `@1` program (no `mark_scheme`) | `COMP_ENGINE_UNSPECIFIED_CASE` (V3): the `@1` default scheme is not yet specified (X-1 approved as option (a), content pending owner) |
| i | Entry 11 scratched in 10D | Excluded from the calculation, noted in the trace (V13, X-5 approved) |

**F-PR-08 — determinism.** F-PR-02 with `marks[]` shuffled → identical output and trace hash.

## 10. Owner decisions needed

Engine-specific:

| ID | Question | Candidates (no recommendation) | Until decided |
|---|---|---|---|
| D-PR-1 | How do several judges' bands become one rating? | PR-A majority band; PR-B lowest band; PR-C median band; PR-D owner-supplied points and thresholds; other | Engine not available |
| D-PR-2 | Meaning of "majority" and the fallback when judges split with no deciding rule (incl. even panels) | e.g. the lower of the tied bands; the higher; fail closed for a manager action; other | Fail closed |
| D-PR-3 | Is there an outcome other than Gold / Silver / Bronze ("no rating", "participation")? May a judge give it? | three bands only; a fourth Studio outcome with a stated label | Three bands only; anything else rejected |
| D-PR-4 | Are a dancer's individual judges' bands shown to the dancer / public, or only the final rating? (Publication-side; listed so F3 does not guess.) | rating only; rating + per-judge bands (judge identity per K0 O3) | Rating only |
| D-PR-5 | Must every assigned judge rate every entry they were assigned? | yes; partial allowed with a stated rule | Required |

Cross-cutting X-1…X-7 (same IDs in all three specs): **APPROVED by the owner 2026-10-24 ("Approve K1 Stage 1 (X-1..X-7) as recommended")**. Every D-OM / D-PR / D-CT item remains open.

| ID | Rule | Status |
|---|---|---|
| X-1 | **APPROVED 2026-10-24: option (a).** Programs locked to `@1`/`@3` are scored with the profile metadata plus the engine `@1` defaults written in this spec. No `@4` re-creation is required. | Rule (approved) |
| X-2 | **APPROVED 2026-10-24.** Fail closed on every unspecified case: no guessed result, a trace entry, and the manager sees the reason. | Rule (approved) |
| X-3 | **APPROVED 2026-10-24.** This engine allows 1 or more judges (no odd-size requirement). Studio engines also refuse a round with `chief_judge_tiebreak` or `score_roles_separately` set to true. | Rule (approved) |
| X-4 | **APPROVED 2026-10-24, consistent with K0 O1.** A round cannot lock with an absent assigned judge. A manager removes the judge from the panel (audited), and the reduced panel must still satisfy X-3. | Rule (approved) |
| X-5 | **APPROVED 2026-10-24.** Scratched and no-show entries are excluded from calculation. They are not placed last. | Rule (approved) |
| X-6 | **APPROVED 2026-10-24.** A multi-dance round yields one result per dance. A combined result is not supported in v1 and fails closed. | Rule (approved) |
| X-7 | **APPROVED 2026-10-24.** Every heat in a round must have the same panel; otherwise the round fails closed. | Rule (approved) |

## 11. Explicitly not in this spec

- No UCWDC medal marks, values, majority-mark rule or medal threshold (S1, S11).
- No placement, ranking or advancement (S6).
- Feedback grades and scores (`written_plus_grade`, `written_plus_score`) never become a rating (S9).
- Approval, publication and corrections are the K0 lifecycle.
