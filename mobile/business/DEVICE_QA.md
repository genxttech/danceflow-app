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

Status (2026-11-15): **VERIFIED end to end: run 6 passed 18 of 18** on the Android 15 emulator (`DEVICE_QA_RESULTS.md`, R6). Six runs were needed, and every failure before the last was the script, not the app:

1. `gradlew.bat` was started by bare name (fixed in #553: absolute path, quoted memory argument).
2. Stopped on purpose, to give the emulator to another session.
3. The script drove the emulator right after `sys.boot_completed`, before Android had settled. It now waits for the activity and package services and dismisses "isn't responding" dialogs.
4. `adb input text` dropped characters and left "owe" in the email field. The script now types in chunks and reads the field back until it matches.
5. 13 of 18: a card below the fold at 2.0 is not in the `uiautomator` dump (the script now scrolls), and it tapped the "Sign in again" heading instead of the button (it now prefers the clickable node).
6. 18 of 18.

On any fatal failure the run keeps `fatal.png` and `fatal.xml`. Reusing an APK with `--apk` only works if the new stack gets the same port, because the port is baked into the APK; otherwise use `--build-dir`.

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
