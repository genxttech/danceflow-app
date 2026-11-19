# DanceFlow Business: device QA on a local Android emulator

The owner approved this plan (2026-11-10): a local **debug development build** on a local emulator. No EAS, no store and no purchases. It uses the shared JDK and Android SDK from `docs/mobile/Local_Android_QA.md`; never install a second SDK. Everything runs through `scripts/device-qa.sh`, which only talks to an emulator (`adb -e`).

Native folders are generated (`expo prebuild`) and git-ignored. The build is `expo run:android --variant debug` with `expo-dev-client`, so it loads JavaScript from Metro on this machine.

## Prerequisites (and who unblocks them)

| Need | State |
| --- | --- |
| Shared JDK + Android SDK, paths in `docs/mobile/Local_Android_QA.md` | The Student session is installing them (#438) |
| Windows Hypervisor Platform turned on, emulator running | Owner action; the APPS coordinator says when |
| `danceflow-business://auth/callback` on the **DEV** Supabase redirect allow list (exact match) | Coordinator, DEV only |
| A DEV staff test account whose sign-in emails can be read, for the DEV PKCE check | Not yet named (see below) |

## Build

```bash
export JAVA_HOME=...      # from docs/mobile/Local_Android_QA.md
export ANDROID_HOME=...
cd mobile/business
bash scripts/device-qa.sh check
bash scripts/device-qa.sh build   # first build takes a while; later ones are incremental
```

Point `.env` at the target first. For DEV checks, use the DEV Supabase URL and anon key plus the DEV web origin. For the fully local variant below, use the iso-qa `--auth` stack. On the emulator, the host machine is `10.0.2.2`, not `127.0.0.1`.

## Checks

Each check records a screenshot (`bash scripts/device-qa.sh shot <name>`) and its command output in the QA notes. A check that can't be run is marked **BLOCKED**, never passed.

1. **SecureStore session persistence**
   - Sign in. Run `storage`: it must find no plaintext `access_token` / `refresh_token` anywhere in the app's storage, and it lists the SecureStore entries.
   - Run `restart` and confirm the app opens on Today, not sign-in.
   - Sign out, then run `storage` again: no session entries remain.
2. **Deep link `danceflow-business://auth/callback` (PKCE)**
   - In the app, tap "Email me a sign-in link". The app stores the PKCE verifier.
   - Open the email link. GoTrue redirects to `danceflow-business://auth/callback?code=…`, and Android routes it to the app. If the link is opened on the host, pass the redirect to `deeplink '<url>'` instead.
   - The app exchanges the code and lands on Today.
   - Negative check: a link with a made-up `code` must not sign in, and raw `access_token` / `refresh_token` parameters must be ignored (this is already unit-tested in `authLink`).
3. **OS text size**
   - Run `textsize 2.0`, then screenshot every screen: sign-in, Today (list, empty, error), appointment detail (lesson and class), Clients, the client screen, More with the confirmation, and the tab bar.
   - Pass means no clipped or overlapping text, and every control still reachable. Finish with `textsize 1.0`.
4. **Reduce Motion**
   - Run `motion on`, relaunch, and run `motion-log`: it must show `reduceMotion=true`. Opening an appointment must fade, not slide.
   - Run `motion off` and confirm `reduceMotion=false` and the slide is back. Finish with `reset`.

## DEV vs fully local

- **DEV** (approval item 2): checks the real `danceflow-business://` redirect against DEV GoTrue once the allow-list entry exists. It needs a DEV staff account whose mailbox QA can read, because a PKCE link only works with the verifier the app itself stored. An admin-generated link can't stand in for it.
- **Local:** use the iso-qa `--auth` stack (#449) with `ISO_QA_AUTH_REDIRECTS` including `danceflow-business://**`. Mailpit catches the link, `/verify` returns the `danceflow-business://` redirect, and `deeplink` hands it to the app. This proves the same native path with no hosted access.

## One-command smoke

`scripts/device-smoke.js` repeats the device checks of R4 and R5 (`DEVICE_QA_RESULTS.md`) with no hand-driven session. It is for the disposable local setup only: it never touches a hosted database and never changes the shipping flag defaults (the QA APK it builds has `pulse` and `studioSchedule` on; that build is not for upload).

```bash
cd mobile/business
node scripts/device-smoke.js --dry-run                                  # print the plan, touch nothing
node scripts/device-smoke.js --apk C:/path/business-qa-flags.apk --keys-from C:/path/earlier-run/stack.json   # reuse a QA APK built by an earlier run
node scripts/device-smoke.js --build-dir C:/dfq                         # build the APK too (Gradle, about 15 minutes)
```

`--build-dir` is a short-path worktree of this repo at the commit under test (Windows' 260-character limit breaks the native build in a long worktree path, see `docs/mobile/Local_Android_QA.md`). Other options: `--memory <MB>` (emulator RAM for this boot only, default 2048; the AVD config is not edited), `--out <dir>` (default `./device-smoke-out`), `--stack-name`, `--web-port` (default 3107), `--avd` (default `df-api35`), `--keep-emulator`, `--allow-busy`.

What one run does, in order:

1. **Preflight.** It refuses to start while an emulator is running or Java/Gradle processes exist, because the emulator and Gradle are shared with the Student session (`--allow-busy` only when you know the machine is yours). It also needs docker.
2. **Stack and data.** An `iso-qa --auth` stack, the roster-names migration, the fictional seed, and a QA password on the two seeded users through GoTrue's admin API.
3. **Web.** A production `next build` and `next start` (not `next dev`).
4. **APK, emulator, install.** Builds or reuses the QA APK, boots the emulator if none runs (and remembers that it did), records the font scale and night mode.
5. **Checks** (each asserts on the screen's text through `uiautomator` and keeps a screenshot named after the check): owner in light and dark at 1.0 and at 2.0 from a cold start (Today switch and Pulse tab, Studio view with the instructor on each row, Pulse numbers), a live font change, the empty day, a 403 after the role is demoted mid-session and its recovery through "Refresh studios", a 401 after the session is ended and the button back to sign-in, and the instructor view (no switch, "Your day", no client count).
6. **Teardown, always** (also after a failure): restores the font scale and night mode, uninstalls the app, stops the web server, removes the stack, and stops the emulator only if this run started it.

Output: `summary.json`, the screenshots and `stack.json` in the output folder; the exit code is 0 only if every check passed. A check that needs a screen the run could not reach fails with the label it was waiting for; nothing is marked passed by default.

Status (2026-11-15): **VERIFIED end to end: run 6 passed 18 of 18** on the Android 15 emulator (`DEVICE_QA_RESULTS.md`, R6). Six runs were needed, and every failure before the last was the script, not the app:

1. `gradlew.bat` was started by bare name (fixed in #553: absolute path, quoted memory argument).
2. Stopped on purpose, to give the emulator to another session.
3. The script drove the emulator right after `sys.boot_completed`, before Android had settled. It now waits for the activity and package services and dismisses "isn't responding" dialogs.
4. `adb input text` dropped characters and left "owe" in the email field. The script now types in chunks and reads the field back until it matches.
5. 13 of 18: a card below the fold at 2.0 is not in the `uiautomator` dump (the script now scrolls), and it tapped the "Sign in again" heading instead of the button (it now prefers the clickable node).
6. 18 of 18.
7. (2026-11-16, after #589) Failed at sign-in: the app was no longer in the foreground (the launcher was showing, "no Email field"), and no log was kept, so the cause (crash, low-memory kill, or the emulator restarting the launcher) is **unconfirmed**. The script now checks that the app is the top activity before each wait and each typing attempt: the first loss saves the logcat and relaunches once, a second loss fails the run with `logcat-lost-foreground-*.txt`.

8. (2026-11-16, #593/#594 logging, APK of run 7, `--memory 3072`) Failed again, before any check: the app left the foreground twice. The evidence says **emulator/system, not the app**: the app's ApplicationExitInfo is `reason=6 (ANR)`, "Input dispatching timed out (Application does not have a focused window)"; just before, right after the cold boot, `com.android.systemui` had an ANR and then "crashed too many times" with `system_server` lock contention; no low-memory kill, empty crash log. Evidence: `C:\dfr-out\qa-smoke8`. The result for the candidate commit is **UNVERIFIED pending a clean run**. The script now (a) builds and starts the web before the emulator boots (it already did: the CPU is idle at boot), (b) waits, after boot and before every cold relaunch, for a 30 s quiet window with the launcher resumed and no system UI crash or ANR in logcat, and (c) on the first foreground loss does a cold relaunch (force-stop, wait for a quiet system UI, start). Boot flags (`-no-snapshot`, `-gpu swiftshader_indirect`) are unchanged: no measurement shows a snapshot or another GPU mode helps, so they were not changed.
9. (2026-11-16, main 4039d8da, `--memory 3072`) Failed, but a different and smaller way: the system UI stayed quiet (no ANR this time) and the app did start, yet two script bugs ended the run before sign-in: the foreground check ran about 5 s after the launch and called a still-starting app lost, and the cold relaunch after it used up the 30 s the wait had been given (the dump at 6 s after the relaunch still had empty text; the screenshot taken seconds later shows the sign-in screen). Fixed: a 20 s grace period before a loss is declared, and a relaunch restarts the wait's own deadline. Evidence: `C:\dfr-out\qa-smoke9`. Still **UNVERIFIED** until a clean run.
10. (2026-11-16, main 2fb55c0a, `--memory 3072`) Failed: "no Email field". The app was ANR-killed again at the start ("Application does not have a focused window", the same signature as run 8, while the system UI was still settling: two unstable windows were logged), the guard did the cold relaunch, and then `typeInto` read the tree 8 s after the start with no wait, found no field and threw, although `fatal.png` shows the sign-in screen rendered. A third script bug, fixed: `typeInto` now waits up to 30 s for the field. Evidence: `C:\dfr-out\qa-smoke10`. The ANR kill at app start has now been seen in runs 8 and 10 and not in 6, 7 (no cause kept) or 9: it is emulator-side, and the app recovers on a cold relaunch. Still **UNVERIFIED** until a clean run.
11. (2026-11-16, main aa7f0921, `--memory 3072`) Failed: "the sign-in was refused three times". The ANR-at-start recurred (cold relaunch recovered it) and the typed email and 10-dot password were correct (`fatal.png`). Cause, a harness defect that was latent since the `--apk` reuse was written: the APK carries the anon key of the stack that built it (run 7's), signed with that stack's random JWT secret; run 11's fresh stack has a different secret, so the API refuses the key and the app shows its generic "did not match" message. Runs 8 to 10 never got as far as the sign-in, and run 6 built its APK in the same run. Fix: `--keys-from`; `--apk` without it is refused. Evidence: `C:\dfr-out\qa-smoke11`. Still **UNVERIFIED** until a clean run.
12. (2026-11-16, main ca7ffc1e with #605, `--keys-from`, `--memory 3072`) Failed: sign-in "refused" three times. The key fix held (same secret, same URL, the old anon key verifies under the new secret, still valid) and no ANR this time, but the app's log shows `TypeError: Network request failed` at the sign-in: the phone could not reach the stack at 10.0.2.2. Emulator-side networking is the suspect (unproven: the stack was torn down, and the first two attempts had left the 600-line log window). The app showed "did not match" for it, which is an app defect fixed separately (an unreachable server now says so). **Decision: device runs stopped after run 12.** Evidence for the Business app stays run 6 (18 of 18 on a clean build) plus the harness and audit tests; the candidate commit is UNVERIFIED on a device. Before any later attempt: an emulator-side reachability probe of the stack before the app is launched, and a larger log window. Evidence: `C:\dfr-out\qa-smoke12`.

On any fatal failure the run keeps `fatal.png`, `fatal.xml` and the crash and recent main logcat (`logcat-fatal-*.txt`, `exit-info-*.txt`: the app's ApplicationExitInfo, which tells a low-memory kill from a crash). Reusing an APK with `--apk` needs the same port **and the same keys**: the APK holds the anon key signed with the build stack's random JWT secret, and a fresh stack has another, so sign-in is refused with "email and password did not match" (run 11; the earlier text here said only the port mattered, which was wrong). Pass `--keys-from <stack.json of the run that built the APK>`: the new stack then reuses that secret (iso-qa `ISO_QA_JWT_SECRET`, opt-in). The anon key in the APK expires 7 days after the build. Otherwise use `--build-dir`.

Lessons for the next device script: wait for the system to settle, not for `boot_completed`; verify typed text by reading it back; the dump holds only what is on screen; a heading and its button can share the same words.

## Accessibility-tree audit (TalkBack)

Ported from the Student app (`mobile/student/scripts/qa-smoke/a11y-audit.mjs`, `docs/mobile/Student_TalkBack_Audit.md`), same rules so the two reports read alike. TalkBack walks the `uiautomator` tree: it speaks a node's own content-desc and ignores its children, otherwise it merges the descendants' text, so a clickable node with no text or content-desc anywhere inside it is announced as just "button".

```bash
cd mobile/business
node scripts/device-smoke.js --apk <QA APK> --a11y --out <dir>      # the smoke, also saving the tree of every check, plus sign-in, class roster, client and More
node scripts/a11y-audit.js <dir>                                    # writes a11y-report.md and a11y-report.json, exit 1 if any control is unlabelled
```

What it reports per screen: **unlabelled** controls (fails the audit), **small** targets under 44dp (reported; a row cut off at the screen edge is not counted), and **stutter** (the same words twice in a row in the reading order); then the reading order itself, interactive items in `[brackets]`.

What is guarded without a device: `src/__tests__/a11yTreeAudit.test.ts` (the audit rules on fixture trees) and `src/__tests__/readingOrder.test.tsx` (the order a screen reader walks sign-in, Today, the studio view, Pulse, the class roster, the client and More, plus an error state, from the rendered tree; with the existing `a11y.test.tsx` audit of roles, names, states and touch targets). Status: the audit CLI was dry-run on two real `uiautomator` dumps kept from the smoke runs (the sign-in screen, empty and after a refused sign-in; now fixtures in `src/__tests__/fixtures/`): 0 unlabelled controls, 0 targets under 44dp, a sensible reading order. The `--a11y` capture mode of the smoke (which saves the other screens) has **not been run on a device yet** (the emulator was not free); run it once and record the report in `DEVICE_QA_RESULTS.md`.

## Reachability check and log window (not yet run on a device)

After the emulator boots, the script asks the emulator itself (toybox `nc`, a plain GET) whether `10.0.2.2:<stack port>/auth/v1/health` and `10.0.2.2:<web port>/` answer. If not, the run stops with a named `emulator reaches the ...` FAIL instead of a misleading sign-in failure (run 12). Failure logs now keep the last 3000 main-log lines (was 600). Both are covered by `deviceSmokeLib.test.ts` for the pure parts; the `nc` probe itself has not run on an emulator, so treat its first device use as unverified.

## Stale baked configuration (found 2026-11-17, runs 7-17)

Every harness-built APK since the R5 build carried the **same older stack's** `EXPO_PUBLIC_SUPABASE_URL` (`http://10.0.2.2:56601`) and anon key (minted 2026-11-15 08:42Z) instead of the current stack's (port 56600, new key). Read from the APK without a device: the Hermes string table of `assets/index.android.bundle` (the helper `hermesStrings` in `device-smoke-lib.js`). Cause: the build sets `CI=1`, which makes Expo skip its automatic Metro cache reset, and Metro's cache (the OS temp dir) kept the inlined values of the first build. The app then failed to reach a port nothing listens on ("Can't reach DanceFlow"); runs 11 and 12 were this, not a refused password or a flaky network. Fixes in the script: the build runs with a private `TEMP` (cold Metro cache), and **before the emulator is touched** the APK's baked URL, web URL and anon key are checked against this run's stack (`APK carries this run's stack URL, web URL and anon key`). An APK that disagrees fails the run in seconds. The RC3 build in `qa-rc3` carries `qa-placeholder.invalid` and can never be smoked. The logcat kept on failure now drops the `AccessibilityNodeInfoDumper` lines our own uiautomator dumps cause.

## Run 19 (2026-11-17, main 14f441dfd, unminified QA release APK): 22 of 22 PASS

APK built fresh with `--build-dir C:/dfq` (private TEMP, smoke 18; its baked-config check then failed on a harness bug, GNU `tar` read `C:` as a host, fixed to Windows `tar.exe`), then smoke 19 ran the same APK with `--apk` and `--keys-from`. All of: APK carries this run's stack URL, web URL and anon key (the key is accepted when signed with the stack's secret); emulator Wi-Fi up; stack API and web app reachable from the emulator; owner light 1.0, dark 1.0, dark 2.0 cold, light 2.0 cold (3 checks each); live font change; empty day; 403 and recovery; 401 and re-sign-in; instructor. Evidence `C:\dfr-out\qa-smoke19` (summary.json, stack/seed), APK `C:\dfr-out\qa-smoke18\business-qa-flags.apk`. This closes the runs 7-17 series: they drove an APK with a stale baked config. Not covered by this run: R8 (minified) build, TalkBack, the `--a11y` pass, iOS (no macOS), real devices.

## System UI ANR diagnostics and host memory (2026-11-19)

Ported from the Student smoke (PR 671). When "System UI isn't responding" appears, the harness first saves `systemui-anr-N-diag.txt` (load average, meminfo, `top`, ApplicationExitInfo of `com.android.systemui`, ActivityManager warnings) and only then taps Wait; the count is added to `summary.json` as a passing record that names the dismissal, never hidden. It also writes `host-memory-before-boot.txt`, `host-memory-after-settle.txt` and `host-memory-end.txt` (free RAM and the biggest process groups) so an ANR can be classified as environmental (host starved) or harness-fixable. The boot settle (`waitSettled`, `waitSystemUiStable`) already existed here.
