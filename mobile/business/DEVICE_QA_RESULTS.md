# DanceFlow Business: device and DEV QA results

How each check is run is in [DEVICE_QA.md](DEVICE_QA.md). A check is PASS only with evidence. Anything that couldn't be run is **BLOCKED**, never passed. Device screenshots are in [`docs/mobile/screenshots/business-shell/device/`](../../docs/mobile/screenshots/business-shell/device/).

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| D1 | DEV GoTrue accepts `danceflow-business://auth/callback` as `redirect_to` (exact match) | **PASS** (2026-11-10) | [dev-redirect-check.json](../../docs/mobile/screenshots/business-shell/dev-redirect-check.json) |
| D2 | Full DEV PKCE sign-in from the app | **BLOCKED**: no QA inbox on DEV (the coordinator's decision; no account is created and nobody's mailbox is used) | — |
| E1 | SecureStore session persistence, plus a scan for plaintext tokens | **PASS** (2026-11-12) | `e1-*.png`, notes below |
| E2 | PKCE deep link `danceflow-business://auth/callback` on the emulator | **PASS** after a fix (2026-11-12) | `e2-*.png` |
| E3 | OS text size 2.0 on every screen | **Text: PASS** after a fix. **Tab bar: FAIL**, open (collapsed at every text size) | `e3-*.png` |
| E4 | Reduce Motion (`animator_duration_scale` 0 → `reduceMotion=true`, live) | **PASS** (2026-11-12) | logcat, below |

## Setup

- **Device:** debug development build `com.idanceflow.business` 0.1.0 (x86_64, built locally from `C:\dfb`, no EAS) on the shared AVD `df-api35` (Android 15 / API 35, google_apis x86_64, 2 GB, cold boot, WHPX, swiftshader GPU). JavaScript came from Metro (`exp+danceflow-business://expo-development-client/?url=http://127.0.0.1:8081` with `adb reverse`).
- **Backend:** a local iso-qa `--auth` stack (real GoTrue v2.188.1 and Mailpit) with every migration above the baseline cutoff, reached from the emulator at `10.0.2.2:56600`. `next dev` (Turbopack) from #453 (`7dafe207`) served `/api/staff` on `10.0.2.2:3100`. The seed was fictional: a Denver studio, instructor Ida. No hosted access.
- **Starting system settings, recorded before any change:** `font_scale=1.0`, `window_animation_scale=1.0`, `transition_animation_scale=1.0`, `animator_duration_scale=null` (the default, 1), night mode **no** (the Student run had already left dark mode). All were then set explicitly to 1.0 / 1 / 1 / 1 / no, and **restored to exactly those values at the end**.
- **Noise, not app failures:** the cold-booted emulator raised "Pixel Launcher / System UI isn't responding" dialogs, and the dev menu opens on first launch. The helper script dismisses both.

## E1: SecureStore persistence

- **Sign-in:** password sign-in as Ida led to Today ([e1-signed-in-today](../../docs/mobile/screenshots/business-shell/device/e1-signed-in-today.png)).
- **Storage scan:** run with `adb shell "run-as com.idanceflow.business …"` over `shared_prefs` and `databases`.
  - No `eyJ` (JWT) and no `access_token` / `refresh_token` in `shared_prefs` or `databases`, AsyncStorage's `RKStorage` included.
  - A positive control (`auth-token`) is found in `SecureStore.xml`, which proves the scan reads the files.
  - The session is stored as a manifest key plus 3 chunks (`key_v1-sb-10-auth-token…`), each value Keystore ciphertext (`{"ct": …}`).
- **Persistence:** `am force-stop`, then a relaunch, opened straight on Today without asking to sign in ([e1-after-force-stop-relaunch](../../docs/mobile/screenshots/business-shell/device/e1-after-force-stop-relaunch.png)).
- **Sign-out:** after signing out from More, 0 session entries remain in SecureStore.
- **Fixed in `scripts/device-qa.sh`:** its first `storage` check passed `sh -c '…'`, which doesn't survive `adb shell run-as`, so it scanned nothing. It now runs single-string remote commands, includes the positive control, skips `files/` (the dev JS bundle mentions `access_token` as code, not data), and reports BLOCKED if it can't read storage.

## E2: PKCE deep link

**Bug found and fixed (`170761b8`).** Every `danceflow-business://auth/callback` link opened Expo Router's "Unmatched Route" page, because the path had no route ([before](../../docs/mobile/screenshots/business-shell/device/e2-before-fix-unmatched-route.png)). `app/auth/callback` now shows "Signing you in…", leaves for the app once there is a session, or says "This sign-in link didn't work" and offers a way back to sign-in.

After the fix, everything below was checked on the device while signed out:

| Link | Result |
| --- | --- |
| `…/auth/callback?code=made-up-code-123` | "This sign-in link didn't work", no session ([screenshot](../../docs/mobile/screenshots/business-shell/device/e2-fake-code-link-didnt-work.png)) |
| `…/auth/callback#access_token=evil&refresh_token=evil` | Same, and no session: raw tokens are never read |
| **The real link** | Signed in, as described below |

