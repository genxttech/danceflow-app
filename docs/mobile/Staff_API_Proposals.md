# Staff API proposals (not implemented)

Additions the Business app needs beyond slice 2. Each is a proposal: no route exists, no behaviour is promised. Errors stay flat `{error, code}`; every route goes through `requireStaffApi` before any data read, with a refusal test per role.

## P1. Device token registration (push)

`PUT /api/staff/workspaces/{studioId}/devices/{deviceId}` body `{ platform: "android"|"ios", token, appVersion }`; `DELETE` on sign-out. Needs a new table keyed by user + device (migration, coordinator-run on hosted DBs), a retention rule (drop on sign-out and on provider "unregistered"), and the token never logged. The app side (`pushSetup.ts`) already treats a missing endpoint as "registered: false" and carries on. Open: per-studio or per-user token; recommend per-user with studio opt-in rows.

## P2. Studio day schedule (front desk, admin)

`GET .../schedule?date=` returning every appointment of the studio for the day (same row shape as `today`, plus `instructor`). Owners, admins and front desk only; instructors keep `today`. Pagination by day, not cursor. Events excluded in v1 (as `today`).

## P3. Waitlist and capacity on class rosters

Extend the appointment `roster` with `waitlistCount` and, for markers, `waitlist: [{clientId, name, position}]`. Today the app shows "N of M booked · Full" only. Read-only first; promotion from the waitlist stays on the web.

## P4. Session recap writes

`PUT .../appointments/{id}/recap` `{summary, homework, nextFocus, visibleToClient}` for the assigned instructor only, idempotent by state. Needs the web recap rules (visibility, notification to the client) extracted into a shared module first, as with door check-in.

## P5. Pulse summary

`GET .../pulse` with counts only (today's appointments, unmarked past classes, new clients this week). No money. Needed for the Pulse tab, which is a placeholder.

## Deferred

Event door check-in (logic is inside events server actions with Organizer Suite entitlement checks; extract first).
