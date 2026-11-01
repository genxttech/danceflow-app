# Competition acceptance report on qa-sut-3 — 2026-10-29 (QA-A, run 3)

Specs: `e2e/tests/competition-schedule-heats-acceptance.spec.ts` (schedule, regression) and
`e2e/tests/competition-scoring-results-acceptance.spec.ts` (new: SS1 setup, ballots, lock, results). PR #341.
Machine-readable twin: `competition-qa-sut3-acceptance-2026-10-29.json`.
Independent review of this evidence has not happened yet; this is the implementer's account.

## Summary

| Spec | Runs | Result |
|---|---|---|
| Schedule & Heats (regression on the final heads) | 1 run, 25.1 min | 27 PASS (25 scenarios + 2 warm-ups), 4 BLOCKED, 2 NOT IMPLEMENTED, 0 FAIL |
| Scoring & results | 2 runs back to back, 5.4 and 4.8 min, identical | 9 PASS (8 scenarios + 1 setup), 11 BLOCKED, 1 NOT IMPLEMENTED, 0 FAIL |

**The main finding of this run: ballots cannot be locked through the UI, so results cannot be calculated, approved or
certified in the browser.** Everything up to the lock works and is asserted; everything after it is BLOCKED (not PASSED), with
no SQL shortcut. Details in §5.

## 1. System under test (`qa-sut-3`, local, unpushed, worktree `C:\Dev\studioapp-qa-sut3f`, head `4c818452`)

`qa-sut-2` (composition in the NS1 report; itself `qa-sut` + REG 3d7a8f80 + F2 cfdc4d2e + F1 688b5718 + NS1) plus, with
`git merge --no-ff`, in this order, **both clean, no conflicts**:

| # | Merged | SHA |
|---|---|---|
| 1 | SS1 #344 (carries NS1 final 34b3130c and F2 cfdc4d2e) | 106d5e16 |
| 2 | `competition-int-f1f2-registration` (F2 cfdc4d2e + F1 688b5718 + a commit mapping STUDIO_ENGINES into REGISTERED_ENGINES) | 171fe7cb |

`REGISTERED_ENGINES` is built from `STUDIO_ENGINES`, whose keys are `studio_callback_tally@1` and `studio_ordinal_majority@1`
(checked in `engineAdapter.ts` / `engines/index.ts`). A provisional earlier build (`qa-sut-3-provisional`) was not used.

## 2. Database

Fresh Supabase CLI project `qa-acc3` (API 57821, DB 57822, mail catcher 57824), E1's `build-db.mjs`
(`--external --cutoff 20270116090000 --crlf 20260831090000_user_has_client_portal_access_helper.sql`): July baseline plus 276
migrations, **269 ok, 7 failed**, the same 7 known non-competition failures as before (5A guard, client-photos and
event-media buckets, 2B, payroll 9A/9B/9C). **All 12 Competition migrations applied in filename order**:
20270101 E1, 0102 E2, 0103 R2, 0106 O1, 0108 SC1, 0110 K1, 0111 desk balance, 0112 CB-2, 0113 REG, 0114 F2, 0115 NS1, 0116 SS1.

## 3. Environment

Turbopack dev server on 3100, own `stripe listen`, Stripe TEST key from the process environment only (the run folders and these
files were scanned for key strings: none). Dev server restarted fresh between the schedule spec and the scoring spec; the two
scoring runs shared one server. Playwright retries 0; the re-check / re-click helpers are the ones described in §8 of the NS1
report (in-test iterations not instrumented).
**Memory:** sampled every 20 s: peak working set of the dev server and its node children 4,198 MB; peak system memory in use
31,966 MB (the sampler matches node processes whose command line names the qa-sut-3 worktree, so it may undercount). Host load was not sampled; the scoring runs
were much faster than the earlier saturated-host runs (about 5 min each). Artifacts (outside the repo):
`…\scratchpad\runs\20261029-*-q3sched`, `…-q3scoreA`, `…-q3scoreB`.

## 4. Schedule & Heats spec on the final heads (regression)

