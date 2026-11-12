# Student App P0: release sequence and device QA

**Scope:** PR #438 (payment sheet account, signup, secure sessions, raw-token links, push ownership, Partner Search moderation guard). **Status (2026-11-10):** both migrations are applied on DEV and PROD, confirmed by read-only checks. Nothing is deployed and no app is built. Each further hosted step needs the owner's approval.

## What ships where

| Piece | Kind | Files |
|---|---|---|
| Push device claim | SQL | `20270213080000_mobile_push_token_claim.sql` (+ rollback, suite `test_T_mobile_push_token_claim.sql`) |
| Partner Search moderation guard | SQL | `20270213090000_partner_profile_moderation_guard.sql` (+ rollback, suite `test_T_partner_profile_moderation_guard.sql`) |
| `stripeAccountId` in event checkout | Web | `src/lib/events/event-order-payment.ts` |
| Partner save stops writing `moderation_status` | Web | `src/app/account/partner-search/actions.ts` |
| Everything under `mobile/student` | App | needs an EAS build |

**Release baseline (2026-11-12, latest):** PROD does not equal `main`. Live www is `dpl_813hjGqTNYQm5jXdsZbc238dQi28`, built from `claude/tw4f-key-setup-gate-on-cf1` at `39eaec03`: the CF1 line (`0db5eabe`) plus one TW-4F admin-only commit, with no SQL and nothing mobile. The app rollback is `dpl_3Z4vTnmERqKwq5sUTgqCgiVBG1Ds` (the `0db5eabe` build). The #438 web changes must ship on `39eaec03` or its successor.

Web-side files in #438, in four groups:

| Group | Files |
|---|---|
| Event checkout returns `stripeAccountId` | `src/lib/events/event-order-payment.ts` and its test |
| Partner save stops sending `moderation_status` | `src/app/account/partner-search/actions.ts` |
| Self-deletion refused for staff, organizer or admin logins | `src/lib/student-identity/account-controls.ts` and its test, `src/app/api/student/account/route.ts`, `src/app/account/actions.ts`, `src/app/account/page.tsx` |
| Boundary test for the mobile auth code | `src/lib/auth/__tests__/verifiedEmailBoundaries.launchsec1ca.test.ts` |

- **Dry run on `39eaec03` (2026-11-12, scratch worktree, removed afterwards; nothing pushed to the release branch):** `0db5eabe` is an ancestor, and the one commit in between touches none of the nine files. All nine apply cleanly, each on its own and all together. The suites pass 64/65; the only failure is the expected boundary test. ESLint has no errors. The `src`-walking accessor test timed out once on the cold first run again (27 s) and passed warm.
- **Dry run on `0db5eabe` (2026-11-12, the CF1 baseline before it; scratch worktree):** none of the nine files changed between `03297304` and `0db5eabe`. All nine apply cleanly with `git apply --check`, each on its own and all together.
- **Tests on the patched `0db5eabe`:** the event-order-payment, deletion and boundary suites pass 64/65, and the one failure is the expected boundary test (below). ESLint on the six web code files reports no errors. On the first run in a cold scratch directory, the accessor boundary test, which walks all of `src`, also failed after 62 s; on a rerun it passed. That's a timing risk in the web suite, not a #438 issue.
- **Ship the boundary test with the mobile change, not in a web-only release.** It reads `mobile/student/src/lib/auth.tsx` and asserts the raw-token branch is gone. On `0db5eabe`, without #438's mobile change, that file still has the branch, so the test fails (1 test).
- **Dry run on `03297304` (2026-11-12, the previous baseline):** all nine applied cleanly; the suites passed apart from the same boundary test.
- **Earlier baselines:** the patch also applied cleanly to `ab940288` (2026-11-10), and to `release/competition-cib`, `release/competition-r2-app` and `release/d7-core-organizer-suite` (2026-11-09).
- **Promotion windows:** promote nothing within 10 minutes of a CI-B checkpoint. Production promotion stays an owner gate.
- **Migration numbers:** `20270213080000` (push claim) and `20270213090000` (moderation guard) sort before Competition's `20270215090000` and `20270215091000`, now on PROD, and no number collides. Both of ours are already applied on DEV and PROD.

## Order

