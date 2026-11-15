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
node scripts/device-smoke.js --apk C:/path/business-qa-flags.apk        # reuse a QA APK built by an earlier run
node scripts/device-smoke.js --build-dir C:/dfq                         # build the APK too (Gradle, about 15 minutes)
```

`--build-dir` is a short-path worktree of this repo at the commit under test (Windows' 260-character limit breaks the native build in a long worktree path, see `docs/mobile/Local_Android_QA.md`). Other options: `--out <dir>` (default `./device-smoke-out`), `--stack-name`, `--web-port` (default 3107), `--avd` (default `df-api35`), `--keep-emulator`, `--allow-busy`.

What one run does, in order:

1. **Preflight.** It refuses to start while an emulator is running or Java/Gradle processes exist, because the emulator and Gradle are shared with the Student session (`--allow-busy` only when you know the machine is yours). It also needs docker.
2. **Stack and data.** An `iso-qa --auth` stack, the roster-names migration, the fictional seed, and a QA password on the two seeded users through GoTrue's admin API.
3. **Web.** A production `next build` and `next start` (not `next dev`).
4. **APK, emulator, install.** Builds or reuses the QA APK, boots the emulator if none runs (and remembers that it did), records the font scale and night mode.
5. **Checks** (each asserts on the screen's text through `uiautomator` and keeps a screenshot named after the check): owner in light and dark at 1.0 and at 2.0 from a cold start (Today switch and Pulse tab, Studio view with the instructor on each row, Pulse numbers), a live font change, the empty day, a 403 after the role is demoted mid-session and its recovery through "Refresh studios", a 401 after the session is ended and the button back to sign-in, and the instructor view (no switch, "Your day", no client count).
6. **Teardown, always** (also after a failure): restores the font scale and night mode, uninstalls the app, stops the web server, removes the stack, and stops the emulator only if this run started it.

Output: `summary.json`, the screenshots and `stack.json` in the output folder; the exit code is 0 only if every check passed. A check that needs a screen the run could not reach fails with the label it was waiting for; nothing is marked passed by default.

Status (2026-11-15): **UNVERIFIED end to end.** The pure parts (argument handling, the plan, the busy check, the `uiautomator` parsing) are unit-tested in `src/__tests__/deviceSmokeLib.test.ts`. A first full run reached the Gradle step and failed there because `gradlew.bat` was started by bare name (fixed: absolute path, and quoting of the memory argument on Windows); a second run built the web app and the APK and started the emulator, and was then stopped on purpose because another session needed the emulator, so **none of the device checks has been run by this script yet**. The stack, web and Gradle steps are proven; the flows (sign-in, the matrix, teardown after a full pass) are not. Re-run with `--apk <the built APK>` (the stack port is baked into the APK, so it only works if the new stack gets the same port; otherwise rebuild) and record the result in `DEVICE_QA_RESULTS.md`.
