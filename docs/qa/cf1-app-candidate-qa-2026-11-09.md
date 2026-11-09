# Competition Finals (CF1) app release candidate: QA report

Date: 2026-11-09. Git-only candidate. **Nothing was merged, deployed, promoted, applied to a hosted database, or changed in Vercel or Stripe.**

| Item | Value |
|---|---|
| Candidate branch | `release/competition-cf1-app-candidate` (draft PR against `release/tw4f-monitoring-r2-cib`) |
| Base (live www code) | `release/tw4f-monitoring-r2-cib` `a965f477` (deployed as dpl_6cCoRGWg…) |
| CF1 source | `cf1/integration-5` `400cce2b`, engine-spec wording from `28a7722e`; F1 engines byte-identical to `competition-f1-studio-engines` `ee6bd401` |
| Heat-size hotfix | `hotfix/competition-heat-capacity-reason` `ac902c28` (parent `a965f477`, standalone; merged into the candidate) |
| App code under browser test | `4ffdede9` (app code byte-identical to the final head; later commits touch e2e, docs and scripts only) |
| Inventory | `cf1-app-candidate-inventory-2026-11-09.md` / `.json` |
| Schema compatibility | `cf1-app-candidate-schema-compat-2026-11-09.json` |
| QA stack baseline | `cf1-app-candidate-qa-stack-baseline-2026-11-09.json` |
| Browser results | `cf1-app-candidate-acceptance-on-2026-11-09.json`, `cf1-app-candidate-acceptance-dark-2026-11-09.json` (traces and screenshots stay outside the repository under `<scratchpad>/runs/`) |

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
| Q8 | CF1-C acceptance, flag **ON** (advancement + regression specs) | PASS: 16 scenarios + 2 setup steps; **SCN-R82 BLOCKED** (no UI creates an entry without a registration; SQL gate U82 covers it, owner-accepted 2026-11-01) | dev mode, `cf1c-qa` (section 5), app `4ffdede9` | `cf1-app-candidate-acceptance-on-2026-11-09.json`. Run 48 min; server log shows `/competition/officials` served 200, so the candidate code was under test (the live base has no such route). |
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
   - decisions on review P2-2 and the P2 trust-model question.
5. **Still prohibited and not requested:** registration flag, director outreach, Stripe operations, hosted SQL.