Same result as the earlier runs: all of SCN-0 … SCN-9 and SCN-10.1/10.2/10.3/10.5/10.6/10.7 PASS (SCN-10.x include the NS1 chair
desk). BLOCKED: SCN-1.3, SCN-6.3, SCN-10.4 (on the wizard's `custom` event) and SCN-4.3; NOT IMPLEMENTED: SCN-4.1, SCN-4.2. The
SS1 and REG changes did not regress any schedule behaviour.

## 5. Scoring & results spec (two identical runs)

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| SCN-0c | Judges and owner prove their mailbox through the sign-in link (setup, not a scenario) | PASS | — |
| SCN-1.3 | Callback target: "Callbacks + Final" applied in Advanced settings (SS1); "Callback target not set" blocker shown; T=2 saved and persisted | PASS | rounds `Callback round` (callback tally) + `Final`; `target_advancement_count` = 2 after reload; blocker text gone |
| SCN-11.1 | Callback competition: publish (methods pinned), 4 entries paid in one Stripe TEST order, running order published, panel ready, round started, heat on the floor | PASS | round `active`, target 2, 3 panel assignments |
| SCN-11.2 | Callback ballots: a wrong pick count is refused (nothing stored); three judges each submit exactly T picks from their own accounts | PASS | ballot count 0 after the refusal, 3 after the submissions |
| SCN-11.3a / SCN-12.3 | Manager locks the ballots | **BLOCKED** | the desk shows "1 heat(s) not locked yet" and Lock ballots is disabled (asserted on both events) |
| SCN-11.3 | Callback calculation advances exactly T | **BLOCKED** | needs the lock |
| SCN-11.4 | Ties at the callback line | **BLOCKED** | needs the lock; the tie rule is in the F1 engine spec and was not guessed |
| SCN-11.5 | Final built from the advanced couples, one heat | **BLOCKED** | needs the lock; no screen creating the Final's heat from the callback result was found in the code (to confirm) |
| SCN-12.1 | Ordinal competition: "Final only (ordinal majority)", publish, pay, schedule (one heat of 4), panel, start | PASS | exactly one scoring heat with 4 entries |
| SCN-10.1 | No-show marked on the active heat | PASS | `event_competition_heat_no_shows` row, `marked_by` owner |
| SCN-10.5 | Judge sheet: the no-show entry is gone from the ranking form, with a note | PASS | 3 rank selects, none labelled with the no-show entry, note visible (this scenario was partial/BLOCKED on the `custom` event; it is fully real here) |
| SCN-12.2 | Three judges submit ordinal ballots for the three entries who danced | PASS | ballot count 3 |
| SCN-10.4 | After the lock, marking a no-show is refused | **BLOCKED** | needs the lock |
| SCN-6.3 | Official scratch in a locked heat | **BLOCKED** | needs the lock (heats lock only through it) |
| SCN-14.1 | Calculate; no-show excluded; calculator-only approval refused | **BLOCKED** | needs the lock |
| SCN-14.2 | Correction opened | **BLOCKED** | needs the lock |
| SCN-14.2b | A new ballot makes the result stale; approval refused until recalculated | **BLOCKED** | no UI submits a corrected ballot while a correction is open (also needs the lock) |
| SCN-14.3 | Recalculate, second manager approves, heat certified, certified heat refuses a scratch | **BLOCKED** | needs the lock |
| SCN-14.4 | Who can see results | PASS | judge, instructor and other-studio owner get 404, front desk is sent to check-in, anonymous goes to login, and the public event page shows no result text |
| SCN-13.1 | Publication and entrant visibility | **NOT IMPLEMENTED** | F3 is not built |

## 6. Findings

1. **FINDING — heats cannot be locked from the UI, so ballots cannot be locked.** The ballot desk refuses to lock while any
   heat is not locked ("1 heat(s) not locked yet"). Heat `lock_state` changes only through the database function
   `set_competition_heat_lock_state`, which no screen calls (only F2 calls it, to certify after approval). Running a heat to
   "Done" does not lock it. Result: no browser path from submitted ballots to a calculated, approved or certified result, which
   blocks SCN-6.3, 10.4, 11.3–11.5, 14.1–14.3. The scenarios are written and become real as soon as a path exists (re-run the
   same spec).
2. **FINDING (already with the owner) — corrected ballots (SCN-14.2/14.2b):** F2 lets the database accept a corrected ballot
   while a correction is open, but no screen offers the form.
3. The SS1 setup UI works end to end: apply a setup to all divisions, the callback target blocker and T field, publish with the
   method pinned, judges' callback and ordinal ballots from their own accounts, the no-show note and the missing entry on the
   judge sheet.
4. The no-show read needs a verified-email credential (see the NS1 report); the harness verifies the owner's mailbox first.

## 7. Integrity, teardown and shutdown

- Teardown: every run's checked cleanup (it throws on any leftover) completed; it clears the competition history tables
  through the DB container by event id. I did not re-query `qa-acc3` after stopping it.
- Shutdown: my dev server, my own `stripe listen` and the memory sampler were stopped (PIDs verified as mine);
  `supabase stop --backup` kept the data in docker volumes of project `qa-acc3`. Nothing was deleted.
- Hosted DEV/PROD, deploys and live providers were not touched.
