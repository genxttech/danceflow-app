# DanceFlow Business: iOS readiness (prepared without macOS)

**Verification status: BLOCKED.** No macOS host or iOS device/simulator is available to this team, so nothing below has been run on iOS. Items marked "config review" were checked by reading `app.json`; they are not device results.

## Config review (`app.json`, 2026-11-14)

| Item | State | Note |
| --- | --- | --- |
| `ios.bundleIdentifier` | `com.idanceflow.business` | Matches Android package; must exist in the Apple developer account before any build. |
| `ios.supportsTablet` | `true` | Needs iPad layout verification (Today list, roster) or set to `false` for v1. Decision for the owner. |
| `ITSAppUsesNonExemptEncryption` | `false` | Correct while only HTTPS/TLS and Keystore/Keychain are used. |
| `scheme` | `danceflow-business` | Needed for the magic-link PKCE callback; same value must be in the Supabase redirect allow-list (D1 passes on DEV). |
| Usage descriptions (`NSCameraUsageDescription` etc.) | none | None needed today: no camera, photos, location, contacts, or microphone. The push permission prompt text is OS-fixed, so no key is needed for it. Revisit if door check-in adds a QR scanner (camera string required). |
| Push (`expo-notifications`) | not installed | Needs the APNs key uploaded to EAS/Expo, the Push Notifications capability, and `aps-environment` entitlement. |
| `userInterfaceStyle` | `light` | Dark mode is unsupported; see the dark-mode proposal. |
| Fonts | system | No bundled-font licence issue. |

## Written verification checklist (run on macOS, all currently BLOCKED)

1. Build: `npx expo prebuild --platform ios` then a debug build on an iOS 17+ simulator; record Xcode and Expo SDK versions.
2. Sign-in: request a magic link, open `danceflow-business://auth/callback?code=...` with `xcrun simctl openurl booted`, confirm Today loads (mirrors Android E2).
3. Keychain persistence: force-quit and relaunch, confirm the session survives; sign out, confirm the Keychain entries are gone (mirrors E1).
4. Dynamic Type: set the largest accessibility size, walk Today, appointment, class roster, clients, client detail, More. Confirm no clipped text. iOS scales `lineHeight` with `fontSize` in `AppText`; check that is true on device (mirrors E3).
5. Tab bar: iPhone with home indicator and one without; confirm height from `tabBarHeight` is correct (the Android collapse came from `height: "auto"`).
6. VoiceOver: every roster radio reads "Present, <name>" with checked state; day buttons; error states announce via alert role.
7. Reduce Motion: toggle in Settings, confirm stack transitions are instant (mirrors E4).
8. Safe areas: notch/Dynamic Island, landscape is locked to portrait in config.
9. iPad (only if `supportsTablet` stays true): layout at 11" and 13", split view.
10. Offline: airplane mode on Today shows the unavailable state with Retry, and Retry recovers.
11. Push (after APNs key): permission prompt, token registration, tap routing, notification while app is foreground/background/killed.

## What unblocks this

A macOS machine (or a cloud Mac / EAS iOS build plus a TestFlight device), an Apple developer account with the bundle id, and the APNs key. None of these are available to the Business session.
