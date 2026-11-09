# Staff API contract (v1)

For the Business app (`mobile/business`). Base path: `/api/staff`. All routes are read-only `GET`s in this version.

## Authentication

Send the Supabase access token on every request:

```
Authorization: Bearer <access_token>
```

There is no cookie fallback, and the student API's `x-danceflow-access-token` header is not accepted. When a request returns `401`, refresh the session once and retry. If it still returns `401`, sign the user out.

## Errors

Every refusal is JSON, and no route redirects. Branch on `code`. `error` is display text and may change.

```json
{ "error": "This workspace is paused until billing is resolved.", "code": "workspace_paused" }
```

| Status | `code` | Meaning | What the app should do |
| --- | --- | --- | --- |
| 400 | `invalid_request` | A malformed workspace id, appointment id or date | Treat as a client bug |
| 401 | `unauthenticated` | Token missing, invalid or expired | Refresh once, then sign out |
| 403 | `account_inactive` | Account deactivated, pending deletion, banned or without a profile | Sign out and explain |
| 403 | `platform_admin_unsupported` | Platform admins cannot use this API in v1 | Explain, and send them to the web |
| 403 | `not_a_member` | No active membership of that workspace. A workspace that does not exist gives the same answer | Refresh `/me` and leave the workspace |
| 403 | `workspace_paused` | The workspace's subscription is not `active` or `trialing` | Show the paused screen; billing stays on the web |
| 403 | `role_not_permitted` | The role has no access to this feature | Hide the feature |
| 404 | `not_found` | The appointment is missing, in another studio, or not the caller's to read. These cases are indistinguishable | Show "not found" and refresh the list |
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
      "accessAllowed": true,
      "subscriptionStatus": "active",
      "capabilities": { "viewStudioSchedule": true, "viewClients": false }
    }
  ]
}
```

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
- Render times in `timeZone`, not the device's zone.

## `GET /api/staff/workspaces/{studioId}/appointments/{appointmentId}`

Requires `capabilities.viewStudioSchedule`. Instructors can read their own appointments. Owners, admins and front desk can read any appointment in the studio. `accessScope` reports which rule applied (`own-instructor` or `broad`).

The response is the same shape as a Today row, plus:

```json
{
  "studioId": "uuid",
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

- `roster` is present only for `group_class`, and lists enrolled dancers only. `capacity: null` means no limit. `attendanceStatus` is `null` until attendance is recorded.
- An attendee's `name` can be `null` for an instructor (see Known limits). Keep the row and show a neutral label such as "Dancer". Owners, admins and front desk always get a name.
- `recap` is present only for `private_lesson` and is `null` if none has been written.

## Not in v1

- **Financial and CRM data:** prices, payment state, package balances, referral source and contact details are not returned to any role, including owners.
- **Writes:** attendance, recaps and every other mutation.
- **Independent instructors and organizer roles:** both get `role_not_permitted` on schedule routes. An instructor's own floor rental is also not served, which matches the web detail page.
- **Events** on the day schedule, which the web schedule page does show.
- **Lesson recap video.**

## Known limits

- **Class roster names for instructors:** `clients` RLS does not let an instructor read client rows, and the teaching RPC only covers an appointment's primary client. So an instructor sees the name of a class attendee only if that person is also in their private-lesson teaching relationship. A dedicated instructor roster RPC would remove this limit and needs a SQL migration.
- **Instructor lookup failures:** `resolveViewerInstructorId` returns null on a read error as well as on no match, so a transient failure can show as `instructorId: null` with an empty day rather than a `503`. It fails closed, but it can look like an unlinked account.
- **Workspace activity:** these routes do not write `last_workspace_access_at` or `workspace_access_logs` as the web layout does, so mobile-only activity does not count as workspace access.
- **Rate limiting:** none is applied yet.
