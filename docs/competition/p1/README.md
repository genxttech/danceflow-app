# P1 pilot restrictions (draft, not applied anywhere)

DanceFlow Studio/Custom pilot policy (OWNER-DECISIONS section 21, `0d68b2f38`; MVP-RELEASE-ASSESSMENT sections 2-3). Not a governing-body rule; no rulebook was consulted for this document.

**State: written and reviewed by reading. Nothing has been executed.** No apply, merge, deployment or activation is authorized.

## Files

`20270301180000_competition_p1_pilot_restrictions.sql` and its rollback. Requires PR 865 (`20270301090000`) and PR 877 (`140000`, `141000`); PR 899 (`170000`) is independent and also required for P1. It redefines no function: 16 triggers (`zz_compp1_*`, `ENABLE ALWAYS`, no role exemption) and 4 unique indexes.

**It is global.** It restricts every competition event in the database; there is no per-event switch. The rollback removes it completely.

## What it refuses

| Rule | Mechanism | Code |
|---|---|---|
| Only a final; no callback scoring; no advancement | round and advancement triggers | `COMP_P1_FINAL_ONLY`, `_CALLBACKS_OFF`, `_ADVANCEMENT_OFF` |
| One round per division (cancelled included), one live heat per round and version, one live dance per heat, one published or live order per event | unique indexes `compp1_*` | `23505` |
| After the start: no new programs, divisions or rounds; no round cancel, removal or retype | structure and round triggers | `COMP_P1_STRUCTURE_FROZEN` |
| After the start: no order replacement or unpublish, publication-order edit, heat insert, delete, move, renumber or cancel, or dance change; a started heat never goes back | heat, dance and version triggers | `COMP_P1_ORDER_FROZEN` |
| Corrections, including reopening locked ballots | round and correction-cause triggers | `COMP_P1_CORRECTIONS_OFF` |
| Paper ballots; a ballot for a heat that has not started | ballot trigger | `COMP_P1_PAPER_BALLOTS_OFF`, `_HEAT_NOT_STARTED` |
| Adding a couple to, or removing one from, a started heat, by any writer | placement and entry triggers | `COMP_P1_STARTED_HEAT` |
| Approval by the calculator or with an override reason; a final with fewer than two ranked couples | approval trigger | `COMP_P1_SECOND_APPROVER_REQUIRED`, `_MINIMUM_COUPLES` |
| Approval or publication for a declared UCWDC, NDCA or WSDC event | approval and publication triggers | `COMP_P1_SANCTION_BLOCKED` |
| Changing a published couple's name or number, or a published round, division or program name | name triggers | `COMP_P1_PUBLISHED_FROZEN` |
| A structural change while the event is being started or advanced | event lock, never waited for | `COMP_P1_BUSY` (retry) |

"Started" means any heat staging, active or complete, any round active or later, or any ballot, in that event.

## Choices to know about

- **Ballots.** Because ballots exist only for started heats, the PR 877 block covers a scored couple; the full ballot-block design stays paused.
- **Refunds and registration sync** already leave a couple in a started heat alone (read from code). The backstop covers a race with the heat start: the write is refused and should succeed on retry. Webhook retry behaviour is not verified.
- **A judge may still replace their own ballot** while the round is active. Without that, a No-show recorded after a ballot would leave the round unable to lock. Reopening locked ballots is refused.
- **`other` sanctioning stays approvable**, as OD-01 decided.
- **A round cancelled before the start** still counts as the division's one round, and its audit rows may prevent deleting it (inferred).
- **Accepted residual** (assessment section 6): a manager can still prepare a second contest with the same people before judging and choose which to publish.

## Review and unverified

One independent read-only review of the first draft found two blockers (running order replaceable through a second published version; corrections through ballot reopening) and gaps (couples added to started heats; dance and numbering edits; `other` sanctioning; stranded cancelled rounds). All but the sanctioning choice are changed above; **the changes are not re-reviewed**. It found no apply-time or runtime SQL error by reading, assuming PostgreSQL 14 or later.

Unverified: everything at runtime; races and deadlocks; composition with Option D and PR 866; application behaviour; hosted data (the preflight refuses data that already breaks the limits).

## Tests and application messages

`sql-tests/test_T_competition_p1_pilot_restrictions.sql` needs PR 865, PR 877 and this migration. **Never executed**, so it may fail on its own assumptions. By its author's account it covers the four probed self-approval routes, the freezes, the ballot rules, self-approval, sanction, the one-couple final, published names, started-heat additions and removals, a ballot replaced after a No-show, the happy path, pre-start edits and event deletion. Not covered: the busy refusals, advancement, the publication sanction guard, the removal backstop, the refund path and any concurrency. With PR 899 installed some order writes may be refused by its guard first, leaving this one unproven there. The suite has not had its own review.

Application messages (`src/lib/competition/pilotMessages.ts`) are not type-checked or tested. Actions that throw (competition, advanced schedule, generation, registrations) still show a generic message in production, because Next.js hides thrown server-action errors; they need to return the error instead.

## Recovery after the 2026-11-27 composed run (not yet executed)

The composed run by another session showed that this suite stopped in its setup (a role value not cast to the enum), so none of its checks had run, and that the phase 10D.1 suite's allow-list of heat-entry triggers did not include this migration's trigger. The suite was repaired by reading only. `test_T_phase10d1_heat_entry_eligibility_with_p1.sql` is a labelled adapted copy of the PR 866 version that allows exactly `zz_compp1_placements`; the released suite is unchanged and is expected to fail that one check wherever this migration is installed. Known gaps in the suite after repair: the started-heat addition branch and the one-published-order index are not exercised (earlier guards refuse first). Agreed with the PR 863 session: a guard's own behaviour is proven on the chain without this migration; guards with no P1-legal copy are listed as untested with it. `run-p1-focused.sh` runs that session's composed runner, pinned, for selected suites only.
