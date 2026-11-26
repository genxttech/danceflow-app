# Business internal release (versionCode 2): what is done, what can be run, what needs the owner

2026-11-24, main `dfd204abf` (#830, versionCode 2, version name 0.1.0, no upload). Reconciles the Business "unverified" items from `Business_Release_Readiness.md`, `Business_Release_Candidate_Checklist.md` and `Android_Release_Audit.md` against what has been proven since. Nothing here uploads, flips a flag or touches production.

Columns: **Done** (evidence exists), **Executable** (engineering can run it; heavy ones go through the heavy-lock queue), **Owner** (needs a decision or an account only the owner has).

| Item | Done | Executable | Owner |
|---|---|---|---|
| Push delivery | Client side: registration, claim, routing guarded by `push.test.tsx`, `pushSetup.test.ts`, `notificationRoute.test.ts` | Nothing end to end: there is no staff-facing sender (A9); the token is unbound at sign-out since 2026-11-26 | A7: which Firebase project and FCM key; whether the first candidate ships without push (the app already says "notifications not available" without credentials) |
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

Push token at sign-out (fixed 2026-11-26): sign-out and sign-out of all devices now delete this device's `mobile_push_tokens` row while the session is still valid, waiting at most 5 s and never blocking sign-out. No server change was needed (the own-row delete policy exists); the earlier note here that it did was wrong. If the phone is offline at sign-out the row stays until the next account on the phone claims it, or until the sender drops it. Covered by `authPushUnbind.test.ts`; not run on a device (push is off without credentials). Also noted: a normal sign-out revokes the session locally only ("Sign out of all devices" revokes it on the server).

Checked and fine: tokens only in SecureStore with no fallback to AsyncStorage, backup off, no raw tokens read from links, no tokens in logs, notification routing validates ids and the server authorizes, one refresh then stop on a 401 with the same idempotency key, state reset on user switch.

## versionCode 2 build check (2026-11-26, main `ee6a254fc`, after #869 and #868)

QA release APK (`assembleRelease`, QA keys, flags `pulse` and `studioSchedule` on, **x86_64 only**), disposable local stack, fictional data. Evidence `C:\dfr-out\business-vc2\run1` (`summary.json`), APK SHA-256 `54907ffae60c979255f9c43ad84487f543552daa08de93a2ad3e4170ab8f02c9`.

| Check | Result |
|---|---|
| APK identity | `com.idanceflow.business`, versionCode 2, versionName 0.1.0, target and compile SDK 36, min 24 |
| One-command smoke with `--a11y` | PASS 28/28: light and dark at 1.0 and 2.0, live text-size change, empty day, 403 and recovery, 401 and sign-in again, instructor, and the sign-in, class roster, client and More trees |
| Accessibility tree audit | 23 screens, 0 unlabelled controls. The "small" flags on the roster marks and the My day / Studio switch are 115 px = 43.8 dp at density 420 (a 44 dp control rounded to pixels) |
| 16 KB: `zipalign -c -P 16 4` | PASS (exit 0) |
| 16 KB: ELF `PT_LOAD` alignment | PASS for the 18 x86_64 libraries, 0 below 16384 |

**Not covered by this run:** the signed or unsigned **AAB** (not built), **arm64-v8a** libraries of this commit (the QA APK carries x86_64 only; the earlier arm64 pass is in `Android_Release_Audit.md`), the appointment and client screens in dark at 2.0, R8, real TalkBack, a real device. The sign-in link change of #869 is covered by unit tests only: the smoke signs in with a password.