The real link, step by step:
1. The app's "Email me a sign-in link" stored the PKCE verifier in SecureStore (`…auth-token-code-verifier`) ([screenshot](../../docs/mobile/screenshots/business-shell/device/e2-link-requested.png)).
2. Mailpit caught "Your Magic Link", with `token=pkce_…` and `redirect_to=danceflow-business://…`.
3. GoTrue `/verify` answered `303` to `danceflow-business://auth/callback?code=…`.
4. `am start -d` delivered that link to the app, which showed [Signing you in](../../docs/mobile/screenshots/business-shell/device/e2-signing-in.png) and then [Today](../../docs/mobile/screenshots/business-shell/device/e2-signed-in-via-link.png).
5. SecureStore then held the 4 session entries, and the verifier had been consumed (0 left).

## E3: OS text size 2.0

**Bug found and fixed (`AppText`).** Android scales `fontSize` with the system text size but not a fixed `lineHeight`. Every AppText style set one, so at 2.0 glyphs were clipped to half a line ([before](../../docs/mobile/screenshots/business-shell/device/e3-before-fix-200pct-clipped.png)). Scaling the line height in JavaScript also drifted from the native scale after an activity recreation. On Android, AppText therefore sets **no** fixed line height, and native text layout fits the font. iOS (which scales both) and web keep the type scale. The two text inputs no longer spread `lineHeight` either.

The web 200% check zoomed whole boxes, line height included, so it couldn't catch this. Only the device run could.

After the fix, at 2.0, there was no clipped or overlapping text on any of these screens:
- [Today with 3 appointments](../../docs/mobile/screenshots/business-shell/device/e3-200pct-02-today-nov10-list.png)
- [class attendance (Present / No-show)](../../docs/mobile/screenshots/business-shell/device/e3-200pct-04-class-attendance-scrolled.png)
- [private lesson](../../docs/mobile/screenshots/business-shell/device/e3-200pct-05-private-lesson.png)
- [My clients](../../docs/mobile/screenshots/business-shell/device/e3-200pct-06-my-clients.png)
- [client](../../docs/mobile/screenshots/business-shell/device/e3-200pct-07-client-detail.png)
- [More with the sign-out-everywhere confirmation](../../docs/mobile/screenshots/business-shell/device/e3-200pct-09-more-confirm.png)

The day buttons wrap instead of truncating.

**Still FAIL: the tab bar collapses (at 1.0 and at 2.0).** On this Android 15 edge-to-edge build the bottom tab bar is only 74 px (about 28 dp) tall, at `[0,2326][1080,2400]`, and its labels are squashed to 11 px. The bar ignores any `tabBarStyle.height`: the explicit height, `"auto"` and bottom-tabs' own default all gave identical geometry, and the bundle was confirmed to carry each change ([screenshot at 1.0](../../docs/mobile/screenshots/business-shell/device/e3-tabbar-collapsed-at-1.0.png)). Tapping the icons still works, which is how this run navigated. This needs its own investigation of bottom-tabs 7.21 / react-native-screens on edge-to-edge. It's a follow-up, not covered here.

Observation (development-only warning): "Looks like you have configured linking in multiple places" appears after the activity is recreated, for example when the font scale changes. `MainActivity` is `singleTask`, and `configChanges` doesn't include `fontScale`, so the activity is recreated and the root mounts a second time. It isn't user-visible in release, but it's worth a look with the tab-bar follow-up.

## E4: Reduce Motion

| State | `animator_duration_scale` | App logged (dev build, logcat) |
| --- | --- | --- |
| Baseline, relaunched | 1 | `reduceMotion=false` |
| "Remove animations" on, relaunched | 0 | `reduceMotion=true` (stack transition becomes `fade`) |
| Switched off **while the app was open** | 1 | `reduceMotion=false` (live listener) |
| Switched on while open | 0 | `reduceMotion=true` |

The mapping `reduceMotion → "fade"` is unit-tested (`motion.test.tsx`).

## D1: how it was checked

The check uses DEV GoTrue's email-link endpoint with a deliberately **invalid** token, `GET /auth/v1/verify?token=<invalid>&type=magiclink&redirect_to=<url>`, without following the redirect. An invalid token is a failed lookup, so **no email was sent and no user was created**. GoTrue sends the resulting error to `redirect_to` only if that URL passes the allow list; otherwise it falls back to the site URL.

| `redirect_to` | Answer | Meaning |
| --- | --- | --- |
| `danceflow-business://auth/callback` | `303` → `danceflow-business://auth/callback#error=access_denied&error_code=otp_expired…` | Accepted |
| `danceflow-business://auth/callback/x` | `303` → `http://localhost:3000#error=…` | Refused: the entry is exact-match |
| `https://not-allowed.example/cb` | `303` → `http://localhost:3000#error=…` | Refused (negative control) |

Side note: DEV's site URL is `http://localhost:3000`.
