# Google Play internal testing: upload procedure and compliance drafts

Status 2026-11-17 (re-checked against main 20e5bacdb (RC4), see section 11; the Business device-IDs row was corrected). Earlier status 2026-11-14. Draft prepared by engineering. **Nothing has been uploaded or submitted.** Facts below were verified in the repo on the date shown; anything not verifiable is marked **OWNER INPUT**. Companion documents: `Android_Release_Audit.md` (build and signing), `Android_Push_Firebase_Setup.md` (FCM).

## 1. Apps

| | DanceFlow (consumer) | DanceFlow Business (studio staff) |
|---|---|---|
| Package | `com.idanceflow.student` | `com.idanceflow.business` |
| Source | `mobile/student` | `mobile/business` |
| Version in config | 0.1.0, versionCode 1 | 0.1.0, versionCode 1 |
| Accounts | yes (email magic link / password through Supabase) | yes (staff sign-in only; no sign-up) |

## 2. Upload procedure (internal testing)

Prerequisite: an upload keystore exists and a signed `.aab` has been built (see `Android_Release_Audit.md`, "What the owner must do"). Do this once per app.

1. Play Console → select the app → *Test and release* → *Testing* → *Internal testing*.
2. *Testers* tab: confirm the tester list (the owner already created the internal tester lists; each tester must accept the opt-in link and use the Google account that is on the list).
3. *Create new release*. When asked about **Play App Signing**, accept (*Continue*): Google keeps the app signing key and your upload key signs each upload. The first AAB you upload fixes the upload certificate for this app.
4. *Upload* the `.aab` (drag it into the box). Console shows version code, the permissions it detected and any errors. A version code can be used once per app; the next upload must be higher.
5. *Release name* defaults to the version code and name; leave it.
6. *Release notes* (en-US), first release, suggested wording:
   - DanceFlow: `<en-US>First internal test build. Sign in, browse studios and events, view your schedule and tickets. Please report anything that looks broken.</en-US>`
   - DanceFlow Business: `<en-US>First internal test build for studio staff: sign in, see today's lessons and classes. Please report anything that looks broken.</en-US>`
