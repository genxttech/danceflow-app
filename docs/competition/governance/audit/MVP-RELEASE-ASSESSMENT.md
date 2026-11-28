# Studio/Custom MVP: conditional release-readiness assessment (PROVISIONAL)

2026-11-26, release line `release/website-embeds` `49dbaee1b`. Owner priority: OWNER-DECISIONS.md section 20 and its release-focus follow-up. Built from two read-only analyses plus coordinator spot checks (marked **checked**). Nothing here was executed by the analyses; "executed" means another session ran it on a local database. **The MVP is not release-ready.** No end-to-end run exists on this head.

## 1. Recommendation

Release a restricted pilot ("P1"). B2 does not appear necessary for it and stays paused: by code reading (untested), new database restrictions would close the four probed self-approval routes, and B2 as designed would not close the main residual either.

## 2. P1: minimum workflow

Registration (staff or $0; paid hosted checkout unproven), eligibility (adults only), setup with one final-only division per contest, published running order, judge-panel readiness, day-of heats, judges' own electronic ballots, database calculation, approval, publication.

## 3. Disabled at the database boundary (all new; none built)

Callbacks and advancement; a second round or heat per division; adding rounds or divisions after judging starts; multi-dance; running-order replacement and round or heat cancellation after start; corrections; paper ballots; **ballots for a heat that has not started**; approval by the calculator (no self-approval in the pilot). Also: at least two couples in a final; published names and numbers frozen. A hidden control is not enough: managers can write several of these tables directly.

**Ballot mechanism (inference, to verify).** Refusing ballots before a heat starts lets the existing started-heat block (PR 877) satisfy section 15 requirement 1 without the full ballot block. Ordinal ballots are per heat (**checked**: only `callback_yes` is round-level), and today the insert guard does not require a started heat (**checked**). Refund and registration-sync behaviour for started heats still needs verification.

## 4. Essential PRs (all draft, unapproved; CI is Vercel only, no SQL)

| PR | Provides | State |
|---|---|---|
| 867 `6dc6b2d4e` | under-18/judge guards already on hosted, into Git | suites pass |
| 865 `d5c3bed52` | approval override limits | suite passes; concurrency unverified |
| 899 `02cf1c73d` | published running-order write guard | **not ready**: planted-heat hole (read, unreproduced); fix in progress |
| 877 `8c738c4d8` | entry status and started-heat guard | combined run in progress |
| 866 `3b65f63d1` | eligibility enforcement | composed suite passes; **its write guard refuses the app's current eligibility save (checked)** and the replacement app wiring is in no PR |
| 863 `93583d01c` | under-18 database guard | composed run, some adapted copies; app tests not run |
| 835 `7778a9a0c` → 837 `d42eff6fa` → 846 `9b040c993` | app age and eligibility | targeted tests only; a Vercel check fails on 837 and 846; 837/846 write eligibility directly |
| 864 `9d7477c09` | panel readiness | merge-ready as a dark draft; test fixes pending; app confirm flag missing |
| 844 `b56ea086f` | event deletion guard | local SQL pass |
| 832 `12bef34b0` | official-body sanction block (app only) | unit tests only |
| 878 `22c27b505` | scratch screen | full type check, build, tests queued |

Deferred: 901, 908 (design). Recorded merge order: 867, 865, 864, 866, 863, 877, 878; 835 before applying 863; 899 and 844 are not yet placed. Hosted DEV lacks PV-1 (and likely OJ-1).

## 5. Interacting guards: combined testing required

heats (866, 877, 899); heat entries (866, 867, 877); schedule versions (866, 899); entries (866, 877); 877 and 899 also change writers to run with elevated rights. The latest combined run (run6) covered 865, 864, 866, 863, 877, 867 at near-current heads and passed except two suites that also fail on the base, some as adapted copies, without concurrency tests. **899 has never run with any of them.**

## 6. Blockers still reachable

1. Self-approved replacement by spare or moved round (executed with a test-planted spare; remains with all existing PRs).
2. A scored couple whose heat is not started can be scratched or withdrawn (read).
3. Option D planted-heat hole (read, unreproduced).
4. Under-18 and eligibility not enforced on the release line until 863/866 and their app work ship (read).
5. Published results show names and entry numbers read live (**checked**).
6. A direct final can have one couple (read).
7. A new running order is possible after ballots but before a heat is staged (read).
8. Official-body block is app-only (read).
9. Managers and scorers read ballots without audit (OD-10), and no conflict check (OD-05) was found (read).

**Residual after P1:** a manager can set up a second contest with the same people (another division, program or event) before judging, have both judged, and choose which to publish. Controlled judge accounts and a manager acting as judge also remain. P1's two-person approval makes this need a second authorized person; it does not remove it.

## 7. Smallest corrections

1. One pilot-restriction migration (section 3), with app messages. Small to medium.
2. Finish the Option D fix (899).
3. Eligibility app wiring for 866 and rework of 837/846.
4. Panel confirm flag (864) and approval error messages (865).
5. Verify refunds and registration sync against started heats.

## 8. Integration tests before any release claim

One composed chain at final heads including 899, with unmodified suites (officials and refunds fail today); apply and rollback; bypass replays without superuser fixtures; races; every scratch writer; app-to-database registration, eligibility and panel flows; full type check, tests and build; production-build browser run of the whole pilot plus flag-off smoke; read-only hosted preflights.

## 9. Deferred until after the pilot

B2, callbacks, multi-round and multi-dance formats, re-dances, post-publication corrections, mid-event restructuring, paper ballots, per-heat withdrawal, ballot exception workflow, official-body profiles.

## 10. A versus B

| | A: P1 | B: finish B2 first |
|---|---|---|
| Blockers | section 6 | section 6 plus an unreviewed B2 design, open owner questions and a new approver role |
| New work | section 7 | section 7 (except 1) plus new tables, publication, approval and revalidation changes |
| Leaves open | the residual above | the second-division and other-event residuals too |
| Estimate (**judgement, low confidence**) | about 5 to 10 working days to a tested pilot candidate | about 3 to 6 weeks more |

Basis and limits: today's draft corrections took 2 to 3 days with 10 to 20 commits each; composed database runs take 5 to 22 minutes but the shared queue was about 6 to 7 hours; unstarted work has no observed basis. Assumes approvals within a day.

## 11. Decisions still needed later (not part of the next approval)

Before activation: adjudicate the residual (section 18 keeps R-11 blocked until then); decide whether OD-05, OD-10 and OD-15 apply to the pilot or are deferred (their text applies now); refund and no-show behaviour. Merges, hosted SQL, deployment and activation remain separate approvals.

## 12. Next owner approval

Approve scope P1 (sections 2 and 3, a pilot-only restriction that temporarily disables callbacks, correction recovery, multi-dance, multiple rounds and paper ballots, and requires approval by someone other than the calculator, changing R-11 for the pilot only) and authorize non-applied draft work for section 7 and its local tests and independent review. Nothing else.
