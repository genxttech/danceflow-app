# Student app: iOS readiness (configuration review and verification checklist)

Status 2026-11-14. **Everything that needs an iOS device or build is BLOCKED**: there is no macOS machine, Xcode, simulator or iPhone available to engineering, and no EAS iOS build. This page records what could be reviewed from the repository alone (`mobile/student/app.json`, `app.config.js`, source) and the checklist to run when a Mac or an EAS iOS build exists. Nothing here was run on iOS.

## Configuration review (from the repository)

| Item | State | Note |
|---|---|---|
| Bundle id | `com.idanceflow.student` | Matches Android package. |
| URL scheme | `danceflow` (app.json `scheme`) | Registers `danceflow://` for the magic-link return (`danceflow://auth/callback`) and payment returns. No `associatedDomains`: universal links are not configured, so iOS only opens the app from the custom scheme. |
| `NSLocationWhenInUseUsageDescription` | present | Nearby studios and events. |
| `NSUserNotificationsUsageDescription` | present but **not an Apple key** | iOS ignores it; notification permission is requested at runtime and needs no Info.plist string. Harmless; can be removed. |
| `ITSAppUsesNonExemptEncryption` | `false` | OK for HTTPS-only use. |
| Photo library string | **missing** | `expo-image-picker` is used (`app/partners/draft.tsx`, `app/partners/index.tsx` call `requestMediaLibraryPermissionsAsync`) but the `expo-image-picker` config plugin is not listed in `plugins`, so `NSPhotoLibraryUsageDescription` is not generated. Without it the permission request can abort the app on iOS. Fix: add the plugin with a `photosPermission` string. `app.json` is CODEOWNERS-protected, so this needs owner approval and was not changed. |
| Camera / microphone strings | not needed | The app displays QR codes; it does not scan or record. Re-check if that changes. |
| Push (APNs) | plugin present (`expo-notifications`) | Requires an APNs key attached to the Expo project and an iOS dev/production build; the `aps-environment` entitlement is added by the plugin at prebuild. Token and delivery proof BLOCKED (no device, no APNs/FCM credentials). |
| Apple Pay | disabled (`merchantIdentifier: ""`) | The Stripe payment sheet works without it. Enabling needs an Apple merchant id and Stripe configuration (owner/Stripe change). |
| Sign in with Apple | `usesAppleSignIn: false` | Not required: sign-in is email magic link only, no third-party social login. |
| Account deletion in the app | present (Settings > Delete Account) | Satisfies App Store guideline 5.1.1(v). |
| Privacy manifest / data-use declarations | not reviewed | Expo SDK 54 libraries ship privacy manifests; the App Store Connect privacy answers (email, location, purchases, identifiers for push) are an owner task. |
| Orientation / tablet | portrait, `supportsTablet: true` | Check iPad layouts at verification time or set `supportsTablet: false`. |
| `runtimeVersion` | policy `appVersion` | OTA updates are tied to the app version. |

## Keychain usage review

`src/lib/secureSessionStorage.ts` stores the Supabase session and the push token id through `expo-secure-store` with `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
- Good: items are not synced to iCloud Keychain or included in device backups/transfers, and are readable by background push handling after the first unlock.
- To verify on a device: iOS keeps Keychain items after the app is deleted, so a reinstall can find the previous session. Confirm that behaviour is acceptable (the session is validated with `getUser` at start and cleared when invalid; see `src/lib/auth.tsx`), or add a first-launch marker that clears secure storage on a fresh install.
- Large values: SecureStore limits are ~2 KB per item on some OS versions; `secureSessionStorage` chunking is covered by `secureSessionStorage.test.ts` (Android/Node); confirm on iOS.

## Verification checklist (run when a Mac or an EAS iOS build exists)

Mark each PASS/FAIL with a screenshot or log.

1. Build installs and launches (dev client or preview build). No red screen on cold start.
2. Magic link: request a link, open it from Mail on the device. Cold start (app killed) and warm start both land on the intended screen (event or Today); expired/used link shows the "Sign in needs another try" state; Back goes to Today.
3. Guest discovery: signed out, Discover and event pages load; Wallet deep link (`xcrun simctl openurl booted danceflow://wallet`) redirects to sign-in.
4. Notifications: first-run permission prompt appears only from the Settings toggle; denied state shows the "blocked in device settings" message and the Open Settings button works; token claim row appears (needs APNs); tap routing from a notification (needs APNs).
5. Photo picker on Partner Search/Draft after the plugin fix: permission prompt shows the purpose string; denying works without a crash.
6. Location: permission prompt string, denied path.
7. Payments: Stripe payment sheet presents (needs a Stripe TEST key and connected account); cancel shows the neutral notice; return URL `danceflow://wallet?checkout=event` re-opens the app.
8. Keychain: sign in, kill app, relaunch (session kept); sign out (session gone); delete app and reinstall (see Keychain note).
9. Dark mode and Dynamic Type at the largest accessibility size: no clipped text on Today, Event detail, Ticket, Settings.
10. Account deletion and sign-out complete and return to sign-in.
11. iPad (if `supportsTablet` stays true): layouts usable.

## What is needed to unblock

- A Mac with Xcode (or an EAS iOS build profile and Apple Developer access) and an iPhone or simulator.
- An APNs key in the Expo project for push proof.
- A Stripe TEST publishable key and connected account for payment sheet proof.
- Owner approval to edit `mobile/student/app.json` (photo library plugin string, optional removal of the non-Apple notification key).
