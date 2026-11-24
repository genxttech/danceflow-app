# OD-16 Studio defect: panel readiness (E1) disagrees with the scoring rule (E2 and the engines)

**Status: read-only investigation and a RECOMMENDATION only.** Nothing implemented, no migration file, no hosted database touched.
Read at base `origin/release/website-embeds`. Not reproduced by running SQL (local Postgres is a heavy-lock job; the proof below is by code reading
with exact references). Part of PR #834; owner decision OD-16 (2026-11-23): Option B now, with the Studio/Custom judging model preserved for initial
activation **subject to fixing this internal inconsistency**.

## 1. The three rules that disagree

| Where | File and object | Rule applied |
|---|---|---|
| Round start (O1) and the readiness panel (E1) | `src/lib/supabase/migrations/20270101090000_competition_e1_officials.sql`, `competition_round_panel_status` (about lines 768-811); `competition_round_panel_ready` | Ready when `judge_count >= v_min`, where `v_min` defaults to **1** and is raised only by `round.configuration->>'min_panel_judges'` (`greatest(1, n)` for a 1-2 digit integer). **No odd-panel rule. No scoring-method rule.** Counts assigned, lettered judge/chair officials that are active, verified and team members. Does not look at absence. |
| Ballot lock (E2) | `20270102090000_competition_e2_ballots.sql`, `_compe2_panel_rule` (line 588) and `_compe2_round_blockers` (line 721, `panel_ok` at line 788); consumed by `lock_competition_round_ballots` (about line 1203, `COMP_PANEL_SIZE`) | `ordinal_majority` and `callback_tally`: at least **3 present judges and an odd count**; `proficiency_rating`: at least 1; anything else: rule unknown, `panel_ok` false. Counts present (non-absent) lettered judges and **does not** filter inactive or non-team-member officials. |
| Engines | `src/lib/competition/results/engines/common.ts` line 271-272 (X-3), via `studioOrdinalMajority.ts` / `studioCallbackTally.ts` | `judges.length < 3 || judges.length % 2 === 0` fails closed with `COMP_ENGINE_UNSPECIFIED_CASE` / `panel_size`. |

The E1 migration comment says it plainly: "K0 and the engine specs fix no minimum, so none is invented here beyond 1" (line 764-765), written before E2/F1 fixed X-3.

## 2. Where `min_panel_judges` is set and validated

- **Not set by any application code.** `grep` of `src/` finds the key only in the E1 migration and in `sql-tests/test_T_competition_e1_officials.sql` (lines 286-287 raise it to 5 to prove the bar moves). `createCompetitionRoundAction` (`src/app/app/events/[id]/competition/actions.ts` line 303) inserts a round with no `configuration`, so the default is `{}` and `v_min = 1`. The wizard and readiness pages do not write it.
- **No CHECK, no trigger, no RPC validates it.** The only writer path is a direct update of `event_competition_rounds.configuration` by a manager through the `competition_manage` RLS policy (`20260620_competition_foundation_v1.sql` line 365-367, `for all ... can_manage_event_competition`). Later hardening of that policy was not re-verified here. E2's `_compe2_guard_round_config` freezes only `scoring_method` and `target_advancement_count`, not `configuration`.
- UI: `src/lib/competition/officials/contract.ts` lines 84-93 computes "need N more judges" as `max(0, (min_judges ?? 1) - judge_count)`, so the officials page tells an organizer with 1 judge that nothing more is needed.

## 3. Every reachable path from "READY" to "stuck or failed closed"

All assume a round with scoring method `ordinal_majority` or `callback_tally`.

1. **Default config, 1 or 2 judges.** `min_panel_judges` absent, one lettered judge assigned: E1 `ready = true`. O1 `start_competition_round` (line 409-411) proceeds. The round is active and the judge can ballot. `lock_competition_round_ballots` then raises `COMP_PANEL_SIZE` (E2 line 1203). Two judges: same.
2. **Even panel.** Four judges: E1 ready; E2 `panel_ok` false (`v_present % 2 = 1` fails); lock refused; engines would fail closed anyway.
3. **Absence after start.** Three judges assigned, one recorded absent through E2 attendance (`record_competition_judge_attendance`): the present panel is 2, even and below 3. E1 never re-checks; E2 lock refuses (X-4).
4. **Explicit low configuration.** A manager sets `configuration = {"min_panel_judges": 1}` (or 2, 4): accepted, behaves as paths 1-2. A value above 3 is legal and harmless; an **even** value does not make the panel odd.
5. **E1/E2 count different people.** E1 counts only active, verified, team-member officials; E2 `_compe2_round_judges` (line 446) counts every lettered assignment. A deactivated or removed official can make E2 count 3 where E1 counted 2 (or the reverse for OJ-1 authority), so the two checks can both be satisfied by different sets.
6. **Chair counted as a judge by both E1 and E2.** A chair with a letter is a voting judge in both (OD-16 non-voting-chair question: not changed here).

