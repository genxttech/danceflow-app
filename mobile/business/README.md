# DanceFlow Business

Expo app for studio staff: instructors first, owners and admins next. It reads the staff bearer API (`/api/staff/*`, contract in [`docs/mobile/Staff_API_Contract.md`](../../docs/mobile/Staff_API_Contract.md)).

Same Expo SDK (54) and React Native (0.81.5) as `mobile/student`, so both apps upgrade together. No EAS project, store config or native folders yet.

## Run it

```bash
cp .env.example .env   # fill in the Supabase project and the web origin
npm install --legacy-peer-deps
npx expo start
```

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The same Supabase project the web uses |
| `EXPO_PUBLIC_DANCEFLOW_WEB_URL` | The origin that serves `/api/staff/*` |

These values are inlined into the bundle and Metro caches them: after changing any of them, start or export with `--clear` (for example `npx expo export --clear --platform web`), or the old values ship.

## Checks

```bash
npm run typecheck
npm test
npx expo-doctor
npx expo export --platform android
```

## How it fits together

- **Auth** (`src/lib/auth.tsx`): Supabase password or email-link sign-in. The session lives in SecureStore (Keychain / Keystore) through `src/lib/secureSessionStorage.ts`, copied from the Student app (#438) until both move to `mobile/shared`. No account is ever created from this app.
- **API client** (`src/lib/staffApi.ts`): sends the access token as a bearer, refreshes once on a 401, and turns every refusal into a `StaffApiError` carrying the server's `code`. Screens branch on `staffErrorKind`, never on display text. Responses stay in memory only.
- **Navigation** (`src/lib/navigation.ts`): tabs come from `GET /api/staff/me` capabilities. Instructor: Today, Clients, More. Owner and admin: Pulse, Today, Clients, More. A paused workspace, or a role the v1 API does not serve, gets More only, with an explanation.
- **Today** (`src/screens/TodayScreen.tsx`): the caller's own appointments for one studio day, rendered in the studio's time zone, with skeleton, empty, not-linked and distinct error states. Rows open `app/appointments/[id].tsx`.
- **Design** (`src/theme.ts`): Business tokens from `docs/mobile/Mobile_Design_Direction.md`: paper surface, plum for actions only, 4–48 spacing with a 20 gutter. System font until the Bricolage / Hanken licences are confirmed.

## Client lookup and attendance (staff API slice 2, on)

The Clients tab (search, paging, client summary) and class-roster attendance (Present / No-show) follow the **final slice-2 contract** in `docs/mobile/Staff_API_Contract.md` (branch `claude/staff-api-slice2`, 2b071403). Both features are **on by default** since 2026-11-10. The owner's gate was an integration walk against the real endpoints (#453), which passed 27 of 27; see `docs/mobile/screenshots/business-shell/s2-walk-evidence.json`. A server must serve slice 2 before a build reaches it. To turn the features off for one build:

```bash
EXPO_PUBLIC_STAFF_FEATURES=none npx expo start --clear          # both off
EXPO_PUBLIC_STAFF_FEATURES=-attendance npx expo start --clear   # client lookup only
```

The wire format lives only in `src/lib/staffApi.ts` (the "SLICE 2" section and its `to…` adapters). The default lives in `src/lib/features.ts`.

| Endpoint | Used by |
| --- | --- |
| `GET /workspaces/{id}/clients?q=&cursor=&limit=` (limit 1–50; the app asks for 25) → `{ clients: [{ id, firstName, lastName, status }], nextCursor }` | Clients tab. Front desk and admins search active clients. Instructors get "My clients" (the teaching relationship), and their `status` is `null`, so it is hidden. 403 = no client lookup for this role |
| `GET /workspaces/{id}/clients/{clientId}` → `{ client, timeZone, activePackages, nextAppointment }` | Client screen. `activePackages` (id, name, `expiresOn`, items with remaining counts or unlimited) is `null` for instructors, so the section is hidden rather than shown empty. `nextAppointment` renders in `timeZone` |
| `PUT /workspaces/{id}/appointments/{appointmentId}/attendance/{clientId}` with `{ status }` (`ATTENDANCE_MARKS`: `attended`, `no_show`) and an `Idempotency-Key` header → `{ attendee: { clientId, displayName, status, updatedAt } }` | The roster in appointment detail (there is no separate roster route). Shown for `markAttendance` on the appointment's own studio, not for cancelled classes. 409 = not markable, 404 = not on the roster, 400 = missing key |

Each Present or No-show tap is one action with its own idempotency key (8–128 characters of `[A-Za-z0-9-_:.]`). A 401 refresh-and-retry resends the same key, and the server is idempotent by state, so a repeated mark is a 200. A failed save puts the previous mark back and says why on that row.

Times render in the studio's `timeZone` from `/me`, appointment detail and client detail. The device zone is used only if a server without slice 2 omits it. Errors are the flat `{ error, code }` shape; a nested body is still read defensively.

## Sign-in links

Email links come back to `danceflow-business://auth/callback`. That URL has to be on the Supabase project's redirect allow list before email-link sign-in works on a device. Password sign-in needs nothing extra.
