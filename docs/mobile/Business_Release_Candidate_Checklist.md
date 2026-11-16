# Business app: release candidate checklist and server-side prerequisites

2026-11-16. Business (`com.idanceflow.business`). Same vocabulary as the Student checklist: DONE (evidence), PENDING OWNER, BLOCKED (needs something outside Business), OPEN (Business work). Companion docs: `Business_Release_Readiness.md` (what the server must serve and in what order), `mobile/business/DEVICE_QA_RESULTS.md` (R1 to R6 device evidence), `mobile/business/DEVICE_QA.md` (the one-command smoke and the accessibility-tree audit), `mobile/business/IOS_READINESS.md`.

## A. What must be live server-side before a Business candidate is useful

The app is a client of the staff API only. Without A1 every screen after sign-in shows "Temporarily unavailable".

| # | Requirement | Owner | Status |
|---|---|---|---|
| A1 | The staff API routes exist on PRODUCTION: `/api/staff/me`, `.../today`, `.../appointments/{id}`, `.../appointments/{id}/attendance/{clientId}`, `.../clients`, `.../clients/{id}`, and for the flagged screens `.../schedule` and `.../pulse`. **Checked by route file against the live checkout (`C:\dwr`, `447d9b85`): there is no `src/app/api/staff` directory there, so none of them exist on live.** They are on `main` only. | Web release (main reconcile) | BLOCKED (waits for a promotable main) |
| A2 | Migration `20270214120000_instructor_class_roster_names_rpc.sql` on the production database, applied BEFORE the routes that need it are relied on. Without it, class detail and attendance marking for an **assigned instructor** return `503` (owners, admins and front desk are unaffected). Applied to DEV and to the disposable test stacks only. | Owner (PROD SQL gate) | PENDING OWNER |
| A3 | The tables and the `get_teaching_clients_for_instructor` function the routes read are the web app's own and already on production | Web | CONFIRM on production (the repo cannot prove it) |
| A4 | Server environment on the deployment: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (the service role is used only for the account-status check) | Web | CONFIRM (the web app needs them anyway) |
| A5 | `danceflow-business://auth/callback` on the production Supabase Auth redirect allow-list (the emailed sign-in link; password sign-in works without it) | Owner | CONFIRM / PENDING OWNER |
| A6 | A staff test account at a real studio, role owner, admin, front desk or instructor, with a subscription that allows access, for the candidate verification | Owner | PENDING OWNER |
| A7 | Firebase project for release. `danceflow-mobile-dev` is a DEV project; Play internal testing needs a decision on the project, the Business `google-services.json`, and the FCM key in Expo. Push is optional: without credentials More says notifications are not available and everything else works | Owner | PENDING OWNER (same decision as Student A5) |
| A8 | Play upload keystore and Play App Signing (release builds refuse debug signing and a placeholder `google-services.json`, #513) | Owner | PENDING OWNER (same decision as Student A6) |
| A9 | Push sender: no staff-facing sender exists (which events notify which staff, the `{type, id, studioId}` payload `notificationRoute.ts` expects), and the token is not unbound at sign-out. The token table and the claim function are Student's (`20260626`, `20270213080000`) and must be on the target database if push is turned on | Business plus server | OPEN, optional for a first candidate |

## B. Business app items

| # | Item | Status |
|---|---|---|
| B1 | `fontScale` in MainActivity `configChanges` (a live text-size change clipped sign-in without it) | DONE: #531, verified on a device (R4, R6); the new size applies at next launch |
| B2 | App icon: brand icon, adaptive and monochrome icons, splash and notification icon wired (#513); the iOS icon is an RGB copy with no alpha, wired as `ios.icon` | DONE: #581 (asset, pixel-identical to the opaque original) and #583 (wiring, merged with the owner's approval); device launcher and splash PASS (R4) |
| B3 | Feature flags in shipping config: `clients` and `attendance` ON; `pulse`, `studioSchedule`, `bulkAttendance` and `keepStale` OFF. The two screens were verified on a device (R5, R6); flipping them waits for A1 (the routes must exist on the target) and for the release owner's decision | DONE (code and evidence); flip PENDING OWNER |
| B4 | Dark mode (#509) and font scale 2.0, every screen | DONE on Android for sign-in, Today, the studio view, Pulse, the class roster, Clients and More (R3 to R6). Still not seen on a device: the appointment (private lesson) and the client screen in dark at 2.0, and the 401/403 states in dark at 2.0 | OPEN (waits for the emulator) |
| B5 | One-command device smoke (`scripts/device-smoke.js`): 18 of 18 on a device, run 6 (R6). It stopped being run on the candidate commit: android-release's RC2 run failed at sign-in with the email correct and a 10-dot password refused. See B8 | DONE once; OPEN on the candidate commit |
| B6 | Accessibility: roles, names, states and 44pt targets guarded by `a11y.test.tsx`; the reading order of the key screens by `readingOrder.test.tsx`; the tree audit CLI dry-run on real dumps (sign-in: 0 unlabelled, 0 small); VoiceOver `Announce` (#570). The `--a11y` smoke mode (the other screens' trees) and TalkBack on a device have not been run | OPEN (waits for the emulator) |
| B7 | Class roster flows: attendance marking, read-only without the capability, cancelled class, capacity wording, Mark all present (flagged), error and retry states | DONE in jest (`RosterAttendance`, `RosterBulkAttendance`, `AppointmentScreen` suites) and on a device for marking (R2, R5); Mark all present and the keep-last-data banner not yet walked on a device (flags off) |
| B8 | Smoke harness robustness. Finding for android-release's RC2 failure: its copy of the script (main `157f0098`) already contained the settle wait and the verified typing (#568), so it was NOT older. The password field shows bullets, so only its length can be verified, and a lost shift key types a different password of the same length. The password is now lowercase and digits only, and the sign-in retypes both fields up to three times when the server refuses the login | DONE in code (#589, open); the next run on a free emulator is the proof |
| B9 | iOS | BLOCKED: no macOS (`IOS_READINESS.md`: dark mode, Announce, push token, flattened icon, Dynamic Type and VoiceOver checks written, none run) |
| B10 | The 500-row cut-off day | DONE in jest (adapter, HTTP client, studio schedule, Pulse); not seen on a device |

## C. Candidate gate (all must be true)

1. A1 live (the staff routes on the deployment the build points at) and A2 applied before the assigned-instructor paths are relied on.
2. A5 and A6 in place (a real staff account can sign in on the candidate).
3. A7 and A8 decided and in place, or push explicitly left out of the first candidate.
4. B3 decided: which flags the candidate ships with. `pulse` and `studioSchedule` only if A1 included the slice 3 routes.
5. The one-command smoke (`B5`) PASS on the exact candidate commit, then `--a11y` and `scripts/a11y-audit.js` on it (`B6`), results recorded in `DEVICE_QA_RESULTS.md`.
6. The release is a signed AAB from the recorded commit (artifact, version code and name, signer fingerprint, upload to the internal-testing track), built with the production URLs. QA-key builds and the cleartext QA manifest are never uploaded.
7. Rows still BLOCKED (iOS, B4, B6 device parts) are either run or explicitly accepted by the owner.

## D. Rollback

The candidate only reads (`/me`, schedules, clients) and writes attendance through the existing idempotent route. Withdrawing the internal-testing release stops new installs; nothing server-side needs undoing except, if it was applied for the candidate, nothing: migration `20270214120000` is additive (rollback file `rollback/20270214120000_instructor_class_roster_names_rpc_rollback.sql`).
