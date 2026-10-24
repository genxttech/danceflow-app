# Engine spec — `callback_tally` (Studio v1, K1)

Status: **DRAFT for owner approval** · Baseline: origin/main `973f36da` · Docs only (no code, no SQL). **Stage 1 (X-1…X-7) and Stage 2 (D-CT-1…10) APPROVED by the owner 2026-10-24. One sub-process remains unspecified: the auditable tie-break process for a tie that exceeds the final capacity (D-CT-4); until then that case blocks advancement. Engine code stays blocked until Stage 4 (proficiency rating) is also recorded.**

Scoring architecture (five independent dimensions, S4-1…S4-7) is recorded in `scoring-architecture-decisions.md`; Stages 1–3 apply to the Studio methods only.
Engine version on approval: `callback_tally@1`. No engine code may be written until the owner signs off this
spec and the decisions in §10 (owner decision 2026-10-23: engines are specified first, approved, then built).

Sibling specs: [engine-spec-ordinal-majority.md](engine-spec-ordinal-majority.md),
[engine-spec-proficiency-rating.md](engine-spec-proficiency-rating.md). The engine boundary and the advancement
step (`apply_competition_round_advancement`) are owned by the K0 scoring-to-results contract
(`docs/competition/scoring-results-contract.md`, draft on branch `competition-k0-results-contract`, not yet on
main). This spec aligns to that draft and does not redefine it.

## 0. How to read this spec

- Every rule cites a source key from §1. A rule with no approved source is written **NOT SPECIFIED IN PROVIDED
  SOURCE** and points to an owner decision (`D-CT-n`, or a cross-cutting `X-n` shared by all three specs).
- Where a decision is open, the spec lists **candidate options** so the owner can choose. Candidates are not rules
  and carry no recommendation.
- **Governing-body callback rules are not Studio rules** (S10). The UCWDC callback values (yes 10.0, alternates
  5.0–4.0), UCWDC "ties at the cut advance", the WSDC values (yes 10, alternates 4.5/4.3/4.2), the WSDC Chief Judge
  tie-break, WSDC per-role scoring, UCWDC retire (inverted) callbacks and the NDCA 50% minimum recall are all
  recorded in `scoringReference.ts` as references only and are **not** used here.
- Until a decision is made, the engine behaviour for that case is **fail closed** (X-2): no result, a trace entry,
  error `COMP_ENGINE_UNSPECIFIED_CASE`.

## 1. Approved basis (citation keys)

| Key | Source | What it establishes |
|---|---|---|
| S1 | Roadmap Phase 10 §LOCKED DECISIONS, "Studio v1 scoring defaults" (`DanceFlow_Master_Roadmap.md` l.1029) | "final-only structure unless entry volume requires a preliminary"; `callback_tally` is a v1 engine |
| S2 | Roadmap Phase 10 §ARCHITECTURE, "Integrity" (l.930) | ballots immutable; engines deterministic and versioned; trace preserved; finalized results never silently overwritten |
| S3 | Roadmap Phase 10 §ARCHITECTURE, "Rules/version lock" (l.927) | profile, engine version and configuration snapshot locked at publish |
| S4 | Roadmap Phase 10 §LOCKED DECISIONS, "Judge access (studio v1)" (l.1028) | authenticated judges; scorer may enter paper ballots |
| S5 | Roadmap Phase 10 §ARCHITECTURE, "Roadmap-level model" (l.929) | the model includes "advancement decisions" and "adjudication actions" as their own records |
| S6 | `studio_simple@1` `judging.callbacks` (`src/lib/competition/simple/studioSimpleV1.ts`; seeded by `20261108090000_phase10b_competition_profiles.sql`) | label "Callbacks + Final"; description "Judges call the best dancers back from a first round into the final. Best for large divisions."; engine `callback_tally@1`; `competition_mode: relative`; `advancement_method: promote_callback`; rounds: (1) `preliminary` "Callback round" `scoring_method: callback_tally`, (2) `final` "Final" `scoring_method: ordinal_majority`; schema 1, so no `MarkScheme` |
| S7 | `studio_simple@3` (`studioCustomV3.ts`, `20261114090000`) | **no callbacks judging option**; `roundsNote`: "Every division starts with a Final. Preliminary rounds can be added later if entry volume or the rules require them." |
| S8 | `types.ts` `MarkScheme`, `ScoringStage.direction`, `ResultOutputType` and 10C.5 doc §"Scoring metadata" | callback inputs `callback_yes_alternates` / `callback_retire`; direction promote/retire; output type `advancement_ranking`; values are profile parameters, never engine constants |
| S9 | 10C.5 doc §"Adjudication, feedback and the official result are separate" | feedback never becomes a ranking or advancement |
| S10 | Source registry §"Rules for using a source", rules 2 and 4; `scoringReference.ts` header | silent source → `NOT SPECIFIED IN PROVIDED SOURCE`; governing-body references are not profiles and not Studio rules |
| S11 | `20260620_competition_foundation_v1.sql` and `20261108090000` (`create_simple_competition`) | rounds carry `round_type`, `sequence_number`, `target_advancement_count` (nullable, > 0); `create_simple_competition` creates the S6 rounds **without** setting `target_advancement_count` |
| K0 | Scoring-to-results contract draft §5 and §6 (unmerged; alignment only) | `EngineInput` / `EngineOutput`; an advancement stage produces `advanced` per entry against `target_advancement_count`; next-round heats are created only after approval by `apply_competition_round_advancement` |

