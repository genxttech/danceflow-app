# Student device QA R5 (release build, emulator)

2026-11-14. Student release APK (x86_64, debug-signed, Hermes, JS embedded) of `main` at 48c6c356 (includes #530), built in `C:\dq` with `gradlew :app:assembleRelease --no-daemon`. Emulator `df-api35` (API 35, swiftshader, 2 GB). The build used an inert backend (`EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:9`, dummy key), so nothing could sign in and no hosted service was contacted. Screenshots: `C:\dfr-out\qa-student\` (local, not committed). Emulator restored to font scale 1.0, night mode off; the app was uninstalled.

| # | Check | Result | Evidence |
|---|---|---|---|
| R-3b | Sign-in, font 1.0 then 2.0 while the app runs, with #530 | **FAIL (still clips).** Text cut mid-line ("Start" for "Start exploring", "DANCEF"), headline and body clipped | `r3b_01`, `r3b_02` |
| R-3b | Back to 1.0 live | PASS, restored fully | `r3b_03` |
| R-3b | Cold start at 2.0 | PASS (sizes correct, nothing clipped) | `r3b_04` |
| R-3b | Same flow with `fontScale` added to MainActivity `configChanges` (PR #533) | **PASS.** No clipping after 1.0 to 2.0 live (layout keeps its 1.0 sizing until the next launch); restart at 2.0 renders at full size | `r3b_05`, `r3b_06`, `r3b_07` |
| (4) | Magic link cold start, `am start -d danceflow://auth/callback?token_hash=bogus&type=magiclink` | PASS: "Sign in needs another try" with "Request a new link", no crash (the #518 fix holds) | `ml_01_cold_f1` |
| (4) | Warm start, a second link while the app is open | PASS: delivered to the running instance, process alive | `ml_02_warm_f1` (the link-error screen; the second run re-used it) |
| (3) | Dark mode 1.0: sign-in, Discover (guest) | PASS: readable, no light-only surfaces | `dark_01`, `dark_02` |
| (3) | Dark mode 2.0: sign-in, Discover (guest) | PASS (built with the fontScale change) | `dark_03`, `dark_04` |
| (3) | Dark mode Today, Event, Ticket, Settings | **BLOCKED**: need a signed-in session; a release build refuses cleartext HTTP so it cannot reach the local QA stack, and there is no DEV login |
| R-9 | Notification card wording and blank area | **BLOCKED**: the card is in Settings (sign-in). Covered by jest only (#530: wording for not-asked vs final refusal, message at full width) |
| (5) | Notification channel via `dumpsys notification` | **BLOCKED**: the channel is created during push setup after sign-in. `dumpsys` shows the package with importance NONE and no `default` channel, as expected before setup |

## Root cause of R-3b

Expo's MainActivity omits `fontScale` from `android:configChanges`, so a live text-size change recreates the activity while React Native keeps its old shadow tree; glyphs grow, boxes keep their size. #530's JS remount cannot fix it. #533 adds `fontScale` to the committed manifest (protected path, owner approval needed; same fix as Business #531). The cost: the new size applies at the next launch, not live.

## Still BLOCKED (no way to run here)

- Signed-in screens (Today, Event, Ticket, Settings) and the notification card / channel: a session needs a reachable backend and a login; the release build cannot use the local HTTP stack.
- Real push delivery from this build (placeholder Firebase file).
- Real payments (no Stripe TEST key). iOS (no macOS).
