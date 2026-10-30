# CF1 package A4a — contract (callback-target guard, OD-21)

Migration `20270120091000_competition_cf1_a4a_callback_target_guard.sql` (rollback in `rollback/`, suite `sql-tests/test_T_competition_cf1_a4a_target_guard.sql`).
Design: `callback-to-final-advancement-design.md` (rev 21) §3.4.3, §4.6 b, OD-2 A, OD-21, A.9.1/A.9.2, gates U67 and U77. Stack: HL1 → A1 → A0 (`…090000`) → **A4a (`…091000`)**.
Consumers: **B** (readiness refusal, error mapping), **A4** (the OD-15 minimum depends on A4a), A0's own suites (unchanged).

## What A4a adds

`COMP_CALLBACK_TARGET_BELOW_MINIMUM` — a callback target `T` below two is refused wherever the F2 setup guard of A0 already refuses `T` above the Final's capacity. The after-state of a **callback configuration** becomes `2 <= T <= capacity` whenever `T` is not null.

| Property | Value |
|---|---|
| Code | `COMP_CALLBACK_TARGET_BELOW_MINIMUM` |
| SQLSTATE | `P0001` (like `COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY`) |
| Retryable | no (permanent: the organizer must enter a larger target) |
| Message shape | `COMP_CALLBACK_TARGET_BELOW_MINIMUM: <text>`; the code is the prefix up to the first `:`. Text, T edit / insert / successor insert / capacity edit: `the callback target (T) must be at least 2 and no more than the Final's capacity (C).` Program lock: `callback round <round uuid> has target T but its Final holds C; a callback target must be at least 2 and no more than the Final's capacity, so fix it before publishing.` Capacity RPC: `the callback target (T) must be at least 2 and no more than the capacity (C).` The same text (with the other code) is used for `COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY`; B should map by **code**, not by text. |
| Grants | none; A4a adds no object that a client can call |

## Scope (U77)

The check is applied **only** to a callback configuration: a `preliminary` round of a program with `advancement_method = 'promote_callback'` whose successor (`sequence_number + 1`, same division) is a `final` round. It never fires for:

* a Final-only division, including a one-couple "Final only" division, and the Final round itself (even with `target_advancement_count = 1`);
* any round that is not `preliminary`: the O1 day-of fixture's R3 is a `final` round (sequence 1) of a Final-only division with `T = 1` (verified at `test_T_competition_o1_day_of.sql` l.130, l.260), and the E2/CX1/NS1 fixtures use `qualifying` callback_tally rounds with `T = 2`;
* a program that is not `promote_callback`;
* a preliminary round without a successor Final, with a semifinal successor, or with a non-adjacent Final;
* `T` null (D-CT-5: set before ballots). Existing `T < 2` rows are **not** retro-failed; they surface at the next write of `T`, of the Final's capacity (`max_entries_per_heat`), at program lock, and at A4's apply.

## Arms (all inherited from A0; A4a only changes the verdict)

| Arm | Write | Where |
|---|---|---|
| T edit / insert of the callback round | `target_advancement_count` on the preliminary round | `cf1_guard_callback_target_capacity` arm 1 |
| Successor insert / capacity edit | INSERT of the Final, or a change of `max_entries_per_heat` | `cf1_guard_callback_target_capacity` arms 2/3 |
| Reasoned capacity RPC | `set_competition_round_heat_capacity(uuid,integer,text,uuid)` | A0 RPC calls the same check |
| Publish / program lock | `profile_locked_at` null → not null on the program | `cf1_guard_callback_target_program_lock` |

## Composition with A0 (how A4a extends it)

* A0 published `_cf1_callback_target_check(p_t integer, p_capacity integer) returns text` as the extension point and says A4a replaces exactly this function. A4a does so with `create or replace` (same signature, `immutable`, `search_path = public, pg_temp`, no grants): `T is null → null`, `T < 2 → COMP_CALLBACK_TARGET_BELOW_MINIMUM`, `T > capacity → COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY`, else null. The minimum is checked first.
* A0's four raise sites printed `does not fit the Final's capacity`, which is wrong for `T < 2`. A4a rewrites **only the message format string** in three functions (`cf1_guard_callback_target_capacity`, `cf1_guard_callback_target_program_lock`, `set_competition_round_heat_capacity(uuid,integer,text,uuid)`) by an exact-fragment `replace(pg_get_functiondef(...))`, asserted to occur (preflight) and asserted gone (postflight). Arguments, codes, triggers and grants are untouched. This is **not** an md5 pin, so unrelated A0 edits do not break it; a change to those exact fragments makes the A4a preflight fail loudly. If A0 changes those messages, A4a must be re-read.
* Order of triggers on `event_competition_rounds`: `cf1_guard_callback_target_capacity` fires before `cf1_guard_round_capacity` (alphabetical), so a direct capacity write behind `T = 1` reports `COMP_CALLBACK_TARGET_BELOW_MINIMUM`, not `COMP_CAPACITY_DIRECT_WRITE`.
* Apply as the owner of the A0 functions (`postgres`).

## Rollback (position 5)

`rollback/…091000…_rollback.sql` restores A0's check function body and A0's three message fragments, and asserts the restored behaviour. No data is created, so it is unconditional. It must run before A0's rollback (the A0 rollback drops the function). It refuses if A0's objects are missing.

## Mismatches found against the A0 contract (A0 owns the fix)

1. The contract's trigger table lists `cf1_guard_callback_target_capacity` as `BEFORE INSERT OR UPDATE OF target_advancement_count, configuration, sequence_number, round_type`; the migration creates it `before insert or update of target_advancement_count, configuration` only. Consequence: changing `round_type` or `sequence_number` of an existing round (for example turning a Final-only `final` round that carries `T = 1` into a `preliminary` round, or inserting a Final behind it by renumbering) does not run the check. The program-lock arm and A4's apply still catch it at publication and apply; the setup guard does not. A4a did not widen the trigger (A0's object).
2. The A1 error-code catalogue `_cf1_error_codes()` does not list `COMP_CALLBACK_TARGET_BELOW_MINIMUM`; A1 owns that function. Not required for A4a to work.

## For B (readiness)

`src/lib/competition/callbackTarget.ts` exports the TypeScript twin: `CALLBACK_TARGET_MINIMUM` (2), `CALLBACK_TARGET_BELOW_MINIMUM_CODE`, `callbackTargetBelowMinimum(t)`, `callbackTargetCheck(t, capacity)` (twin of the SQL function), `guardedCallbackRounds({rounds, promoteCallbackProgramIds})` (the scope above) and `callbackTargetBelowMinimumFindings(...)` (existing rows to report as a readiness refusal), and `callbackTargetBelowMinimumMessage()` (organizer text). `parseCallbackTarget` now rejects 0 and 1 with that message (the organizer entry point `updateCompetitionCallbackTargetAction` uses it, so the user sees the text before the database refusal). The readiness page is B's; A4a does not touch it.
