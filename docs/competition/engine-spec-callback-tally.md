# Engine spec — `callback_tally` (Studio v1, K1)

Status: **DRAFT for owner approval** · Baseline: origin/main `973f36da` · Docs only (no code, no SQL).
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
| More than one callback round (e.g. preliminary → semifinal → final) | NOT SPECIFIED IN PROVIDED SOURCE → **D-CT-8** | S6 shows one |
| Profiles | `studio_simple@1` programs created with "Callbacks + Final". `@3` has no callbacks option; how a `@3` division gets a callback round is NOT SPECIFIED → **D-CT-8** | S6, S7 |
| When a preliminary is required ("entry volume") | NOT SPECIFIED IN PROVIDED SOURCE → **D-CT-8** | S1 |
| Not this engine | Applying advancement (creating Final heats) — F2 after approval | K0 §6 |

## 3. Inputs

The K0 `EngineInput` envelope for one round. Fields this engine reads:

| Field | Shape | Basis |
|---|---|---|
| `engine_key`, `engine_version` | `"callback_tally"`, `1` | S2, S3 |
| `profile` | `{key, version}` from the program lock | S3 |
| `round` | `{id, round_type, target_advancement_count, advancement_method}` | S11 |
| `mark_scheme` | none in `@1` (schema 1); shape decided by **D-CT-1** and stored per **X-1** | S6, S8 |
| `tie_break_chain` | none in `@1` → **D-CT-4** | S6 |
| `entries[]`, `judges[]` | as K0 | K0 |
| `marks[]` | `{official_id, entry_id, value}` | K0 |

**Ballot shape per judge.** One current ballot per judge (S2). What a mark is, is NOT SPECIFIED IN PROVIDED SOURCE
(**D-CT-1**). Candidate shapes:

- **CT-A yes only.** A mark means "call back"; an entry without a mark from that judge is not called back by them.
  (`MarkScheme.input: callback_yes_alternates` with only `yes`.)
- **CT-B yes + alternates.** As CT-A plus ranked alternates; the owner supplies every value. Governing-body values
  are not used (§0).

| Ballot property | Rule | Basis |
|---|---|---|
| How many callbacks each judge gives | NOT SPECIFIED IN PROVIDED SOURCE → **D-CT-2** (exactly the target / at most the target / any number) | — |
| Callbacks counted per heat or across the round | NOT SPECIFIED IN PROVIDED SOURCE → **D-CT-9** | — |
| Per role (leaders and followers separately) | NOT SPECIFIED IN PROVIDED SOURCE → **D-CT-7**; until decided only `scored_by: entry` | S6 has no role scoring |
| Feedback | never engine input | S9 |

## 4. Outputs

K0 `EngineOutput` `rows[]`, one per entry:

| Field | Meaning | Basis |
|---|---|---|
| `advanced` | `true` = called back into the next round | S6, K0 §6 |
| `output.tally` | the entry's tally (D-CT-3) | S2 (trace) |
| `output.callback_rank` | position by tally, highest first; equal tallies share a position | S8 (`advancement_ranking`) — ordering rule pending D-CT-3 |
| `placement` | NOT SPECIFIED IN PROVIDED SOURCE (do entries that are not called back receive a place?) → **D-CT-6**; until decided, never set | — |
| `rating_band`, `tie_group` | not set | — |

The engine never writes the next round. Advancement takes effect only through `apply_competition_round_advancement`
after the round is approved (K0 §6).

## 5. Algorithm

1. **Check engine availability.** `callback_tally@1` with this spec approved; otherwise `COMP_ENGINE_NOT_AVAILABLE`
   (K0).
2. **Check round type** is `preliminary` and `advancement_method = promote_callback` (S6); otherwise
   `COMP_ENGINE_UNSPECIFIED_CASE`.
3. **Read the target** `T = round.target_advancement_count`. If null: NOT SPECIFIED IN PROVIDED SOURCE
   (**D-CT-5**) → fail closed. Note: `create_simple_competition` never sets it (S11), so every existing `@1`
   callback round has `T = null` today.
4. **Validate input** against §7; the first failure stops the calculation.
5. **Tally each entry** — NOT SPECIFIED IN PROVIDED SOURCE (**D-CT-3**). The key name says *tally* (S1) but no
   approved source defines it. Candidates: under CT-A, the number of judges who called the entry back; under CT-B,
   the sum of owner-supplied values.
