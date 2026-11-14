# Student app: on-device checklist (Android emulator, release build)

Run only when you own the shared Gradle and emulator (check for running `gradle`, `java` and `emulator` first; `--no-daemon`, never `gradlew --stop`). Restore the emulator at the end (`font_scale 1.0`, night mode off). Mark any step you did not run as **BLOCKED**, never PASSED. Record the build commit and APK path with the results.

Tools: `adb` at `C:\Android\sdk\platform-tools`. In Git Bash prefix commands that contain `/sdcard` paths with `MSYS_NO_PATHCONV=1`. Package `com.idanceflow.student`, scheme `danceflow`.

## A. Dark mode at font scale 1.0

Prerequisite: a release APK installed (`adb install -r`, uninstall first if the signature differs).

```bash
adb shell settings put system font_scale 1.0
adb shell cmd uimode night yes
adb shell am force-stop com.idanceflow.student
adb shell am start -n com.idanceflow.student/.MainActivity
adb exec-out screencap -p > student_dark_f1.png
```

Pass when, on each of these screens, nothing is clipped, text is readable against its background, and no white flash or light-only surface appears:

| Screen | How to reach it | Notes |
|---|---|---|
| Sign-in | signed out cold start | all controls and Terms/Privacy links visible |
| Link error | `adb shell am start -a android.intent.action.VIEW -d "danceflow://auth/callback?token_hash=bogus&type=magiclink" com.idanceflow.student` | "Sign in needs another try", "Request a new link" |
| Settings | signed in, More, Settings | delete card shows "How account deletion works" link |
| Today, Discover, Wallet, Schedule, More | tab bar | needs a signed-in session |

Then repeat the screenshot step at `font_scale 2.0` for the same screens. Reset: `adb shell cmd uimode night no; adb shell settings put system font_scale 1.0`.

Signed-in screens need a reachable Supabase and a test login. Without one only the first two rows can run; mark the rest BLOCKED.

## B. Android notification channel

The channel is created when push setup first runs (`getNotificationsModule` in `src/lib/pushNotifications.ts`), which happens after sign-in, before the permission prompt. Expected: one channel, id `default`, name `DanceFlow`, importance 3 (default).

```bash
adb shell pm clear com.idanceflow.student            # start from a clean install state
adb shell am start -n com.idanceflow.student/.MainActivity
# sign in, then open Settings and turn push notifications on (or let the app prompt)
adb shell dumpsys notification --noredact | grep -n "com.idanceflow.student" | head
adb shell dumpsys notification --noredact | grep -A3 "NotificationChannel{.*mId='default'"
```

Pass when the output shows `mId='default'`, `mName=DanceFlow` and `mImportance=3` for `com.idanceflow.student`, the Android 13 permission dialog appears afterwards (not before), and System Settings, Apps, DanceFlow, Notifications lists a "DanceFlow" category. Run the app twice and confirm the channel is not duplicated (`dumpsys` shows one entry).

Output format of `dumpsys notification` differs by Android version: if the grep finds nothing, read the package's section by hand and record what was seen instead of passing it.

Also check: with notifications denied, the app still opens and sign-in works; with Firebase credentials absent the app must not crash (it surfaces no token and logs a handled error). Delivery of a real push is BLOCKED without FCM credentials.

## Known BLOCKED items (cannot be run here)

- Real push delivery: no FCM or APNs credentials.
- Real payments and the Stripe sheet: no Stripe TEST key. The cancel and decline states are proven with a mocked sheet only.
- Any iOS check: no macOS.
- Valid magic-link sign-in: needs a reachable Supabase and a mailbox.
