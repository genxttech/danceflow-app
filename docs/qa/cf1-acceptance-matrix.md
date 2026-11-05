# CF1-C acceptance matrix (Callback -> Final advancement, OD-17 scope)

Package C of CF1 (`cf1/c-qa-acceptance`). Source of truth for the scenarios: `docs/competition/callback-to-final-advancement-design.md`
(branch `competition-cf1-callback-final-design`, rev 21, `80e114a9`) section 13 (SCN rows), section 7.4, A.9.5 (gates U1-U85), A.9.6 (RB1).
Harness: QA-A (PR #341 / #297), `docs/qa/competition-acceptance-harness.md`. Specs: `e2e/tests/competition-cf1-advancement-acceptance.spec.ts`,
`e2e/tests/competition-cf1-regression-acceptance.spec.ts`; helpers `e2e/helpers/cf1Acceptance.ts`; config `e2e/playwright.cf1.config.ts`.

**Phase 1 status (this document): specs written and syntax/type-checked; nothing has been run.** Every row below is therefore
**BLOCKED** (named dependency) or **NOT RUN**, never PASSED. Statuses are updated by the Phase 2 run report, not by editing this file.

## Rules the specs enforce

1. UI-driven journey. No row is written to advance a scenario. The only writes are the Q1 base seed and its teardown (existing QA-A practice).
2. Read-only evidence. CF1 and F2 tables have no grants for any API role (A0 contract, "Tables"), so the service-role client cannot read them.
   They are read with `docker exec ... psql` inside `begin read only` against the dedicated container `supabase_db_cf1c-qa` only (the helper refuses any
   other container name). Tables the service role may read (heats, entries, rounds) still use the service-role client.
3. Zero leftover rows. `afterAll` removes the seed, then asserts: every CF1 table has 0 rows for the run's events, no `event_competition_*` table has any,
   and the events are gone. A leftover fails the run.
4. Capability probe. Before any scenario, the stack is inspected read-only (A0..A6 objects, pinned-function markers, applied versions in the `202701%` block) and
   `CF1_B_PRESENT=true` states that the app under test includes B. A scenario missing a dependency is skipped with a `BLOCKED` annotation naming it.
5. Half-run is not a pass. A scenario that cannot run its main half (e.g. no UI path to make a couple unavailable) ends BLOCKED even if a clean half ran.
6. Stripe TEST keys (`sk_test_` / `rk_test_`) only, from the process environment; the key must report `livemode=false`.

## Run protocol (Phase 2 only; not started)

Own Supabase CLI project `cf1c-qa`, ports **586xx** (checked free on 2026-10-30: nothing listening in 58600-58699; re-check at start). Does not touch
`danceflow-e2e-qa` or `danceflow-local-staging`.

1. Take the DB slot: atomic `mkdir C:/Dev/.cf1-db-slot.lock`, write `owner.txt` (session, purpose, time); release (remove the directory) when the stack stops.
   Check free disk >= 15 GB and memory in use < 29 GB before starting; stop above 29 GB.
2. `supabase start` for `cf1c-qa`; build the schema from the July baseline plus migrations in version order on the **composed chain** (HL1 -> A1 `085000` -> A0 `090000`
   -> A4a `091000` -> A2 `092000` -> A3 `093000` -> A5 `094000` -> A6 `095000`), recording each failure; apply `e2e/setup/qa-reference-data.sql` with `danceflow.qa_stack=local`.
3. Build the SUT (B + chain) on a local unpushed `qa-sut` branch, production build; start the app with Turbopack/`next start`,
   `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true`, local keys, Stripe TEST keys, `stripe listen --forward-connect-to .../api/payments/webhook`.
4. `E2E_LOCAL_DB_CONTAINER=supabase_db_cf1c-qa CF1_B_PRESENT=true E2E_RUN_DIR=<scratchpad>/runs/<ts> npx playwright test -c e2e/playwright.cf1.config.ts`, twice back to back.
5. `node e2e/tools/acceptance-report.mjs <run>/results.json --out docs/qa/cf1-c-acceptance-<date>`; commit only the report and its JSON twin.
6. Also run the U85 SQL suites (below) on the same chain, **before** the Playwright run, in the same slot. Stop the stack; release the slot.
7. Independent review of the run evidence by a separate session before the result is cited as acceptance.

## Scenario matrix (Playwright; ids match `spec.title` prefixes so the report builder keys on them)

"Needs" lists the package / PR whose contract the scenario consumes. Provisional UI wording lives in `CF1_UI` (helper) until B exists.

| ID | Spec | Prerequisites (Needs) | Event / steps | Pass criterion (all must hold) | Status now |
|---|---|---|---|---|---|
| SCN-11.4a tie within capacity | advancement | A0 #370, A1 #364, A2 #365, A3 #366, B; Final capacity control (B5/B6) | Event P: 6 couples, T=4, capacity 8; judges' picks give tallies 3,3,0,2,2,2; lock, calculate, 2nd manager approves, Advance | 5 result rows `advanced=true` (the five at/above the 4th tally), 6th false; exactly one active advancement, generation 1, `advanced_count=5`, entries = those five; one Final floor+scoring heat holding exactly them; one `advancement_applied` audit row; callback round still `approved`; panel text "tie at the cut"; no override/pick control | BLOCKED (A0..A3 + B not composed; no B build) |
| SCN-11.5 Final from advanced couples, one heat | advancement (continues P) | as 11.4a + SCN-11.4a PASS | Final panel built; entrants/public do not see the roster before publication; Final round and heat started; 3 judges rank; lock; calculate; 2nd manager approves | Sheet lists exactly the advanced couples; 3 Final ballots; result rows = the five; no `COMP_ORDINAL_MULTI_HEAT`; exactly one Final heat, `certified` | BLOCKED (as above) |
| SCN-11.4b tie over capacity | advancement | as 11.4a | Event Q: capacity 4, T=4, same picks | calculate completes; 0 `advanced=true` rows; panel shows `tie_over_capacity` and the tied couples (rows 3,4,5); Approve refused `COMP_ADVANCEMENT_BLOCKED` (or disabled), Advance absent/disabled; 0 advancement/heat/entry rows, 0 `advancement_*` audit rows, no Final heat | BLOCKED (as above) |
| SCN-11.4b-cap capacity cannot be raised (B5) | advancement | A0, B capacity screen | After 11.4b, try to raise Final capacity to 8 | refusal alert; round configuration still `max_entries_per_heat = 4` | BLOCKED (A0, B; capacity screen unknown) |
| SCN-11.5c-cancelled cancelled-Final arm, no advancement (OD-10, U84) | advancement | A0 (`cf1_guard_advancement_correction`), B; a UI to cancel a Final round | On event Q cancel the Final round, open a correction on the callback round | refused `COMP_ADVANCEMENT_FINAL_CANCELLED`; callback status not `ballots_locked`; no advancement rows | BLOCKED (A0, B; cancel-round UI not known to exist: if absent stays BLOCKED, SQL U84 carries it) |
| SCN-11.5b correct callback before Final ballots | advancement | A0..A3, B, CX1 #347 (corrected ballots) | Event R: apply generation 1; manager opens correction with reason; judge 3 files corrected callback ballot; recalculate; approve; Advance | one `advancement_revoked` (`source_correction_opened`); generation 1 heat `cancelled` and kept; generation 2 advancement active with a roster different from generation 1; exactly one non-cancelled Final heat with a higher heat number; audit: 2x `advancement_applied`, 1x `advancement_revoked` | BLOCKED (as above) |
| SCN-11.5c-locked correction while Final heat locked | advancement (continues R) | SCN-11.5b PASS; HL1 #350 | Early-lock the Final heat (round `scheduled`), open correction | refused `COMP_ADVANCEMENT_FINAL_LOCKED`; no revocation row added; no audit row added (aborted transaction writes nothing); callback status unchanged | BLOCKED (as above) |
| SCN-11.5c-started correction after Final started | advancement (continues R) | SCN-11.5b PASS | Start the Final round and heat (no ballot), open correction | refused `COMP_ADVANCEMENT_FINAL_STARTED`; same no-write assertions | BLOCKED (as above) |
| SCN-11.5c-ballot correction after a Final ballot (O5) | advancement (continues R) | SCN-11.5b PASS | One Final judge ballot filed, open correction | refused `COMP_CORRECTION_LATER_ROUND_BALLOTS`; same no-write assertions | BLOCKED (as above) |
| SCN-R80 non-callback round unchanged | regression | A1, A2, A3 | Final only (ordinal majority), 4 couples, clean | lock, calculate, approve succeed; placements 1-4; 0 exclusion rows | BLOCKED (A1..A3 not composed) |
| SCN-R81 each scoring setup the UI offers | regression | A1..A3; UI to cancel/refund one registration | Setups enumerated at run time from the "Scoring setup" select; per setup with a driver (today only Final only), clean run then a cancelled-registration couple | clean round OK; unavailable couple refused at lock with `COMP_ROSTER_ENTRY_UNAVAILABLE`, round stays unlocked. Setups without a driver are listed in the evidence, not passed | BLOCKED (A1..A3; no known UI path to make a couple unavailable; Ballroom has no single-dance wizard helper, multi-dance on hold) |
| SCN-R82 comped/manual entry without registration | regression | A1, A2; a manual-entry screen | Probe registrations page for a manual-entry control | if no control: BLOCKED (harness writes no rows). If a control appears the spec fails loudly until authored against it | BLOCKED (no manual-entry UI known; SQL U82 carries it) |
| SCN-R83 exclusion-free rounds | regression (after R80) | A3; SCN-R80 PASS | Read stored evidence of the R80 round | no `reason:"excluded"` content, 64-hex hash, version `approved` (approve recomputes the hash). Does **not** prove byte-identity with pre-CF1 text: that is U72/U83 in SQL + vitest | BLOCKED (A3) |
| SCN-X1 exclusion (OD-20) | regression | A1, A2, A3, A5 #367, B; UI to cancel a registration | Make a couple unavailable; manager requests exclusion with reason; requester cannot co-sign; other manager co-signs; lock, calculate, approve | exclusion rows `exclude_requested`, `exclude_cosigned`; review shows "Excluded", never "No-show"; lock/calc/approve succeed after | BLOCKED (A5, B) |
| SCN-X2 exclusion reversal | regression | A5, B; UI to clear the cause | - | - | BLOCKED (no UI to clear predicate P; SQL U65 carries it) |

Not yet scripted because they depend on a build that does not exist (listed so none is forgotten): **withdrawal / reinstatement UI (A6 #368 + B)**
(U37, U39, U41, U48, U49, U62, U63: SQL suites carry the DB side), **Final-start roster refusals through the UI** (`COMP_ADVANCEMENT_ROSTER_STALE` /
`_INCOMPLETE` / `_BELOW_MINIMUM`: SQL U29, U36, U45, U56), **40P01/55P03 retry message through supabase-js** (U28, B) and **block-mode callback never danced** (U18).
Each becomes a spec only when its screen exists; until then they are BLOCKED on "B app".

## Gate coverage (A.9.5) - what C owns, what it only consumes

| Gate | C's role | How | Status now |
|---|---|---|---|
| U80 non-callback regression | owns the QA-A half | SCN-R80 | BLOCKED (composed chain) |
| U81 each discipline family and scoring method | owns the QA-A half | SCN-R81 (+ SQL enumeration from the applied chain by A3) | BLOCKED |
| U82 comped/manual entries | UI half only if a screen exists | SCN-R82; SQL suite carries it | BLOCKED |
| U83 byte-identical evidence | consequence only; byte parity is A3's SQL/vitest | SCN-R83 | BLOCKED |
| U85 existing E2/F2/NS1/CX1/HL1/SS1/O1 suites | owns the re-run | run `sql-tests/` suites for those features on the composed chain in the slot, unchanged except A2's HL1 md5 line; record pass/fail per suite | NOT RUN (needs composed chain) |
| U58/U59/U65 (UI half) | optional UI proof of the resolution routes | SCN-R81, SCN-X1 | BLOCKED |
| U18 block-mode callback not danceable | needs QA stack | not scripted (needs block-mode fixture) | BLOCKED (B + fixture) |
| U28 `40P01` surfaces through PostgREST | B-owned test; C observes | not scripted | BLOCKED (B) |
| U66 F3 exit | cannot run | F3 absent | BLOCKED (F3) |
| All other U-gates (SQL/concurrency) | not C's | A0..A6 own them | n/a |

## Release-gate reading

RB1 (b) needs U80-U83 and U85 to pass on the composed chain with the OD-17 protections applied. Until Phase 2 runs, **none of that is established**; nothing in this
document is acceptance evidence.
