# Staff API proposals

Additions the Business app needs beyond slice 2. Errors stay flat `{error, code}`; every route goes through `requireStaffApi` before any data read, with a refusal test per role. Status as of 2026-11-15.

| | Proposal | Status |
|---|---|---|
| P2 | Studio day schedule | **Shipped** (#535): `GET .../schedule?date=`, see the contract |
| P5 | Pulse summary | **Shipped** (#538): `GET .../pulse`, see the contract |
| P1 | Device token registration | **Reuses the existing Student push path; no migration** (see below) |
| P3 | Waitlist | **Blocked: no data model** |
| P4 | Recap writes | **Deferred: needs a shared-module extraction first** |

## P1. Device token registration (push)

**Revised 2026-11-15: no new route, table or migration.** The Student app already has the whole registration path, and the Business app now uses it:

- table `public.mobile_push_tokens` (migration `20260626_student_push_notifications_v1.sql`): `expo_push_token` unique, `platform`, `app_slug`, `enabled`, RLS "own rows only";
- function `public.claim_mobile_push_token(p_expo_push_token, p_platform, p_app_slug)` (migration `20270213080000_mobile_push_token_claim.sql`, security definer, authenticated only): the row follows whoever is signed in on the device. `p_app_slug` accepts any `[a-z0-9-]{1,64}`; Business registers as `danceflow-business`;
- server sender `sendMobilePushToUser` (`src/lib/notifications/expoPush.ts`), which talks to Expo's push service: so the app registers an **Expo push token** (`getExpoPushTokenAsync` with the EAS project id), not the raw FCM token.

What is still open and is server or owner work, not app work: both migrations must be applied wherever a Business build registers (the Student release already needs them); a staff-facing sender (which events notify staff, to whom, with what payload `{type, id, studioId}` as `notificationRoute.ts` expects); the EAS project id and Firebase credentials in the build; and unbinding the token on sign-out (a signed-out phone keeps receiving the previous user's notifications until the next sign-in claims it; Student deletes the row at sign-out, Business does not yet).

The earlier draft of a separate `staff_device_tokens` table is withdrawn.

## P3. Waitlist

There is no class waitlist in the data model today: `appointment_attendees.status` is only `booked` or `cancelled`, and the roster capacity rules live in the enroll/cancel RPCs. A waitlist is a product feature (who is promoted, when, with what notice), which needs its own table or a new attendee status plus the promotion rules. The app already shows "N of M booked · Full". Not a no-migration item; no SQL drafted until the product rule is chosen.

## P4. Session recap writes

No migration needed (`lesson_recaps` exists), but the web logic is a 534-line server action (`src/app/app/schedule/[id]/attendance/recap-actions.ts`) that also sends push notifications to the clients, syncs syllabus steps and media links, and uses the cookie client and redirects. It has to be extracted into a shared module the API can call, and the notification behaviour when a recap is marked visible to the client needs an owner decision (should an instructor's phone save notify the dancer?). Recommended order: extract with no behaviour change first (own PR, web tests), then the API route.

## Deferred

Event door check-in: the logic is inside the events server actions with Organizer Suite entitlement checks; extract first.
