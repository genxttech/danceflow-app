# Student app: iOS readiness (configuration review and verification checklist)

Status 2026-11-14, refreshed 2026-11-15 (see "Refresh" below). **Everything that needs an iOS device or build is BLOCKED**: there is no macOS machine, Xcode, simulator or iPhone available to engineering, and no EAS iOS build. This page records what could be reviewed from the repository alone (`mobile/student/app.json`, `app.config.js`, source) and the checklist to run when a Mac or an EAS iOS build exists. Nothing here was run on iOS.

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

## Refresh 2026-11-15: what changed since the first review (d9d94fc5 to main 09746f37)

Still reviewed from the repository only; nothing was run on iOS. Everything in the checklist below stays BLOCKED, and each new behaviour gets a line in it.

**Config and permissions: no new iOS permission, link scheme or entitlement.** `app.json` changed only by the Android release-signing plugin (`./plugins/withAndroidReleaseSigning`, Android Gradle only) and `app.config.js` by the `GOOGLE_SERVICES_JSON` check (Android only); `package.json` gained only the `eas-build-post-install` script. No new dependency. The one open iOS configuration defect is unchanged: **`NSPhotoLibraryUsageDescription` is still missing** (the `expo-image-picker` plugin is not in `plugins`; #525 made Android skip the permission request but iOS still calls `requestMediaLibraryPermissionsAsync`, so on iOS the request can abort the app without the string). Fix still needs owner approval of `app.json`.

| Change | iOS impact | What to verify on iOS |
|---|---|---|
| New outbound links (#524 account deletion, #542 Help Center, Security, DPA) | `Linking.openURL` to https pages; opens Safari. No config needed. | Each opens; Back returns to the app. |
| Notification wording (#530) and channel (#515) | The Android notification channel is skipped on iOS. `normalizePermissionStatus` maps "denied but can ask again" to not-asked; iOS reports `undetermined` before the first prompt and `denied` with `canAskAgain: false` after a refusal (iOS never re-prompts), so the "blocked in your device settings" wording and Open Device Settings button are the correct path. | First prompt from the switch (#537: master switch is off until the OS permission is granted, one tap shows the prompt); refusal shows "blocked" and Open Settings works. |
| Dynamic Type (#530 `useFontScale`, #524 large-text audit) | iOS applies a text-size change live without recreating the app, so the Android manifest fix (#533, `fontScale` in `configChanges`) does not apply. `AppText` caps scaling at 1.35 and inputs use `minHeight`. | Largest accessibility size on Sign in, Today, Event, Ticket, Settings; change the size while the app is open. |
| Pay Now return (#537) | The browser checkout leaves the app; the re-read happens on `AppState` "active" on return, which iOS also fires. | Pay, return from Safari, paid request disappears and the status line shows. |
| Screen-reader roles and labels (#529) | `accessibilityRole="button"`, `selected` state and labels map to VoiceOver traits. **`accessibilityLiveRegion` is Android-only**: it is used on `ErrorState`, the payment status line and the checkout status cards, so VoiceOver will not announce those changes on iOS. | VoiceOver walk of Sign in, Discover, Event, Ticket, Settings, Wallet; trigger an error and a payment status change and listen. Fixed in code (`Announce` component calls `AccessibilityInfo.announceForAccessibility` on iOS when those messages appear; jest-proven); the spoken result still needs a VoiceOver check on a device. |
| Error and retry states (#552, state-coverage PR) | Platform neutral. Offline detection matches the message text; React Native iOS reports a failed fetch as "Network request failed" (matched), but confirm no other iOS wording slips through (for example "The network connection was lost"). | Airplane mode on Today, Wallet, an event: offline card with Try again. |
| Deep links and cold start (#508 routing table, #518 root-navigator crash fix) | Custom scheme only; no universal links. | Cold and warm magic link (checklist item 2) on iOS. |
| Smoke script (#551) | Android emulator only; no iOS equivalent (needs macOS, Xcode, a simulator). | Not applicable until a Mac exists. |

**Owner-pending (unchanged or new):** photo library string (app.json); "offline ticket" (cached tickets or QR at rest) is an open owner product decision with privacy and fraud questions, deliberately not built; App Store privacy answers; APNs key; Apple merchant id.

## Verification checklist (run when a Mac or an EAS iOS build exists)

Mark each PASS/FAIL with a screenshot or log.

1. Build installs and launches (dev client or preview build). No red screen on cold start.
2. Magic link: request a link, open it from Mail on the device. Cold start (app killed) and warm start both land on the intended screen (event or Today); expired/used link shows the "Sign in needs another try" state; Back goes to Today.
3. Guest discovery: signed out, Discover and event pages load; Wallet deep link (`xcrun simctl openurl booted danceflow://wallet`) redirects to sign-in.
4. Notifications (wording and switch behaviour per the 2026-11-15 refresh): first-run permission prompt appears only from the Settings toggle; denied state shows the "blocked in device settings" message and the Open Settings button works; token claim row appears (needs APNs); tap routing from a notification (needs APNs).
5. Photo picker on Partner Search/Draft after the plugin fix: permission prompt shows the purpose string; denying works without a crash.
6. Location: permission prompt string, denied path.
7. Payments: Stripe payment sheet presents (needs a Stripe TEST key and connected account); cancel shows the neutral notice; return URL `danceflow://wallet?checkout=event` re-opens the app.
8. Keychain: sign in, kill app, relaunch (session kept); sign out (session gone); delete app and reinstall (see Keychain note).
9. Dark mode and Dynamic Type at the largest accessibility size, including changing the size while the app is open: no clipped text on Today, Event detail, Ticket, Settings.
9a. VoiceOver walk (roles, labels, focus order) of Sign in, Discover, Event, Ticket, Settings, Wallet; error cards and the payment status line are announced (see the live-region note).
9b. Offline: airplane mode on Today, Wallet and an event shows the offline card with Try again; Try again recovers when back online.
10. Account deletion and sign-out complete and return to sign-in.
11. iPad (if `supportsTablet` stays true): layouts usable.

## What is needed to unblock

- A Mac with Xcode (or an EAS iOS build profile and Apple Developer access) and an iPhone or simulator.
- An APNs key in the Expo project for push proof.
- A Stripe TEST publishable key and connected account for payment sheet proof.
- Owner approval to edit `mobile/student/app.json` (photo library plugin string, optional removal of the non-Apple notification key).
