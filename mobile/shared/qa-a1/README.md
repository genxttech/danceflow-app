# A1 device checks (QA only)

`a1-device-checks.js` drives the assistant launcher and sheet on an emulator through adb + uiautomator. Used by:
- Student: `node mobile/student/scripts/qa-smoke/run.mjs --a1 [--features lumiAssistant] --build-dir <tree> --ref <sha> --out <dir>`
- Business: `node mobile/business/scripts/device-smoke.js --a1 [--aria] --build-dir <tree> --out <dir>`

Without the flag word: Part A (flags OFF): no assistant node on any walked screen, cold start x5 (`am start -W`), logcat counts.
With it: Part B (flags ON, stub responder only): launcher visibility and 44dp target, sheet open/expand/close/back/scrim, keyboard, conversation continuity across navigation and user switch, font 2.0 / dark (the app is cold-relaunched after each font or dark change, because a live change leaves the layout half-measured and screenshots show clipped text), tree order and labels.

Anything not asserted is recorded as FAIL with a detail that starts with "BLOCKED:" (TalkBack, a missing second user), never PASS; the result files have no separate BLOCKED status, so a Part B run exits non-zero until those are really walked. Clipping is not detectable from the accessibility tree: review the font-2.0 screenshots by eye.

## TalkBack spike result (2026-11-23): NOT feasible on df-api35 as configured
What works: `settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService` plus `accessibility_enabled 1` binds the service (`dumpsys accessibility` shows it under Bound services). Under MSYS bash set `MSYS_NO_PATHCONV=1` or the value is mangled and silently not written. TalkBack needs `pm grant ... POST_NOTIFICATIONS` and `RECORD_AUDIO` or it opens a permission activity.

Blockers found:
1. The AVD is `google_apis` (no Play Store): Google TTS never initializes. TalkBack logs `TTS is not ready. Attempted to speak before TTS was initialized` for every utterance, and `FeatureDownloader ... Failed to bind to the service` (no Play services for voice data).
2. TalkBack startup is heavy on this 2-CPU host: right after boot the load average hit about 21 and "System UI isn't responding" / "Android Accessibility Suite isn't responding" dialogs appeared; the second one stayed after load fell to 1.6 and tapping Wait did not clear it, and TalkBack restarted ("TalkBack on" logged repeatedly). Input injection and uiautomator still worked, but nothing stable to walk.
3. `uiautomator dump` has no accessibility-focus attribute, so the focus order can only come from TalkBack's own output: either the spoken-text log lines (they are printed even when TTS is not ready) or screenshots of the focus ring. Neither was reached because focus never moved (Alt+Right via `input keycombination 57 22` produced no focus or speech event in the unstable run).

Not tried (next options, in order): a `google_apis_playstore` or newer image with TTS voice data preinstalled and a longer settle/ANR-dismiss wait; a physical device; or replace the spoken walk with an accessibility-tree assertion suite (Espresso AccessibilityChecks / ATF) plus the existing static order and label checks. Until one of these is done the TalkBack requirement stays UNRESOLVED (BLOCKED), not passed. Evidence: `C:\dfr-out\a1-smoke\talkback-spike\` (screenshots, full logcat).

## TalkBack plan (not automated yet)
TalkBack is installed on the df-api35 image but the traversal is not scripted yet. To run it:
1. The df-api35 image has the TalkBack package (talkback.txt in the Part B evidence lists it). Enable with `adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService` and `accessibility_enabled 1`; restore both afterwards.
2. Per app, flags ON: swipe-right traversal from the top of a screen. Record the spoken order (adb logcat `TalkBack` tag or screen-reader captions): the launcher announces "Open <name> assistant, button" plus its hint.
3. Open the sheet: focus must move into the sheet (accessibilityViewIsModal) and the background must not be reachable; order title, Helping with, Expand, Clear, Close, thread, composer, Send; Retry and link chips announced as buttons/links.
4. Close: focus returns to the launcher or the screen, not lost.
5. Evidence: caption log + screenshots; anything not walked is BLOCKED.

## Keyboard-top measurement

`imeTopFromDumpsys` reads the keyboard's top edge from the full `adb shell dumpsys window` (the `InsetsSource ... type=ime frame=[l,t][r,b] ... visible=true` line, with the IME window's `touchable region` as a fallback). The fixtures in `fixtures/` are real API 35 lines captured on `df-api35`; `node mobile/shared/qa-a1/check-ime-parser.js` checks the parser against them without a device. A hidden keyboard returns null and the check then only asserts on-screen position (it says so in its detail).
