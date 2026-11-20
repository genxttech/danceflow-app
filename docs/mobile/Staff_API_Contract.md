# Staff API contract (v1)

For the Business app (`mobile/business`). Base path: `/api/staff`.

Status of each route:
- **Live in Git:** `GET /me`, `GET …/today` and `GET …/appointments/{id}` (#439/#440).
- **Implemented in Git:** the slice-2 routes and fields below, marked **slice 2** (branch `claude/staff-api-slice2`, stacked on #440). They are tested against real RLS and over HTTP with real GoTrue tokens, and not yet merged or deployed.
- **Planned:** see the end of this doc.

## Authentication

Send the Supabase access token on every request:

```
Authorization: Bearer <access_token>
```

There is no cookie fallback, and the student API's `x-danceflow-access-token` header is not accepted. When a request returns `401`, refresh the session once and retry. If it still returns `401`, sign the user out.

## Formats

- **Timestamps** are ISO 8601 UTC with milliseconds, for example `2026-11-09T15:00:00.000Z`. The server normalizes them (**slice 2**). A build without slice 2 returns the database form `2026-11-09T15:00:00+00:00`; both parse as the same instant.
- **Dates** are `YYYY-MM-DD` in the studio's time zone.
- **Time zones** are IANA names, for example `America/New_York`. Render studio times in the studio's `timeZone`, never the device's zone.

## Errors

Every refusal is JSON, and no route redirects. The shape is flat: `error` is display text and may change, and `code` is stable. Branch on `code`.

```json
{ "error": "This workspace is paused until billing is resolved.", "code": "workspace_paused" }
```

| Status | `code` | Meaning | What the app should do |
| --- | --- | --- | --- |
| 400 | `invalid_request` | A malformed id, date, query, body or header | Treat as a client bug |
| 401 | `unauthenticated` | Token missing, invalid or expired | Refresh once, then sign out |
| 403 | `account_inactive` | Account deactivated, pending deletion, banned or without a profile | Sign out and explain |
| 403 | `platform_admin_unsupported` | Platform admins cannot use this API in v1 | Explain, and send them to the web |
| 403 | `not_a_member` | No active membership of that workspace. A workspace that does not exist gives the same answer | Refresh `/me` and leave the workspace |
| 403 | `workspace_paused` | The workspace's subscription is not `active` or `trialing` | Show the paused screen; billing stays on the web |
| 403 | `role_not_permitted` | The role has no access to this feature | Hide the feature |
| 404 | `not_found` | The record is missing, in another studio, or not the caller's to read. These cases are indistinguishable | Show "not found" and refresh the list |
| 409 | `not_markable` | **slice 2.** Attendance can't be recorded for this appointment: it isn't a group class, or the class is cancelled | Refresh the class and explain |
| 403 | `writes_disabled` | **Write routes added after v0.1.** The server's kill switch for this capability is off (or unreadable: fail closed). Reads are unaffected | Show "This change is turned off right now"; do not retry in a loop |
| 426 | `upgrade_required` | **Write routes added after v0.1.** The build is too old, blocked, or sent no `X-DanceFlow-App` header | Show the update prompt; the write was not applied |
| 503 | `service_unavailable` | A dependency failed, including token verification | Retry with backoff. Do not sign out |

Responses carry `Cache-Control: private, no-store`. Do not persist them beyond what the screen needs, because they contain client names.

## `GET /api/staff/me`

Who the caller is and which workspaces they can open. Call this at launch and after any `not_a_member`.

```json
{
  "user": { "id": "uuid", "email": "a@example.com", "fullName": "Ida Instructor" },
  "workspaces": [
    {
      "studioId": "uuid",
      "name": "Studio A",
      "publicName": "Studio A Dance",
      "slug": "studio-a",
      "role": "instructor",
      "timeZone": "America/New_York",
      "accessAllowed": true,
      "subscriptionStatus": "active",
      "capabilities": { "viewStudioSchedule": true, "viewClients": false, "markAttendance": true }
    }
  ]
}
```

- `timeZone` (**slice 2**) is the studio's zone. A studio with no usable zone reports `America/New_York`, the same fallback the web schedule uses.
- `workspaces` is empty for a signed-in person with no staff role. That is a `200`, not an error. Send them to the Student app.
- A paused workspace is still listed, with `accessAllowed: false`, so the app can explain it. Its workspace routes return `workspace_paused`.
- `role` is one of `studio_owner`, `studio_admin`, `front_desk`, `instructor`, `independent_instructor`, `organizer_owner`, `organizer_admin`, `organizer_staff`. Treat an unknown value as having no features.
- There is one entry per studio, with the role the web would resolve.
- `capabilities` is abridged above. Every key comes from `src/lib/auth/permissions.ts`, and the full set is in `src/lib/auth/staffCapabilities.ts`. Use it to shape navigation only. It is a role-level hint: the server enforces each route itself, a `true` does not mean a route exists yet, and it does not reflect plan entitlements or per-user export overrides. Treat a missing key as `false`.

## `GET /api/staff/workspaces/{studioId}/today?date=YYYY-MM-DD`

The caller's own teaching appointments for one local day in that studio. Requires `capabilities.viewStudioSchedule`.

`date` is optional and defaults to today in the studio's time zone. All statuses are returned, including `cancelled`, so filter on the client if needed.

```json
{
  "studioId": "uuid",
  "date": "2026-11-09",
  "timeZone": "America/New_York",
  "instructorId": "uuid",
  "appointments": [
    {
      "id": "uuid",
      "title": null,
      "appointmentType": "private_lesson",
      "status": "scheduled",
      "startsAt": "2026-11-09T15:00:00.000Z",
      "endsAt": "2026-11-09T15:45:00.000Z",
      "room": { "id": "uuid", "name": "Main Floor" },
      "locationName": null,
      "client": { "id": "uuid", "firstName": "Ana", "lastName": "Rivera" },
      "partner": null
    }
  ]
}
```

- Always scoped to the caller, whatever their role. An owner who teaches sees their own lessons here, not the studio's.
- `instructorId: null` means the caller has no active instructor record at this studio, so `appointments` is empty. Show "not linked to an instructor profile". This is also what a failed instructor lookup looks like (see Known limits).
- `client` and `partner` can be `null` even when the appointment has one. Names come through the teaching relationship rule: scheduled, confirmed or rescheduled lessons that have not ended, or attended lessons from the last 14 days. A partner's name appears only if they are also a primary client in that window. Show a neutral "Client" label, not an error.

## `GET /api/staff/workspaces/{studioId}/schedule?date=YYYY-MM-DD` (slice 3)

The whole studio's appointments for one local day, for **owners, admins and front desk only** (role `studio_owner`, `studio_admin` or `front_desk` in `/me`). Instructors get `403 role_not_permitted` and keep `today`: a studio-wide list would bypass the teaching-relationship window on client names. Independent instructors and organizer roles are refused too. The role check runs before any appointment or client read.

`date` is optional and defaults to today in the studio's time zone; a malformed or impossible date is `400 invalid_request`. The day is the studio's local day (23 or 25 hours on a DST change), and a row belongs to the day its `startsAt` falls in.

```json
{
  "studioId": "uuid",
  "date": "2026-11-09",
  "timeZone": "America/New_York",
  "truncated": false,
  "appointments": [
    {
      "id": "uuid",
      "title": null,
      "appointmentType": "private_lesson",
      "status": "scheduled",
      "startsAt": "2026-11-09T15:00:00.000Z",
      "endsAt": "2026-11-09T15:45:00.000Z",
      "room": { "id": "uuid", "name": "Main Floor" },
      "locationName": null,
      "client": { "id": "uuid", "firstName": "Ana", "lastName": "Rivera" },
      "partner": null,
      "instructor": { "id": "uuid", "firstName": "Ida", "lastName": "Instructor" }
    }
  ]
}
```

- Same row shape as `today` plus `instructor` (`null` for a floor rental or an unassigned slot). Sorted by `startsAt`, then id. All statuses are returned, including `cancelled`. Floor rentals are included, as on the web calendar. Events are not (as in `today`).
- Client names are the studio's own client names (broad staff scope, as on the appointment detail). No prices, payment state, package balances, contact details or referral source.
- At most 500 rows; a day with more is cut and `truncated` is `true`. There is no paging.
- Open the row with `GET .../appointments/{appointmentId}`: broad staff already have access there.

## `GET /api/staff/workspaces/{studioId}/pulse` (slice 3)

The Business home summary: counts for today and the next appointment. Requires `capabilities.viewStudioSchedule` (owner, admin, front desk, instructor; independent instructors and organizer roles get `403 role_not_permitted`).

```json
{
  "studioId": "uuid",
  "timeZone": "America/New_York",
  "date": "2026-11-09",
  "asOf": "2026-11-09T15:30:00.000Z",
  "scope": "studio",
  "instructorId": null,
  "today": { "total": 5, "upcoming": 4, "cancelled": 1, "truncated": false },
  "next": {
    "id": "uuid",
    "appointmentType": "private_lesson",
    "title": null,
    "status": "scheduled",
    "startsAt": "2026-11-09T16:00:00.000Z",
    "endsAt": "2026-11-09T16:45:00.000Z"
  },
  "newClientsLast7Days": 3
}
```

- `scope` is `studio` for owner, admin and front desk, and `own` for an instructor, whose numbers are their own teaching day (the same boundary as `today`). An instructor with no instructor record gets `instructorId: null`, zero counts and `next: null`, never the studio's numbers.
- `today` is the studio's local day. `total` excludes cancelled appointments, `cancelled` counts them, `upcoming` is the part of `total` that has not started yet at `asOf`. `truncated` is `true` when the day has more than 500 appointments and the counts are for the first 500.
- `next` is the earliest appointment from now on whose status is `scheduled`, `confirmed` or `rescheduled` (any day), or `null`. It carries no client names; open it with the appointment detail route.
- `newClientsLast7Days` counts clients created in the last 7 days. It is `null` for an instructor, who has no studio-wide client view.
- No names, prices, payment state, contact details or referral source appear anywhere in this response.

## `GET /api/staff/workspaces/{studioId}/appointments/{appointmentId}`

Requires `capabilities.viewStudioSchedule`. Instructors can read their own appointments. Owners, admins and front desk can read any appointment in the studio. `accessScope` reports which rule applied (`own-instructor` or `broad`).

The response is the same shape as a Today row, plus:

```json
{
  "studioId": "uuid",
  "timeZone": "America/New_York",
  "accessScope": "own-instructor",
  "notes": "Teaching note",
  "instructor": { "id": "uuid", "firstName": "Ida", "lastName": "Instructor" },
  "roster": {
    "bookedCount": 1,
    "capacity": 10,
    "attendees": [{ "clientId": "uuid", "name": "Ana Rivera", "attendanceStatus": "attended" }]
  },
  "recap": {
    "summary": "Worked on frame",
    "homework": "Practice box step",
    "nextFocus": "Timing",
    "visibleToClient": true,
    "updatedAt": "2026-11-09T16:00:00.000Z"
  }
}
```

- `timeZone` (**slice 2**) is the studio's zone, so the app no longer needs to carry it from Today.
- `roster` is present only for `group_class`, and lists enrolled dancers only. It is the roster to mark attendance against; there is no separate roster route. `capacity: null` means no limit.
- `attendanceStatus` is `null` until attendance is recorded, then one of `registered`, `checked_in`, `attended`, `no_show`, `cancelled` (the `attendance_records` set). The app can set only `attended` and `no_show`; the other values come from the web, student check-in or class cancellation.
- An attendee's `name` comes from `get_class_roster_names_for_instructor` for the assigned instructor and from the client record for owners, admins and front desk. It is `null` only when no name is readable. Keep the row and show a neutral label such as "Dancer".
- `recap` is present only for `private_lesson` and is `null` if none has been written.

## `PUT /api/staff/workspaces/{studioId}/appointments/{appointmentId}/attendance/{clientId}` (slice 2)

Marks one enrolled dancer present or absent on a group class. It reuses the web attendance write, so the same database guards and triggers apply.

Request:

```
Idempotency-Key: <8–128 characters: letters, digits, - _ : .>
Content-Type: application/json

{ "status": "attended" }
```

- `status` is `attended` (present) or `no_show` (absent; show it as "No-show"). Anything else is `400 invalid_request`.
- `Idempotency-Key` is required, and its absence is a `400`. Send a new key per user action and reuse it on retries. The write is idempotent by state: if the dancer already has the requested status, nothing is written and the current record comes back with `200`. The server does not store keys in v1.

Response `200`:

```json
{ "attendee": { "clientId": "uuid", "displayName": "Ana Rivera", "status": "attended", "updatedAt": "2026-11-09T16:02:11.000Z" } }
```

Who may call it and what each answer means:
- **Roles:** owners, admins and front desk may mark any group class in the studio. An instructor may mark only a class currently assigned to them. Independent instructors and organizer roles get `403 role_not_permitted`. A floor-rental relationship never authorizes this.
- **Not the caller's class:** a class that isn't the caller's to mark, a missing class, or one in another studio returns `404 not_found`.
- **Not on the roster:** a `clientId` that isn't enrolled in the class (`booked`) returns `404 not_found`.
- **Not markable:** a non-class appointment or a cancelled class returns `409 not_markable`.
- `displayName` follows the roster name rules above and can be `null`.

## Class roster: drop-in enroll and remove (Phase 1A, S2)

Both routes sit behind the write gate (capability `classRoster`, `X-DanceFlow-App` header) and call the same code as the web "Enroll student" and "Remove" buttons (`src/lib/staff/classRoster.ts`, which calls the database functions `enroll_class_attendee` and `cancel_class_attendee`). Capacity, duplicates, cancelled classes and funding are decided in the database under row locks, so a race can never overfill a class or enroll a dancer twice.

### `POST /api/staff/workspaces/{studioId}/appointments/{appointmentId}/roster`

```
Idempotency-Key: <8–128 characters: letters, digits, - _ : .>
Content-Type: application/json

{ "clientId": "uuid", "billingType": "free_comped", "clientPackageId": null, "clientMembershipId": null }
```

- `clientId` is required. `billingType` is optional: `package_credit`, `membership`, `pay_as_you_go` or `free_comped` (database default `package_credit`). `clientPackageId` and `clientMembershipId` are optional ids; `membership` needs `clientMembershipId` (`400 invalid_request` without it).
- A package credit is **not** taken at enrollment. It is taken when attendance is recorded, as on the web.
- Response `201 { "attendee": { "id": "uuid", "clientId": "uuid", "alreadyEnrolled": false } }`. A dancer who is already enrolled is a replay (natural domain key): `200` with the existing attendee and `alreadyEnrolled: true`, never a second row.
- **Roles:** owner, admin and front desk for any class in the studio; an instructor only for their own class. **An instructor's `billingType` and ids are ignored by the database**: it enrolls the dancer only when they have exactly one eligible package or membership, otherwise `409 ambiguous_funding_source` ("ask an owner, admin or front desk"). Independent instructors and organizer roles get `403 role_not_permitted`.
- Refusals: `404 not_found` (missing class, another studio's, not the caller's class, a private lesson, or a client of another studio); `409` with `class_full`, `class_cancelled`, `no_eligible_entitlement`, `entitlement_exhausted`, `membership_not_active`, `ambiguous_funding_source`, or `invalid_funding` (the package or membership is not an active one of this dancer). `409` bodies carry `current: null`.
- Dancer notice: after the enrollment commits the dancer gets the same confirmation (email and push, no SMS) as from the web, once per new attendee row.

### `DELETE /api/staff/workspaces/{studioId}/appointments/{appointmentId}/roster/{clientId}`

Removes a dancer, addressed by client id (the roster the app shows lists clients, not attendee rows). `Idempotency-Key` required, no body.

- Response `200 { "removed": true, "alreadyApplied": false }`. Removing a dancer who was already removed is a no-op: `200` with `alreadyApplied: true`, no second notice.
- `404 not_found`: class missing, in another studio, not the caller's, or the client was never on the roster. `409 attendance_recorded`: the dancer's attendance is already recorded, so they can't be removed. Roles as above.
- The removal notice to the dancer is sent only when the removal actually changed a booked dancer.

## `GET /api/staff/workspaces/{studioId}/clients?q=&cursor=&limit=` (slice 2)

Client lookup.
- **Owners, admins and front desk** (`capabilities.viewClients`) search the studio's `active` clients.
- **Instructors** search only the clients they teach. This is the teaching relationship rule above: their current and upcoming lessons, plus attended lessons from the last 14 days.
- **Other roles** get `403 role_not_permitted`.

Parameters:
- `q`: optional, at most 80 characters, matched case-insensitively against first and last name. Wildcard characters are treated literally.
- `limit`: 1–50, default 25.
- `cursor`: the `nextCursor` from the previous page, used as-is. A cursor that doesn't decode is `400`.

```json
{
  "clients": [{ "id": "uuid", "firstName": "Ana", "lastName": "Rivera", "status": "active" }],
  "nextCursor": null
}
```

- Ordered by last name, then first name, then id.
- `status` is the client's CRM status (`lead`, `contacted`, `consultation_booked`, `converted`, `lost`, `active`, `inactive`, `archived`). It is always `active` in a front-desk search, and `null` for instructors, who can't read client records.
- `nextCursor: null` means there are no more pages.

## `GET /api/staff/workspaces/{studioId}/clients/{clientId}` (slice 2)

A client summary with no money and no contact details. Same role rules as the search. An instructor gets `404 not_found` for a client they don't teach.

```json
{
  "client": { "id": "uuid", "firstName": "Ana", "lastName": "Rivera", "status": "active" },
  "timeZone": "America/New_York",
  "activePackages": [
    {
      "id": "uuid",
      "name": "10 Private Lessons",
      "expiresOn": "2027-01-31",
      "items": [{ "usageType": "private_lesson", "remaining": 4, "unlimited": false }]
    }
  ],
  "nextAppointment": {
    "id": "uuid",
    "appointmentType": "private_lesson",
    "title": null,
    "startsAt": "2026-11-12T15:00:00.000Z",
    "endsAt": "2026-11-12T15:45:00.000Z"
  }
}
```

- `timeZone` is the studio's zone, for rendering `nextAppointment`.
- `activePackages` are packages that are active, not archived and not expired (in the studio's zone), with remaining counts only: no prices, payments or totals. It is `null` for instructors, who can't see package balances.
- `nextAppointment` is the earliest upcoming `scheduled`, `confirmed` or `rescheduled` appointment, or `null`. For owners, admins and front desk that means a lesson where the client is the primary or partner client, or a group class they're booked into. For instructors it is only the instructor's own lessons with that client.
- `status` is `null` for instructors, as in the search.

## `POST /api/staff/workspaces/{studioId}/clients/{clientId}/notes` (client slice C1)

Adds an activity note to a client. It is the web "Add note" action's own write (shared module `src/lib/staff/clientNotes.ts`), so validation, columns and the database guards are the same.

Request:

```
Idempotency-Key: <8–128 characters: letters, digits, - _ : .>
Content-Type: application/json

{ "body": "Called about the showcase.", "noteType": "follow_up", "occurredAt": "2026-11-20T15:30:00Z" }
```

- `body` is required, trimmed, at most 5000 characters (the web form has no cap; the API adds one).
- `noteType` is optional: `general` (default), `follow_up`, `sales`, `lesson`, `billing` or `concern`.
- `occurredAt` is optional ISO 8601; it defaults to now. Any other field is ignored.
- `Idempotency-Key` is required. **The key is not stored**, and a note insert is not idempotent by state, so the route de-duplicates instead: an identical note (same studio, client, author, `noteType` and `body`) created within the last 120 seconds is returned, not inserted again. Reuse the same key and body when retrying a lost response.

Response: `201` with the new note, or `200` with the existing note when it was a retry:

```json
{ "note": { "id": "uuid", "clientId": "uuid", "noteType": "follow_up", "body": "Called about the showcase.", "occurredAt": "2026-11-20T15:30:00+00:00", "createdAt": "2026-11-20T15:30:02.123+00:00" } }
```

Who may call it and what each answer means:
- **Write guard:** the route is behind the per-capability kill switch (`clientNotes`) and the minimum-app-version gate (`X-DanceFlow-App` header): `403 writes_disabled` while the capability is not enabled, `426 upgrade_required` for a missing or too-old build. Identity and membership refusals come first.
- **Roles:** owners, admins and front desk (`canEditClients`, the same as the web action). Instructors, independent instructors and organizer roles get `403 role_not_permitted`.
- **Another studio's client, or a client that does not exist:** `404 not_found` (indistinguishable). A workspace the caller does not belong to is `403 not_a_member`.
- **Bad input** (missing or blank `body`, unknown `noteType`, unparsable `occurredAt`, non-string fields, over-long `body`, malformed ids or key): `400 invalid_request`.
- The write is made with the caller's own token, so row-level security applies (an active membership of that studio and a client of the same studio).
- **What is recorded:** the note row (`studio_id`, `client_id`, `note_type`, `body`, `occurred_at`, `created_by` = the caller). The web action writes nothing else (no audit table, no outbox), and `client_activity_notes` has no source column, so a note made on a phone is not marked as such.

## `POST /api/staff/workspaces/{studioId}/clients` (client slice C2, quick add)

Creates a client (a `lead`) with the fewest fields a front desk needs at the door. It is the web "New client" action's own create path (shared module `src/lib/staff/clientCreate.ts`: the same payload builder, the same duplicate-email rule, the same insert), with a minimal body.

Request:

```
Idempotency-Key: <8–128 characters: letters, digits, - _ : .>
Content-Type: application/json

{ "firstName": "Ana", "lastName": "Rivera", "phone": "(555) 010-0100", "email": "ana@example.com", "note": "Met at the showcase.", "allowDuplicatePhone": false }
```

- `firstName`, `lastName`: required, at most 80 characters (the web limits).
- `phone` and/or `email`: at least one is required. They are normalized as on the web: the email is lower-cased; a US number is stored as `+1XXXXXXXXXX`, other numbers need an international `+` form.
- `note`: optional, at most 3000 characters; stored in the client's `notes` field (the web form's "Notes"), not as an activity note.
- `allowDuplicatePhone`: optional boolean, default `false` (see below).
- Everything else the web form has (address, birthday, partner, photo, onboarding documents, status) is not accepted; unknown fields are ignored. The client is created with status `lead`, exactly like a web-created lead, with no referral source and no source marker (the table has none that is truthful for a phone; `source_system` belongs to imports).
- `Idempotency-Key` is required and **not stored**. A retry of a create whose answer was lost is caught by the duplicate rule below (the second attempt answers `409 duplicate_client` with the id of the client the first attempt created), so the app should open that client.

Response `201`:

```json
{ "client": { "id": "uuid", "firstName": "Ana", "lastName": "Rivera", "status": "lead" } }
```

Duplicate response `409` (nothing was created):

```json
{ "error": "A client with this email already exists in this studio.", "code": "duplicate_client", "existingClientId": "uuid", "matchedOn": "email" }
```

- **Email** match (exact, same studio): always blocks, as on the web.
- **Phone** match (same studio; the stored forms `+1XXXXXXXXXX`, `XXXXXXXXXX` and `1XXXXXXXXXX` all match): blocks, because a retry or a returning dancer is the common case. A household can share a phone, so the app may resend with `allowDuplicatePhone: true` after the person confirms; that skips only the phone match, never the email match. Treat `existingClientId` as an invitation to open that client instead (use `GET …/clients/{id}`).
- Matching never looks outside the caller's studio.

Who may call it and what each answer means:
- **Write guard:** the route is behind the per-capability kill switch (`clientCreate`) and the minimum-app-version gate (`X-DanceFlow-App` header): `403 writes_disabled` while the capability is not enabled, `426 upgrade_required` for a missing or too-old build. Identity and membership refusals come first.
- **Roles:** owners, admins and front desk (`canEditClients`, the same as the web action). Instructors, independent instructors and organizer roles get `403 role_not_permitted`; a workspace the caller does not belong to is `403 not_a_member`.
- **Bad input** (missing names, neither phone nor email, over-long or malformed fields, non-string values, missing key): `400 invalid_request`; the `error` text is the web's own validation message.
- The write is made with the caller's own token, so row-level security applies.

## Planned, not in slice 2

- **Session recap writes.**
- **Event door check-in:** the web logic lives inside the events registration server actions, together with Organizer Suite entitlement checks. It needs extracting into a shared module before an API can reuse it, so it is not exposed yet.
- **Not in v1 for any role:** prices, payment state, contact details, referral source and lesson recap video. Package remaining counts are the only balance information, in client detail, for owners, admins and front desk.
- **Independent instructors and organizer roles:** they get `role_not_permitted` on schedule, client and attendance routes. An instructor's own floor rental is not served, which matches the web detail page.
- **Events** on the day schedule, which the web schedule page does show.

## Known limits

- **Class roster names depend on migration `20270214120000`:** until it is applied to a database, a detail request for a group class by its assigned instructor returns `503`. Apply the SQL before deploying the app.
- **Instructor lookup failures:** `resolveViewerInstructorId` returns null on a read error as well as on no match, so a transient failure can show as `instructorId: null` with an empty day rather than a `503`. It fails closed, but it can look like an unlinked account.
- **Workspace activity:** these routes do not write `last_workspace_access_at` or `workspace_access_logs` as the web layout does, so mobile-only activity does not count as workspace access.
- **Rate limiting** (from PR 674, 2026-11-19): 600 requests a minute per IP address before the token is checked, and 240 a minute per user and IP after it; over the limit the answer is `429` with `{ "error", "code": "rate_limited" }` and a `Retry-After` header. The counters are in memory per server instance, so the limit is approximate and resets on a deploy.
- **Idempotency keys** are validated but not stored. Retries are safe because the attendance write is idempotent by state, not because the server remembers the key.
- **Conflicting attendance writes must not be queued (rule for the app).** Because the server keeps no key, requests replayed later are applied in arrival order and the last one wins. A queued "attended" followed by a queued "no_show" (or the reverse) therefore ends at whichever arrives last, not at what the person decided last. Worse, "attended" deducts a package credit through a database trigger and "no_show" does not give it back, so a flip can leave a credit deducted for someone marked absent. The app must send an attendance mark only while online, one at a time, wait for the answer before allowing the next change to the same person, and never keep a queue of attendance writes for replay. A failed or unknown result is shown to the person and re-read from the server, not retried blindly with a different status.
- **Attendance notes** (from PR 674): a status change made through this route leaves the record's notes as they are; earlier behaviour (the shared writer set notes to null on update) could erase notes written on the web.
- **Attendee name after a write:** the name in the response is looked up after the write has committed; if that lookup fails the response is still `200` with `displayName: null`, not a `503`.
- **Client cursors** are opaque; a cursor the server did not issue answers `400 invalid_request`.
- **Instructor client scope** follows the teaching relationship window. A student whose last attended lesson with the instructor ended more than 14 days ago, and who has nothing upcoming with them, drops out of the instructor's search and summary.

## Write gate (Phase 0, P0-1)

Every write route added after v0.1 goes through `requireStaffWrite(request, studioId, capability)` (`src/lib/staff/writeGuard.ts`), capability keys `appointmentAttendance`, `clientNotes`, `clientCreate`, `classRoster`. The v0.1 class-attendance route predates it and is not behind it.

- **Header:** `X-DanceFlow-App: business/<versionName>/<versionCode>/<android|ios>`, for example `business/0.2.0/3/android`. Required on every gated write; missing, malformed, another app id, a code below the platform minimum or a blocked code = `426 upgrade_required`. Reads never need it.
- **Policy:** one server environment variable `STAFF_API_WRITE_POLICY`, JSON: `{"enabled": ["clientNotes"], "minimumCode": {"android": 2}, "blockedCodes": {"android": [1]}}`. **Fail closed:** unset, empty, not JSON, or any malformed field means every write is `403 writes_disabled`; a capability not listed in `enabled` is disabled. It is read on each request; changing it takes a redeploy.
- **Order:** identity, membership and pause refusals (401/403) first, then `writes_disabled`, then `upgrade_required`.

## Write helpers: idempotency patterns, conflicts, error-code registry (Phase 0, P0-2)

Shared by every write route added after v0.1 (`src/lib/staff/writeSupport.ts`). No migration and no stored keys.

- **`Idempotency-Key` is required on every write** (8-128 characters of letters, digits, `- _ : .`) and is not stored. A retry must reuse the same key and the same body.
- **Three patterns make a retry safe** (each write names its pattern in its design note): (1) **state-based**: setting a status that is already set is a no-op that returns the current record with `alreadyApplied: true` (attendance, attended/no-show, cancel attendee); (2) **client-supplied entity id**: the app sends a UUID it generated once per user action (`noteId`, `clientId`), the route inserts with that id; an identical replay returns the existing row with `200`, the same id with different content is `409 idempotency_conflict`; (3) **natural domain key**: the existing uniqueness rule is read as a replay (a dancer already enrolled in the class returns the existing attendee with `200`, `alreadyEnrolled: true`).
- **Conflicts are `409 { error, code, current }`**, where `current` is the server's present state of the thing the app tried to change, so the app can show it and reconcile (replace its local copy with `current`, do not blindly retry).
- **Bodies** are JSON objects of at most 16 KB; anything else is `400 invalid_request`. A write route returns flat errors only.
- **Error-code registry for writes** (lower snake case; a slice adds its codes here): `writes_disabled` (403) and `upgrade_required` (426) from the write gate; `idempotency_conflict` (409); slice codes are defined in each slice's design note (`outcome_conflict`, `payment_required`, `duplicate_email`, the roster codes such as `class_full`, `already_enrolled`).
