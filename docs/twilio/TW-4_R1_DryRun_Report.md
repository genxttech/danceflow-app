# TW-4 R1 dry run (local, fake Twilio): results and production-readiness assessment

Date 2026-10-16. Scope: the controlled dry run required by the independent R1 security review. **No Twilio contact, no resource or fee, no SMS, no deploy, no commit. No migration was applied to a shared database and no runner-window or registration row was created in shared DEV or PROD.** Everything ran against a local Supabase stack (the QA stack, DEV public schema + TW-4A + 4A.1 + R1 + R1.1) and a disposable local Postgres container, with the FAKE adapter, synthetic non-pilot studios (reserved test domain) and synthetic business data. A fetch guard installed before any client was created recorded zero non-loopback requests.

## What was run
| Suite | Result |
|---|---|
| Dry-run integration `dryRun.tw4r1.test.ts` (real runner + real SQL functions via PostgREST + fake adapter; 5 synthetic studios) | 15 / 15 pass |
| R1 integration `localStack.tw4r1.test.ts`, 4A integration `localStack.tw4a.test.ts` | 11 + 14 pass |
| SQL suite R1 (incl. R1.1) `test_T_twilio_tw4_r1_runner.sql` | 59 checks pass; 22 mutation probes each fail the suite (1 equivalent) |
| SQL suite TW-4A/4A.1 | 89 checks pass |
| Two-session concurrency `tw4_r1_concurrency_local.sh` (real committed data, simultaneous psql sessions) | 7 checks pass |
| Runner unit tests (in-memory store) | 43 pass, 10+ mutation probes caught |
| Full `npx vitest run` | 404 files / 6407 tests pass, 3 opt-in local-stack files skipped (40 tests, run separately above); `tsc` 0 errors; ESLint 0 errors |
| Rollback then re-apply of R1 and R1.1 on a disposable database | clean |

## The eight required verifications
1. **Complete sequence with the fake adapter:** 18 steps (S1–S11, T1–T6, B1) succeed for studio X; ONE brand submitted (Standard, vetting on, flagged mock); studio waits in `brand_pending`; the EIN appears in exactly one Twilio call (the business EndUser) and one audit row attributed to the admin.
2. **Runner window authorization, expiry, allow-listing, kill switch:** no window means `runner_closed` and nothing is created; owner and outsider cannot open one (42501); hours outside 0–72 or a short reason are refused (22023); a window for studio D does not help studio X; an expired window and `hours=0` are closed; `refresh` (GET-only) needs no window. **Finding F-A (below): closing the window did NOT stop a run already in progress. Fixed in R1.1; with R1.1 the test passes (run stops with `runner_closed`, zero brands).**
3. **Crash recovery and reconciliation of uncertain paid responses:** a lost reply on the paid create is `unknown_outcome`; the rerun adopts the brand by lookup (still exactly one). A simulated process crash after Twilio created a resource but before the ledger write leaves the step `in_flight`, the lease is released, and the rerun adopts the existing resource by lookup (no duplicate). Unrecognized error types are treated as unknown, never as definite failures.
4. **No duplicate fee-bearing brand:** five repeated runs: zero create/assign/submit calls; ten sequential repeats after a concurrent pair: still one brand; a resubmitted or recovered onboarding is refused the paid step (`brand_exists`, SQLSTATE 55000) while the studio holds a brand or an unresolved earlier attempt.
5. **Mock brands cannot become real:** the mock brand gets no registration row, the studio stays in `brand_pending`, a Twilio-side "APPROVED" for the mock SID changes nothing, direct service-role calls to mirror or approve it are refused (22023), and the TW-3 approval invariant still refuses an approval without campaign, number and sender.
6. **Mock execution does not purge the EIN:** the ciphertext and key remain after the mock "approval"; the 30-day sweep purges nothing; no `ein_purged` audit row exists. (For a non-mock brand the approval path purges the EIN, covered by the R1 integration test.)
7. **Lease expiry, concurrency, SID immutability:** two overlapping runs: one proceeds, the other is turned away (`lease_busy`); in SQL, two simultaneous claims serialize (the loser waited about 2 s then was refused 55P03), two simultaneous paid begins give exactly one `execute` and one `reconcile`, and a taken-over lease cannot begin or finish a step. Lease expiry mid-run: the second run completes; the cut-off first run is refused at its next database call. A completed step's SID cannot be re-finished (22023) and its status cannot regress; **finding F-B: the table owner could rewrite a succeeded step's `provider_sid` directly; fixed in R1.1**.
8. **Real Twilio calls stay disabled:** the gate is closed in test/dev (switch alone is not enough), the factory refuses a real adapter, constructing one throws, the fake is allowed only against a loopback database, and the fetch guard saw zero non-loopback requests.

