# E1 officials: who may open the judging pages (OJ-1)

**OJ-1: owner decision 2026-11-10.** Organizer-team judges = YES, narrowly.

## Rule

A user who is only on an organizer team, with no studio role, may open the judging pages only when they hold an **active official assignment** with a judging role (judge, chair or scorer) for **that** competition's event. The pages are `/app/judging`, the judge ballot `/app/judging/[eventId]/rounds/[roundId]/ballot`, and the ballot desk `/app/judging/[eventId]/rounds/[roundId]/ballot/desk`, the desk only if their official role allows it.

- **Organizer-team membership alone grants nothing.**
- **Isolation holds:** an assignment for event A never opens event B, nor another studio's or organizer's events.
- **Revoked or ended assignments lose access immediately.** This covers a deactivated official and an organizer membership that ended.
- **Studio staff are unchanged.** They keep the studio layout, and E2's round-keyed RPCs decide as before.

## Authority (no parallel rule)

| Check | Where | Authority |
|---|---|---|
| Event assignment | `/app` layout (`/app/judging` paths only, Competition Finals on), judging page loaders | E1 `my_competition_judging_assignments()`: the caller's own rows, `status = 'active'`, verified email, still a team member of the event's studio or organizer (`_comp_e1_is_team_member`) |
| Ballot (judge) | judge ballot page, `submitJudgeBallotAction`, `saveCallbackDraftAction` | a panel assignment for that round in the E1 reader; then E2 `competition_judge_ballot_sheet` / `submit_*` (via `_compe2_round_role`) |
| Desk (chair, scorer) | desk page; `enterPaperBallotAction`, `recordAttendanceAction`, `lockBallotsAction`, `reopenBallotsAction`, `lockHeatAction`, `reopenHeatAction`, `deskNoShowAction` | a chair/scorer assignment, AND E2 `competition_round_ballot_status(round)` resolving the caller as chair or scorer (never manager); then the write RPC's own check |

The app checks only refuse earlier; they never grant. Every write still goes through an RPC that authorizes against the target row's own event. Implementation: `src/lib/competition/officials/judgingAccess.ts`, the `/app` layout branch, and `src/app/app/judging/JudgingShell.tsx`, a minimal frame with no studio navigation or data.

## Evidence

- **Unit tests:** `src/lib/competition/officials/__tests__/judgingAccess.oj1.test.ts`, written failing first. It covers:
  - an organizer-only user with no assignment is refused;
  - an official assigned on A is allowed on A and refused on B;
  - another tenant's event is refused;
  - revoked access is refused, and a reader error fails closed;
  - studio staff are unchanged;
  - forged requests to all nine judging actions are refused before any write RPC.
- **SQL proof:** `scripts/qa/oj1/oj1-sql-proof.sql`, on the local QA stack in one rolled-back transaction. With organizer membership only, the reader returns 0 rows. With an active judge on A, it returns 1 row, for A only. Once deactivated, it returns 0. Once the organizer membership ends, it returns 0.

## Not changed

- A billing-paused studio's staff are still redirected to billing by the `/app` layout. That is separate from OJ-1.
- No SQL changed for OJ-1.
