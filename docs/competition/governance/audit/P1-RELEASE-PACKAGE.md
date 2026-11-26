# P1 release package: restricted Studio/Custom pilot (v0, 2026-11-26 ~21:15Z)

Authorization: OWNER-DECISIONS.md section 21 (non-applied drafts, local QA, review, preparation only). **P1 is not release-ready.** Background: MVP-RELEASE-ASSESSMENT.md.

## 1. Included and disabled (scope frozen)

**Included:** staff or $0 registration (paid hosted checkout unproven), adult eligibility, one final-only division per contest, published running order, panel readiness, day-of heats, judges' own electronic ballots, database calculation, approval by someone other than the calculator, publication.

**Disabled, enforced in the database and app:** callbacks and advancement; extra rounds or heats; multi-dance; rounds or divisions added after judging starts; running-order replacement and cancellation after start; corrections; paper ballots; ballots for a heat not started; self-approval; official-body-declared results; finals with one couple.

## 2. Required PRs, dependency order and owner

| Order | PR / work | Head | State | Writer |
|---|---|---|---|---|
| 1 | 867 under-18 and judge guards into Git | `6dc6b2d4e` | **ready for owner approval** | OD-31 session |
| 2 | 865 approval limits | `d5c3bed52` | suite passes; concurrency unverified | R-11 session |
| 3 | 864 panel readiness + app confirm flag + E1 fix | `9d7477c09` | changing | R-10 session |
| 3a | R2-refunds test fix (test only) | new | in progress | R-10 session |
| 4 | 835 → 837 → 846 age and eligibility app + eligibility save wiring | `7778a9a0c` `d42eff6fa` `9b040c993` | qfem check fails on 837, 846; wiring unbuilt | R-15 session |
| 5 | 866 eligibility guards (write guard only after step 4 is deployed) | `3b65f63d1` | composed suite passes | R-15 session |
| 6 | 863 under-18 database guard (after 835) | `93583d01c` | some adapted suites | OD-02 session |
| 7 | 877 entry status and started-heat guard | `8c738c4d8` | run in progress | OD-31 session |
| 8 | 878 scratch screen (after 877, or together) | `22c27b505` | full build queued | SC1 session |
| 9 | P1 restriction migration + app messages (slots `20270301180000`+) | none yet | **unbuilt** | OD-31 session |
| 10 | 899 published-order guard (needed subset under evaluation) | `d2ee7e3f4` | fix unexecuted | R-11 session |
| 11 | 844 event deletion guard | `b56ea086f` | local SQL passes; some e2e fixtures will be refused | unassigned |
| 12 | 832 official-body block (app) | `12bef34b0` | unit tests only | unassigned |

Positions of 899, 844, 832 and the restriction migration are proposals until the composed run.

## 3. Mandatory blockers

Restriction migration unbuilt; eligibility wiring unbuilt (866 would refuse today's app); Option D hole unfixed in executed form; self-approved replacement reachable until the restrictions exist; published names and numbers read live; under-18 and eligibility unenforced on the release line; no end-to-end run on this head; no composed run including 899 or the restrictions.

**Rulings needed before activation, not now:** the residual (a second contest with the same people prepared before judging; R-11 stays blocked until adjudicated); whether OD-05, OD-10, OD-15 apply to the pilot; refund and no-show behaviour.

## 4. Tests

| Executed locally (reported by sessions) | Pending |
|---|---|
| 867 suites 8/8; composed run6 (865, 864, 866, 863, 877, 867): passes except officials and R2-refunds, which also fail on base; some adapted copies | combined 877+878 run; R-11 dance-bypass check |
| 865 standalone with rollback; bypass probe (replacement reachable) | 899 run with its fix |
| 864 standalone run 2 | E1 / R2 fix run |
| 878 targeted tests and database suite on an older 877 head | 878 full type check, build, tests |
| | **composed P1 run with 899 and restrictions, concurrency, bypass replays without superuser fixtures, end-to-end workflow, production-build browser run, flag-off smoke** |

## 5. Hosted SQL (each apply separately approved; DEV before PROD)

0. Do **not** apply JC1/U18/U18-S: already on DEV and PROD.
1. DEV only: PV-1 (and OJ-1 if absent; confirm by read) before 865.
2. `20270219090000` (844; position to confirm), `20270301090000` (865).
3. Deploy the app that sends the panel confirmation, then `100000`-`102000` (864).
4. `110000` (866 core), `120000` (863; its activation count must return 0), `130000` (866 gates).
5. Deploy the eligibility app wiring, then `131000` (866 write guard).
6. `140000`, `141000` (877), `170000` (899), `180000`+ (restrictions).

Rollback: app first, then SQL in reverse release order. Competition flags stay OFF until activation.

## 6. Owner approval sequence

1. **Now:** approve PR 867 (Git only).
2. Each later PR merge, at an exact head, once reviewed.
3. Composed P1 test results.
4. DEV SQL apply. 5. PROD SQL apply. 6. App promotion. 7. Residual and OD-05/10/15 rulings. 8. Pilot flag activation. 9. Public registration and any fee-bearing action (separate).

## 7. Deferred after P1

B2 (unless an executable test shows P1 needs it), callbacks, multi-round and multi-dance formats, re-dances, post-publication corrections, mid-event restructuring, paper ballots, per-heat withdrawal, ballot exception workflow, official-body profiles.

## 8. PR 867 verification (coordinator, 2026-11-26)

Head `6dc6b2d4e5657f27754c9dfc62e977f642ecb04c`, one commit on `release/website-embeds` `49dbaee1b`, 0 behind. **Checked:** all 10 files are byte-identical to `release/competition-cf1-app-candidate` `92a8c17c6`; three Vercel checks pass; draft, mergeable, review required. **From the PR record, not re-run:** 8/8 local suites on this head, independent review with no blockers and no auto-apply mechanism, hosted postflights matching on DEV and PROD. Not executed: type check, tests, build (no application code), browser, replay from an empty database.
