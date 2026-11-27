# OD-04: event delete guard (draft, Git-only)

Owner decision 2026-11-23: **Option A, BLOCK** (audit row X-18, `docs/competition/governance/audit/OWNER-DECISIONS.md`). Status: prepared in a
draft PR; **not applied to DEV or PROD**; applying SQL anywhere needs a separate owner approval.

## What was wrong
`events` had no delete guard. Every Competition OS table references `events(id)` ON DELETE CASCADE and `protect_competition_history_evidence`
(10A) deliberately allows a row to go once its parent event no longer exists, so one `delete from public.events` removed all ballots, results and
audit rows. Demonstrated on a local database before the fix (the ballot event row was gone after the delete). The results contract's claim that
deletion is blocked was false; it is corrected in the same PR.

## What the guard does
`20270219090000_competition_od04_event_delete_guard.sql`: BEFORE DELETE (row) and BEFORE TRUNCATE (statement) triggers on `public.events`, both
ENABLE ALWAYS (so `session_replication_role = replica` does not bypass them). The delete is refused (SQLSTATE 23503,
`COMP_EVENT_HAS_SCORING_EVIDENCE`, naming the tables) when any protected table has a row for the event. It runs before any cascade starts, so
nothing is touched. It applies to every event with evidence (Studio, Custom and body-declared alike); it does not look at event type, body or format.
Rollback: `rollback/20270219090000_competition_od04_event_delete_guard_rollback.sql` (drops triggers and functions only; touches no data).

Concurrency: PostgreSQL locks the event row before it fires a BEFORE ROW delete trigger, so a concurrent evidence writer (which holds FOR KEY SHARE on
the event row through its foreign key) is waited for and then seen. The guard also takes the row lock explicitly (defense in depth). The race
script: race 1 (writer first, delete refused) is the meaningful one; race 2 (delete first) only confirms PostgreSQL FK locking and would pass without the guard. Race 1 passes with or without the explicit lock for this reason, so the explicit lock is not independently proven.

## Per-table decision (what "protected evidence" means)
All 21 listed tables reference `events` with ON DELETE CASCADE (checked by the suite), so the event delete was the cascade path.
- **Protected** (any row blocks): ballots, marks, ballot_events, ballot_corrections, judge_attendance, result_versions, result_rows, result_events,
  result_approvals, result_publications, round_advancements (+entries, heats, revocations), round_capacity_events, round_exclusions,
  correction_causes, correction_cosigns, final_withdrawals (+requests, request_cancellations).
- **Not protected, deletable with an evidence-free event** (the suite seeds one row in each and deletes the event): ballot_drafts (working copies),
  setup, registration, schedule, heats, check-in, panel/officials, operational audit (entry_changes, heat_lock_events, official_events,
  round_transition_events, no-shows, OD-17 switch and audit). They are preserved whenever the event holds scoring evidence, because the whole
  event is then undeletable.
- **Money**: refund tables and RB3 reconciliations are `ON DELETE RESTRICT` already; unchanged.
- **No FK to events**: checkin_payment_audit, program_locks, scoring_pins keep a plain `event_id`; nothing cascades from `events` to them.
- Other parents: `events.organizer_id` is ON DELETE CASCADE (an organizer delete reaches events and is therefore refused by the guard);
  `events.studio_id` is NO ACTION (a studio delete cannot cascade to events). Both are tested.
- Child level: every protected table refuses a direct row delete while its event exists (suite check C1, 21 of 21), so round/program/heat
  cascades cannot remove evidence either.

A suite check fails if a table whose name contains "competition" references events and is neither protected nor in the suite's classified list.
Tables outside that name filter (ordinary event tables) are covered by the unchanged-behavior baseline instead.

## Archive / hide: what exists, what is missing
Exists: `events.status` accepts `cancelled` and `completed`, `visibility` accepts `private`; the guard leaves both updates open (suite A1/A2), and the
events list already puts ended events in a Past view ("never deleted"). Programs have status `archived`. Missing: a dedicated event-level archive
flag (for example `archived_at`) that hides an event from active lists and the public directory without implying cancelled or completed, and any UI
that offers "archive instead" (the app has **no** event-delete action at all; deletion happens only through the database, RLS policy
`events_delete_by_studio_role`, or tooling). Smallest design if wanted: nullable `events.archived_at`, set by a manager-only update, excluded from
default lists; additive migration, no data change. **Not built here**: documented only, because the owner asked for the minimum and existing
status/visibility already hide an event without destroying evidence.

Note: RLS policy `events_delete_by_studio_role` lets any active studio role holder delete events (pre-existing). The guard does not change who may
delete; it only refuses when evidence exists. Whether delete should be narrowed to owners is a separate owner question (not changed).

## Retention rules (not a timer)
NDCA Rule Book June 2026 III.E item 2 (printed p.25; sha256 `d1b73e1f504d2f84b610fc489695dc2cb68e60c224970b03dd3f9f280cecdaa6`): organizers retain
the original adjudicators' score sheets for at least thirty days after the event closes. WSDC Registry Event Rules v2026.1C 3.1 item 9 (p.12;
sha256 `140caae75a8dd3378268e3d353fedf44911c1c2adb981fa4e81650f4e856d3b5`): results are posted and open to competitors for at least thirty days.
Both re-read in the PDFs on 2026-11-23; hashes match the registry. They are minimums. DanceFlow keeps the evidence for as long as the event row
exists and **never deletes automatically**. Posting and visibility of results (OD-22, OD-23) are not part of this change. Register entries:
OD04-0001, OD04-0002, OD04-0003.