6. **Order entries** by tally, highest first. Equal tallies share a position (no tie is broken for ordering alone).
   Basis: S6 "call the best dancers back" — a higher tally means more judges called the entry back; the ordering
   rule itself is part of D-CT-3.
7. **Draw the cut.** Entries in positions `1…T` are called back. If entries with equal tallies straddle position `T`
   (some would be inside, some outside), the outcome is NOT SPECIFIED IN PROVIDED SOURCE (**D-CT-4**) → fail closed.
   If `T ≥` number of entries: NOT SPECIFIED (**D-CT-5**) → fail closed.
8. **Emit rows** (§4) and the trace (§8). Never read the clock, database, randomness, names or entry numbers (S2).

## 6. Tie-break chain

| Situation | Rule | Basis |
|---|---|---|
| Equal tallies entirely inside or entirely outside the cut | No tie-break needed: all advance or none do | §5 step 6–7 |
| Equal tallies straddling the cut | NOT SPECIFIED IN PROVIDED SOURCE → **D-CT-4** | — |
| `@1` chain | none (schema 1) | S6 |
| Excluded | UCWDC "ties at the cut advance"; WSDC Chief Judge raw scores; random draw; entry number | S10, S2 |

Candidates for D-CT-4: (a) every tied entry advances (the next round exceeds `T`); (b) no tied entry advances
(the next round is below `T`); (c) a manager **advancement decision** records who advances, with a reason, as the
separate record the model already names (S5) — the engine reports the tie and the round waits; (d) an owner-stated
tie-break rule (e.g. a judge-ordered rule) before (a)–(c).

## 7. Invalid-input handling

First failure stops the calculation; no partial result. Proposed `reason` values under
`COMP_ENGINE_INVALID_INPUT` (to be mirrored by the K0 contract owner).

| # | Condition | Result | Basis |
|---|---|---|---|
| V1 | Engine key/version unknown or spec not approved | `COMP_ENGINE_NOT_AVAILABLE` | K0 |
| V2 | Round not `preliminary` / not `promote_callback` | `COMP_ENGINE_UNSPECIFIED_CASE` | S6 |
| V3 | `target_advancement_count` null, or `≥` entries | `COMP_ENGINE_UNSPECIFIED_CASE` until **D-CT-5** | S11 |
| V4 | No `mark_scheme` (every `@1` program today) | `COMP_ENGINE_UNSPECIFIED_CASE` until **D-CT-1** / **X-1** | S6 |
| V5 | `scored_by = role` or `input = callback_retire` | `COMP_ENGINE_UNSPECIFIED_CASE` (D-CT-7) / invalid `scheme_mismatch` | S6 |
| V6 | No judges / below minimum panel | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-3** | NOT SPECIFIED |
| V7 | Mark from an official not on the panel | invalid `official_not_on_panel` | S4, K0 §9 #2 |
| V8 | Mark for an entry not in the round | invalid `entry_not_in_round` | K0 §9 #3 |
| V9 | More than one mark for (judge, entry) | invalid `duplicate_mark` | S2 |
| V10 | Mark value not in the scheme (e.g. an alternate under CT-A) | invalid `mark_not_in_scheme` | D-CT-1 |
| V11 | A judge's callback count breaks the D-CT-2 rule | invalid `callback_count` | D-CT-2 |
| V12 | Assigned judge with no ballot | lock step (K0 O1); if it reaches the engine: `COMP_ENGINE_UNSPECIFIED_CASE` | K0 O1 |
| V13 | Scratched / no-show entry in `entries[]` | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-5** | NOT SPECIFIED |
| V14 | Round's heats cover more than one dance | `COMP_ENGINE_UNSPECIFIED_CASE` until **X-6** | NOT SPECIFIED |
| V15 | Tie straddling the cut | `COMP_ENGINE_UNSPECIFIED_CASE` until **D-CT-4** | NOT SPECIFIED |

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
3. `validation` — V1…V15 pass/fail, including each judge's callback count.
4. `tally` — per entry: which judges called it back (and alternates, if CT-B), the tally.
5. `order` — positions with shared positions shown.
6. `cut` — `T`, the entries inside, outside, and any straddling tie with the D-CT-4 rule applied.
7. `result` — `advanced` per entry.
8. On failure: `failure` with code, reason and offending ids.