## 2. Scope

| Item | Rule | Basis |
|---|---|---|
| Purpose | Decide which entries of a callback round are called back into the next round | S6 |
| Direction | Promote (judges call back the best); retire / inverted callbacks are not Studio | S6 (`promote_callback`, "call the best dancers back") |
| Round types | `preliminary` ("Callback round") | S6 |
| Next round | The Final, scored by `ordinal_majority` (separate spec) | S6 |
| More than one callback round (e.g. preliminary → semifinal → final) | Only one callback round exists; it exists only when the organizer turns it on in Advanced (**D-CT-8**, approved 2026-10-24) | S6 shows one |
| Profiles | `studio_simple@1` programs created with "Callbacks + Final". `@3` has no callbacks option; how a `@3` division gets a callback round is not defined by the sources; D-CT-8 (approved) only says the organizer turns callbacks on explicitly in Advanced | S6, S7 |
| When a preliminary is required ("entry volume") | No automatic threshold; the organizer turns callbacks on explicitly in Advanced (**D-CT-8**, approved 2026-10-24) | S1 |
| Not this engine | Applying advancement (creating Final heats) — F2 after approval | K0 §6 |

## 3. Inputs

The K0 `EngineInput` envelope for one round. Fields this engine reads:

| Field | Shape | Basis |
|---|---|---|
| `engine_key`, `engine_version` | `"callback_tally"`, `1` | S2, S3 |
| `profile` | `{key, version}` from the program lock | S3 |
| `round` | `{id, round_type, target_advancement_count, advancement_method}`; `T` is set by the organizer before ballots open (D-CT-5) | S11, D-CT-5 |
| `final_capacity` | the final round's configured couples-per-heat capacity (10D) = the "approved floor capacity" for D-CT-4. Field name and source are for the F1/K0 envelope owner to define | D-CT-4 |
| `mark_scheme` | none stored in `@1`; the engine `@1` default is yes-only by entry (D-CT-1, X-1 option (a)) | S6, S8, X-1 |
| `tie_break_chain` | none in `@1`; D-CT-4 is a fixed rule here, not a chain | S6 |
| `entries[]`, `judges[]` | as K0 | K0 |
| `marks[]` | `{official_id, entry_id, value}` | K0 |

**Ballot shape per judge.** One current ballot per judge (S2). A mark is **yes only** (D-CT-1, approved 2026-10-24;
CT-B alternates not adopted): it means "call back", and an entry without a mark from that judge is not called back by
them. A judge may save selections across heats but cannot submit the final ballot until exactly `T` eligible couples
are selected (D-CT-2).