## Consequences to know before applying
- E2E/QA fixtures that delete events (`e2e/helpers/competitionFixture.ts`, `competitionFullEventFixture.ts`, `stripeTestModeFixture.ts`) will be
  refused on a database where the guard is applied and the event holds ballots/results. Clean up by an operator who disables the trigger, or leave the
  fixture events; no bypass is built in on purpose.
- Any role that owns `public.events` (the migration role on hosted Supabase, or a superuser) can still disable or drop the trigger; ENABLE ALWAYS only defeats `session_replication_role`. Accepted residual risk, not tested.
- SQL test suites from other packages that delete events holding evidence need the same treatment if they run after this migration.

## SQL approval package (for the owner; nothing applied)
1. Preconditions on the target: Competition chain through CF1 and F3 applied (the migration preflight lists the 21 tables and aborts otherwise).
2. Apply `src/lib/supabase/migrations/20270219090000_competition_od04_event_delete_guard.sql` through the approved ops tooling (one transaction; no data change).
3. Read-only postflight: both triggers present with `tgenabled = 'A'`; the five functions exist; `select public._compod04_any_evidence()` shows what the
   target holds (expected empty on PROD today: no competition ballots).
4. Rollback: the rollback file (no data effect).
PROD apply needs separate owner approval; this PR authorizes none.

## Evidence (local isolated Postgres, `cf1host:found` + R2/CF1/F3/PV-1/OJ-1 chain)
SQL suite 158 checks PASS; race script 6 checks PASS (run twice); ordinary-event deletion output identical with the guard, after rollback and after
re-apply; rollback run with committed evidence present left the evidence intact and re-apply worked; static vitest 11 tests PASS.
The independent review is recorded in the PR description.

## Known limits (from the independent review)
- Cost: every event delete (including ordinary events) now runs 21 `exists` probes. `event_competition_marks` has no `event_id` index in the repository migrations, so a probe may scan it; check `pg_indexes` before apply and bulk fixture cleanups. Not changed here.
- If a later migration drops or renames one of the 21 tables, every event delete fails ("relation does not exist") until `_compod04_evidence_tables()` is updated (fails closed).
- Suite check C1 records a pass on any error from the direct row delete, not only the append-only message; it shows each table refuses, not why.
- Race 2 cannot fail without the guard (see above); only race 1 exercises it.

## Composed pilot run (P1, 2026-11-27): classification and fixes
Record: shared note `od02-s5-p1-run-record.md`. #844 head in that run: `b56ea086f`. No finding was a defect of the delete guard; the guard migration and its rollback are unchanged.

| Finding | Class | Disposition |
|---|---|---|
| OD-04 suite B/C: two "unclassified table" failures (`eligibility_determinations` R-15, `panel_recovery_cases` R-10) | completeness check working; classification missing | classified **not protected** in the suite; open owner question below |
| OD-04 suite B/C: `entry_participants` seed refused (`COMP_S5_AGE_BLOCKED`) | test harness: synthetic fixture refused by another package's guard | seed helper switches that table's ENABLE ALWAYS/REPLICA triggers off for the one insert and restores them (suite check S11); never `public.events` |
| OD-04 suite C: seeds of ballots, correction causes and co-signs, approvals, advancements, rounds refused (`COMP_P1_*`) | same | same fix |
| E2 ballots suite B: event delete refused | intended refusal; the suite asserted the old cascade | chain-aware: without the guard the cascade assertions, with it the refusal and "nothing removed" |
| Same assertion in CF1 A1 (U74), A6, A7, advancement (U50) suites; in the composed run their first failure was an R-15 gate | intended refusal, found by running the base chain plus #844 | chain-aware in the same way |
| `run_e2_marks_txn` B | not caused by the guard: passes on base chain plus #844 | left to the owner of the R-15 fixtures |
| E2 ballots suite C: `COMP_P1_FINAL_ONLY` | pilot restriction refuses the fixture (#919) | not this PR |

**Open owner question.** On the composed chain an event holding only eligibility determinations, or a panel recovery case opened by deactivating an official (no attendance row, no ballot), is still deletable and the cascade removes them. That follows the decided scope ("once ballots or results exist"); extending the block to either table is a separate decision (it would have to skip tables that do not exist yet, since both arrive after this migration).

**Still true after the fixes.** Race scripts and fixture clean-ups that delete an event holding evidence are refused silently at clean-up (use a fresh database to re-run). `run_e2_rollback.sh` / `run_f2_rollback.sh` delete evidence-bearing events and assert it worked, so they cannot pass on a chain with this guard; roll this guard back before dropping any of its 21 tables (otherwise every event delete errors).

**Local results (disposable database, composed chain saved by that run):** base plus #844: OD-04 suite 159 PASS; E2, CF1 A1/A6/A7/advancement suites PASS with the guard and again after its rollback; E2 marks, CF1 A6 and CF1 concurrency scripts PASS. With the 12 corrections: OD-04 suite 161 PASS, E2 ballots 211 PASS. With the pilot restriction: OD-04 suite 161 PASS (again after rollback and re-apply), OD-04 race 6 PASS. Ordinary-event baseline identical with and without the guard and across all three chains.
