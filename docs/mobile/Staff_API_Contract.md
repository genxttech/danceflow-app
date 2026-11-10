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

## Planned, not in slice 2

- **Studio schedule:** a studio-wide day view for front desk and admins.
- **Pulse:** the studio summary for the Business home screen.
- **Session recap writes.**
- **Event door check-in:** the web logic lives inside the events registration server actions, together with Organizer Suite entitlement checks. It needs extracting into a shared module before an API can reuse it, so it is not exposed yet.
- **Not in v1 for any role:** prices, payment state, contact details, referral source and lesson recap video. Package remaining counts are the only balance information, in client detail, for owners, admins and front desk.
- **Independent instructors and organizer roles:** they get `role_not_permitted` on schedule, client and attendance routes. An instructor's own floor rental is not served, which matches the web detail page.
- **Events** on the day schedule, which the web schedule page does show.

## Known limits

- **Class roster names depend on migration `20270214120000`:** until it is applied to a database, a detail request for a group class by its assigned instructor returns `503`. Apply the SQL before deploying the app.
- **Instructor lookup failures:** `resolveViewerInstructorId` returns null on a read error as well as on no match, so a transient failure can show as `instructorId: null` with an empty day rather than a `503`. It fails closed, but it can look like an unlinked account.
- **Workspace activity:** these routes do not write `last_workspace_access_at` or `workspace_access_logs` as the web layout does, so mobile-only activity does not count as workspace access.
- **Rate limiting:** none is applied yet.
- **Idempotency keys** are validated but not stored. Retries are safe because the attendance write is idempotent by state, not because the server remembers the key.
- **Instructor client scope** follows the teaching relationship window. A student whose last attended lesson with the instructor ended more than 14 days ago, and who has nothing upcoming with them, drops out of the instructor's search and summary.
