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
