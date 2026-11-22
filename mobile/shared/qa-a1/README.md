# A1 device checks (QA only)

`a1-device-checks.js` drives the assistant launcher and sheet on an emulator through adb + uiautomator. Used by:
- Student: `node mobile/student/scripts/qa-smoke/run.mjs --a1 [--features lumiAssistant] --build-dir <tree> --ref <sha> --out <dir>`
- Business: `node mobile/business/scripts/device-smoke.js --a1 [--aria] --build-dir <tree> --out <dir>`

Without the flag word: Part A (flags OFF): no assistant node on any walked screen, cold start x5 (`am start -W`), logcat counts.
With it: Part B (flags ON, stub responder only): launcher visibility and 44dp target, sheet open/expand/close/back/scrim, keyboard, conversation continuity across navigation and user switch, font 2.0 / dark (the app is cold-relaunched after each font or dark change, because a live change leaves the layout half-measured and screenshots show clipped text), tree order and labels.

Anything not asserted is recorded as BLOCKED, never PASS. Clipping is not detectable from the accessibility tree: review the font-2.0 screenshots by eye.

## TalkBack plan (not automated yet)
TalkBack is installed on the df-api35 image but the traversal is not scripted yet. To run it:
1. The df-api35 image has the TalkBack package (talkback.txt in the Part B evidence lists it). Enable with `adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService` and `accessibility_enabled 1`; restore both afterwards.
2. Per app, flags ON: swipe-right traversal from the top of a screen. Record the spoken order (adb logcat `TalkBack` tag or screen-reader captions): the launcher announces "Open <name> assistant, button" plus its hint.
3. Open the sheet: focus must move into the sheet (accessibilityViewIsModal) and the background must not be reachable; order title, Helping with, Expand, Clear, Close, thread, composer, Send; Retry and link chips announced as buttons/links.
4. Close: focus returns to the launcher or the screen, not lost.
5. Evidence: caption log + screenshots; anything not walked is BLOCKED.

## Keyboard-top measurement

`imeTopFromDumpsys` reads the keyboard's top edge from the full `adb shell dumpsys window` (the `InsetsSource ... type=ime frame=[l,t][r,b] ... visible=true` line, with the IME window's `touchable region` as a fallback). The fixtures in `fixtures/` are real API 35 lines captured on `df-api35`; `node mobile/shared/qa-a1/check-ime-parser.js` checks the parser against them without a device. A hidden keyboard returns null and the check then only asserts on-screen position (it says so in its detail).