## Findings
| # | Sev | Finding | Status |
|---|---|---|---|
| F-A | P2 (must fix before the real adapter runs in PROD) | The window (kill switch) was checked at claim time only; a run in progress continued, including into the paid step, after the window was closed. | **Fixed locally in R1.1** (`tw4_runner_begin_step` requires an open window for every step, SQLSTATE TW001; runner stops with `runner_closed`; SQL tests K01/K02, runner unit test, dry-run 2c, concurrency C4). **R1.1 is NOT applied to DEV** (needs your authorization). |
| F-B | P3 | The ledger guard froze a succeeded step's status but not its `provider_sid`; only the table owner (no API role has table privileges) could change it. | **Fixed locally in R1.1** (guard freezes the sid; SQL test B07b). |
| O-1 | info | Lease takeover mid-run can leave a free, orphan Trust Hub profile (the cut-off run's create). No paid resource is ever duplicated. | accepted |
| O-2 | info | A step that begins in the instant before a window change commits still proceeds (read-committed); the first step to begin after the commit is refused. The paid call follows its begin within milliseconds. | accepted, documented |
| O-3 | info | A retried S2 may leave an orphan EndUser (Twilio has no friendly-name filter for EndUsers). | accepted (reviewed P2-4) |

**Open P1:** none. **Open P2:** F-A until R1.1 is applied and the app deploys with it; the accepted residuals O-1..O-3; plus the review's non-code items: Vercel freezes env vars per deployment (so the database window is the real kill switch and `TW4_ISV_REAL_CALLS` must be removed after the run), no `maxDuration` hook for a Server Action, and never pull production env onto a development machine.

## Exact resulting state
- **Shared DEV (`epdrtzcydvnoidwrepqz`):** TW-4A `f792c351933e`, 4A.1 `9ca53d4d3221`, R1 `63ba6947ab87` applied; all runner/onboarding tables empty; **R1.1 not applied**.
- **PROD:** untouched. **Application code:** uncommitted, undeployed. **Local QA stack:** now has R1.1; fixtures removed (0 synthetic users, 0 windows, 0 ledger rows).
- **New local artifacts:** `20261119092100_twilio_tw4_r1_1_window_and_sid_guards.sql` (sha256 `1a57dd9a963d…`) + rollback (`378bedd59dcd…`); R1 SQL suite `8c5e17f43c4a…` (59 checks); `tw4_r1_concurrency_local.sh` (`740c53a860d2…`); `dryRun.tw4r1.test.ts` + `dryRunFixtures.sql`.

## Production-readiness assessment (what still stands between this and a real ConfiDance brand submission)
The fake-driven behavior is now verified end to end. What the fake cannot prove, and what each gate needs:
1. **Database:** apply R1.1 to DEV (then PROD): TW-4A, 4A.1, R1, R1.1 in order. DEV apply needs your authorization.
2. **Real-adapter validation (not done, not possible without Twilio):** the adapter has never run against Twilio. Required before PROD: a Twilio **mock-brand** run on a **non-pilot** test studio (`TW4_ISV_MOCK_BRAND=on`), confirming the request shapes, the Trust Hub value mappings (business type, job position, regions, A2P company type), the Primary-profile assignment into a Secondary profile, the brand lookup fields, and the three policy SIDs (`GET /v1/Policies`). This is the step the review called for; it makes real Twilio calls (Trust Hub resources, mock brand) and needs your explicit authorization, which this task did not have.
3. **Environment (PROD only):** `SMS_EIN_ENCRYPTION_KEY` (+`_KEY_ID`), `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` (existing), `TWILIO_ISV_PRIMARY_PROFILE_SID`, `TWILIO_ISV_PRIMARY_POLICY_SID`, `TWILIO_ISV_SECONDARY_POLICY_SID`, `TWILIO_ISV_A2P_POLICY_SID`, `TWILIO_ISV_COMPLIANCE_EMAIL`; `TW4_ISV_REAL_CALLS=on` set only for the run and removed afterwards; the EIN-purge cron registered in `vercel.json`.
4. **Application:** commit/PR/deploy of the TW-4A + R1 code (per-studio legal pages must be live before a campaign can cite them); pilot flag for ConfiDance only; runner window opened for ConfiDance only, for the shortest time needed.
5. **Business information (owner):** ISV compliance mailbox; industry value; spend authorization (Standard brand about $46 plus vetting and monthly fees later); ConfiDance's own legal name, EIN, entity type, address, representative and area code entered by ConfiDance's owner in the wizard; the consent evidence listed in `TW-4A_Registration_Readiness.md` §2.6.
6. **Authorizations still required (none given):** R1.1 to DEV; the Twilio mock-brand dry run; PROD SQL; app deploy; the real submission itself (a fee-bearing action).
7. **Targeted review:** the review's P1s are closed; a short re-check of R1.1 is cheap but not blocking (two function bodies, no privilege change).
8. **After submission (not R1):** brand approval wait (minutes to 7+ business days), then R2 (Messaging Service, campaign, number), Twilio's pre-submission review of the campaign package, carrier approval, activation gates (TW-3 approved row, global SMS status, consent).
