# Android release audit (Student and Business)

Audit date 2026-11-14, against `main` at `ca32fa6e` plus the release-prep branch `claude/android-release-prep-3af2cd`. Scope: configuration, signing and local release builds. **Nothing was uploaded, published or built in EAS cloud; no production credentials were created.** Companion documents: `Android_Push_Firebase_Setup.md`, `Google_Play_Internal_Testing.md`, `Local_Android_QA.md`.

## 1. Verified build results (local, QA-signed, not for upload)

Built with `gradlew bundleRelease --no-daemon` from the short path `C:\dfr\r` (a git worktree), Expo SDK 54.0.37, React Native 0.81.5, Gradle 8.14.3, JDK 17, build-tools 36.0.0, all four ABIs. Signed with a **throwaway QA keystore generated outside the repo** (`C:\dfr-qa\qa-only-DO-NOT-UPLOAD.keystore`, CN `DanceFlow QA ONLY DO NOT UPLOAD`, 365 days, never committed, never to be reused). Outputs are outside the repo in `C:\dfr-out\`.

| | Student | Business |
|---|---|---|
| AAB | `C:\dfr-out\student-release-qa-signed.aab` (99,103,690 B ≈ 94.5 MiB) | `C:\dfr-out\business-release-qa-signed.aab` (64,424,031 B ≈ 61.4 MiB) |
| Package | `com.idanceflow.student` | `com.idanceflow.business` |
| versionCode / versionName | 1 / 0.1.0 | 1 / 0.1.0 |
| minSdk / targetSdk / compileSdk | 24 / 36 / 36 | 24 / 36 / 36 |
| `debuggable` | not present (false) | not present (false) |
| Signer (jarsigner / apksigner) | `CN=DanceFlow QA ONLY DO NOT UPLOAD`; SHA-256 `93:F4:E4:5E:1B:B7:4F:C9:31:F4:D8:F7:C9:4A:CE:0B:AC:BA:F7:D4:7F:5E:32:A8:86:DD:BD:9D:0A:D8:F0:99`; SHA-1 `39:6D:68:0B:76:A5:A5:E3:16:0A:62:FF:D8:75:AA:69:AD:90:CA:A7` | same QA key |
| Debug-signed? | **No** (the debug key is `5E:8F:16:06:…` SHA-1; not the signer) | **No** |
| ABIs | arm64-v8a, armeabi-v7a, x86, x86_64 | same |
| JS | Hermes bytecode (`c61fbc03` magic in `index.android.bundle`) | same |
| Universal APK from the AAB (bundletool 1.18.3, checksum-verified) | 146,888,762 B | 97,454,146 B |
| Bundletool `validate` | passes | n/a (installable) |

Caveats: (a) the first Student AAB was built **before** the Firebase DEV file arrived, so it contains the **placeholder** `google-services.json` (fake project; push cannot work). A second Student build with the real DEV file is covered in `Android_Push_Firebase_Setup.md`. (b) Both bundles were built with placeholder `EXPO_PUBLIC_SUPABASE_URL=https://qa-placeholder.invalid`, so they start and show sign-in but cannot sign in. The production/EAS `production` environment supplies the real values. (c) Build timing on this shared PC: Student 1 h 38 m (first attempt died on an AAPT2 timeout under load), Business 46 m.

## 2. Google Play target API requirement

