# Local Android QA (Student and Business apps)

A free, local Android toolchain on the engineering PC for development builds and emulator QA. No EAS, no paid services and no store accounts. The owner approved it on 2026-11-10, including Google's Android SDK licence terms.

## Toolchain (shared by both apps)

| Item | Path / version |
|---|---|
| JDK | `C:\Android\jdk-17` (Eclipse Temurin 17.0.21+9, SHA-256 checked against Adoptium) |
| Android SDK root | `C:\Android\sdk` |
| Command-line tools | `C:\Android\sdk\cmdline-tools\latest` (cmdline-tools 23.0, SHA-1 checked against Google's repository index) |
| SDK packages | `platform-tools`, `build-tools;36.0.0`, `platforms;android-36`, `ndk;27.1.12297006`, `cmake;3.22.1`, `emulator`, `system-images;android-35;google_apis;x86_64` |
| Downloads kept | `C:\Android\downloads` |

Environment for any shell that builds or runs the emulator:

```bash
export JAVA_HOME='C:\Android\jdk-17'
export ANDROID_HOME='C:\Android\sdk'
export PATH="/c/Android/jdk-17/bin:/c/Android/sdk/platform-tools:/c/Android/sdk/emulator:$PATH"
```

**Adding packages:** cmdline-tools 23 deprecates `sdkmanager` in favour of the `android` CLI. Use the `.exe` directly with metrics off:

```bash
/c/Android/sdk/cmdline-tools/latest/bin/android.exe --no-metrics --sdk='C:\Android\sdk' sdk install "<package;version>"
```

Don't use `sdkmanager.bat` from Git Bash: Windows batch parsing splits package names at `;`. It also doesn't accept `--no-metrics`, so its first run on 2026-11-10 (licence acceptance plus platform-tools and emulator) ran with the CLI's default metrics.

## Acceleration

`emulator -accel-check` on 2026-11-10 reported "WHPX(10.0.26300) is installed and usable", with Hyper-V enabled. Don't install other hypervisor drivers.

## AVD

| Setting | Value |
|---|---|
| Name | `df-api35` (in `%USERPROFILE%\.android\avd`) |
| Image | `system-images;android-35;google_apis;x86_64` |
| RAM | 2048 MB, 2 cores, 4 GB data partition |
| Snapshots | off (cold boot, `-no-snapshot`) |
| Run | `emulator -avd df-api35 -no-snapshot -no-boot-anim -gpu swiftshader_indirect -memory 2048 -no-audio` |

`avdmanager.bat` hung with no output from Git Bash, so the AVD was written by hand:
- `df-api35.ini`: `path` and `target=android-35`
- `df-api35.avd\config.ini`: `image.sysdir.1=system-images\android-35\google_apis\x86_64\`, `hw.ramSize=2048` and `fastboot.forceColdBoot=yes`

Cold boot takes about 2.5 minutes. RAM is tight on this PC: run one emulator at a time, stop Gradle daemons (`gradlew --stop`) before booting, and shut everything down after a session.

## Building the Student app without EAS

- **`android/app/google-services.json`:** gitignored, and the build's Google Services plugin requires it. For local QA it holds a placeholder with fake values for `com.idanceflow.student`. Push delivery doesn't work with it; that test needs real FCM credentials.
- **Path length:** this worktree's path is too long for the native build. CMake object paths pass Windows' 260-character limit (`Filename longer than 260 characters`). Without changing the system long-path setting, map a drive letter to the **worktree root** with `subst W: C:\Dev\studioapp\.claude\worktrees\<worktree>`, then build from `W:\mobile\student`. Map the root, not `mobile\student`: Expo autolinking won't look for `package.json` at a drive root.
- **`android/local.properties`** (gitignored): `sdk.dir=C:/Android/sdk`, with forward slashes. Backslashes are read as escapes.
- **Build only for the emulator's ABI:**

  ```bash
  cd W:/mobile/student/android && ./gradlew assembleDebug -PreactNativeArchitectures=x86_64 -Dorg.gradle.jvmargs="-Xmx3g -XX:MaxMetaspaceSize=768m"
  ```

  A clean first build took about 21 minutes. The debug APK is 93 MB, x86_64 only.
- **APK:** `mobile/student/android/app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r`.
- **JavaScript:** the debug build loads it from Metro.
  - Start Metro with `GOOGLE_SERVICES_JSON=./android/app/google-services.json` plus the `EXPO_PUBLIC_*` values for the stack under test. Without the first, `app.config.js` can't resolve the file and the dev client shows "There was a problem loading the project".
  - Run `adb reverse tcp:8081 tcp:8081`.
  - Open the app with `adb shell am start -a android.intent.action.VIEW -d "exp+danceflow-student://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`.
  - The first bundle takes about 2.5 minutes, longer than the dev client waits. Warm it by fetching the bundle URL from the host first.
  - `expo start` writes `expo-env.d.ts` (gitignored), which adds react-native-web types to local typechecks.
- **Typing an email with `adb shell input text`:** it drops `@`. Send it as key event 77.
- **Local QA stack:** the emulator reaches the host as `10.0.2.2`, so `EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:<port>`. Debug builds allow plain HTTP. Sign in through the local stack's mail catcher, not DEV: there is no DEV inbox.