**Consequence, not just a message.** Once the round leaves draft/scheduled the panel is frozen (E1 `guard_competition_panel_assignment`, `COMP_PANEL_FROZEN`, line 174-237), so the organizer **cannot add the missing judges**. Absence can only shrink the panel. The only exit from an active round that cannot lock is `cancel_competition_round` (O1; refused once a publication exists) and rebuilding the round. A started round with ballots entered is therefore unrecoverable without cancelling.

Reproduction script (recommended, NOT RUN): in an isolated Postgres with the E1/E2/O1 migrations, create a published ordinal round, assign one lettered judge, assert `competition_round_panel_ready = true`, start the round, submit a ballot, call `lock_competition_round_ballots` and assert `COMP_PANEL_SIZE`; repeat with two and four judges, and with three then one absence.

## 4. Smallest recommended correction (not implemented)

Align readiness to the scoring rule that already governs locking; do not invent a new number.

1. **E1 readiness reads the E2 rule.** Redefine `competition_round_panel_status` (and keep `competition_round_panel_ready` unchanged) so that `v_min` is `greatest(1, _compe2_panel_rule(round.scoring_method).min_judges, configured)` when the rule is known, and `ready` additionally requires an odd assigned count when `odd_required`. Report `min_judges`, `odd_required` and `missing` entries (`panel_size`, `panel_even`). For an unknown method (`none`) keep today's behavior, since such a round cannot lock at all. Because `_compe2_panel_rule` is `immutable` and has `revoke all` from API roles, the definer function can call it. Redefinition of a deployed function: md5-pinned exact-fragment replace, as OJ-1 and PV-1 did; dependency order E2 before this change.
2. **Setter guard.** A `BEFORE INSERT OR UPDATE OF configuration` trigger on `event_competition_rounds`: if `configuration` contains `min_panel_judges`, require an integer in 1..99 and, for a known scoring method, at least the E2 rule minimum; reject a value that would weaken the rule (`COMP_PANEL_MIN_BELOW_RULE`). The odd requirement is not configurable.
3. **Count the same people.** Make E2 `_compe2_round_judges`-based counting and E1 counting agree by having the E1 check apply the same filters as E1 and adding the same active/verified/team-member filters to the E2 count, or document why E2 counts all. (Smallest: leave E2 unchanged and let E1 be the stricter gate.)
4. **Warn on absence.** Absence recording keeps its audited removal behavior but the UI shows "recording this absence leaves N present, below the odd minimum of 3" (copy only; no E2 change). Optional second step: refuse such an absence unless the organizer confirms.
5. **UI copy.** `officials/contract.ts` computes need from `min_judges` and `odd_required` returned by the corrected status; add the sentence "Studio methods need at least 3 judges and an odd panel (DanceFlow policy, K1 X-3)".

**Label:** this is DanceFlow policy (K1 X-3), not a governing-body rule; the three bodies' panel rules are separate (section 6C of the design doc).

## 5. Dependencies, tests, effect on existing data

- **SQL dependencies:** E2 `_compe2_panel_rule` (immutable, exists); E1 status function redefinition (md5 pin); one trigger on `event_competition_rounds` (name sorting after `compe2_guard_round_config` is not required; it is independent). It interacts with OD-05 s4 only through the shared aggregator (`_compoc_blockers_panel_size` can call the same corrected function; one source of truth).
- **App dependency:** `src/lib/competition/officials/contract.ts` (need computation) and its test `officials.e1.test.ts`.
- **Tests to add:** readiness false at 1, 2, 4 judges for ordinal/callback and true at 3, 5; proficiency true at 1; unknown method unchanged; setter rejects `min_panel_judges` 1 and 2 for ordinal and accepts 5; configuration without the key untouched; E1/E2 parity test with an inactive official; absence copy test; rollback restores the previous function text by md5.
- **Existing fixtures that will change (to enumerate at implementation):** `test_T_competition_e1_officials.sql` (readiness assertions; lines 286-287 use 5, still valid) and every O1/E2/F2/CF1 SQL fixture that starts a round with fewer than 3 lettered judges for an ordinal or callback round. Those fixtures currently pass only because E1 does not apply the rule.
- **Existing rows:** no application path writes `min_panel_judges`, so rounds with a value below 3 should not exist except by hand edits. The correction must not edit rows; a read-only audit query (rounds with `configuration ? 'min_panel_judges'` and value < 3 or even) belongs in the implementation preflight. DEV/PROD row counts are NOT CHECKED (no hosted access was used).
- **Rollback:** restore the previous `competition_round_panel_status` text (md5-pinned) and drop the trigger; no data change.
