# Student device QA R6 (signed-in, QA-only HTTP variant)

2026-11-15. Follow-up to R5 (`Student_Device_QA_R5.md`) for the rows that needed a signed-in session. Student release APK (x86_64, debug-signed, Hermes) built in `C:\dq` from `main` at 48c6c356 (includes #530) plus the **QA-only HTTP variant**: `android:usesCleartextTraffic="true"` added to the manifest by hand and `EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:56600` plus the disposable stack's demo anon key in a local `.env`. Neither change was committed or reverted into shipping config; the manifest and `.env` were restored afterwards. Backend: a disposable iso-qa `--auth` stack (`stuqa`, scenario `main`, plus migration `20270213080000` for `claim_mobile_push_token`, applied to that stack only). The DanceFlow web API was **not** run; a 25-line mock served `/api/student/studio-links` and `/api/student/profile` only. Emulator `df-api35` (API 35). Screenshots: `C:\dfr-out\qa-student\` (local, not committed). Everything was torn down afterwards: stack removed, mock stopped, app uninstalled, emulator at font scale 1.0 and night off.

Sign-in: GoTrue's mail delivery to Mailpit timed out under load ("context deadline exceeded"), so the magic link was generated through the GoTrue admin API and opened as `danceflow://auth/callback?token_hash=...&type=magiclink`, which is the same verification path the app uses for an emailed link. Result: signed in as the test dancer, Today rendered (`li_04_signed_in.png`).

| # | Check | Result | Evidence |
|---|---|---|---|
| R-9 | Card wording before the first prompt | **PASS**: "Turn on Push Notifications to allow alerts from DanceFlow." (no "blocked") | `r9_03_card_before.png` |
| R-9 | System prompt from the master switch | PASS: "Allow DanceFlow to send you notifications?" | `r9_05_prompt.png` |
| R-9 | After "Don't allow" | **PASS**: "Push notifications were not enabled." (not "blocked"), no blank area | `r9_06_after_deny.png` |
| R-9 | After "Allow" with no usable Firebase file (this build uses the placeholder) | **PASS for layout**: "Push notifications could not be set up on this device yet. Your updates still appear in the app." renders full width under the header, no blank white area; the card then reads "Push notifications are available on this device." | `r9_08_after_allow.png`, `dk2.0_settings.png` |
| (5) | Notification channel | **PASS**: `NotificationChannel{mId='default', mName=DanceFlow, mImportance=3}` for `com.idanceflow.student` after the prompt (`dumpsys notification --noredact`) | logged above |
| (3) | Signed-in dark mode at font 1.0 | **PASS**: Today, Discover, Wallet, Settings readable, nothing clipped | `dk1.0_*.png` |
| (3) | Signed-in dark mode at font 2.0 (cold start after the change) | **PASS**: Today, Discover, Wallet (tab labels fit), Settings (email wraps, all text visible) | `dk2.0_*.png` |
| (3) | Event detail and Ticket in dark mode | **BLOCKED**: needs a seeded studio, event and registration, and the web API (`/api/...`) which was not run; the mock does not serve them |
| (1) | Partner profile photo flow | **BLOCKED**: needs the web upload API and images on the emulator (R-12 already showed the picker opens with no permission prompt) |
| | Push token reaching the server | **BLOCKED here**: this build carries the placeholder Firebase file, so no real Expo token; R-10 in `Android_Release_Audit.md` covers it with the real DEV file |

## Observations

- The master switch shows **on** by default before any permission exists (`pushEnabled` default true). Tapping it first turns push **off**; a second tap triggers the system prompt. That is existing behaviour, not caused by #530; consider defaulting the switch to the real permission state in a follow-up.
- Typing through `adb input text` on this slow emulator can drop characters (an address was truncated and created a stray user in the disposable stack; harmless, torn down).

## Still BLOCKED

- Event detail, Ticket and partner photo upload (need web API and seed data), real push delivery from this build (placeholder Firebase file), real payments (no Stripe TEST key), iOS (no macOS), Android 12 and older (no AVD).