7. *Next* → review warnings (an unfinished store listing/Data safety form blocks *production*, not internal testing, but fill them in; see sections 3–8) → *Save* → *Go to overview* → *Send changes for review*/*Start rollout to Internal testing*. Internal testing is normally available within minutes with no full review.
8. *Testers* tab → copy the *join on the web* opt-in link and send it to testers. Installs come from the Play Store after they opt in.
9. After install: sign in, then run the push check in `Android_Push_Firebase_Setup.md`.

Before the first release also complete the *App content* tasks in the Console dashboard (Privacy policy, Ads, App access, Content rating, Target audience, Data safety, Government/Financial/Health declarations as listed there). Internal testing does not need all of them approved, but **production** does.

## 3. Privacy policy and account deletion

> Sections 3-10 are drafts. Read the factual corrections in section 12 before copying anything into Play Console.

| Requirement | What the repo provides today | Status |
|---|---|---|
| Privacy policy URL | `https://idanceflow.com/privacy` (also `/privacy-policy`, which redirects to it). Page `src/app/privacy/page.tsx`, version 2026-07-17. Contact `support@idanceflow.com`. | Exists. **OWNER INPUT:** confirm the production domain serves it publicly, and have the policy reviewed for mobile specifics: it mentions push messages and a general "location" rights clause but does not explicitly say the app reads device location for nearby search or collects Expo push tokens. |
| Terms | `https://idanceflow.com/terms` | Exists. |
| In-app account deletion (DanceFlow) | Settings → *Delete DanceFlow account* → *Permanently Delete* (`mobile/student/app/settings.tsx`, `DELETE /api/student/account`, two native confirmation dialogs, Continue then Permanently Delete; the app sends `confirmation: DELETE` itself, the user does not type it; blocked with a message when the account cannot be deleted there, e.g. active obligations). | Exists. |
| In-app account deletion (Business) | None. Business has no self-service sign-up; accounts are staff accounts created by a studio. | **OWNER INPUT:** Play's policy covers apps that let users *create* an account in-app. Business does not, but decide and state the staff account removal path (studio owner removes the staff member; support request to `support@idanceflow.com`). |
| Web deletion URL (required in the Data safety form for apps with accounts) | The signed-in web page `https://idanceflow.com/account` has *Delete DanceFlow account* (`src/app/account/page.tsx`). It sits behind sign-in. | **OWNER INPUT / gap:** Google wants a URL a reviewer can open that explains how to request deletion. Recommended: a small public page (for example `/account-deletion`) describing the steps, the data deleted/retained and the support email. Until then, `https://idanceflow.com/privacy` plus `support@idanceflow.com` is the weakest acceptable answer. |

## 4. Data safety form — drafted answers

Derived from the app code. **OWNER INPUT** items are confirmations that cannot be made from the repo. Encryption in transit: yes (HTTPS to Supabase, DanceFlow web API and Stripe; the release builds do not permit cleartext, see audit). Users can request deletion: yes (section 3).

### DanceFlow (consumer)

| Data type (Play category) | Collected | Shared | Purpose | Notes |
|---|---|---|---|---|
| Email address (Personal info) | Yes | No | Account management, app functionality | Sign-in identifier. |
| Name (Personal info) | Yes | No (visible to studios you book with, as part of app function) | App functionality, account management | **OWNER INPUT:** confirm whether "shared" should be "Yes" for studio-visible profile fields. |
| Approximate and precise location | Yes, optional, only when the user taps "near me" | No | App functionality (nearby studios and events) | `ACCESS_COARSE/FINE_LOCATION`, foreground only, used for the query. **OWNER INPUT:** confirm whether the coordinates are sent to and retained by the server or only used in the request. |
| Photos | Yes, optional (partner profile photo upload) | No | App functionality | Picked through the system picker. |
| Other user-generated content (messages, partner posts, notes) | Yes | No | App functionality | **OWNER INPUT:** confirm LUMI assistant content flow and any third-party AI processor and whether it counts as "shared". |
| Purchase history / payment info | Purchase history: yes. Card data: **no**, handled by Stripe's SDK/Google Pay and never reaches DanceFlow servers | Payments: shared with Stripe (service provider) | App functionality | Declare as collected through a payments provider; Stripe is a processor/service provider. |
| Device or other IDs (Expo push token) | Yes | Shared with Expo (push relay) and Google FCM | App functionality (notifications) | Token stored server-side in `mobile_push_tokens`. |
| Crash logs / diagnostics | **OWNER INPUT:** the apps ship no crash SDK; Expo Updates reports update checks. Confirm and answer "No" unless a crash/analytics service is added. | | | |
| Contacts, calendar, health, audio, files, web history | No | | | |
| Event ticket ownership link (claim on sign-in, `claim_my_event_registrations`) | Not a new data type: after sign-in the app asks the database to attach event registrations that carry the signed-in user's own verified email to that account (sets `event_registrations.user_id` only on rows where it is empty). No new data is collected from the device; the registrations are the purchase history and name/email already declared above. | No | App functionality | Called with no arguments, as the signed-in user, once per app run; reads and writes only that user's event-registration ownership; never touches clients, payments or other tables. |

### DanceFlow Business

| Data type | Collected | Shared | Purpose |
|---|---|---|---|
| Email address | Yes | No | Account management, app functionality |
| Name, appointment details, studio client names (user-generated/business data shown to staff) | Yes (displayed; held by the studio's backend) | No | App functionality |
| Device IDs / push tokens (Expo push token) | Yes since `mobile/business/src/lib/expoPush.ts`; no token is minted until the Business app has an EAS project id (`eas init`) | Shared with Expo (push relay) and Google FCM | Notifications. Match the DanceFlow row before submitting. |
| Location, photos, payments | No | | |

## 5. Content rating questionnaire (IARC) — suggested answers

Both apps: category *Utility/Productivity/Social*-style apps; no violence, sexual content, profanity, controlled substances or gambling; **user interaction**: DanceFlow lets users exchange content with partners/studios (answer "Yes, users can interact" and "users can share content" if the partner feature is live; **OWNER INPUT:** confirm which); shares location: DanceFlow yes (optional, with the user's permission); digital purchases: DanceFlow yes (event tickets, packages through Stripe); Business no. Let the questionnaire compute the rating; expect Everyone/Teen-range.

## 6. Target audience and content

Target age group: **18 and over** is the safest honest answer for both apps (the privacy policy says the service is not directed to children under 13 for unmanaged accounts). Selecting 13+ groups triggers Families-policy questions; do not tick children's age groups. **OWNER INPUT:** confirm the business intent (minors may attend lessons through a guardian's account).

## 7. Ads declaration

Neither app contains advertising SDKs (verified: no ads dependencies in either `package.json`). Declare **"No, my app does not contain ads."**

## 8. App access instructions for reviewers

Both apps require sign-in. Play requires working credentials or a way to obtain them.

- **How to supply an account without real data:** create a dedicated reviewer account in a studio set up for review (a studio named "DanceFlow Review Studio" with synthetic students, appointments and events), never a real studio or real people's data. Use a mailbox on a domain you control (for example `play-review@idanceflow.com`) and a password credential: the student app signs in with email plus a magic link that arrives by email, which a reviewer cannot read, so the account must have a **password** set, or the instructions must say how to obtain the code.
- **Instructions text (draft):** "Open the app → Sign in → enter the email and password below. The account belongs to a demonstration studio containing sample data only. [credentials supplied in the *App access* form's login fields]."
- **Business:** needs a staff (instructor) account in the same demonstration studio.
- **OWNER INPUT:** create these accounts on PROD (engineering must not create PROD users or touch hosted databases), and paste the credentials into the Console's *App access* form only. Do not put them in the repo.

## 9. Permission declarations

| Permission | App | Justification (Play form / listing text) | Special declaration needed? |
|---|---|---|---|
| `INTERNET` | both | Network access to DanceFlow services. | No |
| `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` | DanceFlow | Optional "near me" search for studios and events; requested at the moment the user taps it; foreground only. | Normal runtime permission, covered by the Data safety form. No background location. |
| `POST_NOTIFICATIONS` | DanceFlow | Reminders for lessons, tickets, events and studio updates the user opts into. | No |
| `VIBRATE` | DanceFlow | Haptic/notification vibration from libraries. | No |
| Removed in this release prep: `CAMERA` (library-added; the app only uses the photo picker), `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE` | | Not used by either app; removed so they are not declared. | n/a |

## 10. Store listing items still needed (OWNER INPUT)

App icon 512×512, feature graphic 1024×500, at least two phone screenshots per app, short (80 chars) and full descriptions, category, contact email/website, and a distinct DanceFlow Business icon (the Business app currently has no icon asset; see audit). Existing marketing copy in `app.json` `description` fields can seed the descriptions.

## 11. Release checklist and owner queue (2026-11-17, main `c47e3ae17`)

Status key: PASSED = run with evidence; UNVERIFIED = not run or inconclusive; BLOCKED = needs the owner or a missing prerequisite. Evidence under `C:\dfr-out`; details in `Android_Release_Audit.md` section 9.

| Item | Status | Evidence |
|---|---|---|
| Release AABs build from main (both), QA-signed | PASSED | `rc3/` |
| targetSdk 36, versionCode 1 / 0.1.0, not debuggable, no cleartext, allowBackup false | PASSED | `rc3/` |
| 16 KB page size (both) | PASSED | `rc3/` |
| Permissions match the Data safety and permission tables (the claim call needs no new permission or data type; the photo picker adds none) | PASSED (Business push-token row corrected in section 4) | `rc3/` |
| Student device smoke 13/13 (unminified) | PASSED | `qa-rc3/student-smoke2` |
| Business device smoke | UNVERIFIED (harness: stale baked config in the QA APK and a defective reachability probe, fixed in #631/#633; re-run needed; see audit section 9) | `qa-rc3/business-smoke3` |
| R8 / minified Student | build PASSED; device smoke FAILED in dark mode; do not ship minified | `qa-rc3/student-smoke-r8*` |
| Baked `EXPO_PUBLIC_*` of the shipping AABs (decoded from the final artifact) | PASSED: both AABs bake only the QA placeholders (no stack URL, no JWT, no secret); the archived R8 AAB is contaminated with a disposable-stack URL and key and must not be used | `rc3/bk/` (see audit section 9) |
| **Before every upload:** decode the baked `EXPO_PUBLIC_*` values from the final AAB (Hermes string table of `base/assets/index.android.bundle`) and compare them with the intended release environment (production Supabase URL, production anon key, `https://idanceflow.com`, Stripe publishable `pk_live_`); reject any localhost/`10.0.2.2`/`.invalid`/stack URL, any anon key from a disposable stack, any `service_role`/`sk_`/`whsec_` string | REQUIRED STEP | audit section 9, Runbook step 1b |
| Real Play upload keystore and Play App Signing | BLOCKED (owner) | - |
| Firebase release project and real `google-services.json` per app | BLOCKED (owner) | DEV file only |
| Business EAS project (`eas init`) and push credentials | BLOCKED (owner) | - |
| Production push (FCM v1 key under the production EAS projects) | UNVERIFIED | DEV delivery proven 2026-11-14 |
| Account deletion web page timing, privacy policy URL | OWNER INPUT | section 3 |
| Store listing assets, content rating, Data safety submission | OWNER INPUT | sections 4-8, 10 |
| Android 12 and older, live font-size change (R-3b), EAS cloud build | UNTESTED / UNVERIFIED | - |

### Owner queue, in order

1. Generate the Play upload keystore (keep it and its passwords outside every repo) and create both apps in Play Console with Play App Signing; give engineering only the certificate fingerprint, never the key.
2. Decide the Firebase release project (or confirm `danceflow-mobile-dev` is it), delete the service-account key file left in Downloads, and upload an FCM v1 key under each production EAS project.
3. Run `eas init` in `mobile/business` (EAS project id, `expo.owner`), then store each app's `google-services.json` as the `GOOGLE_SERVICES_JSON` EAS file variable.
4. Decide when the web account-deletion page and privacy policy URL go live (the Data safety form needs the deletion URL before submission) and confirm the A7 purchasability decision.
5. Confirm the Data safety OWNER INPUT items (name sharing, location retention, LUMI processor, crash/diagnostics), the content rating answers and the store listing.
6. Approve the first internal-testing build (unminified), then upload by hand per section 2.


### RC4 update (main `20e5bacdb`, 2026-11-18)

| Item | Status | Evidence |
|---|---|---|
| Release AABs build from main (both) with a private `TEMP`; QA-signed | PASSED | `rc4/` |
| Baked `EXPO_PUBLIC_*` decoded from each final AAB (Student, Business, Student R8): placeholders only, no JWT, no secret, no stack URL | PASSED (required pre-upload step; re-run on the real release artifact against the production values) | audit section 10 |
| targetSdk 36, v1/0.1.0, not debuggable, no cleartext, allowBackup false, blocked permissions absent, 16 KB | PASSED | `rc4/` |
| Business device smoke | PASSED 22/22 | `qa-rc4/business-smoke` |
| Student device smoke (unminified) | PASSED 13/13 on the third attempt (one transient sign-in connection failure, one stack-guard refusal; see audit section 10) | `qa-rc4/student-smoke3` |
| R8 / minified Student | PASSED: build with `:app:minifyReleaseWithR8` (91.2 MB vs 99.1 MB) and smoke 13/13 on a forced-R8 QA APK. The first release can still be the unminified AAB; R8 is a candidate, not yet the default | `qa-rc4/student-smoke-r8`, `rc4/student-rc4-r8.aab` |
| Signing guard negative test; R-3b live font change; Android 12 and older; EAS cloud build | UNVERIFIED / UNTESTED | - |

The RC3 rows above that call R8 "FAILED in dark mode" are superseded: that smoke was unminified (audit section 9 correction). The owner queue above is unchanged.
### RC5 update (main `8535bedc2`, 2026-11-18)

Build, manifest, targetSdk 36, 16 KB and baked-config decode: PASSED for both AABs (SHA-256 in `Android_Release_Audit.md` section 11). Device smokes (Student matrix, Student `--events` with the dancer views, Business): BLOCKED by an emulator System UI ANR, so the wallet-reads-the-views check is UNVERIFIED on RC5; RC4 smokes passed (section 10). Owner queue unchanged.

### MILESTONE 2026-11-20: Student version code 1 is live on the internal track

Owner-confirmed 2026-11-20: **DanceFlow (Student) 0.1.0, version code 1 is ACTIVE and AVAILABLE TO INTERNAL TESTERS** on the existing internal testing track. Not production, not open testing. The Console's *upload key certificate* SHA-256 matched the pin in `docs/mobile/tools/upload-cert.json` exactly (`12:E5:24:0E:...:A1:EE:AF`).

| | |
|---|---|
| Artifact | `C:\dfr-out\release\student-f5f31103.aab` (99,116,172 B), outside the repo; keep it |
| SHA-256 | `f67a39a52d15f503b79f62a408746da4f8592e6566320a3830a2bee31b8fbda7` |
| Built from | main `f5f31103f2ed` via `Build-ReleaseAab.ps1` (worktree `C:\dfr\rel-student`); read-only artifact checks all PASS (`Android_First_Internal_Release_Prep.md` section 8) |
| Version | versionName 0.1.0, **versionCode 1**; the next upload needs **versionCode 2** |
| Tester steps | `Student_Internal_Tester_Smoke.md` (message to forward, 8-step smoke, what we watch server-side, housekeeping) |

Still UNVERIFIED: device behavior of this exact production-valued AAB (only the QA build of the same inputs was smoke-tested), push delivery (DEV Firebase project), and the Play pre-launch report. Business was not uploaded on 2026-11-20 when this was written; superseded: a read-only Console check on 2026-11-22 showed Business **version code 1 (0.1.0) Available to internal testers**, released Nov 20 4:47 PM (`Business_Release_Package_Internal_Testing.md`, 2026-11-23 status).

## 12. Factual verification of the drafts (2026-11-26, main `b758fe072`): these corrections override sections 3-10

Checked against the repository and the 2026-11-20 AAB checks. Drafts stay **pending**; nothing was submitted (H10). "Code" means verified by reading or searching the source, not by observing traffic.

| Section | Draft says | Verified fact | Effect on the form |
|---|---|---|---|
| 3 | No public deletion page; recommends writing one | The page exists on main (`src/app/account-deletion/page.tsx`) but `https://www.idanceflow.com/account-deletion` returns **404** (2026-11-26); `/privacy` returns 200 | Blocker until released (H2) |
| 3 | Privacy policy gap on location and push tokens | Confirmed: the policy (2026-07-17) mentions push communications but not device location or push tokens | Policy wording still needed |
| 4, location | Owner to confirm whether coordinates reach the server | Code: studios, events, jobs and partner search compare distance **on the device**; no write or query sends the coordinates; requested from a user action | Declare location as used in the app and **not collected off the device**, after the owner accepts that reading of Play's definition |
| 4, LUMI | Owner to confirm a third-party AI processor | Code: the shipped LUMI screen builds answers from the dancer's own data on the device; no AI request. "Report" stores the prompt and answer (`lumi_response_reports`). The new assistant is flag-off and a local stub | Declare the report text as user content; no AI sharing for current builds. Re-check if the assistant gets a backend |
| 4, partner profile | (not listed) | Display name, headline, bio, city, state (typed), styles, goals, availability and photo are saved to the partner profile; no coordinates | Include under user content and profile info |
| 4, diagnostics | "the apps ... Expo Updates reports update checks" | Student ships `expo-updates` (checks `u.expo.dev` at launch); **Business does not**. Neither ships a crash SDK | Answer per app |
| 4, payments | Card data handled by Stripe SDK / Google Pay | Release builds bake no Stripe publishable key, so event registration uses **hosted checkout in the browser**; the in-app payment sheet is used only when a key is built in. Wallet "Pay Now" opens a server checkout link | Card data still never reaches DanceFlow; do not describe an in-app Google Pay flow for these builds |
| 5 | "Digital purchases: yes (event tickets, packages through Stripe)" | The app starts checkout for **event registrations** (real-world events) and opens payment links; no in-app package or digital-content purchase was found (the marketplace checkout functions are unused) | The "digital purchases" answer is likely **No**; confirm against Google's definition before submitting |
| 6 | Policy not directed to children under 13 | Confirmed (policy section 13). The 18+ choice stays an owner decision | None |
| 7 | No ads SDK | Confirmed for both `package.json` files | None |
| 8 | Reviewer signs in with a password | **Wrong for Student:** its sign-in screen offers only an emailed link; there is no password sign-in. Business has password sign-in | Student reviewer access is **unsolved**: needs a mailbox the reviewer can use or a reviewed code change. Blocks any review that requires sign-in |
| 9 | `POST_NOTIFICATIONS`, `VIBRATE` listed for DanceFlow only | The Business AAB also declares both | Declare for both |
| 10 | Business has no icon asset | Business icon assets now exist (`mobile/business/assets/`) | Only the 512 px store icon export and graphics remain |

Related: the owner disposition G5 calls public text claiming in-app ticket purchasing false. The code does contain an event-registration checkout (hosted, in the browser, in release builds). Whoever words that correction should check it against this fact.
