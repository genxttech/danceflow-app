# Student app: crash and error reporting options

2026-11-18, main `793ef6439`. **Options analysis only. No signup, no SDK install, no fees, nothing implemented.** Today the app ships **no crash or analytics SDK** (checked: `mobile/student/package.json`; the Play doc records the same). Crash signal today is Play Console Android vitals (Google collects them for users who opted in on their device) plus tester reports.

Source key: [FB-PRICE] https://firebase.google.com/pricing (fetched 2026-11-18); [RNFB] https://rnfirebase.io/crashlytics/usage (2026-11-18); [SENTRY-PRICE] https://sentry.io/pricing/ (2026-11-18); [SENTRY-EXPO] https://docs.sentry.io/platforms/react-native/manual-setup/expo/ (2026-11-18); [PLAY-DS] https://support.google.com/googleplay/android-developer/answer/10787469 (2026-11-18). Anything without a key is repo-derived or UNVERIFIED.

## 1. Options

| | A. Firebase Crashlytics | B. Sentry | C. None (Play vitals + tester reports) |
|---|---|---|---|
| Cost | Pricing page lists Crashlytics as "No-cost" for mobile apps on Spark and Blaze; it states no usage limits or quotas; on Blaze, related Google Cloud services (Cloud Logging, Cloud Storage) are billed separately [FB-PRICE] | Developer (free) plan: one user, "5k errors", 30-day lookback; the page does not say whether 5k is per month (UNVERIFIED); paid tiers exist, prices not captured [SENTRY-PRICE] | free |
| Project reuse | Uses the Firebase project and `google-services.json` the app already needs for push (FCM). The release project decision is still open (`Student_Release_Candidate_Checklist.md` A5) | New vendor account and an organization/project; auth token for source maps | none |
| Expo/EAS integration | Needs `@react-native-firebase/app` and `@react-native-firebase/crashlytics` and the Crashlytics config plugin; the plugin covers only the Gradle plugin steps, and the Google repository step needs a native `android/` folder [RNFB]. Student commits `mobile/student/android` (protected path), so edits there need owner approval. New Architecture is required from RNFB v26 [RNFB]; the app has `newArchEnabled` true. A development/custom build is needed (not Expo Go); inferred, [RNFB] does not state it | `@sentry/react-native` (Expo SDK 50+), config plugin `@sentry/react-native/expo`, Metro config change, `SENTRY_AUTH_TOKEN` as an EAS environment variable for source-map upload [SENTRY-EXPO] | none |
| Protected paths touched | `app.json` plugins, likely `android/` Gradle files, `google-services.json` (owner-held) | `app.json` plugins, `metro.config.js`, EAS env | none |
| Readable stack traces | needs deobfuscation/mapping upload; effort UNVERIFIED (Hermes JS stack for RN errors needs source maps either way) | source maps upload built into the plugin for native builds [SENTRY-EXPO] | n/a |
| Control over data | `setCrashlyticsCollectionEnabled(false)` persists; can default off until consent via `firebase.json` [RNFB] | `sendDefaultPii` off by default; with it on, events include IP, cookies, user info [SENTRY-EXPO]; breadcrumbs/screenshot defaults not verified here (UNVERIFIED) | n/a |
| Effort (estimate, not measured) | 1.5 to 3 days incl. native config, a test crash, a release build, and the device check | 1 to 2 days incl. EAS token and source maps | 0 |

## 2. Play Data safety implications [PLAY-DS]

- Data sent off the device by SDKs counts as the app's collection even when a third party receives it. Crash logs are "App info and performance: Crash log data"; diagnostics too. Pseudonymous identifiers do not remove the need to disclose.
- Transfers to a service provider that processes data on the developer's behalf generally do not count as "sharing"; an SDK vendor that builds advertising profiles across customers would. Crashlytics and Sentry as error-reporting processors normally fit the service-provider description, but the vendor's data-processing terms are UNVERIFIED here and are the owner's call.
- Today's draft (`Google_Play_Internal_Testing.md` section 4) answers "Crash logs / diagnostics" as an OWNER INPUT, defaulting to "No" if no SDK is added. **Adding either SDK changes that answer to Yes (collected, not shared if processed on our behalf), purpose "App functionality/analytics", plus a device identifier (Crashlytics installation ID; Sentry device context).** The privacy policy (`src/app/privacy/page.tsx`) would need a line about crash reports.
- Do not attach user identity: no email, name or user id in crash reports. Keep breadcrumbs off for network URLs (event and order ids) and never log API payloads (they contain names and tickets).

## 3. Recommendation (minimum)

1. **For internal testing (RC6): none.** Rely on Play vitals and the tester script; adding a native SDK touches protected files and changes the Data safety form during the first release, with no tester yet to benefit.
2. **Before the first public/closed-track release: Crashlytics, collection default off until the Data safety answer is final, no user identifiers,** because the Firebase project and `google-services.json` are already an owner dependency for push, the price is listed as no-cost, and it adds one vendor instead of two. Re-check the vendor's current terms when the owner decides.
3. Sentry is the alternative if source-mapped JS errors and release health matter more than keeping one vendor; its free tier is small (5k errors, one user) and needs an account and an EAS token.
4. Independent of vendor: the app-level logging stays free of personal data, and the config reader in `Student_Min_Version_And_Kill_Switch_Design.md` is the first-build item that matters for incident response.

## 4. Owner decisions and what I can do

Owner: choose A, B or C and when; confirm the Firebase release project; approve edits to `app.json`/`android/`; update the Data safety form and privacy policy; supply any vendor account. Engineering: write the integration PR on request after those, run a test crash on a disposable build, decode the artifact for stray keys, and update the Data safety draft. Not done: no vendor facts beyond those keyed above were verified; free-tier limits can change and must be re-read at decision time.
