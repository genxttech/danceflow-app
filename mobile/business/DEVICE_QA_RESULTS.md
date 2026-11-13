# DanceFlow Business: device and DEV QA results

How each check is run is in [DEVICE_QA.md](DEVICE_QA.md). A check is PASS only with evidence. Anything that couldn't be run is **BLOCKED**, never passed. Device screenshots are in [`docs/mobile/screenshots/business-shell/device/`](../../docs/mobile/screenshots/business-shell/device/).

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| D1 | DEV GoTrue accepts `danceflow-business://auth/callback` as `redirect_to` (exact match) | **PASS** (2026-11-10) | [dev-redirect-check.json](../../docs/mobile/screenshots/business-shell/dev-redirect-check.json) |
| D2 | Full DEV PKCE sign-in from the app | **BLOCKED**: no QA inbox on DEV (the coordinator's decision; no account is created and nobody's mailbox is used) | — |
| E1 | SecureStore session persistence, plus a scan for plaintext tokens | **PASS** (2026-11-12) | `e1-*.png`, notes below |
| E2 | PKCE deep link `danceflow-business://auth/callback` on the emulator | **PASS** after a fix (2026-11-12) | `e2-*.png` |
| E3 | OS text size 2.0 on every screen | **PASS** after two fixes: text (2026-11-12) and tab bar (2026-11-13, root cause below) | `e3-*.png`, `device-qa.sh tabbar` |
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

**Tab bar: root cause found and fixed (re-run 2026-11-13).** On native Android, the bottom tab bar collapsed to 74 px (about 28 dp), with its buttons squashed to 26 px and the labels to 11 px.
- **Cause:** `tabBarStyle: { height: "auto" }` in `app/(tabs)/_layout.tsx`, added earlier to fix clipped labels on web. Native layout can't size an `"auto"` tab bar from its content, because the tab items are `flex: 1` with no intrinsic height. It shrinks to its padding. Web sizes it from content, which is why it looked fine in the browser.
- **Reproduced:** re-applying `height: "auto"`, with a fresh Metro and the served bundle checked for the code, gave exactly the failing geometry ([screenshot](../../docs/mobile/screenshots/business-shell/device/e3-tabbar-repro-height-auto.png)). `device-qa.sh tabbar` = **FAIL**.
- **Fix** (in `7c65990c`): an explicit numeric height from the text size and the bottom inset. `tabBarHeight(fontScale, insets.bottom)` = 8 + 24 (icon) + 4 + ceil(12 × 1.35 × max(1, fontScale)) + 8 + insets.bottom, with `paddingBottom = insets.bottom + 8` (unit-tested in `tabBar.test.ts`).
- **Proof:** on a cold start with a verified bundle, the tabs are 117 px at font 1.0 ([screenshot](../../docs/mobile/screenshots/business-shell/device/e3-tabbar-fixed-1.0.png)) and 159 px at 2.0 ([screenshot](../../docs/mobile/screenshots/business-shell/device/e3-tabbar-fixed-2.0.png)). Every tab is at least 44 dp and above the 63 px navigation inset, with labels readable. `tabbar` = **PASS** both times, and again after changing the text size while the app was open.
- **Not the cause:** the redundant `SafeAreaProvider` in `app/_layout.tsx` (Expo Router already provides one). It was left in place as the smallest change.
- **Process lesson:** Metro's file watcher on this PC sometimes doesn't pick up edits. Readings that seemed to show "an explicit height still collapses" came from stale bundles. Restart Metro with `--clear` and check the served bundle before trusting a device result.
- **Regression check:** `bash scripts/device-qa.sh tabbar` fails when any tab is under 44 dp or extends past the navigation-bar inset.

Observation (development-only warning): "Looks like you have configured linking in multiple places" appears after the activity is recreated, for example when the font scale changes. `MainActivity` is `singleTask`, and `configChanges` doesn't include `fontScale`, so the activity is recreated and the root mounts a second time. It isn't user-visible in release, but it's worth a look with the tab-bar follow-up.

## E4: Reduce Motion