Google Play Console Help, "Target API level requirements for Google Play apps" (https://support.google.com/googleplay/android-developer/answer/11926878), read 2026-11-14: from **31 August 2026** new apps and app updates for phones and tablets must target **Android 16 (API level 36) or higher**; an extension to **1 November 2026** could be requested; existing apps must target API 35+ to stay visible to newer-OS users. Both apps target **36**, so they meet the requirement. (Wear/Auto/TV have other levels; not relevant.) 16 KB page-size support was not covered by that page; see the item below.

## 3. Audit table

| Item | Student | Business | Verdict |
|---|---|---|---|
| minSdk / targetSdk / compileSdk | 24 / 36 / 36 (SDK 54 defaults) | same | OK |
| 64-bit ABIs | arm64-v8a and x86_64 present with the 32-bit ones | same | OK. Play requires 64-bit if native code exists. |
| 16 KB page size | Not verified. RN 0.81 / NDK 27 produce 16 KB-compatible `.so` by default, but third-party prebuilt libs (e.g. Stripe, mlkit barcode `libbarhopper_v3.so`, pdfium) were not individually checked | RN libs only | **Follow-up:** run `bundletool`/`zipalign -c -P 16` on the arm64 libs before production; Play enforces 16 KB for new submissions targeting 35+ on Android 15+ devices. |
| versionCode strategy | `app.json` `versionCode 1`, committed `android/app/build.gradle` `versionCode 1`; `eas.json` `appVersionSource: remote` + production `autoIncrement` | `app.json` `versionCode 1`; `eas.json` same strategy (new) | EAS remote auto-increment is the source of truth for EAS builds. For local builds bump by hand (Play rejects reused codes). With a committed `android/` the EAS increment is applied to `build.gradle` during the build. |
| Release signing | **Fixed in this branch:** was `signingConfigs.debug`; now env/`keystore.properties` upload key, fails loudly if absent | **Fixed:** same, via config plugin on generated android project | OK after fix; see section 4. Verified: Student release without credentials is refused. |
| Permissions (merged manifest, Student) | declared by us: `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `POST_NOTIFICATIONS`, `INTERNET`, `VIBRATE`. Library-added: `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `RECEIVE_BOOT_COMPLETED`, `USE_BIOMETRIC`, `USE_FINGERPRINT`, `com.google.android.c2dm.permission.RECEIVE`, `DOWNLOAD_WITHOUT_NOTIFICATION`, play-install-referrer, app-icon badge permissions for launchers | Business: `INTERNET`, `VIBRATE`, `USE_BIOMETRIC`, `USE_FINGERPRINT`, `ACCESS_NETWORK_STATE`, app-private dynamic receiver permission | Removed because unused: `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW` (was in the main manifest, would ship to release), `READ/WRITE_EXTERNAL_STORAGE`, and `CAMERA` (the picker is library-only; no `launchCameraAsync` anywhere). Justifications in `Google_Play_Internal_Testing.md` §9. Biometric permissions come from `expo-secure-store` and are harmless. |
| `allowBackup` | was `true`; now `false` (session data lives in SecureStore; Auto Backup would restore tokens to another device) | `false` | Fixed. |
| Cleartext traffic | release manifest does not set `usesCleartextTraffic`; with targetSdk ≥ 28 the default is **off**. Only `src/debug/AndroidManifest.xml` sets it (debug builds, for Metro) | not set | OK. Consequence for QA: a release build cannot talk to the local HTTP QA stack. |
| Exported components | 9 `exported=true` in the merged manifest: `MainActivity` (launcher + `danceflow://` VIEW), `FullscreenPlayerActivity` (expo-video), Stripe redirect/launcher activities, `CropImageActivity`, `LocationTaskService`, `FirebaseInstanceIdReceiver`, `ProfileInstallReceiver`, compose `PreviewActivity` | `MainActivity` and library defaults | Expected library exports. `androidx.compose.ui.tooling.PreviewActivity` is a Compose tooling activity pulled in by a library; harmless but Play's pre-launch report may flag it. |
| Deep links | custom schemes only: `danceflow://`, `exp+danceflow-student://` (Student); `danceflow-business://`, `exp+danceflow-business://` (Business). **No `https` intent filter, no `autoVerify`, no `assetlinks.json`** | same | OK for magic links today (they come back through the web bridge to the custom scheme). The app already refuses raw tokens in links (`authLink.ts`). If App Links are wanted later, host `/.well-known/assetlinks.json` with the Play App Signing SHA-256. |
| R8 / shrink | `android.enableMinifyInReleaseBuilds` unset = **false**, `shrinkResources` false | same | Works; larger APK/AAB (94 MiB, mostly 4 ABIs × native libs). **P2 follow-up:** enable R8 with a QA pass (reanimated/Stripe keep rules already partly in `proguard-rules.pro`); Play delivers per-ABI splits so installs are smaller than the AAB. |
| Hermes | on (`hermesEnabled=true`) | on (default) | OK |
| New Architecture | on (`newArchEnabled=true`, `app.json`) | on | OK (SDK 54 requires it anyway). |
| Edge-to-edge | enabled | enabled | OK for targetSdk 36 (mandatory). |
| `expo-dev-client` in release | included (production AAB contains the dev launcher classes but no dev menu is shown in release, see QA) | included | Acceptable per Expo; remove from the production config when convenient to shrink the surface. |
| App name / icons | `DanceFlow`; icon, adaptive foreground + monochrome, notification icon, splash all present | `DanceFlow Business`; **no icon, adaptive icon, splash or notification asset exists in `mobile/business`** (default Expo icon ships) | **Business needs a store-ready icon (owner/design input).** Student OK. |
| Expo SDK compatibility | SDK 54.0.37; `expo install --check`: "Dependencies are up to date" | same | OK |
| Updates | `expo-updates` ON, URL `https://u.expo.dev/122aaca5-…`, `runtimeVersion 1.0.0`, check on launch ALWAYS | no `expo-updates`; no EAS project | OK. Business needs `eas init` before EAS builds. |
| Placeholder Firebase file | `android/app/google-services.json` is gitignored; Student release builds now refuse the placeholder (or a missing/wrong-package file) | n/a (no Firebase until push lands) | Fixed. See Firebase doc. |
| Orientation | portrait locked | portrait | OK |

## 4. Signing: how the Play upload key will be produced

**Recommendation: Play App Signing with an owner-generated upload key, kept as a local keystore.**

- Play App Signing is mandatory for new apps on AAB: Google holds the key that signs what users install; you sign each upload with a separate **upload key**. If the upload key is lost or leaked, Google support can reset it; the app signing key stays safe. That makes the upload key the right thing to keep locally.
- **Local keystore (recommended first release):** the owner creates it once, stores it and its passwords in a password manager plus an offline backup, and builds with `gradlew bundleRelease` (or any build path) using the env vars below. Free, no cloud build minutes, works for both apps.
- **EAS-managed credentials:** `eas credentials` can generate and store the upload keystore for you, which removes the "lost laptop" risk but ties builds to EAS Build (paid beyond the free tier) and needs a second step to download a backup. If the owner later moves to EAS Build, upload the **same** local keystore (`eas credentials` → Android → production → Keystore → set up with an existing keystore) so only one upload key ever exists.
- Never reuse the QA key. Never commit a keystore or its passwords (`.gitignore` now blocks `*.keystore`, `*.jks`, `keystore.properties`, `*.aab`).

**What the owner must do (once per app, or one shared upload key for both):**

1. On the PC with the JDK, run (replace the alias; it will prompt for passwords; choose strong ones):
   ```bash
   keytool -genkeypair -v -keystore "%USERPROFILE%\df-credentials\danceflow-upload.keystore" -alias danceflow-upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   Use a different keystore/alias per app if you want separate upload keys; a single key for both is allowed by Play.
2. Back it up (password manager attachment and an offline copy). Do not put it in the repo, Downloads or chat.
3. Build: set `DANCEFLOW_UPLOAD_STORE_FILE`, `DANCEFLOW_UPLOAD_STORE_PASSWORD`, `DANCEFLOW_UPLOAD_KEY_ALIAS`, `DANCEFLOW_UPLOAD_KEY_PASSWORD` in the shell (or an untracked `android/keystore.properties` with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`) and run `gradlew bundleRelease` in `mobile/student/android` (Business: after `npm run prebuild:android`, in `mobile/business/android`). Real `EXPO_PUBLIC_*` values and the real `google-services.json` are needed in that shell.
4. Upload the `.aab` as described in `Google_Play_Internal_Testing.md`; on the first upload accept Play App Signing.

Verified here: with the QA key supplied through those variables the AAB signs (section 1). With the variables unset, `gradlew :app:bundleRelease` fails with `Release signing is not configured (task :app:packageReleaseResources)…` and builds nothing debug-signed. With credentials but a placeholder `google-services.json` it fails with `android/app/google-services.json is the QA placeholder; release needs the real Firebase file.` (both runs 2026-11-14).

