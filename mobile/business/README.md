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

## Sign-in links

Email links come back to `danceflow-business://auth/callback`. That URL has to be on the Supabase project's redirect allow list before email-link sign-in works on a device. Password sign-in needs nothing extra.
