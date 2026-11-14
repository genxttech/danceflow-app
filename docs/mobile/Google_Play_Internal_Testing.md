# Google Play internal testing: upload procedure and compliance drafts

Status 2026-11-14. Draft prepared by engineering. **Nothing has been uploaded or submitted.** Facts below were verified in the repo on the date shown; anything not verifiable is marked **OWNER INPUT**. Companion documents: `Android_Release_Audit.md` (build and signing), `Android_Push_Firebase_Setup.md` (FCM).

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

| Requirement | What the repo provides today | Status |
|---|---|---|
| Privacy policy URL | `https://idanceflow.com/privacy` (also `/privacy-policy`, which redirects to it). Page `src/app/privacy/page.tsx`, version 2026-07-17. Contact `support@idanceflow.com`. | Exists. **OWNER INPUT:** confirm the production domain serves it publicly, and have the policy reviewed for mobile specifics: it mentions push messages and a general "location" rights clause but does not explicitly say the app reads device location for nearby search or collects Expo push tokens. |
| Terms | `https://idanceflow.com/terms` | Exists. |
| In-app account deletion (DanceFlow) | Settings → *Delete DanceFlow account* → *Permanently Delete* (`mobile/student/app/settings.tsx`, `DELETE /api/student/account`, requires typing DELETE; blocked with a message when the account cannot be deleted there, e.g. active obligations). | Exists. |
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

### DanceFlow Business

| Data type | Collected | Shared | Purpose |
|---|---|---|---|
| Email address | Yes | No | Account management, app functionality |
| Name, appointment details, studio client names (user-generated/business data shown to staff) | Yes (displayed; held by the studio's backend) | No | App functionality |
| Device IDs / push tokens | No (no push in this app today) | | |
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
| Removed in this release prep: `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE` | | Not used by either app; removed so they are not declared. | n/a |

## 10. Store listing items still needed (OWNER INPUT)

App icon 512×512, feature graphic 1024×500, at least two phone screenshots per app, short (80 chars) and full descriptions, category, contact email/website, and a distinct DanceFlow Business icon (the Business app currently has no icon asset; see audit). Existing marketing copy in `app.json` `description` fields can seed the descriptions.
