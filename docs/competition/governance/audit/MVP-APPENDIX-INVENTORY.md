# Appendix: workflow and PR inventory (read-only)

# Competition OS: Studio/Custom MVP release inventory (conditional)

Snapshot 2026-11-26 about 21:00Z. Read-only. No tests, docker, hosted access, edits or comments.
Shipping line `origin/release/website-embeds` `49dbaee1b`. Candidate pilot: final-only, one round per contest, one dance per division, adults only, flags OFF.

Marks: **V** = verified this pass (git ref, GitHub API, local log). **R** = reported by a repo doc, PR body or session memory; not re-run or re-read at source. **I** = inferred. **ND** = not determined.
All queued or pending test results are PROVISIONAL.

## 1. Workflow, step by step

Flags (V): `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED` (registration; build-time public variable, so a rebuild is needed, I), `COMPETITION_FINALS_ENABLED` (officials, ballots, judging, day-of, results), `COMPETITION_PUBLIC_RESULTS_ENABLED` (also needs finals). All default OFF (exact string "true"). All are global; no per-studio allowlist (R: CF1 QA report). The finals flag gates UI and server actions only; the RPCs are granted to `authenticated` (R: same report).

| Step | On the shipping line (V unless marked) | Missing, or only in a PR | Executed end to end |
|---|---|---|---|
| Setup | `/app/events/[id]/competition/new`, divisions, settings; preset `final_only` (`studio_ordinal_majority@1`); `create_competition_draft`, `publish_competition_program`. No flag | No guard limiting a contest to one round: only `unique(division_id, sequence_number)`; round rows are inserted directly from the app. No PR found that adds final-only / one-round / one-dance restriction (I) | Part of the runs below |
| Registration | `/events/[slug]/competition/register`; `api/events/[slug]/competition/{checkout,resume,release}`; `quote_/start_/prepare_/finalize_competition_registration`. Registration flag. $0 orders finalize without Stripe (code comments, I) | Public activation holds (R, memory): ordinary-event whole-payment refund still calls `refunds.create` without amount (V, `registrations/actions.ts:2429`); early-bird appears fixed (I); check-in concurrency ND | Oct 30 harness chain paid by Stripe TEST card (R; registration scenario not checked individually). Real hosted Checkout NOT PROVEN since the 11-20 canary decision (R). Free-order path: NONE found |
| Eligibility | Registrations page; `updateCompetitionEntryEligibilityAction` writes `eligibility_status` directly. Only `ineligible` blocks scheduling (`floorPlanner.isSchedulableEntry`) | No under-18 gate on the line. `unverified` entries can compete (R-15). PRs 835, 837, 846 (app), 866, 863 (SQL). App call to `set_competition_entry_eligibility` is in NO PR (V) | NONE for the new gates (unit and local SQL only) |
| Scheduling | readiness, generation runs, schedule, publish: `create_/review_/apply_competition_heat_plan`, `apply_competition_floor_plan`, `publish_competition_schedule_version`. No flag for planning. Ordinal Final must be a single heat | Published-order direct-write guard: PR 899, blocker open | Oct 30 chain (R); dark smoke 11-09/10 (R). Schedule-heats spec on the CF1 candidate: BLOCKED (R) |
| Judging | officials page, `/app/judging`, judge ballot, judge desk, paper entry; `assign_competition_panel_member`, `submit_competition_ballot`, `enter_competition_paper_ballot`, `lock_competition_round_ballots`. Finals flag. Judges must be studio/organizer team members with an assignment (OJ-1) | External judges: design only (783). Panel readiness can accept panels the lock refuses: PR 864 | Oct 30 chain and CF1 11-09 (R). Judge "Open ballot / Open desk" links in browser: NOT RUN (R) |
| Day-of | day-of page; `schedule_competition_round`, `advance_competition_floor_heat`; no-show; heat lock. Finals flag | In-app Scratch: `scratchHref` 404s; PR 878. DB entry-status guard: PR 877. JC1/U18/U18-S not in the line's Git: PR 867 | Partly in Oct 30 chain (R) |
| Scoring | results page; `calculate_competition_round` with database recompute (PV-1) | None found for final-only | Oct 30 (before PV-1). PV-1 browser 3/3 on 11-10, dev mode (R) |
| Initial approval | `approve_competition_round_result`; one-manager self-approval of an initial result | 1-character override reason and self-approval of corrected versions: PR 865. R-11 cross-round replacement CONFIRMED by local probe, open (R) | Oct 30 chain (R) |
| Results | `publish_competition_round_result` (default `entrants`), `withdraw_...`; `/events/[slug]/competition/results` | The page requires the PUBLIC results flag even for a signed-in entrant's own result (V). No link to it found outside the staff app (I). Event-deletion guard: PR 844. Sanction-declared block: PR 832 | Oct 30 certification/results (R). Public page with flag on in browser: NOT RUN (R) |
| Refund (support) | R2 refund page and ledger; released to production 11-09 (R) | Callback/settlement repair is dark | Real competition refunds: none on PROD at release (R) |

