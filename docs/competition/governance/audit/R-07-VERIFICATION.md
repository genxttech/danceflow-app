# R-07 verification: Studio scoring fail-closed controls

**Owner ratification:** R-07 YES as DanceFlow policy, 2026-11-23 (recorded in `OWNER-DECISIONS.md` on `claude/comp-audit-owner-decisions`).
**Scope:** independent, read-only verification before initial activation. No scoring-engine change, SQL, migration, merge, deployment or activation.
**Base:** `origin/release/website-embeds` @ `49dbaee1b` (branch `claude/r07-scoring-verify-021f3c`). Verified: 2026-11-23.
**Governance:** [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md). Studio/Custom release gates are separate from the requirements of
future governing-body profiles; a missing body capability blocks only that profile while OD-01 holds.

## 1. Result in one paragraph

Every entry point that selects, stores, resolves, pins, ballots or calculates a scoring method was traced. No path was found by which
an unapproved, unknown, unsupported, rejected or legacy-unmapped method, or an unapproved ballot format, reaches an engine or accepts a
ballot (section 4). Two items are *gaps in depth, not bypasses* (section 7, F-1 and F-2) and one is a latent unreachable lookup defect
(F-3). **The SQL runtime suites were NOT RUN** (section 8), so every database claim below is code inspection plus static parity with the
TypeScript registry, not database execution. The body requirements named in R-07 items 8-10 are recorded NOT IMPLEMENTED
(register entries `R07-*`).

## 2. Evidence legend

| Tag | Meaning |
|---|---|
| **INSPECTED** | read in source; behavior inferred, not run |
| **EXECUTED-TS** | vitest run in this worktree (pure TypeScript, no database) |
| **STATIC-PARITY** | executed test that reads migration *text* and compares it to TypeScript; does **not** run SQL |
| **DEV-READ** | read-only query through `sb.sh dev-read` (aggregate counts only) |
| **NOT RUN** | not executed in this slice |

## 3. Executed evidence

| Run | Files | Tests | Result |
|---|---|---|---|
| New negative file `scoring/__tests__/r07.failclosed.test.ts` | 1 | 124 (123 pass + 1 intentional `it.fails` marker for F-3) | pass |
| `scoring/`, `ballots/`, `results/` (includes engines, calculate, evidence, publication) and `governance/` (the rule-register integrity test, now covering the ten `R07-*` entries); includes the new file | 27 (1 skipped) | 539: 537 pass, 1 expected fail, 1 skipped | pass |
| Mutation check on the new file: temporarily mapped `majority_rules` to the UCWDC key and flipped UCWDC to `approved`; the file reported 7 failures; the mutation was reverted (`git checkout`) and no source file differs from base | 1 | 7 failed as intended | file restored |
| `tsc --noEmit` | n/a | n/a | **NOT RUN** (full `tsc` is a heavy-lock job; CI runs it) |

## 4. Controls and entry points traced

