# Business app: device QA still owed

Run when the emulator is free (android-release owns Gradle and the emulator until it hands back). Anything not run is BLOCKED, not PASSED. Record results and screenshots in `mobile/business/DEVICE_QA_RESULTS.md`.

## Setup
1. Release build from main containing #513 (app.json wiring) and #509 (dark mode), installed from the signed bundle.
2. iso-qa `--auth` stack plus `seed-staff.mjs`; the app's API base pointed at it (10.0.2.2).
3. Set `font_scale` and `cmd uimode night` BEFORE the first launch; then force-stop and cold start. Never judge a layout after a live change (stale layout is a known debug-only effect; #520 and the tab-bar follow-up address it).

## Matrix (each cell: screenshot + pass/fail)
Screens: Sign in, Today (with rows), Today (empty), Appointment (private lesson), Class roster with attendance, Clients, Client detail, More (notifications card hidden until the adapter lands).
Combinations: font 1.0 and 2.0, light and dark. 16 cells per screen group; Sign in at 2.0 is the known failure (`b2-font2.png`).

## Checks per cell
- No clipped or overlapping text; tab bar labels fully visible; buttons grow rather than cut text.
- Contrast legible in dark (palette is AA by jest; this checks real rendering and the status bar).
- Roster: mark Present / No-show, error row on API failure, "N of M booked · Full".
- TalkBack: every control named, focus order top to bottom.

## Push (after the expo-notifications PR lands)
Permission prompt only from the button; denied state explained; no google-services file present gives "unavailable", not a crash.

## iOS
BLOCKED: no macOS available. See `mobile/business/IOS_READINESS.md`.
