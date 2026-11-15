# Staff API proposals

Additions the Business app needs beyond slice 2. Errors stay flat `{error, code}`; every route goes through `requireStaffApi` before any data read, with a refusal test per role. Status as of 2026-11-15.

| | Proposal | Status |
|---|---|---|
| P2 | Studio day schedule | **Shipped** (#535): `GET .../schedule?date=`, see the contract |
| P5 | Pulse summary | **Shipped** (#538): `GET .../pulse`, see the contract |
| P1 | Device token registration | **Needs a migration** (draft SQL below, not applied) |
| P3 | Waitlist | **Blocked: no data model** |
| P4 | Recap writes | **Deferred: needs a shared-module extraction first** |

## P1. Device token registration (push)

`PUT /api/staff/devices/{deviceId}` body `{ platform: "android"|"ios", token, appVersion }`, and `DELETE` on sign-out. Per user, not per studio: a person who works at two studios has one phone. The app side (`pushSetup.ts`) already treats a missing endpoint as "registered: false".

Draft SQL (NOT applied anywhere; the coordinator runs hosted SQL). RLS on, no anon grant, a user reads and writes only their own rows, and the token never leaves the table (no route returns it):

```sql
create table public.staff_device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null check (length(device_id) between 8 and 128),
  platform text not null check (platform in ('android', 'ios')),
  token text not null check (length(token) between 20 and 4096),
  app_version text check (app_version is null or length(app_version) <= 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, device_id)
);
create index staff_device_tokens_token_idx on public.staff_device_tokens (token);
alter table public.staff_device_tokens enable row level security;
revoke all on public.staff_device_tokens from anon, authenticated;
grant select, insert, update, delete on public.staff_device_tokens to authenticated;
create policy staff_device_tokens_own on public.staff_device_tokens
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
```

Rules to implement with it: upsert by `(user_id, device_id)`; when a token is registered by a different user (a shared phone), revoke the older row; the sender (not built) drops a row on a provider "unregistered" answer; `DELETE` sets `revoked_at`. Tests: no token, wrong user cannot touch another user's row (real RLS), shared-phone revoke, invalid platform and oversized token are `invalid_request`. Needs the Firebase credentials work before anything is sent.

## P3. Waitlist

There is no class waitlist in the data model today: `appointment_attendees.status` is only `booked` or `cancelled`, and the roster capacity rules live in the enroll/cancel RPCs. A waitlist is a product feature (who is promoted, when, with what notice), which needs its own table or a new attendee status plus the promotion rules. The app already shows "N of M booked · Full". Not a no-migration item; no SQL drafted until the product rule is chosen.

## P4. Session recap writes

No migration needed (`lesson_recaps` exists), but the web logic is a 534-line server action (`src/app/app/schedule/[id]/attendance/recap-actions.ts`) that also sends push notifications to the clients, syncs syllabus steps and media links, and uses the cookie client and redirects. It has to be extracted into a shared module the API can call, and the notification behaviour when a recap is marked visible to the client needs an owner decision (should an instructor's phone save notify the dancer?). Recommended order: extract with no behaviour change first (own PR, web tests), then the API route.

## Deferred

Event door check-in: the logic is inside the events server actions with Organizer Suite entitlement checks; extract first.