| # | Entry point | Control | Evidence |
|---|---|---|---|
| E1 | Setup wizard preset (`configureStudioScoring`, `resolvePreset`, `selectablePresets`) | presets list only the two approved methods; `resolvePreset` re-resolves through `resolveMethod` + `selectableMethods` + `checkCompatibility`; unknown preset key refused | INSPECTED; EXECUTED-TS (`setup presets expose only approved methods`) |
| E2 | RPC `apply_competition_scoring_setup` (SS1) | draft program only; `studio_simple` only; patch-key allow-list; a `scoring_method` must be the legacy value of an `approved` method with an engine (else `COMP_ENGINE_NOT_AVAILABLE`) | INSPECTED (`20270116090000`, lines 140-180); NOT RUN in SQL |
| E3 | Direct writes to `event_competition_divisions.scoring_method_key/version` and `event_competition_rounds.scoring_override_*` | trigger `guard_competition_scoring_selection`: key+version pair, FK to the registry, `approved` and engine present, program unlocked draft only | INSPECTED (`20270113090000`, lines 205-275); STATIC-PARITY for the seed; NOT RUN in SQL |
| E4 | Registry content | `competition_scoring_methods` CHECK: `approved` iff engine id and ballot formats present; rows append-only (guard trigger) | INSPECTED; STATIC-PARITY (statuses/ids equal `SCORING_REGISTRY`) |
| E5 | Legacy `scoring_method` columns (programs/rounds CHECK) | storing is permitted for ten legacy values; **use** is blocked everywhere: map has 3 rows, others resolve `unmapped`, are never pinned as selectable, have no ballot format and no engine | INSPECTED; EXECUTED-TS; DEV-READ (section 6) |
| E6 | Round creation by templates/profiles (10B, 10C.5, profile v3, registration isolation), clone (K1), WCS foundation, legacy create actions (`actions.ts` lines 139 and 317) | all write only the legacy `scoring_method` column (clone copies it, does not copy `scoring_override_*`); none can name an unapproved *registry* method | INSPECTED (grep of every migration that inserts rounds; no API route touches scoring) |
| E7 | Lock/publish: trigger `pin_competition_program_scoring`, `competition_scoring_resolve`, `competition_round_scoring_effective_internal` | pin written at lock; live (unpinned) read is never `selectable`; selection frozen after lock | INSPECTED |
| E8 | Publish readiness `studioScoringReadiness` + `publishScoringBlockers` | draft unavailable/unknown selection and legacy/selection mismatch are **blockers**; unmapped legacy with no selection is a notice and the round counts as not configured | INSPECTED; EXECUTED-TS (`readiness: unsupported configurations are never a calculable round`) |
| E9 | Ballot entry: submit RPC and `_compe2_guard_ballot_insert` | `_compe2_format_for_scoring` returns no row for an unmapped value (`COMP_BALLOT_SCORING_METHOD_UNSUPPORTED`); `_compe2_format_approved` allows only `ordinal_rank@1`, `callback_yes@1` (`COMP_BALLOT_FORMAT_NOT_APPROVED`); format must equal the round's expected format | INSPECTED (`20270102090000`, lines 247, 291-297, 846-868); STATIC-PARITY |
| E10 | `_compe2_validate_marks` (L477) | refuses any format other than `ordinal_rank`/`three_band`; the `three_band` branch is reachable only after the approval gate (which refuses it) | INSPECTED; STATIC-PARITY |
| E11 | TypeScript `validateBallot` | unregistered (`COMP_BALLOT_SCORING_METHOD_UNSUPPORTED`) and unapproved (`COMP_BALLOT_FORMAT_NOT_APPROVED`) formats refused; medal-tier values refused as ranks | EXECUTED-TS |
| E12 | Results calculation (`calculateRound` -> RPC): `_compf2_engine_pin` + engine lookup | engine must be the pinned `selectable` method; the RPC refuses a requested key/version different from the pin (`COMP_ENGINE_NOT_AVAILABLE`); `lookupRegisteredEngine` knows only the two Studio engines | INSPECTED; EXECUTED-TS (registered engines, lookup) |
| E13 | Engines (X-6) | both engines refuse any run whose `danceIds.length != 1` with `COMP_ENGINE_UNSPECIFIED_CASE` / `multi_dance_unsupported`; refuse another engine key/version; a run contains no overall/combined field; each engine refuses the other's mark shape | EXECUTED-TS (zero, 2, 3 and 10 dances x both engines) |
| E14 | API routes, import | `src/app/api` has no scoring-method writer; no import path exists | INSPECTED (grep) |

## 5. R-07 items against the evidence

