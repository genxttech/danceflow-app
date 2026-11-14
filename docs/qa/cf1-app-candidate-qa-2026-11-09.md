# Competition Finals (CF1) app release candidate: QA report

Date: 2026-11-09. Git-only candidate. **Nothing was merged, deployed, promoted, applied to a hosted database, or changed in Vercel or Stripe.**

| Item | Value |
|---|---|
| Candidate branch | `release/competition-cf1-app-candidate` (draft PR #443; base retargeted to `release/cf1-hotfix-heat-schedulepush`, then to `release/tw4f-key-setup` on 2026-11-10) |
| Base (live www code) | **since 2026-11-10 18:02Z:** `release/tw4f-key-setup` `03297304` (tree 51640920, www dpl_AYaUyuLF…) = `ab940288` + 12 TW-4F key-setup files; merged in section 10.7. **Before that,** `release/cf1-hotfix-heat-schedulepush` `ab940288` (tree 640ba2ab, live as dpl_6rhE7gAq…). Originally `release/tw4f-monitoring-r2-cib` `a965f477` (dpl_6cCoRGWg…); sections 2–8 below were written against that base, and section 0 records the rebase. |
| CF1 source | `cf1/integration-5` `400cce2b`, engine-spec wording from `28a7722e`; F1 engines byte-identical to `competition-f1-studio-engines` `ee6bd401` |
| Heat-size hotfix | `hotfix/competition-heat-capacity-reason` `ac902c28` (parent `a965f477`, standalone; merged into the candidate) |
| App code under browser test | `4ffdede9` (app code byte-identical to the final head; later commits touch e2e, docs and scripts only) |
| Inventory | `cf1-app-candidate-inventory-2026-11-09.md` / `.json` |
| Schema compatibility | `cf1-app-candidate-schema-compat-2026-11-09.json` |
| QA stack baseline | `cf1-app-candidate-qa-stack-baseline-2026-11-09.json` |
| OJ-1 / PV-1 (2026-11-10) | section 10 |
| Browser results | `cf1-app-candidate-acceptance-on-2026-11-09.json`, `cf1-app-candidate-acceptance-dark-2026-11-09.json` (traces and screenshots stay outside the repository under `<scratchpad>/runs/`) |

## 0. Rebase onto the new live code (2026-11-10)

- **New live base:** `ab940288` = `a965f477`, then PR 441 (TW-4F pricing release, `ebeef20d`), then `bbadbf13` (this branch's heat-size fix `ac902c28` cherry-picked; identical patch-id), then PR 444 (schedule-push fix `81363467` and its tests `ab940288`).
- **Merge:** a real merge `63c83cf1`, with no force-push. `ac902c28` stays in this branch's history because removing it would need a rewrite. It and `bbadbf13` are the same patch, so the tree carries one heat-size change.
- **Conflict:** one, in `src/app/app/events/[id]/competition/schedule/actions.ts` (`friendly()` and the heat-size RPC call). It is the same overlap resolved in `de1a8d80`. I kept the candidate side: flag off = the live fix (one call), flag on adds the CF1 idempotent retry. No other file conflicted.
- **Preservation against `ab940288`: 0 changed files** in every area of section 3, plus the two new protected areas:
  - **PR 441 pricing release:** all 17 files.
  - **PR 444 schedule-push:** `src/lib/notifications/schedulePush.ts` and its 2 tests.
  - Against live, the schedule files differ only by the flag-gated CF1 additions (Final heat-size section, CF1 retry and error copy). The heat-size test file is identical to live.
- **Static schema check:** not re-run. PR 441's SQL (20270210*, 20270212) changes only TW-4F price objects, which no CF1 file references. The CF1 references are unchanged since section 4.
- **Tests on `15ca8098`** (app code = the merge plus a test-only warm-up fix):

  | Check | Result |
  |---|---|
  | tsc | PASS |
  | ESLint on 130 changed files | 0 errors, 5 warnings |
  | Full vitest, `--maxWorkers=4` | 597 files passed, 6 failed, 59 skipped; 9,684 tests passed, 6 failed, 1,290 skipped. **All 6 failures were 5 s timeouts**: five whole-source scan guards and `closeout.phase8d`. |
  | Those 6 files re-run sequentially | 138/138 PASS |

  - **`closeout.phase8d`:** it also fails alone on the unchanged live code (`a965f477` worktree; the documents area is identical in all three trees), so it's a machine-speed issue, not a candidate regression.
  - **Fix in my own test:** an earlier run exposed a cold-import timeout in `finalsGate.liveOff.cf1dark`. That file now warms its modules once.
- **Dark smoke, flag off, on `15ca8098`:** 7/7 PASS (dev mode, `cf1c-qa`, 6.5 GB free at start). Evidence: `cf1-app-candidate-acceptance-dark-rebase-2026-11-10.json`.
- **Flag-on CF1-C acceptance:** not re-run after the rebase. The only incoming code is TW-4F pricing and schedule push, outside the CF1 surface. The section 6 Q8 result stands for the CF1 code, which is unchanged.
- **Memory:** free RAM read 1.5 GB at 02:44Z and tsc was started without rechecking (it completed). Every later heavy run started at ≥ 6 GB.

## 1. Verdict

The candidate is the live release plus the CF1 overlay, dark by default. With `COMPETITION_FINALS_ENABLED` unset no studio sees anything new: every CF1 page, server action and the public results page answer 404, and every live page CF1 touched behaves as the live release, with one deliberate exception, the owner-approved heat-size hotfix (section 6). Financial and platform controls are untouched (0 changed files in each protected area). All referenced RPCs, relations and columns exist in the PROD post-S3 + CI-B schema. Unit, type and lint checks pass. Browser acceptance passed in dev mode. The production-build run and the Stripe-based acceptance suites are **BLOCKED**, not passed.

## 2. Dark gate

`src/lib/competition/finalsGate.ts` (`import "server-only"`):

- `COMPETITION_FINALS_ENABLED` must be exactly `"true"`. Unset, empty, `"1"`, `"TRUE"` and the like are all OFF. It is a server variable, never `NEXT_PUBLIC_`.
- The public results page also needs `COMPETITION_PUBLIC_RESULTS_ENABLED` = `"true"`. That variable alone opens nothing.
- **First statement of every CF1 entry point:** `requireCompetitionFinals()` / `requireCompetitionPublicResults()`. This covers 16 files: 10 pages, 38 server actions, and `updateCompetitionCallbackTargetAction`. A unit test pins the inventory, so a new CF1 page or action fails the test until it is gated.
- **Live pages CF1 modified:**
  - With the flag off, these load and render nothing CF1-related: Advanced settings (studio scoring, callback target), Readiness (CF1 checks are neither counted nor shown), Schedule (Final heat-size section), heat planning (no callback refusal, no ordinal single-heat blocker), publish (no scoring-readiness refusal), and workspace navigation (the live list).
  - The navigation flag comes from the server layout.
- **Optional per-studio allowlist: not built.** It is not trivial: the officials and judges entry points are not studio-scoped by session.
- **No database check was weakened.** R2 gate, OD-17, publication, D7 desk gate and RLS remain the authority.
- **The flag only gates UI and server actions** (review informational item). The S1–S3 RPCs are already granted to `authenticated` on PROD, so a manager can call them directly with the flag off. That was true before this candidate. The database gates are the real control.

## 3. Preservation review (diff against `a965f477`)

| Protected area | Paths compared | Changed files |
|---|---|---|
| R2 refunds | `competition/registrations/**`, `entryRefunds*`, `src/app/api/payments/**`, R2 migrations | 0 |
| CI-B desk balance | `competition/checkin/**`, `checkinBalance.ts`, `20270211090000` | 0 |
| D7 organizer gates | `src/lib/billing`, organizer routes and libs, `20270203*`, `20270205*` | 0 |
| Founder Pricing / billing | pricing, stripe, billing routes | 0 |
| TW-4F | `src/lib/twilio`, `src/lib/sms`, `src/app/platform/sms`, `src/app/api/cron`, TW-4F migrations, `vercel.json` | 0 |
| H1 platform admin | `src/app/platform`, `src/lib/platform`, `src/lib/auth`, `src/proxy.ts` | 0 |
| Competition registration flag | `registrationFlag.ts`, `src/app/api/events/**`, public register pages | 0 |
| Package / build config | `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json` | 0 |

- **Outside the competition surface**, only these changed: `scripts/qa/*` (new), `src/lib/e2e/runDirGuard.ts` (new, test harness), and two `src/lib/e2e` tests.
- **Migration files:** they are Git-only copies. All 25 CF1 forward files and their rollbacks have sha256 values identical to `cf1-release-manifest-2026-11-08.tsv` (the PROD-applied blobs). The R2 forward and rollback files already in the base also match.

## 4. Schema compatibility (static, no hosted query)

- **Method:** `scripts/qa/cf1-schema-compat.mjs` extracts every `rpc(...)`, `from(...)` and selected or filtered column from the app files changed since `a965f477`, then checks them:
  - RPCs: existence, `authenticated` EXECUTE, and an overload of the same arity, against PROD post-S3 `q02_F`.
  - Relations and grants: against `q04_R` and `q08_G`.
  - RPC argument names and columns: against the migration DDL. A column is also accepted when the live release already queries it, which covers base tables created outside the migration folder.
- **Result:**
  - 83 RPC references: all exist with `authenticated` EXECUTE. 67 have named arguments and all of those match a PROD overload. (The live two-argument heat-size call is gone since the hotfix.)
  - 32 relations: all exist with grants.
  - 222 columns: 212 resolve to migration DDL, 10 are already queried by the live release.
  - **0 problems.** No reference depends on a migration after 2026-11-19 outside the manifest.
- **CI-B:** it replaced only `record_competition_checkin_payment`. No CF1 file calls it. Its PROD md5 (`f7ff0735…`) is reproduced on the QA stack (section 5).
- **Dependency note (review P3-a):** with the flag off, Advanced settings still selects `events.competition_sanctioning` and the division/round scoring columns from `20270113090000` (S1, live on PROD). Rollback order must stay app first, then SQL.

## 5. Browser QA environment

- **Stack:** local Supabase `cf1c-qa`, granted to this session by the coordinator. It was originally built from an older CF1 chain.
- **Backup:** taken before any change (`pg_dump -Fc`, kept outside the repository).
- **Brought to the PROD competition baseline by forward-only, one-transaction-per-file applies:**
  - R2 `20270103090000` and gate `20270103091000`; D7 `20270203090000`, `20270203100000`, `20270205100000`.
  - CF1 `20270120102000`, `103000`, `104000`, `105000`; F3 `20270122090000`; CI-B `20270211090000`.
  - Re-applied A0 review fixes `20270120101000`.
  - Re-created two functions verbatim from their manifest files: A7 `cf1_a7_record_correction_cause`, and `cf1_guard_advancement_correction` with F3's exact in-place patch.
  - The old S3 subset could not be rolled back: the manifest rollback files refuse that older state, and nothing was changed by the refusal.
- **Result, PROD post-S3 fingerprint queries on competition objects:**

  | Catalog | Identical to PROD | Exceptions |
  |---|---|---|
  | Functions | 307/308 | `record_competition_checkin_payment`: QA has PROD's current CI-B md5 `f7ff0735…`; the S3 snapshot predates CI-B (expected) |
  | Triggers | 197/197 | none |
  | Relations | 86/86 | none |
  | Constraints | 759/760 | `event_competition_registration_cart_people_name_check`, a pre-existing difference unrelated to CF1 |
  | Policies | 87/87 | none |
  | Grants | 89/89 | none |

  Outside the competition surface, the stack still differs from PROD in 4 TW-4F/monitoring functions that are missing and 5 that differ (recorded in the baseline JSON). CF1 does not use them.
- **Run mode:**
  - **App:** the candidate on `next dev` (Turbopack, dev mode), port 3100. A `next build` was attempted first and its 4 GB build worker ran out of memory with 6.9 GB free on the machine. The production-build run is therefore BLOCKED (below), per the coordinator's fallback rule.
  - **Browser:** installed Google Chrome 156 (`channel: "chrome"`) through a run-local config override that is not committed. No browser download was made.
- **Memory rule:** each run started only at ≥ 6 GB free RAM (6.1–8.1 GB recorded per run). One earlier attempt was started at 5.0 GB free, which was a mistake. It failed at browser launch before any scenario step and is not counted.
- **Fixture teardown:** on the PROD-equivalent schema, service_role can no longer delete entitlement rows (D7 least privilege). The fixture now clears its own studio's rows through the pinned local container, which is the harness's documented pattern. All runs ended with zero leftover rows.

## 6. QA matrix

| # | Check | Status | Environment | Evidence |
|---|---|---|---|---|
| Q1 | TypeScript `tsc --noEmit` | PASS | local, final head | exit 0 |
| Q2 | ESLint on the 128 changed source, spec and script files | PASS (0 errors, 5 warnings) | local | unused-variable warnings only |
| Q3 | Full vitest | PASS: 600 files passed, 57 skipped, 0 failed; 9,675 tests passed, 1,275 skipped | local, `--maxWorkers=4`, merged head | run log (scratchpad). Two earlier full runs at default parallelism had 35 and 32 failures: all 5 s load timeouts, plus knock-on failures in the same files. Those 25 files re-run sequentially: 535/535 PASS. |
| Q4 | Dark gate unit tests (`finalsGate.cf1dark`, `finalsGate.liveOff.cf1dark`) | PASS (87 incl. hotfix) | local | failing-first: 72 of 81 fail with the gate removed |
| Q5 | Heat-size hotfix unit test | PASS 6/6 | hotfix worktree on `a965f477` and candidate | failing-first: 6/6 fail on `a965f477` |
| Q6 | Review P2-1 judging links test | PASS 4/4 | local | failing-first: 4/4 fail |
| Q7 | Static schema compatibility | PASS (0 problems) | PROD post-S3 fingerprints + CI-B md5 | `cf1-app-candidate-schema-compat-2026-11-09.json` |
| Q8 | CF1-C acceptance, flag **ON** (advancement + regression specs) | PASS: 16 scenarios + 2 setup steps; **SCN-R82 Browser N/A** (no manual-entry UI exists; U82 SQL PASS; conditional contract, ACCEPTED by owner 2026-11-01, not a blocker) | dev mode, `cf1c-qa` (section 5), app `4ffdede9` | `cf1-app-candidate-acceptance-on-2026-11-09.json`. Run 48 min; server log shows `/competition/officials` served 200, so the candidate code was under test (the live base has no such route). |
| Q9 | Dark smoke, flag **OFF** (SCN-DARK 1–5) | PASS 6/6 | dev mode, `cf1c-qa`, flag and public flag unset | `cf1-app-candidate-acceptance-dark-2026-11-09.json`: 9 CF1 owner URLs → 404, public results → 404, live competition pages → 200, live navigation, no CF1 control on Advanced |
| Q10 | Heat-size hotfix in the browser (SCN-DARK-6, flag off) | PASS | as Q9 | saved notice; exactly one `event_competition_round_capacity_events` row (capacity 2, the reason, a UUID request id) |
| Q11 | Acceptance on a production build (`next build` + `next start`) | **BLOCKED** | build OOM: 4 GB build worker, 6.9 GB free | not counted as PASS |
| Q12 | Schedule-heats + scoring-results acceptance (`playwright.acceptance.config.ts`) | **BLOCKED** | needs Stripe TEST keys + `stripe listen` (SCN-2.1 pays with a test card); this session runs no Stripe operations | SCN-3.2 updated to fill the required reason |
| Q13 | Public results page with `COMPETITION_PUBLIC_RESULTS_ENABLED=true` | NOT RUN (browser) | — | unit-tested only; public visibility is an owner decision |
| Q14 | Judge "Open ballot / Open desk" links in the browser | NOT RUN (browser) | — | unit-tested; CF1-C specs open the ballot by URL |
| Q15 | SQL test suites (`sql-tests/`) | NOT RUN here | — | SQL is already live on PROD; prior evidence in `cf1-int5-closeout-2026-11-07.md` / RB4 |
| Q16 | Harness protocol "two runs back to back" | NOT RUN | — | each suite ran once on the final app code |

## 7. Independent review disposition

The review was run by a separate Opus agent with no anchoring. It received the diff and the requirements, not my conclusions. It found **no P0 and no P1**.

| Finding | Severity | Disposition |
|---|---|---|
| P2-1: `/app/judging` lists rounds as text; no link to the judge ballot or chair/scorer desk | P2 | **Fixed**, failing-first: `judgingRoundLinks()`. Panel judges get "Open ballot"; chair and scorer get "Open desk"; malformed ids get no link. The round-keyed RPCs stay the authority. |
| P2-2: an organizer-team-only official cannot reach `/app/judging` (the `/app` layout requires a studio context); judges of a billing-paused studio are sent to billing | P2 (flag-on only) | **Not changed.** This is an architecture/product decision (layout change). Listed for the owner/coordinator. |
| P2-design: `calculate_competition_round` accepts app-built rows; the DB verifies hashes but does not recompute placements, and a single manager plus an override-reason approval could publish fabricated placements | P2 (trust model) | **Not changed.** This is live PROD SQL. Owner question. |
| P3-a: the Advanced page selects S1 scoring columns even with the flag off | P3 | Accepted: S1 is live on PROD. Rollback app first. |
| P3-b: a direct URL hit on a CF1 route runs the existing `/app` layouts before the 404 (a paused studio is redirected to billing) | P3 | Accepted: no link leads there; not a visible change. |
| P3: callback target 1 shows the error boundary instead of a friendly message; Results stays "Later" in the nav; readiness badge ignores two warning rows; `HEAT_PLANNER_VERSION` not bumped; scoring setup is two writes | P3 | Recorded for the CF1 follow-up backlog (flag-on only). |

**Update 2026-11-10:** the owner decided both open items. P2-2 is resolved by **OJ-1**: organizer-team judges may use the judging pages only with an active official assignment for that event. The P2 trust-model item is resolved by **PV-1**: the database recomputes every result and refuses any other rows. See section 10.

## 8. Live regression found and fixed (separately shippable)

- **The regression:** since the PROD S3 migrations, `set_competition_round_heat_capacity(round, capacity)` always raises `COMP_CAPACITY_REASON_REQUIRED` (OD-14). The live app called only that form, so **"Max entries per heat" cannot be saved on www today**.
- **Coordinator instruction:** reason plus audit is owner-approved (OD-3/OD-14). The hotfix commit `ac902c28` (parent `a965f477`) touches only the schedule actions, the schedule page form and a new test.
- **What the hotfix does:**
  - The form always collects a reason (20–500 characters) and sends a fresh request id.
  - The action requires the request id to be a UUID and the round to belong to the event, then calls the four-argument RPC.
  - Capacity refusals from the database are shown as plain sentences.
- **In the candidate:** the hotfix is the flag-off baseline. With the flag on, the CF1 path adds one idempotent retry.
- **Note:** a manager without a verified email gets the generic "could not be saved" copy, because `COMP_CAPACITY_FORBIDDEN` is deliberately not echoed. A friendlier message is a possible P3.

## 9. Owner authorizations needed (none are granted by this report)

1. **Heat-size hotfix (`ac902c28`) to www**, independently of CF1:
   - authorize a Vercel deployment of that commit (on top of `a965f477`) and its promotion to www;
   - name the rollback target `dpl_6cCoRGWg…`;
   - no SQL and no env change.
2. **CF1 candidate to www (dark):**
   - approve the draft PR into `release/tw4f-monitoring-r2-cib` (or a release branch from it);
   - authorize a Vercel deployment and promotion with `COMPETITION_FINALS_ENABLED` and `COMPETITION_PUBLIC_RESULTS_ENABLED` **unset in Production**, with the hosting owner confirming they are unset;
   - rollback target: the then-live deployment;
   - no SQL (everything is already applied);
   - TW-4F env flags stay as they are.
3. **Before staging:**
   - a production-build acceptance run (Q11) on a machine with enough memory;
   - the Stripe-TEST suites (Q12) if the owner wants them repeated on this composition.
4. **Activation, each a separate owner decision after a dark release:**
   - set `COMPETITION_FINALS_ENABLED=true` (a Production env change; global, no per-studio allowlist);
   - optionally `COMPETITION_PUBLIC_RESULTS_ENABLED=true`;
   - OD-17 switch rows; result publication;
   - review P2-2 and the P2 trust-model question: decided 2026-11-10 (OJ-1 and PV-1, section 10).
5. **Still prohibited and not requested:** registration flag, director outreach, Stripe operations, hosted SQL.
6. **PV-1 and OJ-1 PROD SQL (owner decisions 2026-11-10), before the candidate app:**
   - apply `20270215090000` (PV-1), then `20270215091000` (OJ-1), through the approved ops path; files, sha256s, rollbacks and postflight pins are in section 10.6;
   - rollback order: app first, then OJ-1, then PV-1.

## 10. OJ-1 and PV-1 (owner decisions 2026-11-10)

Git-only; the Finals flag stays off by default. Nothing was applied to a hosted database.

Specs:
- OJ-1: `docs/competition/e1-officials-judging-access.md`.
- PV-1: `docs/competition/scoring-results-contract.md` §5 and §11a, plus both engine specs.

### 10.1 What changed

**OJ-1: organizer-team judges.**
- **Rule:** a user with no studio role may open `/app/judging`, the ballot page and the desk page only with an active E1 official assignment (judge, chair or scorer) for that event. The desk also needs E2 to resolve them as chair or scorer.
- **Where it is enforced (server side):**
  - the `/app` layout, flag on, `/app/judging` paths only;
  - both page loaders;
  - all nine judging actions.

  The code is in `src/lib/competition/officials/judgingAccess.ts`.
- **Studio staff:** unchanged.
- **Scope ruling: judging only.**
  - The 10A manager authority (`can_manage_event_competition`) is unchanged, and its SQL is untouched.
  - A manager without an assignment cannot act as a judge (proof P8).

**OJ-1 SQL fix, from review P2 (`20270215091000`).**
- E2's round role and the four judge functions now also require E1's `_comp_e1_is_team_member`.
- So an official removed from the team loses access at once, even if their official row stays active.

**PV-1: the database recomputes results (`20270215090000`).**
- **The port:** both engines are ported to plpgsql over the stored evidence: callback tally, and ordinal majority under the studio_simple@1 rules profile.
- **`calculate_competition_round`:**
  - refuses any row set or warning list that differs from the database's own result, with `COMP_RESULT_RECOMPUTE_MISMATCH`;
  - fails closed on anything the port does not support, with `COMP_RESULT_RECOMPUTE_UNSUPPORTED`.
- **`approve_competition_round_result`:** re-verifies the stored rows.
- **App changes:**
  - the two new error codes get plain copy;
  - the unresolved-tie panel reads verified rows only, never an app-built trace.

### 10.2 Evidence

| Check | Result |
|---|---|
| OJ-1 unit tests (failing first) | 10/10 |
| OJ-1 SQL proof, `scripts/qa/oj1/oj1-sql-proof.sql` | P1–P8 as expected (see the E1 doc) |
| PV-1 SQL suite, `test_T_competition_pv1_recompute.sql` (fails first without the migration) | 30/30 |
| TS↔SQL equivalence, golden fixtures | 1,904 cases, **0 disagreements**. 2 cases differ only in the reason, both on malformed input, and both engines refuse them. |
| TS↔SQL equivalence, random corpus (seeds 20261110, 7, 424242) | 7,500 cases, **0 disagreements**; every refusal reason equal |
| Fabricated rows sent through PostgREST as `authenticated` | refused (SQL suite, and browser SCN-PV1-1/2 below) |
| Composed chain (PROD order, then PV-1 + OJ-1) | Calculate and approve pins match. PV-1/OJ-1 rollback and re-apply, and full reverse and re-apply: all 0-line diffs. Suites: PASS 40, FAIL 0. |
| A3 lock probe on the PV-1 chain | **CONC A3 PASS (9/9 probe values)**, `verify_cf1_a3_locks.sh` as shipped. An earlier "cannot create a3probe" came from an old local sed patch, not from the suite. |
| Control: baseline chain without PV-1/OJ-1 | PASS 38. FAIL 1: CONC F3, classified in 10.3 as a harness timing flake. A3 not verified. |
| CONC F3, original script (git HEAD, sha `748037e1…`), fresh baseline, twice | 11/11 and 11/11 |
| CONC F3, hardened script (proven ordering, sha `cca18ac6…`), fresh baseline | **11/11, order proven for every probe**: B was seen waiting on `Lock/transactionid` while A held the round lock |
| CONC F3, hardened script, PV-1 chain (calculate `167529ba`) | **11/11, order proven for every probe** |
| Fault injection, `scripts/qa/pv1/fault-injection.sh` | **PASS.** F1: error after the calculate redefinition, client stops (exit 3). F2: same point, client keeps sending (3 ERROR lines; the commit became a rollback). F3: error before any function. Each injected error was confirmed raised, and each left calculate/approve at the pre pins with no PV-1 function. F4 then applied the real PV-1 (pins `167529ba` / `3cf63c3b`, 10 functions) and OJ-1 (`a7d7a235`). |
| Browser SCN-PV1-1 (ordinal swap) and SCN-PV1-2 (callback flip, forged warnings); flag on, dev mode | **3/3 PASS** (Playwright exit 0, 27.3 min, system Chrome, `cf1c-qa`): SCN-0c setup 1.7 min; SCN-PV1-1 14.0 min; SCN-PV1-2 7.5 min |
| tsc (`.next` deleted) / ESLint on the 23 lintable files changed since `d3ca629a` / full vitest `--maxWorkers=4` | tsc **0 errors**. ESLint **0 errors, 0 warnings**. Vitest: 604 files passed, 1 failed, 59 skipped; 9,699 tests passed, 1 failed, 1,290 skipped (407 s). The one failure is the known `closeout.phase8d` 5 s timeout (section 0); re-run alone it passes **39/39**. |

### 10.3 CONC F3 baseline failure: a harness timing flake (coordinator verdict 2026-11-10)

- **Symptom:** the baseline chain run reported CONC F3 "1 failure". Its wrapper kept only the last 4 lines, so the failing case's name was lost.
- **Cause:** the original script ordered every race with a bare `sleep 1`, and nothing checked that session A held the round lock before B started. On a loaded host, B can start first. That inverts the ordered probes (3–6, 10, 11).
- **Evidence:**
  - The original script passed 11/11 twice on a fresh baseline.
  - The hardened script passed 11/11 on a fresh baseline and 11/11 on the PV-1 chain.
  - In each hardened run, every probe ran only after A was seen inside its lock-holding transaction and B was seen waiting on that lock.
- **The test change is test-only:** `test_T_competition_cf1_f3_concurrency.sh` now uses `race()` with in-database polling of `pg_stat_activity` and a 15 s hold. A probe whose ordering cannot be established is NO VERDICT, never PASS or FAIL. The F3 SQL is unchanged.
- **Run hygiene:**
  - The host rebooted at 14:57Z and killed the background runs. Every result above either finished before the reboot or was re-run after it.
  - One stopped job outlived its stop and overlapped a run on the same container. Both the job and that run were voided and are not counted.

### 10.4 Test-only neutralizer and partial apply

**Confinement.**
- Six SQL suites feed hand-built rows. Each installs a no-op `_comppv1_verify` inside its own transaction, which is never committed.
- The no-op occurs only in `sql-tests`. It appears zero times in the migrations and rollbacks.
- Each neutralizer block now refuses under per-statement autocommit (`now() = statement_timestamp()`). Proven on `cf1c-qa`:
  - under autocommit, the block is refused;
  - inside an explicit transaction, the no-op is present;
  - after `rollback`, the real verifier is back.

**Partial PROD apply.** No restructuring was needed:
- `20270215090000` is one explicit `begin` … `commit`.
- It creates and revokes the real verifier before either redefinition.
- Each redefinition re-reads its installed text and raises unless the text equals the post pin.
- The preflight refuses if any `_comppv1_` function already exists, so a leftover no-op blocks the apply.
- Any error aborts the transaction, and the final `commit` becomes a rollback. This holds whether the client stops on the first error or keeps sending statements. The fault-injection run above proves both cases.

### 10.5 Review disposition (independent Opus security review)

| Finding | Disposition |
|---|---|
| P0 | none |
| P1: organizer managers can use desk, paper-ballot, attendance and no-show powers without an assignment | Out of scope per the coordinator ruling: this is 10A manager authority, unchanged and documented. |
| P2: the E2 role ignored team membership | **Fixed** (`20270215091000`) |
| P2: the unresolved-tie panel read the app-built trace | **Fixed**: it reads verified rows only |
| P2: approve did not re-verify | **Fixed**: approve re-verifies the stored rows |
| Follow-up review | The three P2s are confirmed closed; no new P0–P2 |
| P3: `_compe2_round_judges` still counts a removed judge | Recorded, out of scope |
| Caveat: an autocommit runner would leave the neutralizer installed | **Fixed** by the guard in 10.3 |

### 10.6 PROD SQL (future; NOT applied; owner authorization required)

Apply the SQL before the app: PV-1 first, then OJ-1. Each file goes through the approved ops path on its own, as the postgres role.

| Step | File | sha256 | Rollback (sha256) |
|---|---|---|---|
| 1 | `20270215090000_competition_pv1_result_recompute.sql` | `69123627e47e7966a42d6671c0f1ef7ec13472eaf309b25dc2fce7b9b4af1462` | `rollback/20270215090000_competition_pv1_result_recompute_rollback.sql` (`b8226d278e196e3e80ee612a9394ead4cfdbf7475bcecb3695df5ab4ff4c4402`) |
| 2 | `20270215091000_competition_oj1_official_team_member.sql` | `4a30f5e22abc9abf2330191aace170cc07ab6f94c4ab9179b208f8847e007a19` | `rollback/20270215091000_competition_oj1_official_team_member_rollback.sql` (`979ea0129ff9e8574ebb2b02de8c656e2fd2dccd535d20476138878af2a4292f`) |

**Rollback order:** the app first, then the OJ-1 rollback, then the PV-1 rollback.

**Postflight pins:**

| Function | md5 |
|---|---|
| calculate | `167529bada8ca5a4dd98e22d4d0a3252` |
| approve | `3cf63c3bb00a78142ea2c8e70a8b4a0c` |
| `_compe2_round_role` | `a7d7a235d9522a073312807df3ff11f9` |

These steps are added to the owner authorizations in section 9 (item 6).

### 10.7 Merge of the new live code `03297304` (2026-11-10, after 10.2)

- **Merge:** live moved at 18:02:40Z to `release/tw4f-key-setup` `03297304` (tree 51640920, www dpl_AYaUyuLF…). That is `ab940288` plus 12 TW-4F key-setup files. A real merge (`7e183053`), no force-push.
- **No conflicts.** None of the 12 files overlap any candidate file.
- **Preservation:** all 12 key-setup files are byte-identical to `03297304`. The candidate's own diff against `03297304` has the same patch-id as its diff against `ab940288` before the merge, so nothing else moved.
- **Re-run on the merge** (coordinator scope):

  | Check | Result |
  |---|---|
  | tsc (`.next` deleted) | **0 errors** |
  | `src/lib/sms/__tests__/keySetup.test.ts` | **6/6** |
  | The two TW-4F `localStack` suites (`localStack.priceauth`, `localStack.pricehello`) | not run: TWILIO-owned, verified by the TW-4F release; byte-identical to live `03297304`. Standing rule: TW-4F localStack suites never run on a shared database. |

  The full suite was not re-run, because the merge had no conflict.
- **Inventory** regenerated against `03297304`: 361 paths; the same 10 deliberate exclusions.
- **Manifest:** unchanged. The four PV-1 / OJ-1 file sha256s match its rows.
