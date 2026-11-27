# DanceFlow Business: internal-testing release package

2026-11-18, written from `main` `793ef6439`. Business = `com.idanceflow.business` (`mobile/business`). This is the single page that answers: what can a studio owner or instructor actually do with the app, what must be live on PRODUCTION first, how far it is proven, what the smallest safe release is, how a human tests it, how it is rolled back, and who has to do what. It adds no new facts of its own: every claim cites its source or says it is assumed. Companion docs (read for detail, not repeated here): `Business_Release_Readiness.md`, `Business_Release_Candidate_Checklist.md`, `Staff_API_Contract.md`, `Google_Play_Internal_Testing.md`, `Android_Release_Audit.md`, `mobile/business/DEVICE_QA_RESULTS.md`, `mobile/business/DEVICE_QA.md`.

Marks: **V** = verified from code, a document or recorded run output (source cited). **A** = assumed or not checkable from the repository. Status words: PASSED (run, with evidence), UNVERIFIED (not run or inconclusive), BLOCKED (needs something outside engineering).

## 1. The one fact that decides everything

**The Business app is only a client of `/api/staff/**`, and that API is not on PRODUCTION.**

- **V:** the app sends every request to `EXPO_PUBLIC_DANCEFLOW_WEB_URL` under `/api/staff/**` with the Supabase access token as a bearer (`mobile/business/README.md` "How it fits together"; `Business_Release_Readiness.md` section 1). There is no cookie fallback.
- **V (as of 2026-11-16):** `Business_Release_Candidate_Checklist.md` row A1 records a check by route file against the live checkout (`C:\dwr`, `447d9b85`): no `src/app/api/staff` directory, so none of the routes exist on live. They exist on `main` (eight route files: `src/app/api/staff/me/route.ts`, `.../today`, `.../schedule`, `.../pulse`, `.../appointments/[appointmentId]`, `.../attendance/[clientId]`, `.../clients`, `.../clients/[clientId]`).
- **A:** that is still true today. Re-check before relying on it with one read-only request (not run by me, by instruction): `GET https://<production web origin>/api/staff/me` with no token. A flat JSON `{"error": ..., "code": "unauthenticated"}` with HTTP 401 means the route exists; an HTML 404 means it does not (`Staff_API_Contract.md` "Errors").
- **V:** with no routes live, every screen after sign-in shows "Temporarily unavailable" (`Business_Release_Candidate_Checklist.md` section A, first line). So a Business release cannot be useful before a web release that contains the staff API. The app release is gated on a **web** release; it is not independent of it.

**V: there is no server-side kill switch for the staff API.** No `process.env` read exists in `src/app/api/staff`, `src/lib/staff` or `src/lib/auth/staffApiAuth.ts` (grep, 2026-11-18). The only switches are in the app build (flags, section 4) and removing the app from testers. Server rollback is promoting the previous web deployment (section 8).

## 1a. Gate G-B0: staff API on the live line (status 2026-11-19)