### End-to-end evidence summary
- `docs/qa/competition-qa-sut6-prod-acceptance-2026-10-30.md` (R): composition `d7fcde04`, production build, ordinal Final-only 16 PASS + 1 setup, 1 NOT IMPLEMENTED (SCN-13.1), two runs; callback 5 PASS, 2 NOT RUN. Predates the CF1 overlay on the line, PV-1 and OJ-1. Independent review "has not happened yet" per that report.
- CF1 candidate (R): 11-09 flag-on advancement/regression 16 + 2 setup PASS, 1 BLOCKED, dev mode; schedule-heats + scoring-results BLOCKED (Stripe); production build BLOCKED (out of memory). 11-10 PV-1 3/3; dark smoke 7/7.
- **On `49dbaee1b`: NONE found. With any `202703*` migration applied: NONE (database suites only).**
- All competition e2e specs pay through an undocumented Stripe confirm call that failed in canary run 5 (R: CF1 session memory, D1 package). Whether it still works locally: ND. Plan on a $0 fixture or a repaired harness.

## 2. Open PRs that matter

All V from GitHub API unless noted. Every one below targets the release line (or stacks on a PR that does), is **draft**, MERGEABLE, with **no approving review** (`REVIEW_REQUIRED` on base-targeting PRs; none on stacked ones). CI = three Vercel checks only; no repository Actions job. "CI ok" = all three SUCCESS.

### Mandatory MVP blockers

| PR | Head | Base | Provides | CI | Executed tests (R) | SQL / hosted need | Open items |
|---|---|---|---|---|---|---|---|
| 865 | `d5c3bed52` | line | S1/S2 approval override limits | ok | Standalone local run PASS; S5 integrated run6 suite PASS. Concurrency unverified | `20270301090000`. PROD pin matches; DEV needs PV-1 (+OJ-1) first | R-11 replacement open; app error mapping and override UI missing |
| 864 | `9d7477c09` | line | S3 panel readiness | ok | S3 suite 92 apply/re-apply; composed e1 and r2-refunds fail (pre-existing stale fixtures per independent read). Re-run queued | `100000`-`102000` | Verified "approval-ready as dark Git merge", not for hosted apply. App sends 5 args, so valid-to-invalid attendance change fails until app ships confirm flag |
| 866 | `3b65f63d1` | line | S4 eligibility clearance, gates, write guard | ok | PR body says SQL not executed (stale); later run6 shows R15 suite PASS | `110000`, `130000`, `131000`; needs 863 age predicate | **131000 refuses the current app's eligibility save**; RPC switch, readiness and check-in changes in no PR |
| 863 | `93583d01c` | line | S5 under-18 database guard | ok | run6 (head `fcedfcf33`): apply/rollback/re-apply 8/8; e1 and r2 fail on base; several suites pass only as adapted copies. Concurrency, app tests NOT RUN | `120000`; activation count query must return 0 | Needs 835 first (DOB required) and 866 (fixtures/DOB) |
| 835 | `7778a9a0c` | line | Under-18 refusal at checkout | ok | Targeted tests PASS; tsc, full vitest, build, browser NOT RUN | none | Age as of today, not event date (open question) |
| 837 | `d42eff6fa` | 835 branch | Organizer age verification | **qfem Vercel FAILURE** (cause ND) | 152 targeted PASS; rest NOT RUN | none | Check-in/confirmation unchanged; direct write |
| 846 | `9b040c993` | 837 branch | Status/level verification | **qfem Vercel FAILURE** | 174 targeted PASS; rest NOT RUN | none | Still direct `.update` (V): conflicts with 866 guard |
| 877 | `8c738c4d8` | 867 branch | S6 entry-status guard | ok | Runs 1-2 on an earlier head; SQL changed since; S5 run6 ran part (adapted copies). Combined run in progress at 20:59Z: PROVISIONAL | `140000`, `141000` | Ballot-integrity rule (OWNER-DECISIONS 15) NOT enforced by 877 or 878 (R, code read). Scratch race with heat start in registration sync |
| 844 | `b56ea086f` | line | Event-deletion guard (scoring evidence) | ok | SQL 158, race 6, vitest 36 | `20270219090000`, applied nowhere (R) | e2e fixtures deleting events will be refused |
| 832 | `12bef34b0` | line | Block approve/publish for declared sanctioned events | ok | Unit only; tsc/vitest/build/browser NOT RUN | none | App layer only |
| 899 | `02cf1c73d` (moved today) | line | Published running-order write guard | ok | D suite 45 + races 11 at `60b4edd7e`; **revision `5a84cff9f` re-review NOT READY, blocker open, not executed** | `170000` | Does not close spare-round or replacement-version routes. Whether still needed under a one-round guard: ND |
| **no PR** | - | - | One round per contest, final-only, no cancel/replace/correct/reopen at the database | - | - | new migration | See section 3 |

