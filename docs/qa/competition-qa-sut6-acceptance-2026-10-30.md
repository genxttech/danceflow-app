# Competition acceptance on qa-sut-6 (HL1 early lock and reopen) — 2026-10-30 (QA-A, run 5)

Spec: `e2e/tests/competition-scoring-results-acceptance.spec.ts` (PR #341), run as two filtered halves, one complete run each.
Machine-readable twin: `competition-qa-sut6-acceptance-2026-10-30.json`. This section extends
`competition-qa-sut5-acceptance-2026-10-29.md`; it replaces SCN-6.3 (BLOCKED there) with a real scenario and adds SCN-15.x.
Independent review has not happened yet; this is the implementer's account.

## Summary

| Half | Runs | Result |
|---|---|---|
| Ordinal "Final only" (event E, now five couples) | 1 complete run (6 min) | 16 scenarios PASS + 1 setup, 1 NOT IMPLEMENTED (SCN-13.1), 0 FAIL |
| Callback "Callbacks + Final" (fresh draft event) | 1 complete run (3 min) | 5 scenarios PASS + 1 setup, 2 NOT RUN (SCN-11.4, 11.5), 0 FAIL |

Only one run of each half exists on this SUT (as the coordinator asked), so there is no back-to-back repeat here.
The schedule spec was not re-run on `qa-sut-6`.

## 1. System under test (`qa-sut-6`, local, unpushed, head `d7fcde04`)

Built in the worktree `C:\Dev\studioapp-qa-sut4` as `qa-sut-2` plus, with clean merges: HL1 #350 `ca6c0b8d`
(contains CX1 `bf7d5c7c`, which contains SS1 `40fd227d`) and `origin/competition-int-f1f2-registration` `171fe7cb`.
No install was needed (the package-lock diff against `qa-sut-5` was empty). Migrations (15, all ok): 20270101, 0102, 0103, 0106,
0108, 0110, 0111, 0112, 0113, 0114, 0115, 0116, 0117, **0118** (SS1 advancement freeze) and **0119** (HL1 heat guards).
**0118 and 0119 were applied incrementally**, in that order, on top of the existing `qa-acc4` chain through 0117 (through the DB
container, 2026-10-29); the 7 known non-competition replay failures of the original build are unchanged. Verification: the
`guard_competition_program_advancement_frozen` trigger and the two `hl1_guard_heat_*` triggers exist.

## 2. Environment, footprint and memory

Same reductions as before: Supabase services excluded (studio, imgproxy, postgres-meta, logflare, vector, supavisor,
edge-runtime), dev server `--max-old-space-size=2048`, Playwright headless, one worker, retries 0. Stripe TEST key from the process
environment only (run folders and these files scanned: no key strings). **Memory:** final runs (ordinal + callback, 32 samples at
20 s) peaked at 26,718 MB in use with a minimum of 5,564 MB free and a 3,433 MB dev-server working set; the whole session
(98 samples, including earlier attempts) peaked at 29,478 MB in use with a minimum of 2,803 MB free. The stop thresholds were not
hit in the final runs. **Diagnostic note:** the ordinal run used `qa-sut-6` plus a 3-line `console.log` in the scratch-entry page
(no behaviour change), added to observe a 404 and reverted (`git checkout`) before the callback run; the working tree is clean.

## 3. Ordinal half — one complete run

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| SCN-0c | Judges and owner prove their mailbox (setup) | PASS | — |
| SCN-12.1 | Ordinal setup, publish, five entries paid, running order, panel, round running (heat not started) | PASS | round `active`, the one heat `scheduled` with 5 entries |
| SCN-15.1 | Lock heat on the unstarted heat | PASS | confirm text "Lock heat 1? It has not been danced. The floor can't start or change it until it is reopened. Officials can still scratch entries with a reason."; heat `locked` while `scheduled`; desk shows "1 heat(s) not danced yet: 1." and Lock ballots disabled; the floor console offers no Call to floor |
| SCN-6.3 | Official scratch in the locked, not-yet-danced heat | PASS | the locked-heat notice; empty reason writes nothing; with a reason: audit path `official_locked`, `performed_by` the owner; heat stays `locked`; placement `scratched` |
| SCN-15.2 | Reopen heat with a reason | PASS | confirm text asserted; heat `open`; the floor offers Call to floor again |
| SCN-15.3 | A heat on the floor: no Lock heat; direct call refused | PASS | desk shows "On the floor", no Lock heat button; `set_competition_heat_lock_state` refused with COMP_HL1_LOCK_ACTIVE; heat stays `open` |
| SCN-10.1 | No-show on the active heat | PASS | no-show row by the owner |
| SCN-10.5 | Judge sheet without the no-show entry, with a note | PASS | three rank selects |
| SCN-12.2 | Three judges' ordinal ballots | PASS | ballot count 3 |
| SCN-12.3 | Lock ballots disabled until the heat is locked; after completion Lock heat and Lock ballots work | PASS | "1 heat(s) not locked yet." with Lock ballots disabled while the heat is on the floor; then round `ballots_locked`, heat `locked` |
| SCN-15.4 | Reopen refused after the lock | PASS | no Reopen heat button; direct reopen refused (COMP_HL1_REOPEN_DANCED / ROUND_LOCKED); heat stays `locked` |
| SCN-10.4 | Marking a no-show after the lock is refused | PASS | controls gone; direct call refused; counts unchanged |
| SCN-14.1 | Calculate; calculator-only approval refused | PASS | version 1 `calculated`; placements 1, 2, 3; 0 approvals |
| SCN-14.2 | Correction opened; judge sheet banner; corrected ballot accepted | PASS | ballot count 4 |
| SCN-14.2b | Result becomes stale | PASS | "Version 1 - Stale", Calculate offered, no Approve |
| SCN-14.3 | Recalculate, second manager approves, certified, certified scratch refused | PASS | heat `certified`; no audit row for the refused scratch |
| SCN-14.4 | Who can see results | PASS | judge, instructor, other studio 404; front desk to check-in; anonymous to login; no result text on the public page |
| SCN-13.1 | Publication | **NOT IMPLEMENTED** | F3 is not built |

## 4. Callback half — one complete run, fresh draft event

SCN-0c, SCN-1.3, SCN-11.1, SCN-11.2, SCN-11.3a (heat completed, Lock heat, Lock ballots) and SCN-11.3 (exactly T=2 couples advance)
all PASS, as on `qa-sut-5`. SCN-11.4 (tie at the cutoff) and SCN-11.5 (the Final built from the advanced couples) are NOT RUN.

## 5. Findings and corrections

1. **HL1 v2 works as specified** (§3): early lock with the exact confirm, official scratch inside the locked heat, reopen with a
   reason, refusals for an active heat and for reopening after the lock. The earlier SCN-6.3 BLOCKED finding is closed by HL1 v2.
2. **A heat on the floor counts as danced** for the desk's "not danced" rule, so it is blocked as "not locked yet"; the "not danced yet" text
   appears only for a heat locked before it was danced (asserted in SCN-15.1).
3. **Dev-server artifact (not a product defect):** on a freshly started dev server the first request to the scratch-entry route
   returned a persistent 404 until the route was touched. A production build (`next build` / `next start`) would avoid it.
4. **Correction to my earlier reports today:** the "worker exited (code 134)" stops at SCN-15.1 were not memory. They were an
   infinite recursion in my own `openDesk` helper (a bulk replace had rewritten its body); the log showed "Maximum call stack size
   exceeded". It is fixed. My suggestion that route compilation caused those stops was wrong. The genuine memory stops
   (29.1/2.4, 29.6/1.9, 29.4/2.1 GB used/free) are listed in the `qa-sut-5` report.

## 6. Shutdown and cleanup

Dev server, `stripe listen` and the sampler were stopped (PIDs verified); `supabase stop --backup` on `qa-acc4`. Nothing deleted. Labelled
cleanup steps on `qa-acc4` only: my synthetic `e2e-compfull-*` rows from interrupted runs were purged several times (each purge limited to those rows in that database; e.g. 2 studios + 1 event + 11 users, and 4 studios + 2 events + 22 users for the last interrupted pair). The final check after the last run: 0 e2e studios, 0 events,
0 e2e users. Hosted DEV/PROD, deploys and live providers were not touched.
