# Business: live-line backports, main-versus-live reconciliation plan, tester prerequisites

2026-11-26. Answers the owner dispositions H1, H3, H6, H7, P1, P3 and P4. Planning and read-only evidence only: nothing was merged, applied, deployed, flagged or uploaded.

Facts used: live web = `e84ed0f3` (`release/website-embeds`, deployment `dpl_ERsjXn2R…`, confirmed from the asset URLs on `www.idanceflow.com`). The release branch tip is 7 commits ahead of live and not deployed. PROD checks used the read-only runner (`sb.sh prod-read`): object names and counts only.

## 1. H1: immediate backports for the mobile releases

| # | Item | Live today | Blocks | Action | Gate |
|---|---|---|---|---|---|
| 1 | Public `/account-deletion` page (#516) | **404** | Play data-safety form | Backport PR (H2) | Release-line merge, then deploy |
| 2 | Managed-access guard on self-service account deletion (part of #438) | **Missing**: the live delete action has no check, so a login with a studio, organizer or platform role can delete itself and the role rows cascade | The page in row 1 says such logins cannot be deleted, so it must not ship without this | Same PR as row 1 | Same |
| 3 | Instructor access functions (SQL `20260905160000`, `20260905160100`) and roster names (`20270214120000`) | **Absent on PROD** | Any instructor tester (web or app). Owner, admin and front desk are unaffected | SQL only, no code backport. See `Instructor_RPC_Gap_Impact.md` | One PROD SQL approval per file |
| 4 | Staff API Pulse cards (#774 and later) | Absent | Nothing while `pulseCards` is off (H7) | None now; port with the flag decision | Later |

Already satisfied on live: the staff API routes (`GET /api/staff/me` answers `401` with the API's own error body), the partner-profile moderation guard on PROD (trigger `trg_dancer_partner_profiles_moderation_guard` exists).

Not assessed here, for the Student owner: live's web account page does not call the event-registration claim (#G3 work on main); `claim_my_event_registrations` exists on PROD.

Deployment note: a backport branched from `e84ed0f3` can be staged on its own. Merging it into `release/website-embeds` puts it on top of 7 undeployed commits, so the release owner chooses between staging the backport commit alone and releasing the line tip.

## 2. H1: main-versus-live reconciliation plan (separate from the backports)

### Size, measured 2026-11-26
Merge base `2cc05d9e` (2026-10-15). Since then main has 482 commits touching 2,146 files; the live line has 94 commits touching 1,273 files. 864 files changed on both sides, but **only 36 of them differ today**, and 20 of those are source or configuration outside tests, mobile and docs:

`.github/workflows/e2e-public-event-registration.yml`, `e2e/README.md`, `vercel.json`, `src/app/sitemap.ts`, `src/app/account/page.tsx`, `src/app/events/[slug]/page.tsx`, `src/app/app/layout.tsx`, `src/app/app/settings/{billing,sms}/page.tsx`, `src/app/app/events/[id]/competition/{CompetitionNav.tsx,checkin/actions.ts}`, `src/app/api/{billing/checkout,payments/webhook,sms/send,cron/sms-price-sweep}/route.ts`, `src/app/api/staff/.../pulse/route.ts`, `src/lib/billing/{founderPricing,regularPricing,subscriptionPlanResolution}.ts`, `src/lib/events/event-order-payment.ts`.

Schema: about 29 migration files exist only on the live line (competition work, applied to PROD in releases) and about 23 only on main (billing, mobile, lead, marketplace and claim work).

### Phases
| Phase | Work | Exit evidence | Gate |
|---|---|---|---|
| R0 Inventory | One table per live-only and main-only commit and migration: owner domain, PROD state, keep, port or drop. PROD state comes from object checks, never from migration history (it is stale) | Reviewed inventory; no row "unknown" | none |
| R1 Live into main | Port live-only work to main in domain slices (Competition, TW-4F, others), each by its coordinator, normal CI and protected review. Appointment-work integration waits until R1 is done (H1) | Every live-only file is on main or recorded as dropped | per-PR merge approval |
| R2 The 20 conflicts | Resolve file by file; payments webhook, billing checkout, pricing and `vercel.json` (crons) get an independent review each | Diff of main against live explained line by line for those files | merge approval |
| R3 Schema | For each main-only migration: applied, pending or superseded on PROD; ordered SQL package with preflight, rollback and fingerprint | Package reviewed; DEV lifecycle proof | one PROD approval per file |
| R4 Candidate | Build main as a release candidate with every dark flag off; compare routes, crons and environment names with live | Isolated QA and a staged deployment smoke | deploy approval |
| R5 Cutover | Promote; keep `e84ed0f3` as rollback; afterwards release from main and retire the line | Observation window clean | promotion approval |

Freeze rule while R1 to R5 run: every new live-line fix is also opened on main the same day, or it is lost again.

## 3. H3: Business tester prerequisites, in order

| Order | Prerequisite | State 2026-11-26 | Next engineering step | Owner gate |
|---|---|---|---|---|
| A1 | Staff API on the build's target | **Done** (live) | none | none |
| A2 | Instructor SQL, three files | Not applied | Package below is ready; preflight again on the day | PROD apply, each file |
| A3 | Tables and functions the routes read | **Confirmed except the two functions in A2** | none | none |
| A4 | Server environment on the deployment | Working for reads (the production-valued smoke passed 2026-11-20); `STAFF_API_WRITE_POLICY` unset, so writes answer "turned off" | none; enabling writes is its own decision | env change |
| A5 | `danceflow-business://auth/callback` on the PROD auth redirect allow-list | Not verified by engineering | Check with read-only provider access when available; password sign-in works without it | dashboard change if missing |
| A6 | Tester account (owner, admin or front desk) at a real studio | No dedicated tester account is recorded | Engineering writes the fixture and account script and proves it on DEV; creating anything on PROD is a hosted write | PROD account and data creation |
| A7 | Push | **Excluded** (H6) | Build without `GOOGLE_SERVICES_JSON`; the app then says notifications are not available | none |
| A8 | Upload key and Play App Signing | **Done**: version code 1 is on the internal track | none | each further upload (H4 says wait) |

A2 package (SHA-256 of the file on main; rollback files sit beside them under `migrations/rollback/`):

| File | Apply | Rollback |
|---|---|---|
| `20260905160000_fc1b5d_teaching_client_access_rpc.sql` | `ef7ce593a4c5f4eae2835dd62fff4124a464a4a1900bb2cf96926f90c1e733f5` | `63a5e7ba3aea1337188511cc6b652523819ee05ab8e724e98c30f4d0cb8fe180` |
| `20260905160100_fc1b5d_booking_client_search_rpc.sql` | `5187770af39932b80115ea27b74329d7b725fd2aa8ad4a8b722ca82834bd554e` | `2fab9db225313fe9e8e2b7570385ecbca6eff41c6415256bab037ae89c358a76` |
| `20270214120000_instructor_class_roster_names_rpc.sql` | `210ca4488c1e70125cccfada22527b6dd31277bef1b86fd312c91deb5658601c` | `a38fb809a475b0a59c220d73ccec7dd02c56bebd34bcc1b65a61f21056c179f2` |

The first internal test (owner, admin, front desk) needs none of A2.

## 4. Recorded decisions

| Id | Decision | State in code |
|---|---|---|
| H6 | No push in the first internal build | Build setting only (A7). Whether version code 1 was built with a Firebase file was not checked |
| H7 | Business flags off until server, database and device evidence is ready | Defaults are off. **Version code 1 on the internal track was built with `pulse` and `studioSchedule` on** (production-valued smoke passed for both reads). The next build uses the defaults unless the owner says otherwise |
| P1 | Pulse is the landing for owner, admin and front desk; instructors keep Today | Already implemented behind `pulseHome` (off). No change |
| P3 | No ARIA card for front desk | As shipped. No change |
| P4 | Missing-confirmation window is 48 hours | Recorded. The card is not built; building it dark is the next Pulse slice when dispatched |