### EAS cloud builds and the signing guard

The local-signing guard stands down when `EAS_BUILD=true` (EAS cloud sets it), because an EAS production build injects its own signing credentials and never sets `DANCEFLOW_UPLOAD_*`; EAS fails by itself if it has none. Gradle-level proof (2026-11-14, `:app:bundleRelease --dry-run`, no upload variables set): with `EAS_BUILD=true` the guard does **not** throw (BUILD SUCCESSFUL); with `EAS_BUILD=false` it throws `Release signing is not configured`. **UNVERIFIED:** an actual EAS cloud build was not run (not authorized), so that EAS injects credentials into this committed `android/` project and that the `eas-build-post-install` Firebase hook runs as intended are untested. The Firebase placeholder guard still applies on EAS: production needs the real `GOOGLE_SERVICES_JSON` file variable.

## 5. Findings handed to other owners

1. **Student, `src/lib/pushNotifications.ts`:** no Android notification channel is created and the server sends no `channelId`; add a `default` channel before requesting permission (details in the Firebase doc).
2. **Business icon assets** are missing (design input).
3. **Release R8/16 KB checks** are follow-ups (P2).
4. **Web account deletion page:** `/account` requires sign-in; Play needs a public URL (see Play doc §3).

## 6. Release-build QA matrix (shared emulator df-api35, API 35, Google APIs image)

Installed the bundletool universal APK built from each AAB (Student: the second build, with the real DEV Firebase file and CAMERA removed; Business: the AAB above), signed by the QA key. Evidence screenshots are outside the repo in `C:\dfr-out\qa`. The emulator was overloaded (system ANR dialogs such as "System UI isn't responding", unrelated to the apps), which limited the interactive checks. Before installing, the older **debug** builds of both packages had to be uninstalled (signature mismatch), which cleared their local data; they can be reinstalled from their own builds.

