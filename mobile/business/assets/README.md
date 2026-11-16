# Business app assets

Copied unchanged from `mobile/student/assets` (the approved DanceFlow brand set, #442). Business has no distinct mark yet; when one is approved, replace these files under the same names.

| File | Use |
| --- | --- |
| `danceflow-app-icon-1024.png` | `expo.icon` (1024 x 1024) |
| `danceflow-app-icon-1024-ios.png` | `expo.ios.icon` (1024 x 1024, **RGB, no alpha**): App Store Connect rejects a marketing icon with an alpha channel. It is `danceflow-app-icon-1024.png` with the alpha channel dropped (the original is fully opaque on `#0E1028`, so every pixel is identical; verified channel by channel). Guarded by `src/__tests__/iosIcon.test.ts`. Regenerate it the same way if the icon changes: flatten onto `#0E1028`, write colour type 2. |
| `danceflow-adaptive-foreground-symbol.png` | `expo.android.adaptiveIcon.foregroundImage`, with `backgroundColor` `#0E1028` |
| `danceflow-adaptive-monochrome-symbol.png` | `expo.android.adaptiveIcon.monochromeImage` (themed icons) |
| `danceflow-logo-primary.png` | `expo.splash.image`, `resizeMode` `contain`, `backgroundColor` `#180C1B` |
| `danceflow-notification-symbol.png` | `expo.notification.icon`, `color` `#5B145E` (Android push) |

Wired in `mobile/business/app.json` (icon, splash, adaptive icon, notification) as of the Android release candidate.
