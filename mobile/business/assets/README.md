# Business app assets

Copied unchanged from `mobile/student/assets` (the approved DanceFlow brand set, #442). Business has no distinct mark yet; when one is approved, replace these files under the same names.

| File | Use |
| --- | --- |
| `danceflow-app-icon-1024.png` | `expo.icon` (1024 x 1024) |
| `danceflow-adaptive-foreground-symbol.png` | `expo.android.adaptiveIcon.foregroundImage`, with `backgroundColor` `#0E1028` |
| `danceflow-adaptive-monochrome-symbol.png` | `expo.android.adaptiveIcon.monochromeImage` (themed icons) |
| `danceflow-logo-primary.png` | `expo.splash.image`, `resizeMode` `contain`, `backgroundColor` `#180C1B` |
| `danceflow-notification-symbol.png` | `expo.notification.icon`, `color` `#5B145E` (Android push) |

Not wired: `mobile/business/app.json` is owned by the release session (PR 513). The exact keys to add are the table above, mirroring `mobile/student/app.json`.
