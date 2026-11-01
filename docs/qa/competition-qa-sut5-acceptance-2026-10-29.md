# Competition scoring and results acceptance on qa-sut-5 — 2026-10-29 (QA-A, run 4)

Spec: `e2e/tests/competition-scoring-results-acceptance.spec.ts` (PR #341), run as two filtered halves. Machine-readable twin:
`competition-qa-sut5-acceptance-2026-10-29.json`. Independent review has not happened yet; this is the implementer's account.
It supersedes the BLOCKED lines of `competition-qa-sut3-acceptance-2026-10-29.md` for ballots lock, results, correction and
certification (those were blocked by missing UI that HL1 and CX1 have since added). The schedule spec was **not** re-run on this SUT
(see §7).

## Summary

| Half | Runs | Result |
|---|---|---|
| Ordinal "Final only" (event E): no-show, ballots, Lock heat, lock, official scratch, calculate, approve, certify, visibility | 2, back to back, identical (5 and 7 min) | 11 scenarios PASS + 1 setup, 1 BLOCKED (SCN-6.3), 1 NOT IMPLEMENTED (SCN-13.1), 0 FAIL |
| Callback "Callbacks + Final" (event D): setup, target, ballots, lock, calculate | 2, back to back, identical (6 and 4 min) | 5 scenarios PASS + 1 setup, 2 NOT RUN (SCN-11.4, 11.5), 0 FAIL |

The whole results chain now works through the browser: judges submit ballots, a manager completes and locks each heat, the
ballots lock, the result is calculated, a second manager approves and the heat is certified; a correction can be opened and a
corrected ballot makes the result stale. Two scenarios could not be completed as written (see §5).

## 1. System under test (`qa-sut-5`, local, unpushed, head `b65bdab4`)

Built in the worktree `C:\Dev\studioapp-qa-sut4` as branch `qa-sut-5`:

| Layer | Merged | SHA |
|---|---|---|
| `qa-sut-2` (qa-sut + REG 3d7a8f80 + F2 cfdc4d2e + F1 688b5718 + NS1; composition in the earlier reports) | | 1a4429f5 |
| HL1 #350 (heat lock; carries CX1 #347 8ee3057a and SS1 60221714) | origin/competition-hl1-heat-lock | bdd5e640 |
| F1/F2 engine registration (`REGISTERED_ENGINES` maps `STUDIO_ENGINES`) | origin/competition-int-f1f2-registration | 171fe7cb |
| SS1 callback fix (sets the program's advancement_method to promote_callback when a callback setup is applied; code only) | origin/competition-ss1-scoring-setup | 081ffdf7 |

All merges clean. `qa-sut-5` differs from `qa-sut-4` (f20b4f8c) only by SS1's 5-file fix; no migration and no lockfile change.
Migrations applied (13, in filename order, all ok): 20270101 E1, 0102 E2, 0103 R2, 0106 O1, 0108 SC1, 0110 K1, 0111 desk balance,
0112 CB-2, 0113 REG, 0114 F2, 0115 NS1, 0116 SS1, 0117 CX1. Database: fresh `qa-acc4` from the July baseline plus 277
migrations: 270 ok, 7 failed — the same 7 known non-competition failures (5A guard, client-photos and event-media buckets, 2B,
payroll 9A/9B/9C).

## 2. Environment and footprint reductions

Stripe TEST key from the process environment only (run folders and these files scanned for key strings: none), own
`stripe listen`. To stay inside the memory thresholds the final runs used: Supabase services **excluded**: studio, imgproxy,
postgres-meta, logflare, vector, supavisor, edge-runtime (running: db, auth, rest, kong, storage, mail catcher); dev server
`--max-old-space-size=2048`, restarted fresh between the halves; Playwright headless, 1 worker, retries 0.
**Memory** (sampled every 20 s, 106 samples across the final runs): peak system memory in use 26,530 MB, minimum free 5,751 MB,
peak dev-server working set 3,224 MB. Thresholds (stop above 29 GB used or below 2 GB free) were not hit in the final runs.
Artifacts (outside the repo): `…\scratchpad\runs\20261029-*-q5E6`, `-q5E7`, `-q5D1`, `-q5D2`.

## 3. Ordinal half (event E, "Final only (ordinal majority)") — two identical runs

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| SCN-0c | Judges and owner prove their mailbox (setup, not a scenario) | PASS | — |
| SCN-12.1 | Ordinal setup via Advanced settings, publish, 4 entries paid, running order, panel, heat on the floor | PASS | one scoring heat with 4 entries |
| SCN-10.1 | No-show marked in the active heat | PASS | no-show row, marked by owner |
| SCN-10.5 | Judge sheet: no-show entry gone from the ranking form, with a note | PASS | 3 rank selects, none for the no-show entry, note shown |
| SCN-12.2 | Three judges submit ordinal ballots | PASS | ballot count 3 |
| SCN-12.3 | Heat completed, "Lock heat" accepted (native confirm), Lock ballots | PASS | round `ballots_locked`, heat `locked` |
| SCN-10.4 | After the lock, marking a no-show is refused, controls gone | PASS | day-of has no Mark no-show; direct call refused; counts unchanged |
| SCN-6.3 | Official scratch in a locked heat | **BLOCKED** | see §5 |
| SCN-14.1 | Calculate; the no-show is excluded; calculator-only approval refused | PASS | version 1 `calculated` by the owner; placements 1, 2, 3 for the three entries; approve without a reason refused; 0 approvals |
| SCN-14.2 | Manager opens a correction; judge sheet shows the CX1 banner; judge submits a corrected ballot with a reason | PASS | round `ballots_locked` + correction open; ballot count 4 |
| SCN-14.2b | A corrected ballot makes the result stale | PASS | results page shows "Version 1 - Stale", offers Calculate result, no Approve button; stored status `stale`; 0 approvals |
| SCN-14.3 | Recalculate (v2), second manager approves, heat certified, certified heat refuses a scratch | PASS | v2 order follows the correction (couple 2 first); approval by the second manager, no override reason; heat `certified`; scratch refused, no audit row |
| SCN-14.4 | Who can see results | PASS | judge, instructor and other-studio owner 404; front desk sent to check-in; anonymous to login; public event page shows no result text |
| SCN-13.1 | Publication and entrant visibility | **NOT IMPLEMENTED** | F3 is not built |

## 4. Callback half (event D, "Callbacks + Final", fresh draft event) — two identical runs

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| SCN-1.3 | "Callbacks + Final" applied in Advanced settings; "Callback target not set" blocker; T=2 saved | PASS | callback round + Final; target 2 after reload |
| SCN-11.1 | Publish (methods pinned), 4 entries paid, schedule, panel, round and heat started | PASS | round `active`, 3 panel assignments |
| SCN-11.2 | A wrong pick count is refused; three judges submit exactly T picks | PASS | 0 ballots after the refusal, 3 after |
| SCN-11.3a | Heat completed, Lock heat, Lock ballots | PASS | round `ballots_locked` |
| SCN-11.3 | Calculation advances exactly T couples | PASS | 2 advance, the two with the most calls |
| SCN-11.4 | Tie at the callback line | **NOT RUN** | results are reachable now but the tie data set and expected approved rule are not written; the engine refuses a tie over capacity by design |
| SCN-11.5 | Final built from the advanced couples, one heat | **NOT RUN** | no screen creating the Final's heat was found in the code; to confirm now that results are reachable |

## 5. Findings

1. **HL1 and CX1 work end to end** (§3). Lock heat needs a completed heat; the lock chain now reaches certification.
2. **FINDING — SCN-6.3 cannot be reached.** The SC1 "official scratch in a locked, not-yet-danced heat" needs a locked heat that
   has not been danced. HL1 offers Lock heat only for a danced (complete) heat, and a danced-and-locked heat is classed as danced
   by the scratch page, which refuses with "This entry has already danced. Changes go through the results correction workflow."
   The refusal is asserted; no scratch is written. Owner decision: is the locked-before-danced path intended to exist?
3. **FINDING (fixed by SS1 081ffdf7, verified here) — callback calculation.** On the earlier SUT, Calculate on a callback round
   was refused with COMP_ENGINE_UNSPECIFIED_CASE because the wizard's program had advancement_method `none`. With the fix, SCN-11.3
   passes: exactly T couples advance.
4. The stale result shows as "Version 1 - Stale" with a Calculate button; the text "ballots changed - recalculate" in the page code did
   not appear in this flow (the spec asserts what the UI actually shows).
5. The no-show read still needs a verified-email credential (NS1 report); the harness verifies the owner first.

## 6. Attempts that did not complete (for the record, not part of the pass count)

Several earlier attempts stopped or failed. Three were stopped on the memory thresholds: 19:43 (29.1 GB used / 2.4 GB free, then 30.2 GB / 1.3 GB; a schedule-spec attempt), 20:47 (29.6 GB / 1.9 GB) and 21:21 (29.4 GB / 2.1 GB). One run failed on the callback refusal (finding 3), and three ordinal attempts failed on spec issues now fixed (a dev-server 404 on the scratch route, the SCN-6.3 expectation, the stale wording). **Labelled cleanup steps:** after the interrupted runs, my synthetic `e2e-compfull-*` rows in `qa-acc4` were purged
twice (2 studios + 11 users; then 2 studios + 1 event + 11 users) with a purge limited to those rows in that database; no other
database or container was touched. After the final run `qa-acc4` had 0 `e2e` studios, events or users.

## 7. Not run / caveats

- The schedule spec was not re-run on `qa-sut-5` (the coordinator agreed to skip it while memory was tight; its last run was on
  `qa-sut-3`, composition `4c818452`, 27 PASS). HL1/CX1/SS1 do not change the schedule paths, but that is an argument, not a run.
- SCN-11.4 and SCN-11.5 are not run; mobile viewport and concurrency between two managers are not covered.
- Spec-level re-click/re-check helpers are as described in §8 of the NS1 report; in-test iterations were not instrumented.
- Shutdown: dev server, `stripe listen` and sampler stopped (PIDs verified as mine); `supabase stop --backup` on `qa-acc4`.
  Nothing deleted. Hosted DEV/PROD, deploys and live providers were not touched.