| ID | Check | Student | Business | Notes |
|---|---|---|---|---|
| S-1 | Release refuses debug signing / missing credentials | PASS | PASS (same generated script; only Student's negative run was executed) | Section 4. |
| S-2 | Release refuses placeholder / wrong-package `google-services.json` | PASS (Gradle + CLI) | PASS (CLI + `app.config.js` check) | CLI: real file ok for both packages; wrong package, placeholder and missing all rejected. |
| A-1 | Installs from universal APK | PASS | PASS | |
| A-2 | Not debuggable, no backup flag | PASS | PASS | `dumpsys package` flags `HAS_CODE ALLOW_CLEAR_USER_DATA` only; the old debug installs showed `DEBUGGABLE ... ALLOW_BACKUP`. |
| A-3 | Cold start to first screen | PASS | PASS | Student "Find your next dance moment"; Business "Sign in to your studio". No `AndroidRuntime` crash. |
| A-4 | No debug menu or dev client UI | PASS | PASS | None on cold start. Shake and menu gestures were not exercised. |
| A-5 | No cleartext configuration | PASS (manifest) | PASS (manifest) | `usesCleartextTraffic` absent in release manifests, targetSdk 36. A runtime http attempt was not run. |
| A-6 | Sign-in against the local iso-qa `--auth` stack | **BLOCKED** | **BLOCKED** | The stack is HTTP and release builds forbid cleartext; no escape hatch was added to release code. The builds also use a placeholder Supabase URL. Needs a QA-only variant with a network-security exception (not built). |
| A-7 | Secrets scan of APK | PASS | PASS | No `service_role`, `sk_live`, `sk_test`, `BEGIN PRIVATE KEY`, `SUPABASE_SERVICE`, JWT-shaped strings or `AIza` keys; `app.config` has no secret/password/api_key. Only the placeholder QA URL string is in the JS bundle. |
| A-8 | Deep link / magic-link return | PARTIAL: app handles `danceflow://auth/callback?code=...` without crashing; code redemption **BLOCKED** (no backend) | PARTIAL: same for `danceflow-business://` | Redemption needs A-6. |
| A-9 | Font scale 1.0 | PASS | PASS | |
| A-10 | Font scale 2.0 | **FAIL** | **FAIL** | Student sign-in clips: eyebrow "DANCEF", heading cut after "dance", paragraphs and "Send secure link" truncated, "or" divider cut. Business sign-in clips: eyebrow, field labels, both button labels and the helper text. Needs layout fixes in each app's `src` (not changed here). Related earlier Business finding: `docs/mobile/screenshots/business-shell/device/e3-before-fix-200pct-clipped.png`. |
| A-11 | Dark mode | PASS (follows system, legible) | n/a (`userInterfaceStyle: light`; another session is changing that) | |
| A-12 | Push registration and delivery with the real DEV Firebase file | **BLOCKED** | n/a (no push yet) | Needs sign-in and the owner's FCM v1 key upload to Expo. |
| A-13 | 16 KB page-size alignment of native libs | **BLOCKED** (not run) | **BLOCKED** | Follow-up. |
| A-14 | R8/minified release build | **BLOCKED** (not enabled) | **BLOCKED** | Follow-up. |

Other verification: Business `tsc --noEmit` clean and 159 jest tests pass (in `C:\dfr\r`); `expo install --check` clean for both apps; CI job "Mobile apps typecheck and tests" runs on PR #513.

## 7. Release-candidate re-run on current main (2026-11-14)

Tree: PR branch merged with `origin/main` at `e60925aa` (includes #514 Business icons, #515 Student scrolling sign-in and notification channel, #516 `/account-deletion`, #518 cold-start magic-link fix, #519, #520 Business text-size rebuild), merge commit `68997e94`, plus this branch's commits for Business icon wiring and the EAS guard. Student AAB built at `68997e94`; Business AAB built after `expo prebuild` from the branch with the icon wiring. Both built locally, one Gradle build at a time, QA-only key, outputs outside the repo.

| | Student | Business |
|---|---|---|
| AAB | `C:\dfr-out\student-rc.aab`, 99,107,156 B | `C:\dfr-out\business-rc.aab`, 64,696,924 B |
| versionCode / versionName | 1 / 0.1.0 | 1 / 0.1.0 |
| targetSdk | 36 | 36 |
| Universal APK (bundletool) | 146,888,762 B | 97,743,017 B |
| Signer | QA key, SHA-256 `93:F4:E4:5E:...:F0:99` | same |
| debuggable | no (`dumpsys` flags `HAS_CODE ALLOW_CLEAR_USER_DATA`) | no |
| Icon | brand icon, adaptive + monochrome | brand icon wired (`application-icon` is the adaptive `ic_launcher.xml`) |
| Permissions | location (coarse/fine), `POST_NOTIFICATIONS`, `INTERNET`, `VIBRATE` + library ones; no `CAMERA`, `RECORD_AUDIO`, storage or overlay | `INTERNET`, `VIBRATE`, `POST_NOTIFICATIONS` + library ones (expo-notifications); no `CAMERA` etc. |
| Firebase file in build | real DEV file (`danceflow-mobile-dev`), package check passed | none (no `google-services.json` yet; push registration lands separately) |

### Re-run matrix (emulator df-api35, API 35, cold-booted; Google Messages disabled to stop its ANR dialog, re-enabled afterwards). Screenshots: `C:\dfr-out\qa2\`

| ID | Check | Student | Business | Notes |
|---|---|---|---|---|
| R-1 | Cold start to sign-in, no dev UI, not debuggable | PASS | PASS | Clean screen, no ANR dialog in the evidence. Includes the #518 magic-link cold-start fix path (A-8). |
| R-2 | Font scale 1.0 | PASS | PASS | |
| R-3 | Font scale 2.0, **cold start** at 2.0 | PASS (all sign-in text legible, `s3c-font2-coldstart.png`) | PASS (`b2c-font2-coldstart.png`) | Replaces earlier FAIL A-10, which was taken by changing the font size while the app was already running. |
| R-3b | Font size changed while the app is running | **FAIL** (Student sign-in still clips until the app restarts, same screen as A-10) | not re-run (#520 targets this) | Student needs the same "rebuild on text-size change" fix as #520. |
| R-4 | Dark mode | PASS | n/a (light-only) | |
| R-5 | Deep link reaches handler | PASS (`danceflow://auth/callback?code=bogus` → "Sign in needs another try") | PASS (`danceflow-business://...` → "This sign-in link didn't work") | |
| R-6 | Sign-in with release build against local iso-qa `--auth` stack | PASS (QA-only variant, see below): magic link requested in-app, mail read from Mailpit, GoTrue verify redirect replayed as `danceflow://auth/callback?code=...` PKCE exchange `200`, Settings shows `ida.instructor@example.test` | PASS for auth: password sign-in `POST /auth/v1/token?grant_type=password` `200`; the screen after that is "Temporarily unavailable" because `/api/staff/me` needs the web app, which was not run | The Next.js web API (`/api/student/*`, `/api/staff/*`) was not started, so Today shows loading skeletons and Business stops after auth. Student first launch after sign-in then loaded Today ("Your dancer account is ready"). |
| R-7 | Firebase wiring in release build | PASS: `FirebaseApp initialization successful` in logcat; package-id guard and placeholder guard exercised | n/a | |
| R-8 | Notification channel on device | PASS: `NotificationChannel{mId='default', mName=DanceFlow, mImportance=3}` after the in-app permission prompt (`dumpsys notification`) | n/a | #515's channel is created. |
| R-9 | Push permission prompt | PASS: system "Allow DanceFlow to send you notifications?" appears from the master switch | n/a | One wording issue: before the first prompt the card says "Push notifications are blocked in your device settings." and the notification card renders blank (large empty white area) after "could not be set up" (`s13-allowed.png`). UI finding for the Student session. |
| R-10 | Push token registration reaches the server | PASS: `claim_mobile_push_token` called; first call `404` because the local baseline schema lacked migration `20270213080000` (applied to the disposable stack only), then `204`; row `mobile_push_tokens(platform=android, app_slug=danceflow-student, enabled)` holds a real `ExponentPushToken[...]` obtained through FCM with the DEV Firebase file | n/a | |
| R-11 | Push delivery through Expo | **PASS**: `POST https://exp.host/--/api/v2/push/send` returned `ok`, receipt `ok`, and a notification titled "DanceFlow DEV test" was posted on the device (`dumpsys notification`, channel `default`) | n/a | **This shows an FCM v1 credential is already configured in Expo for the Student project.** The earlier assumption that the key upload was still pending is wrong or has since been done. |
| R-12 | Partner profile photo picker on API 35 | PASS: opens the system photo picker with no permission prompt (`p2-picker.png`); CAMERA and storage permissions are not declared | n/a | Choosing a photo and the upload were not run (no images on the emulator; web API not running): **BLOCKED**. Android 12 and older: **UNTESTED** (no AVD). |
| R-13 | No cleartext in the shipping builds | PASS (manifest) | PASS (manifest) | See "QA-only HTTP variant". |
| R-14 | EAS guard: no upload variables | PASS (`EAS_BUILD=true` does not throw, `false` throws; Gradle `--dry-run`) | same script | Section 4. EAS cloud itself UNVERIFIED. |
| R-15 | 16 KB alignment, R8 | **BLOCKED** (not run) | **BLOCKED** | Follow-ups. |
| R-16 | Android 12 and older | **UNTESTED** | **UNTESTED** | No AVD. |

### QA-only HTTP variant (never shipping)

The shipping builds above are untouched. For R-6 to R-11 a second build of each app was made in the throwaway worktree `C:\dfr\r` only, with `android:usesCleartextTraffic="true"` added to the generated/committed manifest by hand (not committed; the Student manifest edit was reverted with `git checkout`), and `EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:<port>` plus the disposable stack's demo anon key baked into the bundle. Artifacts: `C:\dfr-out\student-qa-http.aab`, `C:\dfr-out\business-qa-http.aab` (QA key; never to be uploaded). Note for repeat runs: the Business bundle first picked up a **stale Metro cache** (the old placeholder URL stayed inlined); building with `TEMP`/`TMP` pointing at an empty folder fixed it.

### Emulator and stack state
The disposable iso-qa stack (`relqa`) was torn down, the QA apps uninstalled, font scale reset to 1.0 and the emulator shut down. Existing debug builds of both packages that were on the AVD had to be uninstalled (signature mismatch).

## 8. Release candidate 2 from main `157f0098` (2026-11-15)

Built locally from `C:\dfr\r` at main `157f0098` (includes #533 Student `fontScale` in `configChanges`), QA-only key, one Gradle build at a time, outputs outside the repo.

| | Student | Business |
|---|---|---|
| AAB | `C:\dfr-out\student-rc2.aab`, 99,112,922 B | `C:\dfr-out\business-rc2.aab`, 64,765,796 B |
| versionCode / versionName | 1 / 0.1.0 | 1 / 0.1.0 |
| targetSdk | 36 | 36 |
| Universal APK | 146,905,146 B | 97,890,473 B |
| Signer | QA key, SHA-256 `93:F4:E4:5E:...:F0:99` (not the debug key) | same |
| debuggable | absent (false) | absent (false) |
| `usesCleartextTraffic` | absent | absent |
| 16 KB: `zipalign -c -P 16 4` | exit 0 | exit 0 |
| 16 KB: ELF `PT_LOAD` `p_align` of every `arm64-v8a` and `x86_64` library | 46 libraries checked, 0 below 16384 | 36 libraries checked, 0 below 16384 |

16 KB alignment is therefore **PASS** for both apps on these builds (stored libraries are 16 KB aligned in the APK and every 64-bit library's segments are 16 KB aligned).

Lesson recorded for repeat builds: the first Business RC2 build still carried the QA-only `usesCleartextTraffic="true"` because `expo prebuild` without `--clean` keeps an edited manifest; it was caught by the manifest check, the project was regenerated with `prebuild --clean`, and the build repeated. Shipping Business builds must always follow a `--clean` prebuild (see `Android_Release_QA_Runbook.md`).

### Device smokes on RC2 (QA-only HTTP variants, emulator df-api35, API 35)

| Check | Result | Evidence |
|---|---|---|
| Student signed-in smoke (`mobile/student/scripts/qa-smoke/run.mjs`, QA release APK from `157f0098`): magic-link sign-in, `settings`, `payment-requests`, `wallet` at font 1.0 and 2.0, light and dark | **PASS 13/13** | `C:\dfr-out\qa-rc2\student-smoke\results.json` |
| Business smoke (`mobile/business/scripts/device-smoke.js`) | **UNVERIFIED, pending re-run**: failed at "expected on screen: Today" (sign-in answered "did not match"). Business's analysis of `fatal.xml` points to a dropped shift keystroke on the capital letter of the generated QA password (`adb input text` under load), i.e. a harness failure, not an app defect. A second finding from inspecting the run's APK (`business-qa-flags.apk`, built in-run by `node mobile/business/scripts/device-smoke.js --build-dir C:/dfr/r --out C:/dfr-out/qa-rc2/business-smoke`, no `--apk`): its JavaScript bundle holds `http://10.0.2.2:56601` and a JWT whose header/payload and signature do not match this run's stack (`127.0.0.1:56600`, a different anon key), so the APK was built from a **stale Metro cache** (the script does not give the build an empty `TEMP`, and `%TEMP%` is shared between sessions); that alone makes sign-in answer "did not match". Both causes are harness issues; the fix is Business #589 (lowercase+digits QA password, retry on refusal). The Business session re-runs it (run 12 with `--keys-from`, which also covers the separate defect that a reused QA APK bakes the anon key of the stack that built it, Business #605) (rebased onto #589) | `C:\dfr-out\qa-rc2\business-smoke\` |
| R-3b: font size changed while the Student app is running (post-#533) | **UNVERIFIED on device**: the smoke applies 2.0 before the app starts; the live-change case was not re-shot on RC2 | - |
| Android 12 and older | **UNTESTED**: no API 31/32 AVD; the system image is a download of roughly 1 GB, not fetched | - |

### R8 / minified release (Student): attempted twice, UNVERIFIED

Config: `bundleRelease --no-daemon -Pandroid.enableMinifyInReleaseBuilds=true -Pandroid.enableShrinkResourcesInReleaseBuilds=true -Dorg.gradle.jvmargs="-Xmx3g -XX:MaxMetaspaceSize=768m"`, QA keystore, empty `TEMP`.

1. **Attempt 1 failed in 9 min** at `:app:minifyReleaseWithR8` with *Missing classes detected*: `com.stripe.android.pushProvisioning.*` (5 classes referenced by `@stripe/stripe-react-native`; Stripe push provisioning is optional and not used). Fix, committed on this branch: `-dontwarn com.stripe.android.pushProvisioning.**` in `mobile/student/android/app/proguard-rules.pro`. This is the only R8 finding so far; R8 got past the missing-class check once the classes were declared optional, but no minified build has completed.
2. **Attempt 2 did not complete.** After the rule was added, the build re-ran native CMake configure and compile for four ABIs and stalled in that phase for about 8 hours with roughly 4 GB RAM in use on a PC that other sessions were also using (free RAM about 2.3 GB); the coordinator stopped it. Cause not established (memory starvation is the likely one). No minified AAB or APK exists, so **size and runtime breakage are UNVERIFIED**; this is neither a pass nor an app failure.

To retry: ask for a Gradle/RAM slot, run only after the native outputs are warm (same commit, no checkout in between), cap at 45 minutes with `--no-daemon` and an explicit `-Xmx`, then run the Student smoke with `ORG_GRADLE_PROJECT_android.enableMinifyInReleaseBuilds=true` and `ORG_GRADLE_PROJECT_android.enableShrinkResourcesInReleaseBuilds=true`. Until then Play delivers per-ABI splits, so the 94 MiB AAB overstates install size.

Runbook for repeating all of this: `Android_Release_QA_Runbook.md`.

## 9. Release candidate 3 from main `c47e3ae17` (2026-11-17)

Built locally from `C:\dfr\r` at main `c47e3ae17` (#622; includes Student #611-#622, Business #608/#610, #605, the iOS config PRs and #618), QA-only key, one Gradle build at a time, nothing uploaded, no production credentials. Outputs in `C:\dfr-out\rc3\`. Main had moved to `31f096789` by the time the smokes ran; the later commits (#623-#626) touch four Student wallet/event screens, tests and docs only, so the AABs below are one small step behind main.

| | Student | Business |
|---|---|---|
| AAB | `student-rc3.aab`, 99,116,570 B | `business-rc3.aab`, 64,766,173 B |
| versionCode / versionName | 1 / 0.1.0 (`app.json`) | 1 / 0.1.0 (`app.json`) |
| targetSdk / compileSdk | 36 / 36 | 36 / 36 |
| Universal APK | 146,905,146 B | 97,890,473 B |
| Signer | QA key SHA-256 `93:F4:E4:5E:...:F0:99` (not the debug key) | same |
| `debuggable` / `usesCleartextTraffic` | absent / absent | absent / absent |
| `allowBackup` | false | false |
| 16 KB: `zipalign -c -P 16 4` | exit 0 | exit 0 |
| 16 KB: ELF `PT_LOAD` `p_align` | 46 libraries, 0 below 16384 | 36 libraries, 0 below 16384 |
| Release signing guard | stands (fails without `DANCEFLOW_UPLOAD_*` unless `EAS_BUILD=true`); unchanged in this range, negative test not re-run | same (config plugin) |
| Permissions in the built APK | location (coarse/fine), `POST_NOTIFICATIONS`, plus library permissions (INTERNET, VIBRATE, WAKE_LOCK, RECEIVE_BOOT_COMPLETED, USE_BIOMETRIC/USE_FINGERPRINT, network and wifi state, FCM `c2dm.RECEIVE`, launcher badge permissions). `CAMERA`, `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, external storage are absent. The new `expo-image-picker` plugin adds none. | INTERNET, VIBRATE, RECEIVE_BOOT_COMPLETED, `POST_NOTIFICATIONS`, network state, WAKE_LOCK, USE_BIOMETRIC/USE_FINGERPRINT, `READ_APP_BADGE`; the blocked ones are absent |

Lockfiles did not change since RC2. The `app.json` changes since RC2 are the iOS icon (both apps) and the Student `expo-secure-store`, `expo-location` and `expo-image-picker` plugin options (iOS strings; no Android manifest effect).

### RC3 results

| Check | Result | Evidence |
|---|---|---|
| Student release AAB build | **PASSED** (11 m 35 s) | `C:\dfr\rc3-student.log` |
| Business release AAB build | **PASSED** | `C:\dfr\rc3-business.log` |
| Manifest, SDK, signer, 16 KB (both) | **PASSED** (table above) | `C:\dfr-out\rc3\` |
| Student signed-in smoke on the unminified QA variant (df-api35, API 35): magic-link sign-in, settings, payment-requests, wallet, font 1.0 and 2.0, light and dark | **PASSED 13/13** | `C:\dfr-out\qa-rc3\student-smoke2\` |
| Student R8 build (`-Pandroid.enableMinifyInReleaseBuilds=true -Pandroid.enableShrinkResourcesInReleaseBuilds=true`) | **PASSED to build** in 10 m 7 s; AAB 91,178,013 B (7.9 MB smaller than unminified) | `C:\dfr\rc3-r8-student.log`, `C:\dfr-out\rc3\student-rc3-r8.aab` |
| Student smoke on the "R8 QA variant" | **CORRECTED 2026-11-18: this was NOT an R8 result.** The harness passes its own Gradle arguments and the `ORG_GRADLE_PROJECT_android.*` variables I meant to force R8 with were never set (bash cannot `export` names containing dots), so those APKs were unminified: no `:app:minifyReleaseWithR8` in their `gradle.log`. The dark-mode blank screens (2 of 13, then 6 of 13) were therefore an unminified-build flake of unknown cause. See section 10 for the real forced-R8 run. | `C:\dfr-out\qa-rc3\student-smoke-r8\`, `student-smoke-r8b\` |
| Business device smoke | **UNVERIFIED (corrected 2026-11-17)**. Run 1 failed in the harness (`next build` needs the full repo `node_modules`). Run 2 ("Can't reach DanceFlow"): the QA APK baked the **placeholder** `https://qa-placeholder.invalid`, not the stack URL, because a Metro cache in the shared `TEMP` replayed the shipping build's inlined values (see baked-config decode below). Run 3 ("no HTTP answer from inside the emulator"): the same stale APK, and the reachability probe itself was defective (`nc` half-close made Kong drop the request; the emulator Wi-Fi address appears ~25 s after boot), fixed on main in #631/#633. This is a harness result, not an app result, and not proof of a network problem. Needs a re-run on current main with a private `TEMP` (Business PR 634 adds a baked-config check). | `C:\dfr-out\qa-rc3\business-smoke\`, `business-smoke2\`, `business-smoke3\` |
| Student smoke harness on current main | iso-qa refuses scenario `main` on `origin/main` because #620 added `20270219090000_twilio_price_request_sweep.sql`, which `scripts/qa/scenarios.json` does not list. Worked around with the supported `ISO_QA_REF_MAIN=c47e3ae17`; the real fix is a manifest entry (not mine). | `C:\dfr-out\qa-rc3\student-smoke.log` |
| R-3b: live font-size change on the Student release build | **UNVERIFIED on device** (not re-shot) | - |
| Android 12 and older | **UNTESTED** (no API 31/32 AVD) | - |
| EAS cloud build behaviour | **UNVERIFIED** (no cloud build run) | - |

Recommendation: the first Play release should be the **unminified** AAB (the one smoked 13/13). Do not ship R8 until the dark-mode blank screen is diagnosed (logcat of the minified QA build, then a keep rule or a night-mode fix).


### Baked `EXPO_PUBLIC_*` values in the RC3 artifacts (decoded 2026-11-17, no device)

Method: `base/assets/index.android.bundle` (Hermes bytecode, magic `1f1903c1`) taken from each AAB/APK and scanned for its string table content (URLs, JWT-shaped strings with the payload decoded for `role`/`iss` only, `service_role`, Stripe `sk_`/`pk_`/`whsec_`, private-key markers). The `EXPO_PUBLIC_*` names do not appear (values are inlined at bundle time).

| Artifact | Baked Supabase URL / anon key | Verdict |
|---|---|---|
| `rc3/student-rc3.aab` (the unminified shipping candidate) | `https://qa-placeholder.invalid` / `qa-placeholder-anon`; web URL `https://idanceflow.com`; no JWT-shaped string; no `10.0.2.2`, `56600`/`56601`, `service_role`, Stripe secret or publishable key, `whsec_` or private key. Only library strings mention `localhost`/`127.0.0.1`. | CLEAN, as intended for a QA-signed candidate (real values are supplied by the production EAS environment). Cannot talk to any backend. |
| `rc3/business-rc3.aab` | same placeholders, same absences | CLEAN |
| `rc3/student-rc3-r8.aab` | **`http://10.0.2.2:56600`, mock web `http://10.0.2.2:8791` and an anon JWT (`role=anon`, `iss=supabase`) from a disposable stack**; no placeholder | **CONTAMINATED, not a release candidate.** Built after the smokes with the shared `TEMP=C:\dfr\tmp3`; Metro replayed the inlined values of the Student smoke's QA build. No secret (the key is the anon key of a throwaway local stack), but never upload it. |
| `qa-rc3/business-smoke2` and `business-smoke3` `business-qa-flags.apk` | placeholder `https://qa-placeholder.invalid`, no stack URL, no JWT | **WRONG for a smoke**: the QA APK did not point at the stack. Explains the Business run 2 failure. |
| Student smoke APKs (13/13 and the two R8 runs) | not retained (build output overwritten); not decoded | Functionally evidenced only: magic-link sign-in succeeded against that run's stack, which a wrong URL or anon key could not do. Baked values **UNVERIFIED** by decode. |

Effect on the RC3 claims above: the build, manifest, 16 KB and Student 13/13 results stand (the shipping AABs are decoded clean; the 13/13 run authenticated against its stack). The R8 **build** result stands but the archived R8 AAB must not be used, and the R8 dark-mode smoke failure stays as recorded (baked config not decoded for those APKs; sign-in worked, so the config was functional). The Business smoke is UNVERIFIED, not an environment finding.

### Why the real release path cannot inherit a stale cache

The stale-value risk is specific to **local Gradle/Metro builds** that reuse `%TEMP%\metro-cache` (the harness sets `CI=1`, which makes `@expo/cli` skip the Metro cache reset). An EAS cloud build runs on a fresh build VM per job, with no cache carried over from this PC, and takes `EXPO_PUBLIC_*` from the build profile's environment variables (`environment: production` in `eas.json`). So a cloud production build cannot replay a local cache. That is an inference from how EAS builds work, not something verified here (no cloud build was run). A **local** release build for upload must use a private empty `TEMP`/`TMP` per build and delete `app/build/generated/assets/createBundleReleaseJsAndAssets`, and in all cases the final artifact is decoded before upload (Runbook step 1b).

## 10. Release candidate 4 from main `20e5bacdb` (2026-11-17/18)

Built locally from `C:\dfr\r` at main `20e5bacdb` (#646; RC3 plus Student #611-#614, #621, #626, #641-#646 and Business #624/#625/#631/#633/#634/#636), QA-only key, one Gradle build at a time, a separate empty `TEMP` per build (never shared), `CI` unset, nothing uploaded, no production credentials. Outputs in `C:\dfr-out\rc4\`; smoke evidence in `C:\dfr-out\qa-rc4\`.

| | Student | Business | Student R8 |
|---|---|---|---|
| AAB | `student-rc4.aab`, 99,116,689 B | `business-rc4.aab`, 64,766,173 B | `student-rc4-r8.aab`, 91,178,169 B |
| versionCode / versionName / targetSdk | 1 / 0.1.0 / 36 | 1 / 0.1.0 / 36 | (R8 build of the Student app) |
| Signer | QA key SHA-256 `93:F4:E4:5E:...:F0:99` | same | same |
| debuggable / cleartext / allowBackup | absent / absent / false | absent / absent / false | not re-inspected |
| Blocked permissions (CAMERA, RECORD_AUDIO, SYSTEM_ALERT_WINDOW, external storage) | absent | absent | not re-inspected |
| 16 KB `zipalign -c -P 16 4` / ELF `p_align` | exit 0 / 46 libs, 0 below 16384 | exit 0 / 36 libs, 0 below | not re-checked |
| `:app:minifyReleaseWithR8` in the Gradle log | no (not requested) | no | **yes** (`C:\dfr\rc4-r8-student.log`, 8 m 7 s) |
| **Baked `EXPO_PUBLIC_*` (decoded from the final artifact, Hermes bundle)** | `https://qa-placeholder.invalid`, `qa-placeholder-anon`, `https://idanceflow.com`; 0 JWT-shaped strings; no `10.0.2.2`, `56600`/`56601`, `service_role`, `sk_`/`pk_`/`whsec_`, private key | same | same (0 JWT, placeholders only) |

Signing guard (release builds fail without `DANCEFLOW_UPLOAD_*` unless `EAS_BUILD=true`): unchanged in this range; negative test not re-run.

### RC4 device results (df-api35, API 35, disposable iso-qa stacks, one at a time)

| Check | Result | Evidence |
|---|---|---|
| Business smoke (`device-smoke.js --build-dir`, with the #634 baked-config check, private `TEMP`) | **PASSED 22/22** (owner and instructor paths, light/dark, font 1.0/2.0, 401 session end) | `qa-rc4\business-smoke` |
| Student smoke, unminified QA variant | **PASSED 13/13 on the third attempt.** Attempt 1 was refused by the one-stack guard (another session's `colq2` stack was up; not bypassed). Attempt 2 failed at sign-in ("Sign in needs another try / We could not reach DanceFlow"); its QA APK was decoded and bakes the right stack URL `10.0.2.2:56600` and one anon JWT, so it was not stale config. Attempt 3 passed. One transient connection failure at sign-in, cause not proven (the Student harness has no wait for the post-boot Wi-Fi address that #631 added for Business). | `qa-rc4\student-smoke2` (failure, with the APK `student-smoke2-qa.apk`), `student-smoke3` (pass) |
| Student smoke with R8 forced (`env "ORG_GRADLE_PROJECT_android.enableMinifyInReleaseBuilds=true" ...`) | **PASSED 13/13**, and its Gradle log shows `:app:minifyReleaseWithR8` | `qa-rc4\student-smoke-r8` |
| Student R8 AAB build | **PASSED** (8 m 7 s, 91.2 MB vs 99.1 MB unminified) | `rc4\student-rc4-r8.aab` |
| R-3b live font-size change; Android 12 and older; EAS cloud build | **UNVERIFIED / UNTESTED** (unchanged) | - |

Correction to RC3: the RC3 R8 *build* ran R8 (its Gradle log has the task) but its AAB was contaminated by a shared-`TEMP` Metro cache (section 9); the RC3 "R8 smoke" was unminified and its failures are not R8 evidence. RC4 supersedes both: R8 builds and passes the Student smoke.
## 11. Release candidate 5 from main `8535bedc2` (2026-11-18)

Built from `C:\dfr\r` at main `8535bedc2` (Student wallet reads the dancer views, #649; the commit title still says "DRAFT, DO NOT MERGE before the SQL views are applied on PROD", which the coordinator reports as now satisfied: Gate 1 applied on PROD). QA-only key, one Gradle build at a time, a private empty `TEMP` per build, `CI` unset, nothing uploaded, no production credentials. Outputs in `C:\dfr-out\rc5\`, smoke evidence in `C:\dfr-out\qa-rc5\`. Main has moved on since (#665 at the time of this PR); no mobile build input changed between `20e5bacdb` and `8535bedc2` (lockfiles, `app.json`, `android/`, plugins, `package.json` identical).

| | Student | Business |
|---|---|---|
| AAB | `student-rc5.aab`, 99,116,880 B, SHA-256 `1d1ad9550a5bde681499044f9cdea91867028b9bb866262eaac40780246283b5` | `business-rc5.aab`, 64,766,173 B, SHA-256 `db03e882a80de2cc73e9d6110f3e133adf08a2b138e7dd0a710240a3016f0a5d` |
| versionCode / versionName / targetSdk | 1 / 0.1.0 / 36 | 1 / 0.1.0 / 36 |
| Signer | QA key SHA-256 `93:F4:E4:5E:...:F0:99` (not the debug key) | same |
| debuggable / cleartext / allowBackup | absent / absent / false | absent / absent / false |
| Blocked permissions (CAMERA, RECORD_AUDIO, SYSTEM_ALERT_WINDOW, external storage) | absent | absent |
| 16 KB `zipalign -c -P 16 4` / ELF `p_align` | exit 0 / 46 libs, 0 below 16384 | exit 0 / 36 libs, 0 below |
| **Baked `EXPO_PUBLIC_*` decoded from the final AAB** | `https://qa-placeholder.invalid`, placeholder anon key, `https://idanceflow.com`; 0 JWT-shaped strings; no `10.0.2.2`, `56600`/`56601`, `service_role`, `sk_`/`pk_`/`whsec_`, private key | same | 

Build, manifest, SDK, 16 KB and baked-config checks: **PASSED** for both. Signing guard: unchanged; negative test not re-run.

### RC5 device smokes: BLOCKED (emulator System UI ANR), not an app result

The three smokes were run once each on harness-booted emulators (Student 13/13 matrix, Student `--events` with the dancer views from main refs, Business). All three were derailed by the same emulator fault, not by the app:

| Smoke | Result | Evidence |
|---|---|---|
| Student 13/13 matrix | **BLOCKED**: preflights PASS (APK carries this run's stack and mock-web URLs, emulator Wi-Fi address, emulator reaches the stack API and the mock web API), then sign-in did not complete because the screen shows Android's "System UI isn't responding" dialog (`sign-in-failed.xml`), 4 of 6 steps passed | `qa-rc5\student-smoke` |
| Student `--events` (wallet reading the views) | **BLOCKED**: same System UI ANR dialog at sign-in, 4 of 6 steps passed. The events and views assertions were never reached. | `qa-rc5\student-events` |
| Business smoke | **BLOCKED**: preflights PASS (APK stack/web URL and anon key, Wi-Fi, stack API, web app); the run failed with "no Email field" while the harness logged "system UI still unstable". | `qa-rc5\business-smoke` |

A re-run on an emulator I booted myself and pre-warmed (Google Messages disabled, as in RC2) was refused by the harnesses ("An emulator is already running", needs `--force` / `--allow-busy`). Adding those flags was not allowed in this session, so it was not run; the emulator was shut down and Google Messages re-enabled. The Student wallet-reads-the-views check on a stack with the views applied is therefore **UNVERIFIED for RC5**. Whoever owns the device slot should re-run the three smokes (Student matrix, `--events`, Business) on RC5 or on the same commit, ideally after a longer emulator settle time or with an approved `--force` on a pre-warmed emulator. For RC4 (`20e5bacdb`, section 10) the same three smokes passed, so there is no evidence of an app regression, only no RC5 device evidence.

Not re-run this round: R8 (RC4's R8 AAB and forced-R8 Student smoke stand for `20e5bacdb`), R-3b live font change, Android 12 and older, EAS cloud build: **UNVERIFIED / UNTESTED**.

Owner queue unchanged (Play upload keystore and Play App Signing; Firebase release project and key rotation; `eas init` for Business and `GOOGLE_SERVICES_JSON`; account-deletion page and privacy URL timing, A7; Data safety inputs, rating and listing; approve the first internal-testing build and upload by hand). Before any upload, decode the baked `EXPO_PUBLIC_*` values from the actual release artifact and compare with the production environment (Runbook step 1b).
