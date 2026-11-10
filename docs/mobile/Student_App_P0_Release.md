# Student App P0: release sequence and device QA

**Scope:** PR #438 (payment sheet account, signup, secure sessions, raw-token links, push ownership, Partner Search moderation guard). **Status (2026-11-10):** both migrations are applied and verified on DEV only. Nothing is on PROD, nothing is deployed and no app is built. Each further hosted step needs the owner's approval.

## What ships where

| Piece | Kind | Files |
|---|---|---|
| Push device claim | SQL | `20270211090000_mobile_push_token_claim.sql` (+ rollback, suite `test_T_mobile_push_token_claim.sql`) |
| Partner Search moderation guard | SQL | `20270213090000_partner_profile_moderation_guard.sql` (+ rollback, suite `test_T_partner_profile_moderation_guard.sql`) |
| `stripeAccountId` in event checkout | Web | `src/lib/events/event-order-payment.ts` |
| Partner save stops writing `moderation_status` | Web | `src/app/account/partner-search/actions.ts` |
| Everything under `mobile/student` | App | needs an EAS build |

PROD does not equal `main`. The web pieces must ride whatever release branch PROD is promoted from. The `event-order-payment.ts` patch applies cleanly to `release/competition-cib`, `release/competition-r2-app` and `release/d7-core-organizer-suite` (dry run, 2026-11-09).

## Order

1. ~~**PROD read-only preflight.**~~ Done 2026-11-10 (#438 comment 6757168395):
   - The self-approval hole is present on PROD: same owner policy, `authenticated` holds UPDATE on `moderation_status`, no trigger.
   - Not exploited: 1 listing, `pending`. 0 approved, 0 flagged, 0 hidden.
   - Neither migration is on PROD.
2. ~~**DEV SQL.**~~ Done 2026-11-10 (#438 comment 6757076211). `20270211090000` at 00:50:13Z, then `20270213090000` at 00:53:29Z, each through a fail-closed wrapper that checks the project ref and SHA-256. Catalog and rolled-back behavior postflight passed, with no residue.
3. **PROD guard SQL: `20270213090000` now.** PROD has no flagged or hidden listings, so released web and mobile clients keep working with the guard in place. It can go before the web change, and closing the hole doesn't need to wait for an app release.
4. **PROD push SQL: `20270211090000`** before any app build that uses it. It is additive and safe at any time before step 6.
5. **Web:** ship the two web changes in the reconciled release. Before this, the app falls back to hosted checkout on registration and shows an error when resuming a payment.
6. **App:** EAS build only after steps 3 to 5. Without the push SQL, push registration fails silently. Without the guard, the Partner Search save sends no status, and the trigger is what sends edited approved listings back to review.

**Rollback:** app first, then web (both web changes are harmless on their own), then the SQL rollback files in reverse order (`20270213090000`, then `20270211090000`). Rolling back the guard reopens self-approval.

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

**Blocked, and why:**

| Check | Blocker |
|---|---|
| PaymentSheet on a direct charge | No device or emulator; no authorized Stripe TEST publishable key and connected account for this app |
| Keychain / Keystore persistence; migration from an older build | No device; iOS needs macOS |
| Push delivery and user switch | Needs a development build on a device and Expo push credentials |
| Deep links and legal links opening from email | No device |

**Validated without a device:** jest-expo (52 tests), mobile and root typecheck, `expo install --check`, Android JS bundle (`expo export`), SQL suites for both migrations on a disposable database (fail before, pass after, fail after rollback, pass after reapply), push user switch through real PostgREST and RLS, signup and magic-link flows on a local GoTrue with real email.

**Smallest routes to unblock, each needing the owner's OK:**

1. **Android, no cost:** install the Android SDK and an emulator on this machine (about 10 GB) and run a local debug build (`npx expo run:android`). No EAS. Covers Keystore, deep links and the app shell; PaymentSheet also needs item 3.
2. **One EAS development build** per platform (Expo account usage) for push delivery and iOS Keychain. iOS also needs a physical device or a Mac.
3. **Stripe TEST:** a TEST publishable key plus a controller-model connected account, so the sheet can present a direct charge. Legacy Express direct charges are blocked for new Stripe platforms.