| Ballot property | Rule | Basis |
|---|---|---|
| How many callbacks each judge gives | **Exactly `T` eligible couples across the entire callback round**, not `T` per heat. Eligible = not scratched and not a no-show (X-5) | **D-CT-2**, approved 2026-10-24 |
| Callbacks counted per heat or across the round | Across the whole round; this needs the same panel in every heat (X-7) | **D-CT-9**, approved 2026-10-24 |
| Per role (leaders and followers separately) | Never; callbacks are by entry only (`scored_by: entry`) | **D-CT-7**, approved 2026-10-24 |
| Feedback | never engine input | S9 |

## 4. Outputs

K0 `EngineOutput` `rows[]`, one per entry:

| Field | Meaning | Basis |
|---|---|---|
| `advanced` | `true` = called back into the next round; `false` for entries not called back; **not set on any row when advancement is blocked** (`tie_over_capacity`) | S6, K0 §6, D-CT-4 |
| `output.tally` | the entry's tally = count of yes marks (D-CT-3) | S2 (trace) |
| `output.callback_rank` | position by tally, highest first; equal tallies share a position | S8, D-CT-3 |
| `placement` | never set: entries not called back get no placement (D-CT-6) | D-CT-6 |
| `output.label` | `"Semi-final"` for entries not called back (D-CT-6, wording as the owner gave it) | D-CT-6 |
| `rating_band`, `tie_group` | not set | — |

The engine never writes the next round. Advancement takes effect only through `apply_competition_round_advancement`
after the round is approved (K0 §6).

## 5. Algorithm

1. **Check engine availability.** `callback_tally@1` with this spec approved; otherwise `COMP_ENGINE_NOT_AVAILABLE`
   (K0). The round exists only because the organizer explicitly turned callbacks on in Advanced (D-CT-8); the engine
   never infers a callback round from entry counts.
2. **Check round type** is `preliminary` and `advancement_method = promote_callback` (S6); otherwise
   `COMP_ENGINE_UNSPECIFIED_CASE`.
3. **Read the target** `T = round.target_advancement_count`. If null: `COMP_ENGINE_UNSPECIFIED_CASE` (V3); the
   organizer must set `T` before ballots open (D-CT-5). Note: `create_simple_competition` never sets it (S11), so every
   existing `@1` callback round has `T = null` today.
4. **Eligible entries** `E` = entries minus scratched and no-show entries (X-5). If `T ≥ |E|`: every eligible entry
   advances, the callback round is not danced, and no ballots are required (D-CT-5). Emit and stop.
5. **Validate input** against §7; the first failure stops the calculation.
6. **Tally each eligible entry** = the count of yes marks (D-CT-3). A higher count ranks higher.
7. **Order entries** by tally, highest first; equal tallies share a position. Let `t*` be the tally at position `T`
   (the `T`-th highest tally) and `A` the entries with tally `≥ t*`.
   - `|A| = T`: `A` advances.
   - `|A| > T` (tie at the cutoff) and `|A| ≤` the final's configured couples-per-heat capacity (10D): all of `A`
     advance (D-CT-4).
   - `|A| >` that capacity: advancement is blocked, fail closed, reason `tie_over_capacity`; no row sets `advanced`
     (D-CT-4).
8. **Emit rows** (§4) and the trace (§8). Entries not called back get `advanced = false`, no placement and the label
   "Semi-final" (D-CT-6). The tally is staff information only; nothing carries into the Final (D-CT-10). Never read
   the clock, database, randomness, names or entry numbers (S2).

## 6. Tie-break chain