1. ~~**PROD read-only preflight.**~~ Done 2026-11-10 (#438 comment 6757168395):
   - The self-approval hole is present on PROD: same owner policy, `authenticated` holds UPDATE on `moderation_status`, no trigger.
   - Not exploited: 1 listing, `pending`. 0 approved, 0 flagged, 0 hidden.
   - Neither migration is on PROD.
2. ~~**DEV SQL.**~~ Done 2026-11-10 (#438 comment 6757076211). The push claim at 00:50:13Z (under its old number `20270211090000`), then `20270213090000` at 00:53:29Z, each through a fail-closed wrapper that checks the project ref and SHA-256. Catalog and rolled-back behavior postflight passed, with no residue.
3. ~~**PROD guard SQL: `20270213090000`.**~~ Present on PROD 2026-11-10 (read-only check). PROD has no flagged or hidden listings, so released web and mobile clients keep working with the guard in place. It can go before the web change, and closing the hole doesn't need to wait for an app release.
4. ~~**PROD push SQL: `20270213080000`.**~~ Present on PROD 2026-11-10 (read-only check).
5. **Web:** ship the two web changes in the reconciled release. Before this, the app falls back to hosted checkout on registration and shows an error when resuming a payment.
6. **App:** EAS build only after steps 3 to 5. Without the push SQL, push registration fails silently. Without the guard, the Partner Search save sends no status, and the trigger is what sends edited approved listings back to review.

**Rollback:** app first, then web (both web changes are harmless on their own), then the SQL rollback files in reverse order (`20270213090000`, then `20270213080000`). Rolling back the guard reopens self-approval.

**Renumbered 2026-11-10:** the push claim was `20270211090000`, which collides with the CI-B desk-balance migration already applied on PROD (`20270211090000_competition_checkin_balance_refund`). It is now `20270213080000`, still ahead of the guard. Only the file name and header comments changed; the SQL is the same. Nothing hosted is affected: DEV and PROD already have `claim_mobile_push_token` (applied 2026-11-10 under the old filename), PROD has no `supabase_migrations` table, and DEV's history table records neither version. Nothing is recorded by version, so nothing gets reapplied.

## Hosted read-only evidence

| Check | DEV (2026-11-09, before the fix) | PROD (2026-11-10) |
|---|---|---|
| `dancer_partner_profiles`: owner policy `FOR ALL` with `auth.uid() = user_id`, no trigger, `authenticated` and `anon` hold UPDATE on `moderation_status` | Confirmed, 0 rows. Fixed on DEV 2026-11-10 | Confirmed, 1 row (`pending`). Not fixed yet |
| `event_registrations` | Only staff/organizer policies plus `event_registrations_self_select` (`user_id = auth.uid()`). No public or guest read | Same |
| `attendance_records` | Staff, instructor and platform-admin only. **No student read policy** | Same |
| `commerce_catalog_items` | Studio staff only (`user_studio_roles`). **No student or public read policy** | Same |
| Hosted email templates (Magic Link, Confirm Signup) | **Not checked:** no read-only CLI path; needs the owner's dashboard | Not checked |

What these policies mean for the app (same on DEV and PROD) (all read through the user's own session):

- **`publicDiscovery.ts:384` remaining spots:** a guest or another buyer sees no rows, so the count is the event's full capacity. The server still enforces capacity at checkout; the screen overstates availability.
- **`studentWallet.ts:405,422` tickets:** the `client_id` read returns nothing unless `user_id` matches; the `attendee_email` read returns only rows with `user_id = auth.uid()`. No other buyer's ticket is exposed. Tickets bought before the account existed (`user_id` null) do not show.
- **`studentSchedule.ts:414` attendance:** returns nothing for students. Attendance-based schedule details are empty in the app.
- **`studentWallet.ts:744` catalog items:** the embedded `commerce_catalog_items(name, item_type)` join comes back null for students, so wallet entitlements show without a name or type.

These are functional gaps, not leaks: the app shows less than intended. Fixing them needs server routes or narrow SECURITY DEFINER reads, which is P1 work and a scope decision.

## Device QA

### Android emulator QA (2026-11-10)

**Setup.** A local debug development build of #442 (which includes #438), built without EAS, ran on an API 35 x86_64 emulator with WHPX acceleration and 2 GB RAM (see `Local_Android_QA.md`). The build loaded its JavaScript from Metro. It ran against a disposable local stack reached at `10.0.2.2`: the baseline plus all later migrations in this PR, GoTrue 2.188.1 with Mailpit, PostgREST, and the #438 Next API. Magic links came from Mailpit. Every write was local; nothing hosted was touched. Screenshots and logs are kept in the shared notes folder.

| Item | Result | Evidence |
|---|---|---|
| Sign-in, new address | **PASS** | A `pkce_` signup token was opened as `danceflow://auth/callback?token_hash=…&type=signup` with `adb am start`. Verify returned 200, `record_email_proof_mobile` was called, and the app moved on to the secure-account step |
| Sign-in, returning address | **PASS** | A `magiclink` token opened the same way. Verify 200 and the session was stored. One earlier attempt got 403 "One-time token not found" and didn't reproduce; a direct GoTrue probe accepts PKCE returning-user tokens as `magiclink`, `email` and `recovery` |
| Session kept in Keychain/Keystore | **PASS** | `shared_prefs/SecureStore.xml` holds a manifest plus AES-encrypted chunks (`key_v1-sb-10-auth-token.<id>.0..3`). AsyncStorage (`RKStorage`) contains no `access_token` or `refresh_token` |
| Session survives app kill and relaunch | **PASS** | After `am force-stop` and a relaunch, the home screen shows "Welcome back" with no sign-in. A relaunch with no taps for 60 s made no logout call |
| Sign-out clears the session | **PASS** | SecureStore session keys went from 5 to 0, 0 active refresh tokens remain on the server, and the relaunched app opens signed out |
| Raw-token deep links ignored | **PASS** | A real session was minted for another user. Opening `danceflow://auth/callback#access_token=…&refresh_token=…` and the `?` form left the app signed out, with no keys stored and that user's email shown nowhere |
| Deep links into screens | **PASS** | `danceflow://partners/draft`, `/settings`, `/home`, `/schedule`, `/wallet`, `/discover` and `/sign-in` each opened their screen |
| #442 screens, light and dark | **PASS** (visual) | Home, Schedule, Wallet and Discover in both modes via `cmd uimode night`. All readable, including the dark schedule empty state that used to be unreadable |
| Partner profile save | **PASS** | The device's POST to `dancer_partner_profiles` had 19 fields and no `moderation_status`. The row is `pending` / `published` |
| Account deletion, dancer, through both native dialogs | **PASS** | Delete Account, then "Delete DanceFlow account?" Continue, then "Final confirmation" Permanently Delete. The auth user is removed and the device is signed out |
| Account deletion, login that is also a studio owner | **PASS** | Same dialogs. The server returned 409, the app showed the refusal reason, and the login, the owner role and the session were all kept |
| Payment sheet | **BLOCKED** | No Stripe TEST publishable key or test connected account in the repo |
| Push token claim and delivery | **BLOCKED** | Getting an Expo push token needs real FCM credentials; the local build uses a placeholder `google-services.json`. Notification permission isn't granted, so registration stops before the claim RPC |
| iOS Keychain | **BLOCKED** | Needs macOS or an iOS device |

**Defects found on the device and fixed in this PR:**
1. **`mobile_notification_preferences` first-use race.** The push bootstrap and the Settings card both inserted the default row at once. The second insert hit the primary key (`23505`), and `useNotificationPreferences` had no `catch`, so the rejection went unhandled (dev overlay "Uncaught (in promise)"). Creation is now an upsert that ignores an existing row followed by a re-read, and the hook shows a message on failure. A unit test covers it, and the overlay is gone on the device.
2. **`AppButton` press state.** It rebuilt the press state as `{ pressed }` instead of forwarding it, which fails to typecheck once `expo start` generates `expo-env.d.ts` (react-native-web types add `hovered`). It now forwards the full state.

**Not app defects (environment):**
- **Account reactivation timeout.** The check timed out once because the local Next dev server spent 8.5 s compiling the route on first use, longer than the HTTP client waited. It answered in under 0.3 s afterwards.
- **An earlier unexpected sign-out.** It came from my UI automation, not the app.

**Still blocked, and why:**

| Check | Blocker |
|---|---|
| PaymentSheet on a direct charge | No authorized Stripe TEST publishable key and connected account for this app |
| Push delivery and user switch | Needs FCM credentials for a dev build (Firebase project) or an EAS build |
| iOS Keychain; migration from an older installed build | iOS needs macOS; no older build is installed anywhere to migrate from |

**Validated without a device:** jest-expo (52 tests), mobile and root typecheck, `expo install --check`, Android JS bundle (`expo export`), SQL suites for both migrations on a disposable database (fail before, pass after, fail after rollback, pass after reapply), push user switch through real PostgREST and RLS, signup and magic-link flows on a local GoTrue with real email.

**Local device QA feasibility (2026-11-10, earlier in the day; superseded):** the owner then enabled Hyper-V and approved the free SDK. WHPX became usable and the emulator QA above ran. Kept for the record:

| Requirement | Measured | OK? |
|---|---|---|
| Free disk | C: 108.4 GB free (only drive) | Yes |
| Free RAM for an emulator (~4 GB) | 3.9 GB free of 31.5 GB. Chrome uses ~4.2 GB, Claude ~4.0 GB, WSL ~1.6 GB, Docker ~1.2 GB with 7 containers | No, borderline |
| CPU virtualization for the emulator | Hypervisor running (WSL2 Virtual Machine Platform on). **Windows Hypervisor Platform (WHPX) is disabled**; the emulator needs WHPX when a hypervisor is active. Enabling it needs an administrator and a reboot | No |
| JDK, Android SDK | Neither installed | Installable, but sdkmanager requires accepting the Android SDK licence |

**Local-stack web QA (2026-11-10):** run against a disposable local stack built from the `df-isoqa` baseline plus every later migration in this PR (43 applied, no failures) plus the 1C-A email proof. The stack had GoTrue 2.188.1 with Mailpit, PostgREST, and the #438 Next dev server for `/api/student/*`. The Student web export of #442 was driven by Playwright through one local origin. The magic links came from Mailpit, so no inbox or service-role key was needed.

Two QA-only web stand-ins, never committed: `expo-secure-store` maps to `localStorage` (it has no web build; the app itself keeps web sessions in AsyncStorage by design), and native-only modules (PDF, Stripe, WebView, video) are stubbed.

| Matrix item | Result | Evidence |
|---|---|---|
| Sign-in with a magic link | **PASS (web, local stack)** | A new address got a `signup` token, verified with amr `otp`, and `record_email_proof_mobile` was called. The app moved on to the secure-account step |
| Session survives restart | **PASS (web, local stack)**; native Keystore **not verified** | After a full reload the session key is present and Settings shows the signed-in email |
| Sign-out clears the session | **PASS (web, local stack)**; native **not verified** | The session key is removed, the email is no longer shown, and 0 active refresh tokens remain on the server |
| Partner profile save | **PASS (web, local stack)** | The app's POST to `dancer_partner_profiles` has 19 fields and no `moderation_status`. The row stays `pending`, and the guard trigger is enabled |
| Forged self-approval through PostgREST | **PASS (web, local stack)** | PATCH `moderation_status=approved` gets 403 / `42501`, and the row stays `pending` |
| Account deletion, dancer | **PASS (web, local stack)**; the native two-step confirmation is **not verified** (react-native-web's `Alert` is a no-op) | The app's request (`DELETE /api/student/account`, `confirmation: DELETE`) gets 200; the auth user and profile are removed |
| Account deletion, login that is also studio staff | **FAIL before the fix, PASS after** | **Defect found:** it returned 200 and the profiles delete cascaded away the `studio_owner` role. It is now refused with 409 and changes nothing (fix below) |
| Push claim RPC | **NOT REACHED (web)**: device only | Registration stops at the notification-permission check on web, so no token and no claim. The server function is verified on DEV and PROD and in unit tests |
| Deep links via `adb shell am start -d` | **BLOCKED** | No emulator or device. Mapping and raw-token removal are covered by jest |
| #442 screens, light and dark | **PASS (web)** | Contrast measured from pixels (#442 comment 6762156752); native not checked |
| Payment sheet | **BLOCKED** | No device, and no Stripe TEST key or test connected account in the repo |
| Push delivery | **BLOCKED** | Needs FCM/EAS credentials and a device build |

**Fixed here: self-service deletion of a login that also manages something.** `deleteDanceFlowAccount` now refuses, before any write, when the login has an active `user_studio_roles` row, an active `organizer_users` row, or `platform_role = 'platform_admin'`:
- The app's API returns 409 with the reason, and the app shows it.
- The web account page shows the same message.

Unit tests cover all three cases plus inactive roles, and fail when the guard is removed. **Owner decision:** whether such users should instead be able to delete only their dancer data while keeping the staff login. Today they are refused and pointed to support.

**Smallest routes to unblock, each needing the owner's OK:**

1. **Android, no cost:** turn on Windows Hypervisor Platform (Windows Features, administrator, reboot) and free about 4 GB of RAM. Then the agent installs JDK 17, the Android SDK (licence acceptance needs the owner's OK), platform 36, build-tools 36.0.0, NDK 27.1 and an API 35/36 x86_64 image, about 10 GB in all. It builds a debug APK locally with no EAS and runs the matrix above. An Android phone with USB debugging needs neither the hypervisor change nor the RAM; it only needs the SDK licence OK. Covers Keystore, deep links, sign-in/out, the app shell and account deletion, but only if the owner supplies a magic-link sign-in on the device. PaymentSheet also needs item 3.
2. **One EAS development build** per platform (Expo account usage) for push delivery and iOS Keychain. iOS also needs a physical device or a Mac.
3. **Stripe TEST:** a TEST publishable key plus a controller-model connected account, so the sheet can present a direct charge. Legacy Express direct charges are blocked for new Stripe platforms.