## 9. Worked examples (golden-fixture candidates)

Judges J1–J3; entries 11–18; `T = 4`; shape CT-A; each judge calls back exactly 4 (D-CT-2 candidate "exactly the
target"); tally = number of callbacks (D-CT-3 candidate). Expected outputs are frozen only once those decisions are
made.

**F-CT-01 — clean cut.** J1 {11, 12, 13, 14}; J2 {11, 12, 13, 15}; J3 {11, 12, 14, 16}.

| Entry | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
|---|---|---|---|---|---|---|---|---|
| Tally | 3 | 3 | 2 | 2 | 1 | 1 | 0 | 0 |
| Position | 1= | 1= | 3= | 3= | 5= | 5= | 7= | 7= |
| Advanced | yes | yes | yes | yes | no | no | no | no |

The tie between 11 and 12 (and 13/14) sits inside the cut, so no tie-break is needed (§6).

**F-CT-02 — tie straddles the cut.** J1 {11, 12, 13, 14}; J2 {11, 12, 13, 15}; J3 {11, 12, 14, 15}.
Tallies: 11 = 3, 12 = 3, 13 = 2, 14 = 2, 15 = 2, 16–18 = 0. Two places remain after 11 and 12; three entries share
tally 2.

| D-CT-4 candidate | Expected |
|---|---|
| (a) all tied advance | 11–15 advance (5 > T) |
| (b) no tied entry advances | 11, 12 advance (2 < T) |
| (c) manager advancement decision | engine reports the tie; round waits for the recorded decision |
| Undecided | `COMP_ENGINE_UNSPECIFIED_CASE` (V15) |

**F-CT-03 — target not set.** F-CT-01 with `T = null` (as every `create_simple_competition` round today, S11) →
`COMP_ENGINE_UNSPECIFIED_CASE` (V3) until D-CT-5.

**F-CT-04 — target covers everyone.** Four entries 11–14, `T = 4` → `COMP_ENGINE_UNSPECIFIED_CASE` (V3) until
D-CT-5 (candidates: everyone advances; the round should not exist).

**F-CT-05 — wrong number of callbacks.** F-CT-01 but J2 calls back 5 entries. Under "exactly the target" or "at
most the target": `callback_count` (V11). Under "any number": valid; 15's tally becomes 2 if J2's fifth callback is
15, and the cut then straddles (→ F-CT-02 rules).

**F-CT-06 — alternates (CT-B, symbolic).** J1: yes {11, 12, 13}, alternate-1 {14}. With owner values `y` (yes) and
`a1` (alternate-1), J1 contributes `y` to 11, 12, 13 and `a1` to 14. Tally = sum per entry. No numeric expectation
until the owner supplies the values (D-CT-1).

**F-CT-07 — two heats.** Heat 1 holds 11–14, heat 2 holds 15–18, same panel. Whether each judge gives 4 callbacks
across the round or a quota per heat is D-CT-9; until decided, a round with more than one heat →
`COMP_ENGINE_UNSPECIFIED_CASE`.

**F-CT-08 — invalid inputs** (each starts from F-CT-01 with one change):

| Case | Change | Expected |
|---|---|---|
| a | Mark for entry 99 | `entry_not_in_round` (V8) |
| b | J1 calls back 11 twice | `duplicate_mark` (V9) |
| c | Mark from official J9 | `official_not_on_panel` (V7) |
| d | An alternate mark under CT-A | `mark_not_in_scheme` (V10) |
| e | Scheme `scored_by: role` | `COMP_ENGINE_UNSPECIFIED_CASE` (V5) |
| f | Round type `final` | `COMP_ENGINE_UNSPECIFIED_CASE` (V2) |
| g | Entry 13 scratched in 10D | `COMP_ENGINE_UNSPECIFIED_CASE` (V13) until X-5 |

**F-CT-09 — determinism.** F-CT-01 with `marks[]` shuffled → identical output and trace hash.

## 10. Owner decisions needed

Engine-specific:

| ID | Question | Candidates (no recommendation) | Until decided |
|---|---|---|---|
| D-CT-1 | What is a callback mark? | CT-A yes only; CT-B yes + alternates with owner-supplied values | Engine not available |
| D-CT-2 | How many callbacks must each judge give? | exactly `T`; at most `T`; any number | Engine not available |
| D-CT-3 | What is the tally, and does a higher tally always rank higher? | count of yes (CT-A); sum of values (CT-B) | Engine not available |
| D-CT-4 | Tie straddling the cut | (a) all advance; (b) none advance; (c) manager advancement decision with reason (S5); (d) a stated tie-break rule first | Fail closed |
| D-CT-5 | Who sets `T` and when; what if it is unset or `≥` entries? (`create_simple_competition` never sets it.) | organizer sets it before ballots; a Studio default; everyone advances when `T ≥` entries | Fail closed |
| D-CT-6 | Do entries not called back receive a placement or a label (e.g. "Callback round")? | no placement; shared placement after the finalists; a label only | No placement |
| D-CT-7 | Are callbacks ever per role (leaders and followers separately) in Studio events? | entry only; per role for specified formats | Entry only |
| D-CT-8 | When is a callback round used? What "entry volume requires a preliminary" (S1) means; how a `@3` division gets one (no `@3` callbacks option, S7); more than one callback round? | an entry-count threshold; organizer choice in Advanced; a `@4` "Callbacks + Final" option | No `@3` callback rounds; one callback round in `@1` |
| D-CT-9 | Callbacks counted per heat or across the round when the round has several heats | across the round; per-heat quota | Multi-heat rounds fail closed |
| D-CT-10 | Is anything from the callback round carried into the Final? (S6 scores the Final separately with `ordinal_majority`.) | nothing; tally shown as information only | Nothing carried |

Cross-cutting (same IDs and wording in all three specs — decide once):

| ID | Question | Until decided |
|---|---|---|
| X-1 | Where do decided values live? S8 says scales, values and tie-break chains are profile parameters, so they belong in a new `studio_simple@4`. Programs already locked to `@1`/`@3` (S3: never silently changed) then either (a) score with `@1`/`@3` metadata plus engine `@1` defaults written in this spec, or (b) cannot be scored and must be re-created under `@4`. | Fail closed for locked `@1`/`@3` programs |
| X-2 | Confirm fail-closed for every case this spec marks unspecified (no guessed result; manager sees the reason). | Fail closed (this draft's rule) |
| X-3 | Minimum panel size; are one-judge and even-sized panels allowed? (Rounds already carry `minimum_panel_size`, nullable, from `20260622_west_coast_swing_foundation_v1`; no Studio value is specified. The same migration added `chief_judge_tiebreak` and `score_roles_separately`: Studio engines refuse a round with either set to true, since both are WSDC concepts.) | `COMP_ENGINE_UNSPECIFIED_CASE` |
| X-4 | A judge assigned but absent (K0 O1). | Round cannot lock (K0 default) |
| X-5 | Scratched / no-show entries (10D) at calculation time: excluded, placed last, or other? | `COMP_ENGINE_UNSPECIFIED_CASE` |
| X-6 | A round whose heats cover several dances: one result per dance, or one combined result? | `COMP_ENGINE_UNSPECIFIED_CASE` |
| X-7 | A round split across several scoring heats (10D default capacity 8 per heat). For this engine see D-CT-9. | `COMP_ENGINE_UNSPECIFIED_CASE` |

## 11. Engineering findings (not engine rules; recorded for the F-slice owner)

- `create_simple_competition` (`20261108090000`) creates the "Callbacks + Final" rounds with
  `target_advancement_count` unset, so no existing callback round can be calculated until D-CT-5 is decided and the
  value is set.
- `add_competition_division` (`20261108090000`) copies the rounds of the category's first existing division. Only
  when the category has no division yet does it create a single Final, and then with `scoring_method` `none` for a
  program whose scoring is `callback_tally` (it keeps only `ordinal_majority` / `proficiency_rating`). Such a
  division has neither a callback round nor an `ordinal_majority` Final.

## 12. Explicitly not in this spec

- No UCWDC, WSDC or NDCA callback rule or value (S10).
- No retire / inverted callbacks (S6 promote only).
- Creating next-round heats and approval are the K0 lifecycle (K0 §4, §6).
- Feedback never becomes advancement (S9).