| Situation | Rule | Basis |
|---|---|---|
| Entries tied entirely inside or entirely outside the cut | No tie-break needed: all advance or none do | §5 |
| Tie at the cutoff (entries with the same tally as the `T`-th position) | Advance **all** tied entries when the final can safely accommodate the resulting count (≤ the final's configured couples-per-heat capacity from 10D) | **D-CT-4**, approved 2026-10-24 |
| Same tie, count would exceed that capacity | **Advancement is blocked** (fail closed, reason `tie_over_capacity`). Not decidable by a manager | D-CT-4 |
| Manager advancement decision (former option (c)) | **REJECTED** by the owner | D-CT-4 |
| Callback runoff among tied couples | **Candidate only**, not authorized as an automatic rule. A separately approved, auditable tie-break process must be specified and successfully completed before advancement can proceed | D-CT-4 |
| `@1` chain | none (schema 1) | S6 |
| Excluded | UCWDC "ties at the cut advance"; WSDC Chief Judge raw scores; random draw; entry number | S10, S2 |

Owner wording for D-CT-4 is quoted in §10. "Approved floor capacity" = the final round's configured
couples-per-heat capacity from 10D (owner, 2026-10-24: "floor capacity = 10D final heat capacity"). T greater than
that capacity with no tie is not addressed by the owner's rule and is not checked by the engine; see §11.

## 7. Invalid-input handling

First failure stops the calculation; no partial result. Proposed `reason` values under
`COMP_ENGINE_INVALID_INPUT` (to be mirrored by the K0 contract owner).

| # | Condition | Result | Basis |
|---|---|---|---|
| V1 | Engine key/version unknown or spec not approved | `COMP_ENGINE_NOT_AVAILABLE` | K0 |
| V2 | Round not `preliminary` / not `promote_callback` | `COMP_ENGINE_UNSPECIFIED_CASE` | S6 |
| V3 | `target_advancement_count` null | `COMP_ENGINE_UNSPECIFIED_CASE`: the organizer must set `T` before ballots open (**D-CT-5**, approved 2026-10-24). `T ≥` eligible entries is not a failure: everyone advances, no ballots | D-CT-5 |
| V4 | No `mark_scheme` (every `@1` program today) | The engine `@1` default scheme is yes-only, by entry (**D-CT-1** and **X-1** approved 2026-10-24); no stored scheme is required | D-CT-1, X-1 |
| V5 | `scored_by = role` or `input = callback_retire` | `COMP_ENGINE_UNSPECIFIED_CASE`: callbacks are by entry only (**D-CT-7**, approved) | D-CT-7 |
| V6 | Fewer than 3 judges, an even panel size, or heats with different panels | `COMP_ENGINE_UNSPECIFIED_CASE` (**X-3**, **X-7**, approved 2026-10-24) | X-3, X-7 |
| V7 | Mark from an official not on the panel | invalid `official_not_on_panel` | S4, K0 §9 #2 |
| V8 | Mark for an entry not in the round | invalid `entry_not_in_round` | K0 §9 #3 |
| V9 | More than one mark for (judge, entry) | invalid `duplicate_mark` | S2 |
| V10 | Mark value other than yes (for example an alternate) | invalid `mark_not_in_scheme` | D-CT-1 |
| V11 | A judge does not have exactly `T` yes marks on eligible entries, counted across the whole round | invalid `callback_count` | D-CT-2, D-CT-9 |
| V12 | Assigned judge with no ballot | lock step (K0 O1); if it reaches the engine: `COMP_ENGINE_UNSPECIFIED_CASE` | K0 O1 |
| V13 | Scratched / no-show entry in `entries[]` | Excluded from the calculation and recorded in the trace (**X-5**); marks on an excluded entry are not counted, so a judge left without exactly `T` eligible selections fails V11 until a corrected ballot version is entered | X-5 |
| V14 | Input spans more than one dance | Run once per dance (**X-6**, approved 2026-10-24); combined result not supported, fails closed (`COMP_ENGINE_UNSPECIFIED_CASE`) | X-6 |
| V15 | Tie at the cutoff makes the advancing count exceed the final capacity (or the capacity is missing) | `COMP_ENGINE_UNSPECIFIED_CASE`, reason `tie_over_capacity` (proposed): advancement is blocked, no manager-selected advancement, until a separately approved auditable tie-break process exists and completes (**D-CT-4**) | D-CT-4 |

## 8. Determinism and trace

| Requirement | Basis |
|---|---|
| Same input → identical output and trace; no clock, network, database or randomness | S2, K0 §5 |
| Fixed order: judges by `letter`, entries by `entry_id`; equal tallies listed by `entry_id` in the trace only (listing order never decides advancement) | K0 §5 |
| Behaviour change ships as `callback_tally@2`; locked programs keep `@1` | S2, S3 |
| Hashes computed by the server per K0 | K0 §5 |

**Trace content** (`{step, rule, data}` records):

1. `engine` — key, version, spec reference.
2. `inputs` — profile, round, `T`, scheme, judge letters, entry ids, full mark table.
3. `validation` — V1…V15 pass/fail, including each judge's count of eligible selections.
4. `tally` — per eligible entry: which judges called it back, and the tally (count of yes).
5. `order` — positions with shared positions shown.
6. `cut` — `T`, the number of eligible entries, the tally at position `T`, the entries at or above it, the final capacity `cap`, and the outcome (advance all, or blocked with `tie_over_capacity`).
7. `result` — `advanced` per entry.
8. On failure: `failure` with code, reason and offending ids.

## 9. Worked examples (golden-fixture candidates)

Judges J1–J3; entries 11–18; `T = 4`; mark = yes only (D-CT-1); each judge selects exactly `T` eligible couples across
the whole round (D-CT-2); tally = count of yes (D-CT-3). The final's configured couples-per-heat capacity (10D) is
`cap`; fixtures say which value they assume. "Called back" = `advanced = true`; entries not called back get no
placement and the label "Semi-final" (D-CT-6).

**F-CT-01 — clean cut.** `cap = 8`. J1 {11, 12, 13, 14}; J2 {11, 12, 13, 15}; J3 {11, 12, 14, 16}. Each judge has 4.

| Entry | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
|---|---|---|---|---|---|---|---|---|
| Tally | 3 | 3 | 2 | 2 | 1 | 1 | 0 | 0 |
| Position | 1= | 1= | 3= | 3= | 5= | 5= | 7= | 7= |
| Advanced | yes | yes | yes | yes | no | no | no | no |

The 4th-highest tally is 2 (entry 14); the entries with tally ≥ 2 are 11, 12, 13, 14, which is exactly `T`. No tie
extends the cut, so capacity does not matter. Expected: 11–14 advance; 15–18 get the label "Semi-final", no placement.

**F-CT-02 — tie at the cutoff.** J1 {11, 12, 13, 14}; J2 {11, 12, 13, 15}; J3 {11, 12, 14, 15}. Tallies: 11 = 3,
12 = 3, 13 = 2 (J1, J2), 14 = 2 (J1, J3), 15 = 2 (J2, J3), 16–18 = 0. The 4th-highest tally is 2, so entries with
tally ≥ 2 are 11, 12, 13, 14, 15 = 5 couples, one more than `T`.

| Final capacity | Expected |
|---|---|
| `cap = 8` (or any `cap ≥ 5`) | All five advance (D-CT-4: advance all tied couples when the final can safely accommodate them) |
| `cap = 4` (any `cap < 5`) | Fail closed: advancement blocked, reason `tie_over_capacity` (proposed code; entries 13, 14, 15 listed). No manager-selected advancement (option (c) rejected). The separately approved, auditable tie-break process is not yet specified, so the round stays blocked |

**F-CT-03 — target not set.** F-CT-01 with `T = null` (as every `create_simple_competition` round today, S11) →
`COMP_ENGINE_UNSPECIFIED_CASE` (V3): the organizer must set `T` before ballots open (D-CT-5).

**F-CT-04 — target covers everyone.** Four eligible entries 11–14, `T = 4` (`T ≥` eligible entries). Expected:
all four advance and the callback round is not danced (D-CT-5); no ballots are needed.

**F-CT-05 — wrong number of callbacks.** F-CT-01 but J2 selects 5 entries (or 3). Every judge must select exactly
`T` eligible couples, so: `callback_count` (V11). Fewer than `T` cannot be submitted either.

**F-CT-06 — alternate mark.** J1 marks an entry as an alternate. Only yes marks exist (D-CT-1) → `mark_not_in_scheme`
(V10).

**F-CT-07 — two heats.** Heat 1 holds 11–14, heat 2 holds 15–18; the panel is J1–J3 in both heats. Each judge
selects exactly 4 across the whole round (for example J1 selects 11, 12 in heat 1 and 15, 16 in heat 2: valid; 2 per
heat is not required). Tally and cut are computed across the round (D-CT-9). If the two heats do not have the same
panel: `COMP_ENGINE_UNSPECIFIED_CASE` (V6/X-7).

**F-CT-08 — invalid inputs** (each starts from F-CT-01 with one change):

| Case | Change | Expected |
|---|---|---|
| a | Mark for entry 99 | `entry_not_in_round` (V8) |
| b | J1 calls back 11 twice | `duplicate_mark` (V9) |
| c | Mark from official J9 | `official_not_on_panel` (V7) |
| d | An alternate mark | `mark_not_in_scheme` (V10) |
| e | Scheme `scored_by: role` | `COMP_ENGINE_UNSPECIFIED_CASE` (V5, D-CT-7) |
| f | Round type `final` | `COMP_ENGINE_UNSPECIFIED_CASE` (V2) |
| g | Entry 13 scratched in 10D | 13 is excluded (X-5). J1 and J2 each have only 3 eligible selections → `callback_count` (V11) until their ballots are corrected by a new ballot version. J3 never marked 13 and is unaffected |
| h | `cap` not supplied | `COMP_ENGINE_UNSPECIFIED_CASE` when a tie needs it (V15); not needed when there is no tie |

**F-CT-09 — determinism.** F-CT-01 with `marks[]` shuffled → identical output and trace hash.

## 10. Owner decisions needed

Engine-specific:

| ID | Question | Rule (owner approved 2026-10-24) | Status |
|---|---|---|---|
| D-CT-1 | What is a callback mark? | **APPROVED 2026-10-24 (Stage 2): yes only (CT-A).** CT-B (alternates) is not adopted. | Rule (approved) |
| D-CT-2 | How many callbacks must each judge give? | **APPROVED 2026-10-24.** Owner: "Judges select exactly T couples across the entire callback round, not T per heat. They may save selections across heats but cannot submit their final ballot until exactly T eligible couples are selected." Eligible = not scratched and not a no-show (X-5). | Rule (approved) |
| D-CT-3 | What is the tally? | **APPROVED 2026-10-24:** the count of yes marks; a higher count ranks higher. | Rule (approved) |
| D-CT-4 | Tie straddling the cut | **APPROVED 2026-10-24.** Owner: "Advance all couples tied at the cutoff when the final can safely accommodate them. If that would exceed the approved floor capacity, do not permit an arbitrary manager-selected advancement decision. Require a separately approved, auditable tie-break process. Until that process is specified and successfully completed, advancement remains blocked. A callback runoff among tied couples is a candidate approach, but is not yet authorized as an automatic rule." Option (c), a manager advancement decision, is **REJECTED**. "Callback runoff" is a **candidate only**, not an authorized rule. Approved floor capacity = the final round's configured couples-per-heat capacity from 10D (owner, Stage 3, 2026-10-24: "floor capacity = 10D final heat capacity"). | Rule (approved); over-capacity process **NOT SPECIFIED, advancement blocked** |
| D-CT-5 | Who sets `T` and when; what if it is unset or `≥` entries? | **APPROVED 2026-10-24:** the organizer must set `T` before ballots open. If `T ≥` eligible entries, everyone advances and the callback round is not danced. | Rule (approved) |
| D-CT-6 | Placement or label for entries not called back | **APPROVED 2026-10-24:** no placement, only the label "Semi-final" (recorded as the owner gave it). | Rule (approved) |
| D-CT-7 | Callbacks per role? | **APPROVED 2026-10-24:** by entry only, never per role. | Rule (approved) |
| D-CT-8 | When does a callback round exist? | **APPROVED 2026-10-24:** only when the organizer turns it on explicitly in Advanced. There is no automatic entry-count threshold. | Rule (approved) |
| D-CT-9 | Counted per heat or across the round? | **APPROVED 2026-10-24:** across the whole round. This needs X-7's same panel in every heat. | Rule (approved) |
| D-CT-10 | Carry-forward into the Final | **APPROVED 2026-10-24:** nothing is carried into the Final. The tally is information for staff only. | Rule (approved) |

Cross-cutting X-1…X-7 (same IDs in all three specs): **APPROVED by the owner 2026-10-24 ("Approve K1 Stage 1 (X-1..X-7) as recommended")**. D-CT items: see the table above (Stage 2, approved).

| ID | Rule | Status |
|---|---|---|
| X-1 | **APPROVED 2026-10-24: option (a).** Programs locked to `@1`/`@3` are scored with the profile metadata plus the engine `@1` defaults written in this spec. No `@4` re-creation is required. | Rule (approved) |
| X-2 | **APPROVED 2026-10-24.** Fail closed on every unspecified case: no guessed result, a trace entry, and the manager sees the reason. | Rule (approved) |
| X-3 | **APPROVED 2026-10-24.** This engine needs at least 3 judges and an odd panel size; any other panel fails closed (`COMP_ENGINE_UNSPECIFIED_CASE`). Studio engines also refuse a round with `chief_judge_tiebreak` or `score_roles_separately` set to true. | Rule (approved) |
| X-4 | **APPROVED 2026-10-24, consistent with K0 O1.** A round cannot lock with an absent assigned judge. A manager removes the judge from the panel (audited), and the reduced panel must still satisfy X-3. | Rule (approved) |
| X-5 | **APPROVED 2026-10-24.** Scratched and no-show entries are excluded from calculation. They are not placed last. | Rule (approved) |
| X-6 | **APPROVED 2026-10-24.** A multi-dance round yields one result per dance. A combined result is not supported in v1 and fails closed. | Rule (approved) |
| X-7 | **APPROVED 2026-10-24.** Every heat in a round must have the same panel; otherwise the round fails closed. | Rule (approved) |

## 11. Engineering findings (not engine rules; recorded for the F-slice owner)

- `create_simple_competition` (`20261108090000`) creates the "Callbacks + Final" rounds with
  `target_advancement_count` unset, so no existing callback round can be calculated until the organizer sets `T` (D-CT-5, approved) and the
  value is set.
- `add_competition_division` (`20261108090000`) copies the rounds of the category's first existing division. Only
  when the category has no division yet does it create a single Final, and then with `scoring_method` `none` for a
  program whose scoring is `callback_tally` (it keeps only `ordinal_majority` / `proficiency_rating`). Such a
  division has neither a callback round nor an `ordinal_majority` Final.
- D-CT-4 only covers a tie that pushes the advancing count past the final capacity. A `T` that already exceeds the
  final capacity with no tie is not addressed by the owner's rule and is not checked by the engine; the organizer
  setup (K1 setup fixes, #322) is where `T` would be validated against capacity if the owner wants that.
- D-CT-6 is recorded as the owner gave it: no placement, "only the label 'Semi-final'". The label is attached to the
  entries that are *not* called back; the owner may want to confirm the intended wording.
- The over-capacity tie-break process (a callback runoff is a candidate only) is not specified; advancement for that
  case stays blocked until it is approved and completed.
- Marks on an entry scratched after ballots were submitted leave a judge without exactly `T` eligible selections;
  the engine fails closed (V11) and a corrected ballot version is needed (K0 P1). If the owner prefers a different
  treatment that is a new decision.

## 12. Explicitly not in this spec

- No UCWDC, WSDC or NDCA callback rule or value (S10).
- No retire / inverted callbacks (S6 promote only).
- Creating next-round heats and approval are the K0 lifecycle (K0 §4, §6).
- Feedback never becomes advancement (S9).