| Item | Status |
|---|---|
| Live web line | `release/website-embeds` `ab9f3449` (R+1, `www` dpl_FZb1Jsjn..., live 2026-11-19T17:14:26Z). **V:** `GET /api/staff/me` on `www.idanceflow.com` returns an HTML 404 (2026-11-19; a control route that exists, `/api/student/events/<id>/availability`, answers JSON 401), so the staff API is **not live**. |
| Backport | draft PR #673: one commit on `ab9f3449`, byte-identical to main `cb3a0311` for 30 files (8 routes, guard, libs, tests). Node 20 CI run 44593579060 (SHA-pinned workflow on `claude/ci-verify-staff3`, DO NOT MERGE): 623 files / 9951 tests passed, 0 failed (live base 9770 + the 181 staff tests). **Not merged, not promoted: G-B0 is OPEN.** |
| Business RC6 (main `6d23af298`, 2026-11-19) | **Device smoke PASSED 23/23** (`C:\dfr-out\qa-smoke21`: QA APK built fresh with `--build-dir C:/dfq`, baked-config check passed, normal harness path, no `--force`). One System UI ANR dialog (not the app) dismissed with Wait; classified **environmental** from `systemui-anr-1-diag.txt` (guest load 48 on 2 CPUs, 121 MB free of 2.5 GB, the Business app idle at 206 MB) while the host had 4.0 GB free after settle (7.2 GB before boot, 7.0 GB at the end). **Release AAB** `business-rc6.aab` (`C:\dfr-out\rc6`), 64,766,974 B, SHA-256 `20f2e02ed84a6a4e1f208caa01402357978342fea9d1016868f2fe9393459899`, QA-signed (CN `DanceFlow QA ONLY DO NOT UPLOAD`, SHA-256 `93:F4:E4:5E:...:F0:99`; not uploadable): versionCode 1, versionName 0.1.0, minSdk 24, **targetSdk 36**, allowBackup false, debuggable and cleartext absent, no CAMERA / RECORD_AUDIO / SYSTEM_ALERT_WINDOW / external-storage permissions (INTERNET, notifications, biometric, vibrate, wake lock only, plus library badge and FCM entries), `zipalign -c -P 16 4` exit 0, 72 native libs, 0 with `p_align` below 16384 on the 64-bit ABIs. **Baked config decoded from the final AAB** (Hermes bundle): `https://qa-placeholder.invalid`, `qa-placeholder-anon`, web `https://idanceflow.com`; 0 JWT-shaped strings; no `10.0.2.2`, `56600`/`56601`, `service_role`, `sk_`/`pk_`, `whsec_` or private key. Signing guard not re-tested. Still UNVERIFIED: R8 minified build, TalkBack, `--a11y`, iOS, real devices, a production-signed AAB with real values, and any run against the staff API on the live web (not live: G-B0 open; backport #673 verified on Node 20 CI, not merged, not deployed). |
| Server limits | #674 (merged): 600/min per IP before the token is read, 240/min per user id after. 429 `{error, code: "rate_limited"}` with `Retry-After`. Per server instance, in memory. |
| SQL | none for owner, admin and front desk. Instructors need the two Phase A files (`20260905160000`, `20260905160100`) and `20270214120000`; **they are not part of this release, so do not invite an instructor-role tester** (`Instructor_RPC_Gap_Impact.md`). |

**App 429 handling (#679, merged):** a read that gets a 429 with `Retry-After` of 5 seconds or less waits and retries once; a longer wait is shown ("Too many requests", Try again); an attendance mark is never resent on its own ("Not saved. Too many requests. Try again in a moment."). A tester who sees this should wait, not retry in a loop; record it as a note, not a failure, unless it appears in normal use.

**Owner checklist before the first internal-testing upload:** a Google Play developer account with the Business app created; `eas init` for the Business project (EAS project id) if EAS builds are used; `GOOGLE_SERVICES_JSON` (Firebase) only if push is wanted (push is out of scope for this test); the upload keystore and Play App Signing; the `danceflow-business://auth/callback` Auth allow-list entry; a real owner or front-desk test login; and the **instructor warning**: no instructor-role tester until the Phase A SQL is applied.

## 2. What a studio owner or instructor can do today

"On" = the screen is in the default build (`mobile/business/src/lib/features.ts:18`, `ENABLED_BY_DEFAULT = ["clients", "attendance"]`). "Flag" = off unless `EXPO_PUBLIC_STAFF_FEATURES` names it at build time (`features.ts:7-17`). Roles served: studio owner, admin, front desk, instructor (`src/lib/navigation.ts`, `SERVED_ROLES`); independent instructors and organizer roles get "Not available for your role", platform admins "Use DanceFlow on the web" (`Business_Release_Readiness.md` section 3; `Staff_API_Contract.md` error table).

| # | Capability (what the person sees and does) | Who | Default | Server dependency on PRODUCTION | Degraded behaviour if it is missing |
|---|---|---|---|---|---|
| C1 | Sign in with email and password, or an emailed link; stay signed in across restarts (SecureStore); sign out, and "sign out everywhere" | all four roles | on | the production Supabase project and its Auth settings. Email link also needs `danceflow-business://auth/callback` on the Auth redirect allow-list (**A**, owner to confirm: checklist A5) | no allow-list entry: the emailed link does not return to the app, password sign-in still works. Server unreachable: "Can't reach DanceFlow. Check your connection and try again." (#610; `src/lib/signInError.ts`), not "wrong password" |
| C2 | Account is never created in the app; staff accounts are made on the web | - | - | web account creation (exists) | a tester without a staff role cannot test (checklist A6) |
| C3 | Pick which studio to work in when the person has several; paused studio is explained | all | on | `GET /api/staff/me` | no route: every screen "Temporarily unavailable". Paused subscription: `403 workspace_paused`, an explanation screen, billing stays on the web (`Staff_API_Contract.md`) |
| C4 | **Today:** my appointments for one studio day in the studio's time zone, empty and "not linked" states | instructors (own day); owner/admin/front desk see the studio switch | on | `GET .../workspaces/{id}/today` | "Temporarily unavailable" with retry |
| C5 | **Appointment and class detail**, including the class roster | all four | on | `GET .../appointments/{id}`; for a class **taught by the assigned instructor** also migration `20270214120000_instructor_class_roster_names_rpc.sql` on the PRODUCTION database | migration missing: that detail returns `503 service_unavailable` ("Temporarily unavailable"); owner, admin and front desk are unaffected (`Business_Release_Readiness.md` section 2) |
| C6 | **Mark attendance** on a class roster: Present / No-show, one tap per client, failed save puts the old mark back and says why on that row | roles with `markAttendance` on that class | on | `PUT .../attendance/{clientId}` (idempotent by state); migration above for assigned instructors | `409 not_markable` for cancelled or non-class appointments (explained); 503 as in C5 |
| C7 | **Clients:** search the studio's clients (owner/admin/front desk) or "My clients" (instructors, teaching relationship), open a client: next appointment and, for owner/admin/front desk only, active packages with remaining counts | all four, scoped | on | `GET .../clients`, `GET .../clients/{id}` | 403 `role_not_permitted` hides the feature; 503 retry |
| C8 | **Studio view** ("My day / Studio" switch): the studio-wide day with who teaches | owner, admin, front desk | flag `studioSchedule` | `GET .../schedule` | "Temporarily unavailable" on that view only |
| C9 | **Pulse:** counts for the day with words, next up, new clients | owner/admin (`viewReports`); everyone with schedule access when the flag is on, instructors seeing "Your day" with no client card | flag `pulse` | `GET .../pulse` (no new migration, `Business_Release_Readiness.md` section 2) | "Temporarily unavailable" on that tab only |
| C10 | **Session recovery:** a 401 refreshes once then returns to sign-in with "Sign in again"; a 403 after a role change shows "Not available for your role"; restoring the role and tapping "Refresh studios" brings the numbers back | all | on | the same routes | proven on a device (section 3) |
| C11 | Text size up to 2.0 and dark mode on every screen; live text-size change does not clip | all | on | none | - |
| C12 | **Mark all present** on a roster | roles with `markAttendance` | flag `bulkAttendance` | attendance route | not device-walked: keep off |
| C13 | Keep the last loaded schedule with a banner when a refresh fails | all | flag `keepStale` | none | not device-walked: keep off |
| C14 | **Push notifications** ("More" shows a notifications card) | all | **unavailable** | token table `20260626_student_push_notifications_v1.sql` + claim function `20270213080000_mobile_push_token_claim.sql` on PRODUCTION, a Firebase release project, an EAS project id, and a staff-facing **sender** | no sender exists (`Business_Release_Readiness.md` section 5), so none is delivered; without credentials More says notifications are not available and everything else works. Leave push out of the first release |

**What the app deliberately does not show (V):** prices, payment state, contact details, referral source, lesson recap video (`Staff_API_Contract.md` "Planned, not in slice 2"); nothing about whether a dancer has *claimed* an event registration or account. Guard tests added 2026-11-17 (#624): no staff code touches `event_registrations`, `client_account_links` or claim columns, and no staff `select` lists `user_id` (`src/app/api/staff/__tests__/staffReadsGuard.test.ts`); no screen shows a raw caught message or a vendor name (`mobile/business/src/lib/__tests__/errorWordingGuard.test.ts`).

**Not in v1 at all (V, contract):** event door check-in, session recap writes, events on the day schedule, independent instructor floor rentals, an iOS build.

## 3. Test evidence

All device evidence is on an Android 15 emulator (`df-api35`) against a **disposable local stack with real sign-in and real row-level security**, never against PRODUCTION (`Business_Release_Readiness.md` section 8).

| Evidence | Result | Where |
|---|---|---|
| Unminified QA release APK built fresh from main `14f441dfd`, one-command smoke (`mobile/business/scripts/device-smoke.js`): baked-config check, emulator Wi-Fi and stack/web reachability, owner light 1.0 / dark 1.0 / dark 2.0 cold / light 2.0 cold (Today switch + Pulse tab, Studio view, Pulse numbers), live font change 2.0 to 1.0, empty day, 403 and recovery, 401 and re-sign-in, instructor | **PASSED 22/22 (run 19)** | `C:\dfr-out\qa-smoke19\summary.json`; `mobile/business/DEVICE_QA.md` "Run 19" |
| Same smoke on android-release's RC4 build (main `20e5bacdb`, `device-smoke.js --build-dir`, #634 baked-config check, private `TEMP`) | **PASSED 22/22** | `C:\dfr-out\qa-rc4\business-smoke`; `Android_Release_Audit.md` section 10 |
| RC4 Business AAB: targetSdk 36, 1 / 0.1.0, not debuggable, no cleartext, allowBackup false, blocked permissions absent, 16 KB aligned (36 libs), QA key signed, baked `EXPO_PUBLIC_*` decoded from the final AAB = placeholders only | PASSED | `Android_Release_Audit.md` section 10 table; `C:\dfr-out\rc4\` |
| RC5 | **A / in progress**: android-release holds the emulator for RC5 at the time of writing; no RC5 result exists in the repository. Do not quote one. | - |
| Clients, client detail, class roster, Present/No-show writes (database confirmed), light/dark, font 1.0 and 2.0 | PASSED on earlier runs (not in the 22) | `DEVICE_QA_RESULTS.md` R2, R3, R4 (R4-7: attendance write at 2.0 verified at the request level only) |
| Pulse and the studio-wide schedule on a release build | PASSED | `DEVICE_QA_RESULTS.md` R5 |
| Integration walk of the real slice-2 endpoints | PASSED 27/27 | `docs/mobile/screenshots/business-shell/s2-walk-evidence.json` |
| Staff API unit/HTTP tests and the sign-in error wording tests | PASSED in CI | `src/app/api/staff/__tests__/`, `mobile/business/src/__tests__/` |
| **Anything against the PRODUCTION database or deployment** | **UNVERIFIED** (cannot exist until the staff API is live there) | - |
| Release-signed, production-URL AAB smoke; the pre-upload decode of the real artifact | **UNVERIFIED** (RC builds are QA-keyed with placeholder URLs; the decode step is mandatory on the real artifact, `Google_Play_Internal_Testing.md` section 11) | - |
| R8 (minified) Business build and smoke | UNVERIFIED (harness has no minified mode; Student's R8 passed, not Business). First release should be unminified | - |
| TalkBack end to end; `--a11y` smoke mode; dark 2.0 on the appointment and client screens; Mark all present; keep-last-data banner | UNVERIFIED (`Business_Release_Candidate_Checklist.md` B4, B6, B7) | - |
| iOS | BLOCKED: no macOS (`mobile/business/IOS_READINESS.md`) | - |
| Android 12 and older, EAS cloud build | UNTESTED | `Google_Play_Internal_Testing.md` section 11 |

Harness caveat recorded for honesty: runs 7 to 17 of the smoke drove an APK whose baked URL and key were stale (Metro cache replayed under `CI=1`); that was a harness defect, not an app defect, and the app showed the correct "Can't reach DanceFlow" (`DEVICE_QA.md` "Stale baked configuration"). Never judge a Business build without the baked-config check passing.

## 4. The smallest safe independent Business release

**Independent of Student, Competition, Twilio and claims; not independent of one web release and one SQL file.**

Prerequisites on the server (these are the whole dependency list):

1. **A PRODUCTION web deployment that contains `/api/staff/**`** (the eight routes in section 1). Today they exist only on `main`; PRODUCTION is on a different line, so this needs the main reconcile or a targeted release. **Owner/coordinator decision** (it changes what is live for every product).
2. **SQL `20270214120000_instructor_class_roster_names_rpc.sql` on the PRODUCTION database.** Additive; rollback file `src/lib/supabase/migrations/rollback/20270214120000_instructor_class_roster_names_rpc_rollback.sql` exists (`Business_Release_Candidate_Checklist.md` section D). Apply **before** relying on assigned-instructor class paths. Hosted SQL apply is an owner gate.
3. **Confirm (A):** the production deployment has `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (the service role is used only for the account-status check); the redirect URL in section 2 C1.

The build:

- Signed **unminified** AAB from a recorded commit, built with the production Supabase URL, anon key and `https://idanceflow.com`; versionCode 1 / name 0.1.0 as today (`app.json`).
- Flags: `clients`, `attendance` on (default). **`pulse` and `studioSchedule` on** *only if* prerequisite 1 contains the slice-3 routes `.../pulse` and `.../schedule` (they are on `main` with the rest, so a main-based release includes them; both are device-verified, R5 and run 19). `bulkAttendance` and `keepStale` **off** (not device-walked). If slice 3 is not in the web release, build with none of the optional flags.
- Push left out (C14): no sender, no EAS project, no release Firebase project. The app degrades cleanly.
- Play: internal-testing track only, a named tester list of studio staff (owner, one instructor), no public listing. Owner-side Play items are in section 9.
- Before uploading, decode the baked `EXPO_PUBLIC_*` values from the **final** AAB (Hermes string table; `device-smoke-lib.js` `hermesStrings` or `Google_Play_Internal_Testing.md` step) and reject any `10.0.2.2`, `.invalid`, `qa-placeholder`, disposable-stack URL or `service_role`.

Why this is the smallest: it reads, plus one idempotent write (attendance), and needs no new table, no push sender and no new server env. Removing any of the three server items makes the app either empty (1) or partly 503 for instructors (2).

## 5. Human tester script (12 steps)

Needs: one Android phone (Android 13 or later; 12 and older are untested), the internal-testing install link, a real staff login at a studio whose subscription is active, one studio with classes on today's date, and (if possible) one instructor login and one owner login. Do not use a real client's private data in screenshots you share.

1. Install from the internal-testing link and open the app. **Expect** the sign-in screen: "Sign in to your studio", Email, Password, "Sign in", "Email me a sign-in link".
2. Turn the phone's Wi-Fi and data off, try to sign in. **Expect** "Can't reach DanceFlow. Check your connection and try again." (not "wrong password"). Turn the network back on.
3. Sign in with the staff email and password. **Expect** to land on Today (instructor) or Today with a My day / Studio switch and a Pulse tab (owner, admin, front desk).
4. Today: **Expect** the appointments for today in the studio's time zone, or an explained empty day. Pull down to refresh.
5. Open a private lesson, then a group class. **Expect** detail with the right time, and for a class a roster of names.
6. Instructor only: on a class you teach, tap Present for one person and No-show for another. **Expect** each row to update; reopen the class and the marks are still there. (This writes real attendance: use a class and clients the studio agrees to test on, and say so first.)
7. Clients tab: search a known client. **Expect** results; open one. **Expect** a next appointment, and package counts only for owner/admin/front desk (an instructor sees no package section).
8. Owner/admin only: open the Studio view and Pulse. **Expect** the studio's day with who teaches, and counts with words that agree with the Studio list.
9. More: **Expect** the signed-in role and studio, "Switch studio" if there is more than one, and a notifications card saying notifications are not available (push is not in this release).
10. Settings, Display: set text size to the largest and Dark theme. Relaunch. **Expect** nothing clipped or overlapping on Today, a class, Clients and More; tab labels fully visible. Return the settings to normal.
11. Sign out, then "Email me a sign-in link" with the same address and open the link on the phone. **Expect** a return to the app, signed in. (Only valid if the redirect URL is on the allow-list; if the link opens a browser instead, record it as the A5 gap, not an app failure.)
12. Ask the studio owner to change this person's role or pause the studio, then tap Refresh studios. **Expect** "Not available for your role" or the paused explanation, and recovery after it is restored.

Attendance rule for step 6 and for the app: one mark at a time, online only, wait for the answer before changing the same person again, no queue of attendance writes (the server keeps no idempotency key, so the last request to arrive wins, and "attended" deducts a package credit that "no_show" does not return; see `Staff_API_Contract.md`, Known limits). If a mark shows an error, reopen the class to see the real state before trying again.

Record per step PASS / FAIL / NOT RUN with a screenshot. Any "Temporarily unavailable" on step 3 or later means the staff API is not live on the deployment the build points at: stop and tell engineering, it is not a tester error.

## 6. Monitoring during the test

- **V:** every response carries `Cache-Control: private, no-store` and errors are flat `{error, code}` (`Staff_API_Contract.md`). **A:** watch PRODUCTION web logs for `/api/staff/*` 5xx and for a spike of `503 service_unavailable` (class detail 503 for an instructor = the section 4 SQL is missing).
- **V (known limit):** no rate limiting yet on these routes, and mobile-only activity does not write `last_workspace_access_at` (`Staff_API_Contract.md` "Known limits"); do not read workspace-access reports as app usage.
- **A:** attendance rows written by testers are visible in the studio's normal attendance views; ask the studio to remove or accept them afterwards.

## 7. Pass criteria for the internal-testing release

All of: the tester script run by at least one owner and one instructor with steps 1 to 10 PASS and no step 3+ "Temporarily unavailable"; zero 5xx on `/api/staff/*` from the testers' requests (apart from deliberate offline steps); the decoded baked config of the uploaded AAB equals the production environment; no app crash reported by Play (Android vitals) in the test window. Steps 11 and 12 are required only if the redirect allow-list was confirmed and the owner agrees to change a role.

## 8. Rollback and hotfix

| Layer | Action | Notes |
|---|---|---|
| App | In Play Console halt/withdraw the internal-testing release, or release a fixed AAB with a higher versionCode (`eas.json` has `autoIncrement` for the production profile, `appVersionSource: remote`); tell testers to stay on the previous build | Withdrawing stops new installs; installed copies keep working until the server changes. No data lives only in the app |
| Flags | Rebuild with `EXPO_PUBLIC_STAFF_FEATURES=none` (or `-clients`, `-attendance`) to turn features off; flags are build-time only | a flag flip needs a new AAB, not a server change |
| Web | Promote the previous PRODUCTION deployment (the standing release procedure; promotion is an owner gate) | V: no env or flag gates the staff routes, so this removes the whole API |
| SQL | `20270214120000` is additive and has a rollback file; leaving it applied is harmless to the web app | roll it back only with the owner |
| Data | Attendance written by a tester is ordinary studio data: correct it in the web app | **A** |

## 9. Owner decisions versus what engineering can do alone

**Needs the owner (or an owner gate):**

- Approve and promote a PRODUCTION web release containing `/api/staff/**` (and which line it comes from); apply `20270214120000` to PRODUCTION; set or confirm the three server env values.
- Add `danceflow-business://auth/callback` to the PRODUCTION Supabase Auth allow-list (Auth settings change).
- Create or provide a real staff test login at a real studio, and a studio willing to be tested on (attendance writes).
- Play side (`Google_Play_Internal_Testing.md` section 11 owner queue): upload keystore and Play App Signing, both apps created in Play Console, privacy policy and account-deletion URL timing, Data safety and content rating confirmation, store listing, tester list, approval of the first unminified build. Business EAS project (`eas init`) only if push or EAS builds are wanted (push is out of scope here).
- Decide the flags for the first build (section 4 recommendation: `pulse` and `studioSchedule` on only with slice 3 live).
- iOS: needs a Mac and an Apple account, out of scope.

**Engineering can do alone, without asking (standing dev authorization, no production touch):** keep `main` and the harness green; build the QA and unminified RC AABs locally (one Gradle build at a time) and run the smoke on a disposable stack; decode the baked config of any artifact; run the `--a11y` mode and TalkBack checks when the emulator is free; maintain this package and the checklists; add the production route probe command to the runbook. **Never without approval:** deploy or promote, apply hosted SQL, change Auth settings or env, upload to Play, or point the QA scripts at PRODUCTION (`scripts/qa/staff-api/` are for disposable stacks only).

## 10. Order of work (for the coordinator)

1. Owner decision: which web line carries `/api/staff/**` to PRODUCTION (blocker for everything else here).
2. Apply `20270214120000` on PRODUCTION (owner gate), then run the read-only route probe in section 1 and a real staff-login check of `/me`, `today` and an assigned-instructor class detail.
3. Owner Play prerequisites (keystore, console, redirect URL, tester accounts).
4. Engineering builds the signed unminified AAB from a recorded commit with production values, decodes it, runs the smoke on an equivalent QA build of the same commit, records the result in `DEVICE_QA_RESULTS.md`.
5. Upload to internal testing; run section 5; record PASS/FAIL/NOT RUN per step; decide on widening.

## 2026-11-20 update: real-key AAB built (upload status superseded below)

A real-key Business AAB exists: `C:\dfr-out\release\business-42e31612.aab`, SHA-256 `48cfd4a404d8025156a201d517d520e1a5b8f0c73359e1ebae59b1ca23ab8897`, built from main `42e31612d1d1`, versionName 0.1.0, **versionCode 1**, signed with the pinned upload certificate (SHA-256 `12:E5:24:0E:...:A1:EE:AF`), with `EXPO_PUBLIC_STAFF_FEATURES=pulse,studioSchedule` (effective features: clients, attendance, pulse, studioSchedule; bulkAttendance and keepStale off). The production staff-API smoke passed for `/me`, `/today`, `/schedule`, `/pulse` and the client lookups on `www.idanceflow.com` (GET only, 2026-11-20). Read-only artifact checks (manifest, targetSdk 36, 16 KB, permissions, no Firebase or QA placeholder, secrets scan, signer pin, baked config, baked feature flags) all PASS: see `Android_First_Internal_Release_Prep.md` section 9. It was not uploaded at the time of this entry (see the 2026-11-23 status below). Still UNVERIFIED: a device smoke of this exact AAB, push delivery (no Firebase config in the build), and the Play pre-launch report. Keep the AAB; delete `C:\dfr\rel-business` and its private TEMP only after the owner confirms the hash is recorded.

## 2026-11-23 status: version code 1 is on the internal track

Read-only Play Console check (2026-11-22 evening local, `C:dfr-outplay-verify	rack-4972605853824601480.txt`; recorded 2026-11-23): Business internal testing shows **release 1 (0.1.0), Active, Available to internal testers, released Nov 20 4:47 PM, Not reviewed**, one version code, under the temporary app name `com.idanceflow.business (unreviewed)`. No second release was built or uploaded. That this release is the AAB recorded above is **inferred** (same version code, built the same afternoon); the uploaded bundle's hash and the Console's upload-key fingerprint were not compared by engineering. `main` is at versionCode 2 (#830); no versionCode 2 release exists in Play.

## 2026-11-26: version code 2 QA dry build (QA key, placeholders, never for upload)

`C:\dfr-out\business-vc2-aab\business-vc2-qa-6941125d.aab`, SHA-256 `4fa62aa9315ead80b5bbd287cb792a2347b69aa0e4fcdf1a88b2fbffc623e16b`, built from main `6941125d6412` on this PC (`expo prebuild --clean`, `gradlew bundleRelease --no-daemon`), signed with the throwaway QA key, placeholder Supabase URL and anon key, web URL `https://www.idanceflow.com`, `EXPO_PUBLIC_STAFF_FEATURES=pulse,studioSchedule`.

| Check | Result |
|---|---|
| Manifest | PASS: `com.idanceflow.business`, versionCode 2, versionName 0.1.0, targetSdk 36 |
| 16 KB: ELF alignment, 64-bit libraries (arm64-v8a, x86_64) | PASS: 36 libraries, none below 16 KB |
| 16 KB: `zipalign -c -P 16 4` on a universal APK (18 libraries in each of 4 ABIs) | PASS |
| Secrets scan (1430 entries) | One expected hit: the QA key's name in `META-INF/QA-ONLY.RSA`. All other rules PASS (the tool's overall word is FAIL because of the QA signature) |
| Baked config against `expected-production.business.json` | FAIL, 5 rules. Four are expected from the placeholders. **The fifth is not: see below** |
| Upload signer pin, device smoke, push | Not applicable or not run |

**Release blocker for version code 2: the baked-config gate will reject a correct build.** The rule `"localhost" within the library baseline (<= 2)` counts 3. The two library strings are also in the version code 1 AAB (which passes this rule); the third is the app's own regular expression in `mobile/business/src/lib/staffApi.ts` (`isAllowedBaseUrl`, added by #869), compiled into the bundle whatever the environment holds. So `Build-ReleaseAab.ps1` is expected to fail a production-valued Business build from current main (inferred from the bundle; no production-valued build was made). No localhost literal was found in the Student app source. Evidence: `localhost-context.txt` in the build folder. Proposed fix (not made): let `verify-baked-config.js` discount that one exact literal for the Business app, with a self-test showing that any other extra `localhost` still fails. Do not raise the baseline for both apps.

Build and check evidence (logs, JS source maps, merger report, universal APK) is in `C:\dfr-out\business-vc2-aab\`.

Staging cleanup (H14, 2026-11-26), after the AAB hash and retained files were confirmed and no links were found: deleted the build worktree `C:\dfr\ar-bus` and its worktree record, the private TEMP `C:\dfr\tmp-ar-bus`, the unzipped copy of the AAB and the duplicate `universal-qa.apks` in the evidence folder. The three release AAB hashes were unchanged afterwards (25.4 GB free).
