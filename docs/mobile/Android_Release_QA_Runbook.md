# Android release-candidate QA runbook (local, QA-signed, never uploaded)

What the android-release session runs, in order, on the shared PC. Everything here is disposable: a throwaway QA keystore outside the repo, a local iso-qa stack, the shared emulator. Nothing touches a hosted database, Play, EAS cloud or production credentials.

## Preconditions (checked before each step)

- No `df-isoqa-*` container (`docker ps`), no `java.exe`, no emulator: this PC is shared and the Student smoke refuses to start otherwise. A watcher polls every 30 s and starts only after three consecutive clear checks.
- One Gradle build at a time, `--no-daemon`, never `gradlew --stop`; build from the short real path `C:\dfr\r` (a git worktree at the commit under test).
- Free RAM above about 2.5 GB; abort and report otherwise.

## 1. Build the shipping release candidates (no cleartext, no QA flags)

```bash
cd C:\dfr\r\mobile\student\android   # real DEV google-services.json copied in (gitignored)
gradlew bundleRelease --no-daemon    # env: DANCEFLOW_UPLOAD_* pointing at the QA keystore
cd C:\dfr\r\mobile\business && npx expo prebuild --platform android --clean --no-install
cd android && gradlew bundleRelease --no-daemon
```

Use an empty `TEMP`/`TMP` per build (Metro caches inlined `EXPO_PUBLIC_*` values), and delete `app/build/generated/assets/createBundleReleaseJsAndAssets` first. After a QA variant, regenerate the Business project with `prebuild --clean` so a QA-only cleartext edit cannot leak into the next shipping build (a non-clean prebuild keeps edited files). Record: commit, versionCode/versionName, AAB size, universal APK size (`bundletool build-apks --mode=universal`), signer fingerprint (`apksigner verify --print-certs`), `debuggable` absent and `usesCleartextTraffic` absent (`aapt2 dump xmltree --file AndroidManifest.xml`).

## 2. 16 KB page size

On the universal APK: `zipalign -c -P 16 4 <apk>` must return 0 (stored libraries 16 KB aligned), and every `PT_LOAD` segment of every `lib/arm64-v8a` and `lib/x86_64` `.so` must have `p_align >= 16384` (a small ELF reader; run on all libraries).

## 3. Device smokes on QA-only HTTP variants (the shipping manifest is never edited in the repo)

```bash
node mobile/student/scripts/qa-smoke/run.mjs --build-dir C:\dfr\r --ref <commit> --out C:\dfr-out\qa-rc2\student-smoke
node mobile/business/scripts/device-smoke.js --build-dir C:\dfr\r --out C:\dfr-out\qa-rc2\business-smoke
```

Each script starts its own iso-qa stack, builds a QA release APK with cleartext allowed and the stack's URL baked in, drives the emulator, and tears everything down (stack, app, font scale, night mode, emulator if it started it). The Student run covers magic-link sign-in and `settings`, `payment-requests`, `wallet` at font 1.0 and 2.0, light and dark. The Business run covers owner sign-in, Today, Pulse, Studio view, 1.0 and 2.0, light and dark. **R-3b** (font size changed while the app is running) is checked by hand on the Student release build: sign in, `adb shell settings put system font_scale 2.0` with the app open, and screenshot the sign-in/Today screen without restarting.

## 4. R8 / minified release

Build with `-Pandroid.enableMinifyInReleaseBuilds=true -Pandroid.enableShrinkResourcesInReleaseBuilds=true`, compare AAB and APK size with the unminified build, then rerun the Student smoke with `ORG_GRADLE_PROJECT_android.enableMinifyInReleaseBuilds=true` and `ORG_GRADLE_PROJECT_android.enableShrinkResourcesInReleaseBuilds=true` in the environment and report breakage.

## 5. Android 12 and older

Needs an API 31/32 system image (a roughly 1 GB class download through the SDK manager). Without it the check stays UNTESTED; no AVD exists today.

## Release the machine

Stop the emulator, remove the stack, confirm no `df-isoqa-*` container and no `java.exe` remain, restore the font scale, and tell the other sessions.