| R-07 item | Verdict | Where |
|---|---|---|
| 1. Only two methods selectable | holds (application EXECUTED-TS; database INSPECTED + STATIC-PARITY) | E1-E4, R07-DF-0001 |
| 2. `ordinal_rank@1` preserved, not modified to approximate a body | holds: no medal, Skating or Relative Placement format/engine/row exists | E9, R07-DF-0002 |
| 3. `proficiency_rating@1` rejected; all else fails closed | holds | E4, E9-E11, R07-DF-0003 |
| 4. `majority_rules` is not UCWDC Majority Rules; no silent reinterpretation | holds: not in the legacy map (TS and SQL seed identical), never resolves to a method | E5, R07-DF-0004 |
| 5. Unsupported mapping -> explicit error, no fallback | holds: `COMP_METHOD_LEGACY_UNMAPPED`; an unavailable explicit selection does not fall through to the legacy map | E5, E8 |
| 6. One independent result per dance, no combined placement | engine refusal of several/zero dances holds (X-6, EXECUTED-TS); per-dance result storage for multi-dance rounds is NOT verified here (open semantics) | E13, R07-DF-0005 |
| 7. Disclosure that DanceFlow does not calculate official aggregate Multi-Dance results | **specified as text only; not shown in any UI** | [R-07-MULTI-DANCE-DISCLOSURE-SPEC.md](R-07-MULTI-DANCE-DISCLOSURE-SPEC.md) |
| 8. UCWDC medal ballots, overall Multi-Dance, tiebreakers recorded NOT IMPLEMENTED | recorded | R07-UCWDC-0001, -0002 |
| 9. NDCA Skating System and multi-dance aggregate NOT IMPLEMENTED | recorded; citations re-read in the pinned PDF (below) | R07-NDCA-0001, -0002 |
| 10. WSDC callback and final scoring distinct; Studio ordinal not WSDC-compatible | recorded | R07-WSDC-0001 |

### Citation re-read (pinned PDFs, SHA-256 checked against the registry before reading)

- **NDCA** (`d1b73e1f...daa6b`, June 2026 Master v1): III.D.36 (Ten-Dance, all ten dances together) is on **printed p.23** (PDF p.30), not p.22 as in the ratification text; the book's own index lists "Ten-Dance Competitions, 23". III.D.44 (accumulated marks for multi-dance recalls; not for nine/ten-dance events) is on printed p.24 (PDF p.31). III.C.3.b(1)(d) (scrutineer computes multi-dance results under the Skating System, then adjusts for penalties) is on printed p.17 (PDF p.24); in the extracted text it sits directly under an Invigilator sub-item, which is the printed layout and was not interpreted. III.D.11 is on printed p.21.
- **UCWDC Scoring Format v16.9b** (`44290a06...7b02f`): Rule #3 (finals, majority mark) begins on PDF p.2; Rule #3.1 lists the medal thresholds HM, B, S, G, GH, GG; Rule #9 is on PDF p.5, Rule #10 on p.6, Rule #11 on p.7.
- **WSDC Registry Event Rules** (`140caae7...6b5`, footer Version 2026.1C): 3.4.9 (Callback for preliminaries, Relative Placement for finals) p.20; 3.4.9.d p.21; Section 5 (callback system) pp.22-23.

## 6. DEV read-only data check (DEV-READ, aggregate counts only)

Query run through `sb.sh dev-read` (read-only transaction; no writes; no PROD). No keys or personal data were read.

| Field | Value | Count | Compatibility |
|---|---|---|---|
| `event_competition_rounds.scoring_method` | `ordinal_majority` | 56 | mapped; scores through the approved engine |
| | `none` | 8 | unscored by design (no calculation expected) |
| | `relative_placement` | 9 | **unmapped: cannot be calculated**; readiness reports `COMP_SCORING_NO_METHOD` / `COMP_SCORING_LOCKED_UNSUPPORTED`; no data modified |
| `event_competition_programs.scoring_method` | `ordinal_majority` / `majority_rules` / `round_specific` | 1 / 1 / 1 | program-level value is not read by results scoring; `majority_rules` and `round_specific` are unmapped legacy labels |
| `event_competition_divisions` registry selection | none selected | 73 of 73 | all divisions fall back to the legacy map |
| `event_competition_rounds.scoring_override_*` | none | 73 of 73 | |
| `event_competition_scoring_pins` | no rows | 0 | no program locked with a pin on DEV |
| competition events by `competition_sanctioning` | `none` | 2 | no body declared |
| `competition_scoring_methods` / `competition_scoring_legacy_map` | identical to the repository seed (2 approved, UCWDC/NDCA/WSDC unavailable, proficiency rejected; 3 map rows) | | DEV matches the migration |

Zero rounds are `callback_tally` or `proficiency_rating`. The 9 `relative_placement` rounds and the 1 `majority_rules` program are the
only values that are already blocked. PROD was **not** read (not required for this slice; routine reads allowed).

## 7. Findings