| State | `animator_duration_scale` | App logged (dev build, logcat) |
| --- | --- | --- |
| Baseline, relaunched | 1 | `reduceMotion=false` |
| "Remove animations" on, relaunched | 0 | `reduceMotion=true` (stack transition becomes `fade`) |
| Switched off **while the app was open** | 1 | `reduceMotion=false` (live listener) |
| Switched on while open | 0 | `reduceMotion=true` |

The mapping `reduceMotion → "fade"` is unit-tested (`motion.test.tsx`).

## Re-verification on main `e28a54c7` (2026-11-13)

The checks above were run on earlier branch heads. They were repeated against the merged code in `main`, on the same debug development build, to confirm the squash merge kept the behavior.

- **Build:** the 2026-11-10 debug APK (`com.idanceflow.business` 0.1.0, x86_64, 61.6 MB) was reused rather than rebuilt (a clean build is about 33 minutes). `package.json`, `package-lock.json` and `app.json` are byte-identical to the ones that APK was built from, so the native layer is unchanged; the JavaScript is the current `main`, served by Metro from a clean checkout.
- **Backend:** a fresh iso-qa `--auth` stack with `seed-staff.mjs` (fictional data), and the web app's `/api/staff` from a local `next dev`. No hosted access. Password sign-in as the seeded instructor.
- **Device:** the shared AVD `df-api35`, cold boot. System settings were recorded first (`font_scale=1.0`, animation scales default, night mode no) and restored to exactly those values afterwards.

| Check | Result | Evidence |
| --- | --- | --- |
| Sign in, Today with 4 appointments | **PASS** | Today lists the private lessons, the cancelled one struck through, and the group class |
| E1 `storage` while signed in | **PASS** | no plaintext token; 4 SecureStore entries (manifest key plus 3 chunks) |
| E1 `restart` | **PASS** | relaunch opens on Today, not sign-in |
| E1 sign out, then `storage` | **PASS** | no SecureStore entries, no plaintext token |
| E2 made-up `code` link | **PASS** | "This sign-in link didn't work", no session |
| E2 raw `#access_token=…&refresh_token=…` link | **PASS** | no session created (SecureStore stays empty). The helper's `deeplink` only accepts `?` links, so this one was sent with `am start`; the screen was the same error card as the previous link, so the empty storage is the evidence |
| E3 `tabbar` at font 1.0 | **PASS** | 117 px tall, above the navigation inset |
| E3 `tabbar` at font 2.0, cold relaunch | **PASS** | 159 px tall |
| E3 text size 2.0: Today, appointment detail, Clients, More | **PASS** | no clipped or overlapping text, all controls reachable |
| E4 Reduce Motion on, relaunched | **PASS** | `reduceMotion=true` |
| E4 Reduce Motion off while open | **PASS** | `reduceMotion=false` (live listener) |

**Not covered in this re-run:** the real magic-link sign-in (E2, passed earlier), the group-class and 403 screens at 2.0, dark mode, the visual check that the stack transition fades under Reduce Motion (the mapping is unit-tested), iOS, and DEV sign-in (D2 stays BLOCKED).

## D1: how it was checked

The check uses DEV GoTrue's email-link endpoint with a deliberately **invalid** token, `GET /auth/v1/verify?token=<invalid>&type=magiclink&redirect_to=<url>`, without following the redirect. An invalid token is a failed lookup, so **no email was sent and no user was created**. GoTrue sends the resulting error to `redirect_to` only if that URL passes the allow list; otherwise it falls back to the site URL.

| `redirect_to` | Answer | Meaning |
| --- | --- | --- |
| `danceflow-business://auth/callback` | `303` → `danceflow-business://auth/callback#error=access_denied&error_code=otp_expired…` | Accepted |
| `danceflow-business://auth/callback/x` | `303` → `http://localhost:3000#error=…` | Refused: the entry is exact-match |
| `https://not-allowed.example/cb` | `303` → `http://localhost:3000#error=…` | Refused (negative control) |

Side note: DEV's site URL is `http://localhost:3000`.