### Required integration or release dependency

| PR | Head | Note |
|---|---|---|
| 867 | `6dc6b2d4e` | Lands JC1/U18/U18-S already applied DEV+PROD (R). Git-only; no re-apply. First in order |
| 878 | `22c27b505` | In-app Scratch. Must not ship before 877. Targeted 1482 tests PASS at `98d7e1e28` (R); full tsc/build/vitest queued: PROVISIONAL |
| 848 `3b8e66da5` -> 853 `5078e9e9a` -> 855 `cdc74431f` -> 860 `4500ae5ae` | | Owner-approved Studio/Custom wording stack; targeted tests (R). Part may be deferrable for a final-only pilot (I) |
| 859 `7d169c3b8`, 856 `84a6f9adc`, 861 `b8fbc1ccc` | | Verification/test evidence; 856 not final sign-off |
| 492 `5136bd133` | base CF1 candidate branch | U18/JC1 release evidence (docs, read-only SQL) |

### Deferred post-MVP
Callback rounds and advancement, multi-round, re-dances, corrections (OD-07/11/12), B2 contest lineage (901 `3ecf8e215`), Option C withdrawal (908), external judges (783), paid-flow proof (833, 682, Stripe-TEST workflow) **only if the pilot charges nothing (I)**.

### Docs-only
783, 787, 788, 790, 794, 795, 836, 838-843, 845, 847, 849-852, 854, 857, 858, 862, 901, 908, 900, 301, 318.

### Main-based older PRs
#291-#376, #447, #482 (merged), #443/#445: not release vehicles. The CF1 content is on the line through an overlay commit (`a91f8a46f`, V), so the E1/E2/F1/F2/SS1/HL1/CF1 stack is superseded (I). #292 (refunds) released from a release branch (R). #295 atomic check-in: whether on the line ND. #327 has a failing CI check; irrelevant if superseded.

### Dependency and apply order
Merge order proposed in OWNER-DECISIONS 10 (each separately owner-approved): 867 -> 865 -> 864 -> 866 -> 863 -> 877 -> 878. Not placed there: 835/837/846, 844, 832, 899, wording stack.
SQL timestamp order: (`20270219090000` OD-04) -> 090000 -> 100000-102000 -> 110000 -> 120000 -> 130000 -> 131000 -> 140000/141000 -> 170000.
Constraint (V from files/bodies): app with DOB (835) before S5 apply; app calling the eligibility RPC before 131000; but that app call needs 110000 present. So hosted apply and app deployment must be split into stages (I).
Rollback (R): app first; SQL in reverse release order (141000/140000, 131000, 130000, 120000, 110000, 102000-100000, 090000). S5 rollback refuses while `r15_guard_*` triggers exist; 102000 refuses once panel cases exist; run S3 rollback as the original function owner.

