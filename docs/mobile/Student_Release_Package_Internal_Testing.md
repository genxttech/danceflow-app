# Student app: internal-testing release package

2026-11-18, written at main `793ef6439` (includes #649, the view-reading wallet). Student = `com.idanceflow.student`, 0.1.0, versionCode 1 in config (EAS `appVersionSource: remote`, production profile `autoIncrement`). **Nothing is uploaded and nothing here authorizes an upload.** Companion documents: `Google_Play_Internal_Testing.md` (procedure, Data safety drafts), `Android_Release_Audit.md` (RC4), `Student_Release_Candidate_Checklist.md`, `Student_Dancer_Views_Cutover_Note.md`, `docs/events/event-registration-claim-release-package.md` (server SQL gates, section 15).

Status words: PASS = run, evidence named. UNVERIFIED = not run or not provable from here. BLOCKED = needs something outside Student.

Baseline: no tester has seen any Student build (the Play doc records no upload). RC4 (`20e5bacdb`, QA-signed, never uploaded) is the last build that was device-tested as an AAB, so "new" below means after RC4. Changes already in RC4 but never seen by a tester are in 1b.

## 1. User-visible changes and what each needs

### 1a. New since RC4 (not in any built AAB yet)

| # | Change | User-visible effect | Server pieces needed on PROD | If the server piece is missing (exact behavior) | Test evidence |
|---|---|---|---|---|---|
| N1 | Wallet and Tickets read the dancer views `my_event_registrations` / `my_event_registration_attendees` (#649 `8535bedc2`) | Same tickets and registrations as before; no visible difference while the base-table policies exist | **Gate 1 SQL: the views (APPLIED on PROD 2026-11-19 00:50Z per the coordinator).** Gate 2 (cutover) is NOT needed to use the build | Views absent: the build reads objects that do not exist and the event-ticket part of the wallet shows no tickets (not exercised on a device; moot now that Gate 1 is applied). Gate 2 applied while an old build is installed: old builds read the base tables and show **zero tickets, no error** (see 1d) | PASS on disposable stacks built from main refs, new APK from `9141ca5d4`: matrix with cutover 29/29 (`C:\dfr-out\qa-views\matrix-cutover`), HTTP checks views 16/16 and cutover 17/17 (`api-views`, `api-cutover`: own rows only, safe columns only, embeds work, base tables empty and attendee insert refused after cutover), device claim run views 33/33 and cutover 33/33 (`device-views`, `device-cutover`). Jest `walletTicketsByUser`, `studentWalletScope`. **UNVERIFIED against PROD data** |
| N2 | "N admission spots left" / "Sold out" from the availability route (#651 `c32e4f340`) | Event detail and register screens show the true remaining count per ticket type; "Sold out" can now appear (it could never appear before: the old count only saw the dancer's own rows) | Web route `GET /api/student/events/{id}/availability` (#650, #652 on main). **On the live line only through PR #661 (OPEN)** | Route missing or any failure (no session, 401, 404, 429, 500, offline, malformed): the app shows "Admission spots available" for that ticket type; never a number, never "Sold out". Nothing oversells: the checkout route still enforces capacity and answers "Only N spots remain" | Jest `ticketAvailability.test.ts` (all failure classes). Device smoke screen check `event-availability` expects "3 admission spots left" against the **mock** route (#655): PASS in the claim/matrix runs above. **UNVERIFIED against the real route on PROD** (the real route is covered by web tests, not by a Student device run) |
| N3 | Claim of guest-bought tickets by verified email (calls `claim_my_event_registrations()` once per app run per user, silent) | After sign-in, tickets bought as a guest with the same verified email appear in Wallet. **Dark until Gate 2 activation** | The claim function exists on PROD but is **not executable by any client** until the Gate 2 activation migration; claim also needs the views (N1) to read results | Execute withheld: the RPC answers 42501, the app treats any error as "claimed nothing", no message, no retry. The user sees no change | Claim function behavior (sources, studio-sold exclusion, idempotence, cross-account) PASS on a disposable stack against the final #627 function (`C:\dfr-out\qa-claim627`, `qa-main-final`) and on views/cutover stacks (above). Jest `claimEventRegistrations`. **UNVERIFIED:** the 42501 path on a device (my runs had the function executable); `import`/`organizer_portal`/`other` sources on a device (SQL tests only); production behavior |

### 1b. In RC4 but not yet seen by any tester

| Change | User-visible effect | Server dependency / if missing | Evidence |
|---|---|---|---|
| Error wording (F1, #642-#645): the app shows only its own sentences or the API's `error` string; raw database/SDK text is replaced by the screen's fallback; auth errors map by code (expired or used link, bad address, rate limit, weak or repeated password, email not confirmed, invalid credentials) | A tester never sees vendor or SQL text; sign-in link errors say what to do | None (client-side). A server 5xx reads as a server problem, not "offline" (#645) | Jest `friendlyMessageGuard`, `errorKind`, `errorMapping`, `gotrueCodes` (real GoTrue answers captured on a disposable stack: `docs/mobile/Student_GoTrue_Error_Codes.md`). **UNVERIFIED on a device** for most wordings; hosted GoTrue may differ in version |
| Sign-in link and auth-link behavior (#609, #611, #644-#646) | Connection failure no longer reads as "bad email" or "expired link"; a slow auth callback says it is taking longer and offers Try again; used or expired link gets one clear sentence | Supabase Auth only. PKCE link opened on another device falls to the generic "request a new link" sentence | Jest above; RC4 device smoke 13/13 signs in by magic link (`C:\dfr-out\qa-rc4\student-smoke3`). Cold-start and warm link opening PASS earlier (R5-R7) |
| Wallet also finds tickets linked by `user_id` (#621) and the ticket studio name for no-link buyers (#566) | Guest and claimed tickets show | RLS/views (N1) | Jest + the stack runs above |
| Wording sweep (#611-#614): load failures separate offline, server error and not-found; Try again everywhere | Fewer dead ends | None | Jest guard (allowlist empty) |
| Event/ticket fixes: stale event error cleared (#600), 44dp notification rows | Minor | None | Jest, device matrix |
| Earlier since the RC2 baseline: live text-size change (#533), screen-reader announcements and names (#524-#560), Pay Now return handling (#537), Settings legal links (#542) | See the checklist | `/account-deletion` page must be live for its link (`Student_Release_Candidate_Checklist.md` A2) | RC2/RC4 smoke 13/13; TalkBack/VoiceOver walks BLOCKED |

### 1c. Not user-visible to a tester (do not list in release notes)

Smoke-harness changes (#654 Wi-Fi/steady-answer preflight and baked-config check, #655 mock availability route, claim QA modes). They make QA runs trustworthy; the app does not contain them. The Wi-Fi flap wait is proven by jest only; a real flap has not been exercised on an emulator.

### 1d. Old builds and Gate 2

Gate 2 (`20270222093000`) makes the base-table dancer read return zero rows. Any installed build that reads the base tables (every build before #649) then shows no event tickets and no error. No earlier Student build is known to be in users' hands (nothing was uploaded); the owner confirms that, or chooses option A/B/C in `event-registration-claim-release-package.md` 15.13. There is no minimum-version mechanism in the app or API (UNVERIFIED that none exists in the API; none in the app: option C would need a release).

## 2. The smallest safe and useful Student release

**Release the build as it is on main; do not cherry-pick.** Reasons: every post-RC4 change is either server-gated, fail-closed or client-only wording. Removing the views read (N1) would force a second build before Gate 2 anyway; removing the claim call (N3) gains nothing because it is silent and inert while execute is withheld.

Include: everything on main at the candidate commit. Build: unminified AAB (R8 passed RC4 smoke 13/13 and is a candidate, not the default), built with a private empty `TEMP`, `CI` unset, one Gradle build at a time, release-signed with the upload key. Exclude: nothing; there are no feature flags in the app. Behavior that degrades safely without server pieces: N2 (shows "Admission spots available") and N3 (silent). N1 is the only hard server dependency, and it is satisfied.

**Required order (versus web #660/#661 and Gate 2):**

1. Gate 1 on PROD: DONE (views live; claim function not executable).
2. Web #661 (availability route on the live line): deploy before testers open an event, or accept that testers see "Admission spots available" instead of counts. Not a blocker for the build.
3. Release-environment decode of the final AAB: baked `EXPO_PUBLIC_SUPABASE_URL`, anon key, `EXPO_PUBLIC_DANCEFLOW_WEB_URL`, Stripe publishable key must be the intended production values and nothing else (Runbook step 1b; reject `.invalid`, `10.0.2.2`, stack URLs, disposable-stack JWTs, `service_role`, `sk_`, `whsec_`). Needs the production values from the EAS environment (owner/android-release).
4. Upload to internal testing; run the tester script (section 3); watch section 3b.
5. Web #660 (web readers on the views) must be live before Gate 2; it is not needed for the Student build or for internal testing.
6. Gate 2 cutover + claim activation only after: #660 live, this build seen reading the views (section 3b query), the old-build decision (1d) recorded, and owner authorization. Gate 2 is a separate owner gate and is not implied by this package.

## 3. Tester script (Play internal testing, Android)

Prerequisites: tester account on the internal list; a PROD test dancer account with a password or a mailbox the tester can read (magic link by email); one PROD **event registration for that dancer's email created by the owner** (a guest purchase, `public_event_page` source) to test visibility; one event with a limited ticket type (and, if available, one sold-out type). Do not use real customers' data.

| # | Step | Expected |
|---|---|---|
| 1 | Install from the Play opt-in link; open the app | Opens to sign-in; no crash; no permission prompt before it is relevant |
| 2 | Enter the email, request the sign-in link; open the link from the email on the same phone | Signed in, Today/home loads |
| 3 | Request a link, then open the **same** link a second time | One clear sentence that the link is expired or used; no technical text |
| 4 | Turn on airplane mode, pull to refresh a tab | Offline wording with Try again; no raw error text. Turn it off, Try again works |
| 5 | Open Wallet | Loads without error banner; event tickets section present |
| 6 | Open the guest-bought event ticket (owner-made registration) | Before Gate 2 activation: ticket may be absent if it was not bought under this user_id (expected, claim is dark). After activation: ticket and code appear |
| 7 | Open a ticket with a QR | QR image shown; code readable |
| 8 | Open the limited event | Shows "N admission spots left" matching what the owner expects (if route live) or "Admission spots available" (if not). Sold-out type shows "Sold out" and cannot be chosen |
| 9 | Start registering for a free ticket type (Stripe test is unavailable on PROD: do not enter a card) | Checkout screen loads; capacity message sensible; back out |
| 10 | Settings: toggle notifications, open Help Center, Security, account-deletion info link | Switch matches OS permission; links open the public pages (404 = web release gap) |
| 11 | Set system text size to the largest, reopen the app | No clipped sign-in or wallet text (applies at next launch) |
| 12 | Switch phone to dark mode, visit Wallet, Settings, an event | No blank screens or unreadable text |
| 13 | Sign out, sign in again | Same wallet; no stale data of another user |
| 14 | Kill the app, reopen | Session restored |

Record per step: pass/fail, device model, Android version, app version/build number, screenshot on failure.

### 3b. What to watch

- Play Console: Android vitals (crashes, ANRs) for the internal track; pre-launch report if generated. **The app ships no crash SDK**, so Play vitals and tester reports are the only crash signal.
- Supabase logs (owner-assisted; engineering has no log access): requests to `/rest/v1/my_event_registrations*` from `supabase-js-react-native` prove the build reads the views (the Gate 2 precondition); `claim_my_event_registrations` RPC calls answering 42501 before activation are expected, 0 after; unexpected 4xx/5xx on `/rest/v1/event_registration*`.
- Web logs: `/api/student/events/*/availability` status mix (401/404/429/500 should be rare), `/api/student/studio-links`, `/api/student/profile`.
- Database corroboration without logs: `view_reads.calls` in the gate-2 prerequisite evidence script (`docs/events/event-registration-claim-release-package.md` P3(c)).
- Tester reports of an empty Tickets screen are a Gate 2 stop signal.

## 4. Rollback and hotfix

| Situation | Action | Status |
|---|---|---|
| Bad build on the internal track | Play does not delete a version code. Stop distribution by removing testers from the list or ending the test release in Play Console, then ship a **new** versionCode. A staged-rollout halt exists only on production tracks | Console steps UNVERIFIED (not exercised; owner confirms the exact UI) |
| Previous AAB | **None exists** (first upload). A rollback build means rebuilding an earlier commit with a higher versionCode. Keep each uploaded AAB, its commit, versionCode and SHA-256 outside the repo | Process, not yet exercised |
| Tickets missing after Gate 2 | Roll back the cutover first (restores the base-table policies), then the claim activation if needed; no app change required | Rollback SQL is in the release package (`20270222093000`, `20270222094000` rollbacks); not run |
| Wrong capacity text | Disable or fix the web availability route: the app degrades to "Admission spots available" | Degradation covered by jest |
| Claim misbehaves | Withhold execute again (activation rollback): the app stays fail-closed | Not run on PROD |
| Server-side kill switch inside the app | **None.** The app has no remote feature flag of its own (it reads `lumiEnabled` and similar from the API only). The levers are server routes and SQL above | Observed in code |
| OTA update (expo-updates, runtime 1.0.0) | Configured in `app.config.js`, but UNVERIFIED that a locally built AAB points at a channel, and no update has ever been published. Do not rely on it | UNVERIFIED |
| Hotfix path | Fix on main (PR, CI), build a new RC from the exact commit with a private `TEMP`, run `qa-smoke/run.mjs` on that commit, decode baked config, versionCode+1, upload by hand | Procedure as in `Android_Release_QA_Runbook.md` |

## 5. Owner versus autonomous

Owner (blocked without them): Play upload keystore, Play App Signing and both app entries; the tester list and opt-in link; the upload itself; Firebase release project decision and `google-services.json`/FCM key (push delivery on PROD is UNVERIFIED); production values for the EAS `production` environment (Supabase URL and anon key, web URL, Stripe publishable key; which Stripe mode internal testers use); PROD test accounts (a dancer account with credentials, the guest-bought registration, a limited and a sold-out ticket type) because engineering must not create PROD users or data; Data safety, content rating, privacy and account-deletion URL (A2 depends on main reaching production), store listing; the old-build decision for Gate 2; authorization of Gate 2.

Autonomous (Student engineering, no owner step): keep jest, `tsc` and the device smoke green on the candidate commit; run the decode of baked config on any built artifact once the real values are supplied; run the claim, views and cutover QA on disposable stacks; keep the QA plan and this package current; prepare the hotfix on request. Not autonomous: any build with production secrets, upload, PROD SQL or data, deploys.

## 6. Open items that change this package

- #661 and #660 are OPEN at the time of writing; the live line decides what testers see for N2.
- Run the 42501 (execute withheld) path on a disposable stack with device before activation: UNVERIFIED.
- `--claim-visual` with the views (font 2.0 and dark) not run.
- Real push, real payments, Android 12 and older, TalkBack and VoiceOver walks remain BLOCKED/UNVERIFIED per the checklist.
