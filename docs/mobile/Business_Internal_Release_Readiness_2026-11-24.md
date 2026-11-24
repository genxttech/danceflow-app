# Business internal release (versionCode 2): what is done, what can be run, what needs the owner

2026-11-24, main `dfd204abf` (#830, versionCode 2, version name 0.1.0, no upload). Reconciles the Business "unverified" items from `Business_Release_Readiness.md`, `Business_Release_Candidate_Checklist.md` and `Android_Release_Audit.md` against what has been proven since. Nothing here uploads, flips a flag or touches production.

Columns: **Done** (evidence exists), **Executable** (engineering can run it; heavy ones go through the heavy-lock queue), **Owner** (needs a decision or an account only the owner has).

| Item | Done | Executable | Owner |
|---|---|---|---|
| Push delivery | Client side: registration, claim, routing guarded by `push.test.tsx`, `pushSetup.test.ts`, `notificationRoute.test.ts` | Nothing end to end: there is no staff-facing sender and the token is not unbound at sign-out (A9) | A7: which Firebase project and FCM key; whether the first candidate ships without push (the app already says "notifications not available" without credentials) |
| One-command smoke (#553) | 18/18 on a release APK (R6, smoke 19); writes smoke with the commit preflight (#747); Pulse role + device suite 90/90 on main `38b6277bf` (`C:\dfr-out\pulse-audit\captures\main-0e`) | Re-run on the candidate commit. `dfd204abf` changes only `app.json` (versionCode) from the commit already smoked, so this is one run, not new coverage | none |
| Accessibility | Static roles/names/targets (`a11y.test.tsx`), reading order of every key screen incl. Pulse cards for all roles (`readingOrder.test.tsx`), tree audit over device dumps: 24 screens, 0 unlabelled controls (Pulse close-out); font scale 2.0 for sign-in, Today, studio view, Pulse (all roles), roster, Clients, More | Device dumps for the appointment and client screens at 2.0 in dark and the 401/403 states in dark (B4): one smoke run with `--a11y` | none |
| Real TalkBack (spoken output) | No | **Not executable as configured**: the spike found no usable TalkBack automation on the `df-api35` image. Recorded as unresolved, not covered by the static proxies | Accept the proxies for an internal build, or have a person listen on a real phone for 10 minutes (Today, a roster, Pulse) |
| R8 / minified release | Student: first attempt fixed a Stripe missing-class warning; no minified build has completed. Business: never built minified (shrink is off in the shipped config) | One Gradle build with `-Pandroid.enableMinifyInReleaseBuilds=true` plus the smoke; 45+ min of the heavy slot | Decide whether the internal build must be minified at all (Play delivers per-ABI splits, so the install is smaller than the 94 MiB AAB). Recommendation: ship unminified for internal testing, run R8 as its own slot before production |
| 16 KB page size | `zipalign -c -P 16` exit 0 and 0 of 46 arm64 / 36 x86_64 libraries below 16384, for both apps (`Android_Release_Audit.md`) | Re-check the versionCode 2 AAB with the same two commands (seconds, after the build) | none |
| Kill switch and minimum app version | Server guard and the client states are covered by tests: `writeGuard` (server), `staffApiWrites.test.ts`, `mutation.test.tsx`, `MutationUi.test.tsx`, `ClientWrites.test.tsx` (`writes_disabled` and `upgrade_required` show their own wording, reads keep working, nothing is retried) | none | none |
| Offline, 401, 403, paused studio, wrong role | Every server code has its own message and action (`StaffErrorState`); each screen wires the refresh action; the 401 path refreshes once and resends the same request with the same idempotency key; tests per screen (`TodayScreen`, `StudioScheduleScreen`, `ClientsScreen`, `ClientDetailStates`, `AppointmentScreen`, `PulseScreen`, `staffApi*`) and on a device (403 and recovery, 401 and re-sign-in, R6) | none | none |
| Staff routes on the deployment the build points at (A1) | On main | Verify against the target deployment with a real staff account | Web promotion and the main reconcile; A2 PROD SQL gate; A5 redirect allow-list; A6 test account |
| Signed AAB, upload | Build and signing process documented (`Google_Play_Internal_Testing.md`) | Build the unsigned-QA AAB of `dfd204abf` as a dry run (the one heavy ticket) | A8 upload keystore and Play App Signing; the upload itself |

## What this leaves

Engineering can finish, with no owner input: the versionCode 2 build check (16 KB, baked-config check, smoke with `--a11y`) in one heavy-queue run.

Needs the owner before an internal candidate is useful: A1 live on the build's target (web promotion), A2 and A5 and A6, the push decision (A7), and the upload keystore (A8).

Open and unresolved: real TalkBack, R8, iOS (no macOS).

## Security read of sign-in, token storage and the API client (fresh reviewer, 2026-11-24)

No high-severity defect. Verified and fixed in this change: a sign-in link that carries a token hash (not bound to the device the way a code link is) is now honoured only while this device has a pending sign-in request, so another app or page cannot swap the signed-in person into someone else's account; the staff API client refuses a non-HTTPS base URL (plain http only for the emulator and loopback of a QA build) and gives up a request after 20 s as a network error. Tests: `authTokenHashGate.test.ts`, `staffApiSafety.test.ts`.

Not fixed here, needs a server change and an owner decision (listed with A9): the push token is not unbound at sign-out, so a signed-out shared phone keeps receiving the previous person's pushes until another account claims it. It matters only once a staff push sender exists; push is off without credentials. Also noted: a normal sign-out revokes the session locally only ("Sign out of all devices" revokes it on the server).

Checked and fine: tokens only in SecureStore with no fallback to AsyncStorage, backup off, no raw tokens read from links, no tokens in logs, notification routing validates ids and the server authorizes, one refresh then stop on a 401 with the same idempotency key, state reset on user switch.