### Hosted state (R; no hosted access this pass)
- PROD: CF1 stages through F3/OD-17 dark (11-08), CI-B, PV-1 + OJ-1 (11-12), JC1/U18/U18-S (11-19).
- DEV: JC1/U18/U18-S applied; **lacks PV-1** (read-only 11-26), and OJ-1 per the same note (I for OJ-1's absence).
- No `202702190*` or `202703*` migration applied anywhere. Desk gate `20270205100000` hosted state: ND.

## 3. What the candidate restriction would and would not close (I unless marked)
- Needed at the database: at most one round ever (including cancelled) per division+dance, round type Final, ordinal method, single dance per division, and refusal of correction/reopen/cancel-and-replace for the pilot. A hidden UI control is insufficient (owner requirement; RPCs and table writes reachable, R).
- Would plausibly close probe routes NC, CS, CA and R, which all need a second round. **Not tested.**
- Residuals listed in the B2 record (R, section 13): duplicate dance catalogue records, a second entry set or new division for the same people, another event. These are not closed by a per-division rule and need an explicit decision or further guard.
- Disabling corrections removes the recovery route for a wrong or stuck result; S3 recovery is cancel-based. A pilot operating procedure is needed.

### Integration tests still needed
1. One chain in final release order including OD-04, all 202703 files, the new restriction and (if kept) 899, with apply, rollback, re-apply; unmodified suites, no adapted copies; e1 and r2-refunds failures resolved.
2. Joint 877 + 878 database stage (SC1 SQL suite had not been executed anywhere) and the new ballot-versus-scratch predicate with negatives.
3. Concurrency: R-11 approval (F2 race), S3-S6 races, scratch versus heat start/ballot submit.
4. Negative probes of the restriction: replay NC/CS/CA/R, direct table writes, duplicate dance, second division.
5. App + database: `start_competition_registration` end to end under S5; eligibility RPC from UI; panel confirm flag; PostgREST role tests.
6. Merged-head full `tsc`, full vitest, `next build`.
7. Browser acceptance on that exact build, production mode: setup -> register (adult; under-18 refused) -> eligibility -> schedule -> panel -> ballots -> calculate -> approve -> publish -> entrant view; plus flag-off dark smoke. `e2e/playwright.acceptance.config.ts` and CF1 specs exist but assume callbacks/corrections or paid checkout in places (I).
8. Pre-apply hosted read-only fingerprints and counts (S3 round counts, S5 age counts, S12 legacy scoring-method rounds).

## 4. Environment and release dependencies
- **CI (V):** release-line PRs get only Vercel checks. `e2e-public-event-registration.yml` ends `startup_failure` on the release line (latest listed at `49dbaee1b`, 11-23). Cause likely tag-pinned actions (`@v4`) versus SHA-pinned on main (I). Main's version succeeds on other branches. No PR to port it found. No CI runs SQL suites (R).
- Competition Stripe TEST acceptance workflow: 0 runs listed (V). Canary: failures through 11-21 (V); canary D not dispatched (R).
- **Type check/build/test on the line:** ND for `49dbaee1b`. Last reported full vitest in this domain: 9,804 pass on a PR 683 head 11-19 (R). Candidate-era `next build` ran out of memory (R).
- **Vercel (R, memory):** project `danceflow-app-qfem`; staged `vercel deploy --prod --skip-domain` from a git-archive checkout, confirm STAGED, owner-authorized `vercel promote`, 30-minute observation, rollback to previous deployment. Last recorded live: R+4 `e84ed0f3` (11-22); current live not checked today. Line is 7 commits ahead of it (V), including the dark settlement repair and a `vercel.json` change, which a pilot build would carry. Enabling flags = environment change plus new build, itself a release step.
- Rollback: application first, then SQL (R).

## 5. Estimate inputs (observed; no total estimate given)
- Local composed database runs: R-11 probe 7 min; S5 run5 7 min; S5 run6 22 min; S3 run2 about 5 min (V/R from logs).
- Browser: PV-1 3 scenarios 27 min; CF1 flag-on set about 48 min; dark smoke about 11 min (dev mode); Oct 30 production-build chain 2-3 min per half-run after a build (R).
- Queue (V, 15:59 EST / 20:59Z): 15 tickets, one heavy job at a time on a 2-CPU PC shared by all domains; holder is PR 877's combined run (started 20:44Z, expected 30 min). Listed expected durations in the queued tickets total roughly 6-7 hours (my addition; some tickets may be stale, oldest 15:48Z).
- Remediation PRs: first commits 11-24 about 05:00 EST, last 11-26; 10-20 commits each (V). After 2.5 days only 864 has an independent "merge-ready dark" verdict.
- Review loop today: 899 first draft -> blocker -> revision 15:41 -> re-review 15:57 NOT READY. 878 needed several review passes. New heads invalidate prior approvals and runs.
- Rebase load: today all inspected 202703 branches are 0 commits behind the line (V), so none yet; every merge will move stacked bases and md5-pinned migrations (R-11, S3, 899) may need re-pinning (I).
- Unstarted: one-round/final-only guard; correction/reopen disable; ballot-integrity SQL; eligibility RPC app wiring (with readiness/check-in); panel confirm flag; R-11 app mapping; release-line CI fix; entrant results access decision; final integrated run; production-build browser acceptance; release package; owner approvals (merge, DEV SQL, PROD SQL, deploy, flags are separate gates).
- ND: reviewer availability, owner approval latency, effort for the unstarted items.
