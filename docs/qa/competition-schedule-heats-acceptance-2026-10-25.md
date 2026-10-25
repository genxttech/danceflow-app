# Competition Schedule & Heats acceptance report — 2026-10-25 (QA-A)

Spec: `e2e/tests/competition-schedule-heats-acceptance.spec.ts` (PR #341, stacked on #297). Machine-readable twin:
`competition-schedule-heats-acceptance-2026-10-25.json`.

**Result: two back-to-back runs, identical.** Each run: 20 PASS, 3 BLOCKED, 2 NOT IMPLEMENTED, 0 FAIL, 0 NOT RUN
(run 1 `final1` 22.3 min, run 2 `final2` 14.0 min). The 20 PASS include SCN-0, an environment warm-up that is not a
scenario, so 19 scenarios passed. Skipped tests are never counted as PASS. No SQL setup shortcut is used in any scenario.

Independent review of this evidence has not happened yet; this report is the implementer's account.

## 1. System under test

Local, unpushed branch `qa-sut` (worktree `C:\Dev\studioapp-qa-sut`), built from `origin/main` `bf43cec3`
(K1 specs, PR #293) with `git merge --no-ff` in this order. **Every merge was clean: no conflicts, no resolutions.**

| # | Branch (PR) | Merged SHA |
|---|---|---|
| 1 | competition-int-r2-sc1 (R2 refunds #292 + SC1 scratch #306) | 00002ee8 |
| 2 | competition-r1-checkin-cas (CI-B #295) | 399d90ce |
| 3 | competition-cib-desk-balance (#320) | 328674d6 |
| 4 | competition-cb2-front-desk (#329) | 2cfe4ddc |
| 5 | competition-k1-setup-fixes (#322) | d02e0df9 |
| 6 | competition-e1-officials (#327) | 45a2c2b2 |
| 7 | competition-o1-day-of (#328) | 784eab8a |
| 8 | competition-e2-ballots (#331) | 958b9547 |

`qa-sut` head `572e7821`. The e1 and o1 branches have moved on since (now 17605857 and 2df253dd); this run used the
SHAs listed above. REG #338, F1 #337 and F2 #339 are **not** in the SUT. Harness: branch `competition-qa-acceptance`
on #297 head `3764ae32`. Temporary `console.log` diagnostics added to qa-sut during debugging were reverted
(`git checkout -- src`) before the final runs; qa-sut had no uncommitted changes.

## 2. Database baseline and replay

Supabase CLI project `qa-acc` (API 57521, DB 57522, mail catcher 57524). Schema built with E1's `build-db.mjs`
(`--external --cutoff 20270112090000 --crlf 20260831090000_user_has_client_portal_access_helper.sql`) from the July
schema-only baseline `danceflow-production-pre-accounting-v1-2026-07-15.sql` plus 272 repo migrations in version order
(cutoff = the last migration in qa-sut). **265 ok, 7 failed** — exactly the known non-competition set:

1. `20260918030000_landmark1a_slice5a_capability_activation_bridge` (5A guard: seeded rows absent)
2. `20261005090000_launchsec1b_client_photos_private_storage` (bucket missing)
3. `20261006090000_launchsec1b2_public_asset_storage_authorization` (bucket missing)
4. `20261011090000_launchsec2b_tenant_write_surface` (2B reviewed definitions)
5. `20261102090000_phase9a_payroll_integrity`
6. `20261103090000_phase9b_payroll_approval_evidence`
7. `20261104090000_phase9c_compensation_history`

No competition migration failed. Replay log: scratchpad `replay.json`.

## 3. Environment

App: qa-sut `next dev -p 3100` (Turbopack). Stripe: TEST key only (`sk_test_`), read at run time into the process
environment (never written to a file, log or report; the report folders were scanned for `sk_`/`whsec_` strings: none).
Own `stripe listen --forward-connect-to` listener. Connected account: an existing enabled Stripe TEST Express account.
Playwright: chromium, 1 worker, no retries, `trace: on`, screenshots on every step, JSON + HTML reporters.
Artifacts (outside the repo): `…\scratchpad\runs\20261025-114304-final1\` and `…\runs\20261025-120541-final2\`
(`results.json`, `html/`, `artifacts/<test>/trace.zip` + numbered `NN-label.png`). Dev server quirk: the first request to
an uncompiled route returns 404, so SCN-0 pre-compiles every route; earlier development runs failed on exactly that.

## 4. Scenarios (same result in both runs)

Screenshots: `artifacts/<test-folder>/NN-*.png`; trace: `artifacts/<test-folder>/trace.zip` (full paths in the JSON).
Reproduce: start the stack and app as in §3, then
`E2E_RUN_DIR=<dir> npx playwright test -c e2e/playwright.acceptance.config.ts`.

| ID | Scenario | Status | Key DB / UI evidence |
|---|---|---|---|
| SCN-0 | Route warm-up (not a scenario) | PASS | — |
| SCN-1.1 | Wizard offers only Medal Marks for adjudicated Country (no callbacks) | PASS | no "How are results given?" step; event row created |
| SCN-1.3 | W4/K1 callback-target readiness blocker | **BLOCKED** | no UI path creates a `callback_tally` round (wizard, Advanced round form) — see Findings |
| SCN-1.2 | Create competition, add 2nd division via Divisions page, publish, open registration | PASS | program `configured/open`; 2 divisions, 2 rounds |
| SCN-2.1 | 3 buyers pay 4 entries (Stripe TEST), Entries page shows Paid / $80.00 | PASS | 3 paid orders, 4 confirmed entries; Avery = one competitor in two entries |
| SCN-2.2 | Eligibility: one ineligible entry excluded; Schedule says "3 confirmed entries are ready" | PASS | eligibility rows match; 0 floor heats before generate |
| SCN-3.1 | Generate heats; Avery's entries in different heats; conflicting move disabled in UI | PASS | 2 floor heats, 0 double-bookings; disabled option "…already dancing in Heat n" |
| SCN-3.2 | Capacity 2 persists; regenerate with 4 entries | PASS | scoring-heat sizes [2,2]; `max_entries_per_heat=2` |
| SCN-3.3 | Move heat, add empty heat, remove it | PASS | heat numbers contiguous 1..n after each step |
| SCN-3.4 | Publish; reload; second manager sees Published | PASS | one published version |
| SCN-3.5 | Edit published → draft copy → move → republish | PASS | versions [1 superseded, 2 published]; published order stays in effect on day-of while the copy is edited |
| SCN-5.1 | Unverified judges disabled; after real email verification owner adds 3 officials, chair, panel "Panel ready" | PASS | letters A,B,C; `competition_round_panel_status` ready, 3 judges |
| SCN-5.2 | Judge sees only own assignment; instructor sees none; both 404 on workspace | PASS | other judges' names / entries / other events absent from judge page |
| SCN-7.1 | Day-of: schedule round → start round → heat 1 staging → active → complete; reload | PASS | scoring-heat statuses staging, active, complete; round scheduled → active |
| SCN-6.1 | Scratch in an open heat | PASS | "No payment was changed"; orders unchanged; 1 audit row `normal`; placement `scratched`; heat stays open; day-of no longer lists the entry |
| SCN-6.2 | Danced heat refuses scratch | PASS | amber explanation, no Scratch button, no audit row, entry still confirmed |
| SCN-6.3a | Locking prerequisite evidence | PASS | ballot desk: "Ballots for Custom rounds are not available yet", Lock ballots disabled, 0 ballots, heats open |
| SCN-6.3 | Official scratch in a locked heat | **BLOCKED** | see Findings |
| SCN-7.2 | Cancel round with reason (empty Bronze Open) | PASS | one round `cancelled`, persists after reload |
| SCN-8.1 | Access matrix | PASS | owner and studio_admin 200 on 7 workspace pages + check-in; front_desk redirected to `/checkin` on all 7; instructor, judge, other-studio owner 404 on all pages and the scratch page; anonymous → `/login` |
| SCN-8.2 | DB authorization with real JWTs | PASS | owner reads rows in 5 tables; other-studio owner and anon read none and cannot call `list_competition_official_candidates`; judge's `my_competition_judging_assignments` returns only their own round |
| SCN-9 | Integrity | PASS | one version in effect; contiguous numbers; 0 double-booked dancers; every scratched entry audited; no refunds; 3 paid payments |
| SCN-4.1 | Heat-level judge assignment | **NOT IMPLEMENTED** | panels are per round only |
| SCN-4.2 | Instructor-to-heat assignment | **NOT IMPLEMENTED** | no control exists |
| SCN-4.3 | Real conflict banner / publish blocked | **BLOCKED** | no UI path creates a shared-competitor heat; the guard is covered by the 10D SQL suite, not this walkthrough |

## 5. Findings for the owner / coordinator

1. **Callback programs are unreachable from the UI (SCN-1.3).** The setup wizard (`studio_custom@3`) offers Medal
   Marks for Country and no Callbacks + Final; the Advanced round form has no `callback_tally`. W4/K1's "Callback
   target not set" blocker therefore cannot be walked through; it is tested only by SQL/unit suites.
2. **No UI path to a locked heat (SCN-6.3).** Wizard rounds are scored `custom`; the ballot desk says ballots are
   unavailable for them and Lock ballots stays disabled; heats lock only on ballot lock. SC1's official-scratch-in-a-
   locked-heat path is thus unreachable by UI, and the SC1 PR 306 walkthrough seeds those heats directly.
3. **Schedule page always opens the working draft** for every manager (not an issue; documented by SCN-3.5).
4. A scratch is applied to the entry's placements in every schedule version that holds it.
5. The SC1 scratch is the only scenario that touches an append-only table; teardown needs `E2E_LOCAL_DB_CONTAINER`.

## 6. Integrity, authorization and teardown

- DB assertion (read-only service-role queries) follows every user-visible step; see the Key evidence column and the
  `evidence` entries in the JSON.
- Authorization: UI (SCN-8.1) and database (SCN-8.2, anon-key clients signed in as each user) agree.
- Teardown: both final runs' fixtures were removed by the checked cleanup with zero leftovers (the cleanup throws on any
  leftover; both runs completed). After the runs `qa-acc` still holds **one diagnostic fixture** (studio
  "E2E Full Competition Studio 7204730d", its other studio, 1 event, 11 auth users) that I kept deliberately
  (`E2E_KEEP_FIXTURES=true`) while debugging; it is local, synthetic and was not deleted (no deletion by instruction).
  No refunds or scratch rows remain from the final runs. A scratch audit table is append-only; the cleanup cleared the
  runs' own rows through the DB container.
- Shutdown: my dev server and my own `stripe listen` were stopped (PIDs verified as mine); `supabase stop --backup`
  kept the data in docker volumes `supabase_db_qa-acc` and `supabase_storage_qa-acc`.

## 7. Not covered / caveats

- Development iterations before the two final runs failed for spec or environment reasons and were fixed (cold-compile
  404, wrong expectations about verified judges, per-version row counting, a UI assertion matching a card title, load
  timing); none of those exposed a product defect other than the two UI gaps above. They are not part of the acceptance
  count.
- Not run: mobile viewport, concurrency between two managers editing the same draft, non-manager write attempts (no UI
  path exists; covered by SQL suites), F1/F2/REG behaviour (not in the SUT).
- Hosted DEV/PROD, deploys and live providers were not touched.
