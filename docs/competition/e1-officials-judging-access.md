# E1 officials: who may open the judging pages (OJ-1)

**OJ-1: owner decision 2026-11-10.** Organizer-team judges = YES, narrowly.

## Rule

A user who is only on an organizer team, with no studio role, may open the judging pages only when they hold an **active official assignment** with a judging role (judge, chair or scorer) for **that** competition's event. The pages are `/app/judging`, the judge ballot `/app/judging/[eventId]/rounds/[roundId]/ballot`, and the ballot desk `/app/judging/[eventId]/rounds/[roundId]/ballot/desk`, the desk only if their official role allows it.

- **Organizer-team membership alone grants nothing.**
- **Isolation holds:** an assignment for event A never opens event B, nor another studio's or organizer's events.
- **Revoked or ended assignments lose access immediately.** This covers a deactivated official and an organizer membership that ended.
- **Studio staff are unchanged.** They keep the studio layout, and E2's round-keyed RPCs decide as before.

## Scope boundary: judging, not management (coordinator ruling 2026-11-10, for the owner's release package)

OJ-1 covers JUDGING access: the judging pages, and acting as an official (the judge's own ballot entry and scoring). It does not cover event MANAGER authority.

**Unchanged, pre-existing (10A).** Organizer owners, admins and staff are managers of their organizer's own events through `can_manage_event_competition` (10A, owner-approved in Phase 10), exactly like a studio owner or admin. They keep these manager functions:
- the ballot desk: lock and reopen ballots, lock and reopen heats;
- paper-ballot entry for a judge (E2 design);
- judge attendance;
- heat no-shows (mark and void).

OJ-1 does not change that SQL.

**What OJ-1 adds.**
- An organizer-team member who is not a manager of that event, and holds no official assignment for it, gets nothing.
- A manager does not become a JUDGE without an official assignment. The judge-only paths derive the judge from the caller's own panel assignment and refuse anyone else, managers included, with `COMP_JUDGE_NOT_ASSIGNED`: the judge ballot sheet, `submit_competition_ballot` and `save_competition_callback_draft`. This was verified, no judge-only path accepts manager authority in its place; see proof P8 below.

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
- **SQL proof:** `scripts/qa/oj1/oj1-sql-proof.sql`, on the local QA stack in one rolled-back transaction.

  | Step | Situation | Result |
  |---|---|---|
  | P1 | organizer membership only | 0 rows |
  | P2 | active judge on event A | 1 row, A only |
  | P3 | official deactivated | 0 rows |
  | P4 | organizer membership ended | 0 rows |
  | P5 | membership ended, official row still active | E2 round role is none (was scorer before `20270215091000`) |
  | P7 | membership restored (control) | E2 round role is manager (10A) |
  | P8 | manager without a panel assignment | submit and draft refused `COMP_JUDGE_NOT_ASSIGNED` |

- **E2 team-member fix:** `20270215091000_competition_oj1_official_team_member.sql` (security review P2). An official removed from the team, whose official row stays active, loses chair, scorer and judge access at once. E1's `_comp_e1_is_team_member` is reused unchanged in `_compe2_round_role`, `submit_competition_ballot`, `save_competition_callback_draft`, `competition_judge_ballot_sheet` and `competition_round_no_shows`. Manager authority is untouched.

## Not changed

- A billing-paused studio's staff are still redirected to billing by the `/app` layout. That is separate from OJ-1.
- Manager authority SQL (`can_manage_event_competition`, 10A) is not changed (coordinator ruling 2026-11-10).
