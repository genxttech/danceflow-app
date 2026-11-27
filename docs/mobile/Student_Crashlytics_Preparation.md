# Student app: Crashlytics preparation (owner decision H9)

2026-11-26. **Preparation only. Nothing is installed, configured or collected.** H9: "Prefer Crashlytics for wider-release crash reporting, subject to privacy and data-safety review. Prepare implementation without activating additional production collection yet." Options and sources: `Student_Crash_Reporting_Options.md`. Scope: Student, Android first.

## 1. Why there is no code PR yet

Every step that makes Crashlytics exist in a build touches owner-protected files (`mobile/student/package.json`, `package-lock.json`, `app.json`, `eas.json`; the native `android/` files are committed and release-relevant). JavaScript that calls the SDK cannot compile or be tested without the dependency, and an empty wrapper with no caller would add nothing. So this is the exact change list for one owner-approved PR.

## 2. Change list

| # | File | Change | Protected |
|---|---|---|---|
| 1 | `mobile/student/package.json`, lockfile | add `@react-native-firebase/app` and `@react-native-firebase/crashlytics` with `npx expo install` (versions UNVERIFIED here: resolve and record them at implementation; check their support for Expo 54 / React Native 0.81 and the New Architecture) | yes |
| 2 | `mobile/student/firebase.json` (new) | `{ "react-native": { "crashlytics_auto_collection_enabled": false, "crashlytics_debug_enabled": false, "crashlytics_javascript_exception_handler_chaining_enabled": true } }` (key names to be confirmed against the installed version's documentation) | no, but part of the same PR |
| 3 | `mobile/student/android/app/src/main/AndroidManifest.xml` | `<meta-data android:name="firebase_crashlytics_collection_enabled" android:value="false" />` so native collection is off even if the JS setting is lost | yes (release-relevant) |
| 4 | `mobile/student/android/build.gradle` and `android/app/build.gradle` | add the Crashlytics Gradle plugin classpath and `apply plugin` next to the existing `com.google.gms:google-services` lines; keep the existing release check on `google-services.json` | yes (release-relevant) |
| 5 | `mobile/student/app.json` | add the Crashlytics config plugin to `plugins`, so a clean prebuild (the release script runs one) keeps 3 and 4 | yes |
| 6 | `mobile/student/src/lib/crashReporting.ts` (new) | one module, the only importer of the SDK: `recordError(error)` that does nothing unless collection was enabled for the build; no `setUserId`, no attributes, no custom logs, no network breadcrumbs | no |
| 7 | Tests | the module records nothing with collection off; no other file imports the SDK; a source scan that no user id, email or name is passed | no |

**Order matters:** a clean prebuild regenerates `android/`, so 3 and 4 must come from the config plugin (5) or be re-applied; verify on the built artifact, not on the source tree.

## 3. Collection stays off

Off in three places (2, 3 and no call to `setCrashlyticsCollectionEnabled(true)`). Turning it on is a later, separate owner-approved change, after the Data safety answer and the privacy policy line are final. Note that adding the SDK may still change Play's data-safety answers (installation identifiers) even with crash collection off: **UNVERIFIED, owner/privacy review** before any upload of a build containing it.

## 4. Data safety and privacy drafts (do not submit)

- Data safety, if collection is ever enabled: "Crash logs / diagnostics": collected, not shared when processed on DanceFlow's behalf (vendor terms UNVERIFIED), purpose app functionality and analytics; device or installation identifier.
- Privacy policy sentence (draft for `src/app/privacy/page.tsx`, not applied): "The DanceFlow mobile app may send crash reports, including device model, operating system version, app version and a random installation identifier, to Google Firebase Crashlytics so we can fix failures. Crash reports do not include your name, email address or account identifier."

## 5. Verification for the implementation PR

1. QA-signed release build from the PR (disposable stack, placeholder or dev Firebase file): it builds, smoke passes.
2. Artifact checks: manifest shows collection `false`; no new permission; 16 KB alignment of the new native libraries; no QA or secret strings.
3. With collection off: force a test crash and confirm no upload attempt in logcat; the dev Firebase console stays empty.
4. Only in a disposable build with the **dev** project: enable collection, force one crash, confirm it arrives without user data; then discard that build.
5. Update `Google_Play_Internal_Testing.md` section 4.

## 6. Rollback

Revert the PR (dependency, config and native lines together) and rebuild; with collection off nothing has left any device. A shipped build with collection enabled cannot be switched off remotely by this app today (the update notice of the configuration reader only nudges); turning it off needs a new build.

## 7. Owner inputs still needed

Approval of the protected-file PR; the release Firebase project (H5 asks for a separate production design before wider release); the data-safety and privacy review; when to enable collection.
