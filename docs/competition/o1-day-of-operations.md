# Competition O1 — day-of round operations

Migration `20270106090000_competition_o1_day_of.sql` (K0 slot). Git-only: not applied to any hosted database.
Walkthrough of Schedule & Heats is still required before merge or deploy (owner, 2026-10-24).

## Writers (SECURITY DEFINER, manager only via `can_manage_event_competition`, request-id idempotent)

| Function | Transition | Preconditions |
|---|---|---|
| `schedule_competition_round(round, request)` | draft → scheduled | live published schedule version exists; ≥1 heat of the round in it; no non-cancelled heat of the round without a version (heats parked in draft or superseded versions are ignored) |
| `start_competition_round(round, request)` | scheduled → active | same heat rule re-checked; a `callback_tally` round must have `target_advancement_count` set (`COMPO1_CALLBACK_TARGET_UNSET`, because the round freezes once active); E1 `competition_round_panel_ready(round)` true. Called directly (hard dependency, migration preflight requires E1); the round is locked FOR UPDATE first. No panel assigned = refused (test B1) |
| `cancel_competition_round(round, reason, request)` | any non-terminal → cancelled | reason 3–500 chars; round not `published`/`complete`; no `event_competition_result_publications` row (looked up if the table exists); no heat of the round `staging`/`active`; its not-yet-run (draft/scheduled, open) heats are cancelled with it so a numbered heat shared with another round is not blocked |
| `advance_competition_floor_heat(floor_heat, to, request)` | scheduled → staging → active → complete, for every scoring heat of the numbered heat | floor heat in the live published version; all scoring heats in the expected state, `lock_state = 'open'`, and their rounds `active`; at most one `active` heat per floor (null floor = one shared floor) |

Each call takes a per-event advisory lock, then a row lock on the round (or the scoring heats), so concurrent calls serialize
(`test_T_competition_o1_concurrency.sh`: real second connection). Replaying a request id returns `replayed: true`; reusing it for another
operation/round/actor is `COMPO1_REQUEST_REUSE`.

Audit: `event_competition_round_transition_events` (append-only, same trigger as 10A history). K0 reserves `event_competition_result_events`
for F2 (slot 0104), which is not merged, so O1 owns this minimal table. F2 can fold it into `result_events` later.

## Status guard scope (who may write `event_competition_rounds.status`)

`_compo1_guard_round_status` (before insert/update of status):

1. API roles (`anon`, `authenticated`, `service_role`, `authenticator`) can never change status, and can only insert `draft`.
2. `cancelled` and `complete` are terminal for every role.
3. The O1 edges (→ `scheduled`, → `cancelled`, `scheduled → active`) additionally need an audit row for that round/from/to written in the same transaction.
4. Every other edge must be in the static K0 list below, and is then allowed for non-API roles, i.e. SECURITY DEFINER functions running as the owner. Edges: draft→scheduled→active⇄ballots_locked→calculated→approved→published→complete; calculated/approved/published→ballots_locked (F2 correction); any non-terminal→cancelled. Skip-ahead edges (draft→active, scheduled→calculated, anything→draft) raise `COMPO1_ROUND_EDGE`; a new edge means amending the guard in the owning migration. Expected writers:
   E2 `active ⇄ ballots_locked`; F2 `ballots_locked → calculated → approved`, `→ complete`, correction reopen; F3 `approved → published`.

What this does **not** stop: another owner-run definer function setting `calculated`/`approved`/`published` without going through its K0 writer.
That is a convention enforced by review and by each owner's own tests, not by the database. Proposed (not built): allow-list per edge, where each
owner migration registers its edge in a table (`from`, `to`, `writer_function`) and the guard checks `pg_trigger_depth`/the calling function
via an evidence row like the O1 edges. Decision for the coordinator.

`_compo1_guard_heat_status` applies the same pattern to `staging`/`active`/`complete` on scoring heats (entering or leaving needs an O1 audit row;
API roles refused).

`_compo1_guard_publish_during_run` refuses publishing a new schedule version once any heat of the event is `staging`/`active`/`complete`:
10D copies heats into a new version as `scheduled`, which would erase day-of progress.

## Heat lock order

Advancing a heat requires `lock_state = 'open'` (10A). Completing a heat does not lock it: the path `open → staging → active → complete → locked`
(and `certified` via approval) works through `set_competition_heat_lock_state`, so E2's "every heat locked before ballots lock" holds. Test C16b.
The lock ledger is not written by O1 transitions (it records lock state only); O1 status changes are in the O1 audit table.

## Console

`/app/events/[id]/competition/day-of` (one nav entry "Day-of"): on the floor / up next with entries and a link-only "Scratch" to SC1's
`registrations/scratch/[entryId]` (404 until SC1 merges), rounds with schedule/start/cancel, and the numbered running order. Mobile first.
Does not edit `competition/layout.tsx` or the access helper.

## Open owner decisions (out of scope here)

1. Public or entrant-portal heat sheet / running order (visibility policy not decided).
2. Timing and announcer features.
3. Mid-event running-order edits: currently blocked after the first heat is called (see guard above). Allow with status carry-over?
4. Cancelling a round does not cancel its heats; they stay in the running order. Remove them via a new version before the first heat runs, or cancel with them?
5. Whether a round with `unplaced` (no version) heats should block scheduling (currently yes).

## Review follow-ups applied (independent Opus review)

- Publishing / reopening / inserting a schedule version takes the per-event day-of lock and is refused once any heat has run (`COMPO1_RUN_IN_PROGRESS`), so a publish cannot interleave with an in-flight heat call (concurrency script).
- A heat that has started running cannot change round, division, floor heat or version (`COMPO1_HEAT_FROZEN`).
- Round cancel cancels the round's unrun heats (see above).
- Helper functions are not executable by `service_role` (audit rows cannot be forged).
- `complete` is terminal; if F2 needs to reopen after `complete`, the guard must be amended.
- Notes for E2/F2: `set_competition_heat_lock_state` can lock a heat that never ran; a heat locked while `active` cannot be completed until reopened. The console shows one current heat for the whole event (single floor); multi-floor display is not built.
