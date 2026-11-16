# DanceFlow Business: iOS readiness (prepared without macOS)

**Verification status: BLOCKED.** No macOS host or iOS device/simulator is available to this team, so nothing below has been run on iOS. Items marked "config review" were checked by reading `app.json`; they are not device results.

## Config review (`app.json`, 2026-11-14; rows updated 2026-11-15, see "Changes since the first review")

| Item | State | Note |
| --- | --- | --- |
| `ios.bundleIdentifier` | `com.idanceflow.business` | Matches Android package; must exist in the Apple developer account before any build. |
| `ios.supportsTablet` | `true` | Needs iPad layout verification (Today list, roster) or set to `false` for v1. Decision for the owner. |
| `ITSAppUsesNonExemptEncryption` | `false` | Correct while only HTTPS/TLS and Keystore/Keychain are used. |
| `scheme` | `danceflow-business` | Needed for the magic-link PKCE callback; same value must be in the Supabase redirect allow-list (D1 passes on DEV). |
| Usage descriptions (`NSCameraUsageDescription` etc.) | none | None needed today: no camera, photos, location, contacts, or microphone. The push permission prompt text is OS-fixed, so no key is needed for it. Revisit if door check-in adds a QR scanner (camera string required). |
| Push (`expo-notifications`) | installed, plugin in `app.json` (#513, #526, #545) | The app registers an **Expo push token** through the existing `claim_mobile_push_token` function (app slug `danceflow-business`). On iOS it still needs the APNs key uploaded to EAS, the Push Notifications capability (the plugin adds `aps-environment` at prebuild; `development` until a production build) and the EAS project id. No staff sender exists yet. |
| `userInterfaceStyle` | `automatic` (#509) | Follows the system light/dark setting. The palette is chosen when the app starts, so a change made while the app is open applies at the next launch; the status bar follows the system (`StatusBar style="auto"`). Dark mode was verified on Android only. |
| Fonts | system | No bundled-font licence issue. |

## Changes since the first review (2026-11-15)

| Change | What it means for iOS |
| --- | --- |
| Dark mode (#509, `userInterfaceStyle: automatic`) | New iOS checks: launch in dark, walk every screen (contrast is guarded by jest in both palettes, `contrast.test.ts`, but nothing has been seen on iOS), confirm the status bar and the keyboard match, and that a system switch while open applies at the next launch. |
| VoiceOver announcements (Announce, #570) | `accessibilityLiveRegion` is Android-only. Errors, the roster save results and the stale-data banner now call `announceForAccessibility` on iOS (same component as the Student app, #557). Checklist item 6 now covers it. |
| Push token registration (#545) | A granted permission now ends in an Expo push token registered with `claim_mobile_push_token`. On iOS this needs the APNs key and the EAS project id before the token call can succeed; without them the card says notifications are not available and nothing else is affected. |
| Text size | `fontScale` handling (#531) is an Android manifest change and does not apply to iOS. iOS Dynamic Type scales `fontSize` and `lineHeight` together; nothing in `AppText` or the screens pins a height (guarded by `a11y.test.tsx`), but it has not been walked on iOS. |
| New screens behind flags (Pulse, studio schedule: #540, #541; Mark all present: #549; keep-last-data banner: #550) | All off by default. Walk them on iOS only when a build turns them on (`EXPO_PUBLIC_STAFF_FEATURES`); the same jest, reading-order and device-smoke coverage applies as on Android. |
| Brand assets wired (#513) | **The 1024px app icon is RGBA (it has an alpha channel).** App Store Connect rejects a marketing icon with an alpha channel or transparency. Before an iOS build, flatten `assets/danceflow-app-icon-1024.png` onto a solid background (RGB, no alpha). The Android adaptive and notification icons are fine as RGBA. The splash uses the logo on `#180C1B`. The Student icon should be checked the same way. |
| Accessibility audit (#577) | The TalkBack tree audit is Android-only; VoiceOver needs the Accessibility Inspector on a Mac. The reading-order jest guard (`readingOrder.test.tsx`) is platform-neutral and covers the order of the key screens. |

## Written verification checklist (run on macOS, all currently BLOCKED)

1. Build: `npx expo prebuild --platform ios` then a debug build on an iOS 17+ simulator; record Xcode and Expo SDK versions.
2. Sign-in: request a magic link, open `danceflow-business://auth/callback?code=...` with `xcrun simctl openurl booted`, confirm Today loads (mirrors Android E2).
3. Keychain persistence: force-quit and relaunch, confirm the session survives; sign out, confirm the Keychain entries are gone (mirrors E1).
4. Dynamic Type: set the largest accessibility size, walk Today, appointment, class roster, clients, client detail, More. Confirm no clipped text. iOS scales `lineHeight` with `fontSize` in `AppText`; check that is true on device (mirrors E3).
5. Tab bar: iPhone with home indicator and one without; confirm height from `tabBarHeight` is correct (the Android collapse came from `height: "auto"`).
6. VoiceOver: every roster radio reads "Present, <name>" with checked state; day buttons; error states are **announced** (Announce component: sign-in error, error states, a refused attendance write with the dancer's name, the Mark all present result, the stale-data banner); the reading order matches `readingOrder.test.tsx`.
7. Reduce Motion: toggle in Settings, confirm stack transitions are instant (mirrors E4).
8. Safe areas: notch/Dynamic Island, landscape is locked to portrait in config.
9. iPad (only if `supportsTablet` stays true): layout at 11" and 13", split view.
10. Offline: airplane mode on Today shows the unavailable state with Retry, and Retry recovers.
11. Push (after the APNs key and EAS project id): permission prompt from the button only, the token row appears in `mobile_push_tokens` for `danceflow-business`, tap routing, notification while app is foreground/background/killed.
12. Dark mode: launch with the system in dark, walk every screen; status bar and keyboard match; switch the system theme while open and confirm the change applies at the next launch.
13. App icon: the flattened (no alpha) 1024px icon passes App Store Connect validation.

## What unblocks this

A macOS machine (or a cloud Mac / EAS iOS build plus a TestFlight device), an Apple developer account with the bundle id, and the APNs key. None of these are available to the Business session.