| ID | Class | Finding | Disposition |
|---|---|---|---|
| F-1 | gap in depth (not a bypass) | The `programs`/`rounds` CHECK constraints, the legacy create actions (`createCompetitionProgramAction`, `createCompetitionRoundAction`) and the profile templates (`custom`, `none`, `proficiency_rating`) can still **store** `majority_rules`, `skating`, `wsdc_callback`, `relative_placement`, `custom`, `none`. They are blocked at every consumer, but the wizard-visible name `majority_rules` is a stored value that could be misread as UCWDC Majority Rules by a human reading raw data. | Recorded in R07-DF-0004; labels are the OD-19/OD-28 relabelling workstream's scope; no change here. |
| F-2 | gap in depth (not a bypass) | Coherence between the selected registry method and the legacy `scoring_method` (which picks the ballot format) is enforced in the app (`studioScoringReadiness`, `publishScoringBlockers`), not in SQL. A manager writing the tables directly could create selection=`studio_callback_tally` with legacy `ordinal_majority` and lock. Only approved engines are reachable, and each engine refuses the other's mark shape (EXECUTED-TS), so the result is a failed calculation, not a wrong one. | Recommend (not done): a SQL-side coherence check at pin time. No SQL change authorized. |
| F-3 | latent, unreachable | `ballotFormatForScoring` (`formats.ts`) indexes a plain object, so a prototype-chain name such as `constructor` returns a non-null value. Every stored scoring value is CHECK-constrained, so no row can reach it. Marked with `it.fails` in the new file. | Fix is a one-line `Object.hasOwn`; not made (no behavior change authorized). |
| F-4 | defence in depth (informational) | `_compe2_validate_marks` still contains a `three_band` branch. It is unreachable: `_compe2_format_approved` runs first in both the submit RPC and the insert trigger. | none |
| F-5 | documentation | The ratification text cites NDCA III.D.36 as p.22; the pinned PDF shows p.23. | Corrected in R07-NDCA-0001. |

No finding allows an unapproved method or ballot format to be selected-and-used.

## 8. NOT RUN / PENDING

- **SQL runtime suites** `sql-tests/test_T_competition_scoring_registry.sql` and `test_T_competition_e2_ballots.sql` (plus the F2 calculate suite): **NOT RUN.** The heavy-lock queue (`C:\dfr\heavy.queue`) held seven tickets and a running 70-minute job when this slice reached the point of needing the lock, well over the 45-minute limit, and nobody's work was displaced. Register entries `R07-DF-0001..0004` therefore stay `unverified`; `R07-DF-0005` (pure-engine X-6) is `verified_compliant`.
- `tsc --noEmit`: NOT RUN (heavy); CI will run it.
- Negative SQL cases (not written, would need the lock): `apply_competition_scoring_setup` with `majority_rules`/`custom`/`none`/`proficiency_rating`; direct `update` of `scoring_method_key` to each unavailable/rejected/unknown row; ballot insert with `three_band@1`; calculate RPC with a requested engine other than the pin. Their expected results are stated by the inspected code above.
- The Multi-Dance disclosure is spec only; no UI shows it.
- PROD data read: not performed.

## 9. Files in this change

Test-only: `src/lib/competition/scoring/__tests__/r07.failclosed.test.ts`. Docs: this report, the disclosure spec, ten register entries
(`R07-DF-0001..0005`, `R07-UCWDC-0001..0002`, `R07-NDCA-0001..0002`, `R07-WSDC-0001`) and one TRACKER line. No source, SQL or migration file changed.

## 10. Independent review (subagent, did not see these conclusions)

No bypass found. Confirmed F-2 (engine and ballot format come from different columns; SQL checks each is approved but not that they agree), F-3, F-4, F-1. Corrections applied: R07-DF-0005 wording narrowed to engine refusal; one test title corrected (seed rows compare key/version/status, not engine ids). Acknowledged weaknesses, not fixed: two static-SQL string tests are presence checks only; parity reads the original migrations (a later `create or replace` would not be seen; none exists in 2027*); missing negative cases for readiness on locked programs and `calculateRound` unavailable-engine paths. Not verified by the reviewer or by me: SQL runtime behavior, whether the publish RPC enforces readiness in the database, direct RLS manager updates.
