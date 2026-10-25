# Competition Schedule & Heats + NS1 no-show acceptance report — 2026-10-25 (QA-A, run 2)

Spec: `e2e/tests/competition-schedule-heats-acceptance.spec.ts` (PR #341). Machine-readable twin:
`competition-schedule-heats-ns1-acceptance-2026-10-25.json`. This second report covers the full spec, including the new NS1
no-show scenarios (SCN-10.x), on a second integration branch, `qa-sut-2`. The first report
(`competition-schedule-heats-acceptance-2026-10-25.md`, on `qa-sut`) still stands for the schedule scenarios.

**Result: two back-to-back runs, identical.** Each run: 27 PASS, 4 BLOCKED, 2 NOT IMPLEMENTED, 0 FAIL, 0 NOT RUN.
The 27 PASS include two environment warm-ups (SCN-0, SCN-0b) that are not scenarios, so 25 scenarios passed. Run 1 took 31.7 min
and run 2 took 22.4 min; the host was saturated by other sessions. No SQL setup shortcut is used in any scenario.
Independent review of this evidence has not happened yet; this is the implementer's account.

## 1. System under test (`qa-sut-2`, local, unpushed, worktree `C:\Dev\studioapp-qa-sut2`)

`qa-sut` (head `572e7821`, composition in the first report) plus, merged with `git merge --no-ff` in this order. **All merges
clean, no conflicts.**

| # | Branch (PR) | Merged SHA |
|---|---|---|
| 1 | competition-reg-scoring-registry (REG #338) | 3d7a8f80 |
| 2 | competition-f2-results-lifecycle (F2 #339) | cfdc4d2e |
| 3 | competition-f1-studio-engines (F1 #337) | 688b5718 |
| 4 | competition-ns1-no-show (NS1 #342) | 4863aab5 (merged 3 times as the branch advanced: 03807f1b, 2cca247e, 4863aab5) |

`qa-sut-2` head `1a4429f5`. Temporary `console.log` diagnostics added to two files during debugging were reverted
(`git checkout -- src`) before the final runs.

## 2. Database

Fresh Supabase CLI project `qa-acc2` (API 57721, DB 57722, mail catcher 57724), built with E1's `build-db.mjs`
(`--external --cutoff 20270115090000 --crlf 20260831090000_user_has_client_portal_access_helper.sql`): July baseline plus 275
migrations, **268 ok, 7 failed**, the same 7 known non-competition failures as in the first report (5A guard, client-photos
and event-media buckets, 2B, payroll 9A/9B/9C). No competition migration failed, including REG 20270113, F2 20270114 and NS1 20270115.

## 3. Environment

As in the first report (Turbopack dev server on 3100, own `stripe listen`, Stripe TEST key from the process environment only,
nothing written to files; the run folders and this report were scanned for `sk_`/`whsec_`: none). Artifacts (outside the repo):
`…\scratchpad\runs\20261025-163559-ns11a\` and `…\runs\20261025-170813-ns11b\`.
NS1's tables are append-only and closed to every API role, so the harness reads them **read-only** through the local database
container (`E2E_LOCAL_DB_CONTAINER`), and the local teardown also clears them there.

## 4. Scenarios (same result in both runs)

All SCN-0 … SCN-9 scenarios have the same status and evidence as in the first report, except SCN-0b (new warm-up with the real event).

| ID | Scenario | Status | Key DB / UI evidence |
|---|---|---|---|
| SCN-10.1 | An official marks an entry in the active heat as no-show with a reason | PASS | console shows the "No-show" chip; `event_competition_heat_no_shows` row with the heat entry, reason and `marked_by` = owner; no void row; persists after reload |
| SCN-10.5 | Judge ballot page: note shown, no-show entry not on the sheet | PASS (partial) | role=status note "marked as no-show by an official"; the entry is absent from the sheet rows; ballot submission and the stale-ballot correction prompt are **BLOCKED** (setup-scoring gap, below) |
| SCN-10.3 | A staff member who is not an official is refused | PASS | front desk redirected to check-in, instructor and judge 404 on `/day-of`; direct `void_competition_heat_no_show` calls by front desk, instructor and two judges are rejected; mark/void counts unchanged |
| SCN-10.2 | Void with a reason | PASS | "No-show undone…"; chip gone; one void row linked to the mark; the mark row stays as history; judge note gone |
| SCN-10.7 | The chair marks a no-show on the ballot desk (NS1 4863aab5) | PASS | a non-chair judge has no "No-shows" panel; an empty reason writes nothing; the chair's mark is attributed to the chair (`marked_by` = judge 1); persists after reload |
| SCN-10.6 | A different studio | PASS | 404 on `/day-of` and on the judge ballot page; its direct `mark_competition_heat_no_show` call is refused; counts unchanged |
| SCN-10.4 | After ballots lock, marking is refused | **BLOCKED** | ballots cannot be locked through the UI (wizard rounds are scored `custom`, same gap as SCN-6.3); no SQL shortcut |
| SCN-1.3, SCN-6.3, SCN-4.3 | Callback-target blocker; official scratch in a locked heat; real conflict banner | **BLOCKED** | as in the first report |
| SCN-4.1, SCN-4.2 | Per-heat judge assignment; instructor-to-heat assignment | **NOT IMPLEMENTED** | as in the first report |

## 5. Findings

1. **The setup-scoring gap still blocks the ballot half of NS1** (SCN-10.4, SCN-10.5 partial): wizard rounds are `custom`
   and have no ballot scheme, so a judge cannot rank and ballots cannot lock through the UI.
2. **The floor console swallows a refused read.** `competition_round_no_shows` requires the caller to have a verified-email
   credential (`verified_email_for_user`). A manager without one (e.g. an owner account created without it) can still *mark* a no-show
   (the notice says "No-show recorded") but the console then shows no chip, because `loadDayOf` ignores the RPC error
   (`if (noShowError) continue`). The harness proves the owner's mailbox through the real sign-in link first (as it does for
   judges), after which the console shows the no-show. Worth an owner/NS1 decision: either show an error or relax the read.
3. **Closed tables.** NS1's tables have no API-role grants at all, so even the service role cannot read them; evidence needs
   the database container or an RPC session.
4. The first-hit dev-server 404 is an environment quirk handled by two warm-up tests; it is not a product defect.

## 6. Integrity, authorization and teardown

- The final runs' fixtures were removed by the checked cleanup (it fails the run on any leftover) and the no-show history was
  cleared through the container. After the runs `qa-acc2` still holds fixtures from **development runs I stopped mid-run**
  (10 studios, 55 auth users, no events, no no-shows): their teardown never ran. They are synthetic and local, and were not
  deleted (no deletion by instruction); the stack is stopped with its data kept in docker volumes
  `supabase_db_qa-acc2` / `supabase_storage_qa-acc2`.
- Shutdown: dev server and own `stripe listen` stopped (PIDs verified); `supabase stop --backup`.

## 7. Caveats

- Development runs before the final pair failed for spec/environment reasons (cold-compile 404s, lost clicks under load,
  a nested list selector, a read RPC needing a verified credential, API-closed tables) and were fixed in the spec. They are not part of
  the acceptance count. Two final runs were used because the earlier second runs hit load-related flakes that the harness now retries
  against the database.
- Not run: mobile viewport, concurrent managers on the same draft, F1/F2/REG behaviour beyond their migrations applying
  (they are in the SUT but outside this walkthrough).

## 8. Environment notes and the re-check / re-click logic (read with care)

**Memory and load.** Peak memory was not sampled; the host was under heavy load (run times 31.7 / 22.4 min).

**What was added.** Because clicks sometimes landed before the page hydrated under load (the click did nothing), three
spec-level helpers re-check and re-click. They touch only these steps, all in
`e2e/tests/competition-schedule-heats-acceptance.spec.ts`; no product code and no assertion was weakened:

| Helper (spec) | Steps it touches | What it checks before re-clicking | Why a second click cannot duplicate an action |
|---|---|---|---|
| `setEligibility` (`toPass`, 90 s) | SCN-2.2, SCN-3.2 eligibility saves | **the database**: after each Save it polls the entry's stored eligibility for 10 s; it re-selects and re-saves only if the stored value is still not the one asked for | saving the same eligibility value twice is idempotent |
| panel adds in SCN-5.1 (`toPass`, 120 s) | adding judges to the round panel | **the page** (rendered from the database): it skips the add if the judge is already listed on the panel, and re-adds only when the judge is not listed | the database refuses a second assignment of the same official (`COMP_PANEL_ALREADY_ASSIGNED`) |
| `clickUntil` (`toPass`, 240 s) | floor-console "Call to floor", "Start heat", "Complete heat" in SCN-7.1 and SCN-10.1 | **the page**: it clicks again only if the expected result (e.g. the "On deck" chip, the "Complete heat" button, "No heat is on the floor.") is not visible; it does not query the database before re-clicking | each transition button disappears once the heat has moved, so a second click needs a button that no longer exists, and the database state machine refuses a repeated transition. The tests still assert the database state after each transition (the scoring-heat status polls) |

So the accurate statement is: **re-clicks follow a failed check of the visible result (`clickUntil`, panel adds) or of the
stored value (`setEligibility`); they are not gated on a database check in every case**, and each is protected from double effect by an
idempotent write or a database guard, not by the helper alone. No mark/void of a no-show, scratch, publish or payment step
has retry logic.

**Retries in the final two runs.** Playwright retries are 0 (`retries: 0` in `e2e/playwright.acceptance.config.ts`), and both
final runs report 0 failed, 0 flaky and no retried test. Whether the in-test re-click loops ever iterated during those runs
was **not instrumented**, so it cannot be stated; the screenshots and traces show the end state of each step, not the
number of clicks. Earlier development runs did need the re-clicks (they are why the helpers exist) and are not part of the
acceptance count.
