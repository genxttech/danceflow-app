# DanceFlow Student App

Native Expo app for the DanceFlow dancer/student experience.

## First run

1. Copy `.env.example` to `.env`.
2. Set:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - `EXPO_PUBLIC_DANCEFLOW_WEB_URL`
3. Install dependencies from this folder:

```bash
npm install --legacy-peer-deps
```

4. Start Expo:

```bash
npm run start:clear
```

## Expo Go vs development builds

Expo Go is fine for general UI testing, discovery, auth, profile, wallet, and linked-student portal screens.

Push notifications require a development build. Expo Go on Android no longer supports remote push notifications through `expo-notifications`, so use the EAS development build profile for real push testing.

## EAS setup

From this folder:

```bash
npx eas login
npx eas init
npx eas build:configure
```

After `eas init`, confirm `app.json` has a real value at:

```json
{
  "expo": {
    "extra": {
      "eas": {
        "projectId": "your-eas-project-id"
      }
    }
  }
}
```

## Build commands

Development builds:

```bash
npm run eas:dev:android
npm run eas:dev:ios
```

Internal preview builds:

```bash
npm run eas:preview:android
npm run eas:preview:ios
```

Production builds:

```bash
npm run eas:prod:android
npm run eas:prod:ios
```

## Current release scope

- Public discovery for studios and events
- Magic-link account access
- Dancer profile
- Favorites
- Wallet with tickets, package balances, memberships, and DanceFlow pass
- Linked-student schedule
- Linked-student learning tab
- LUMI value messaging and linked-student coaching support
- Push notification foundation, preferences, and initial schedule/event/favorite alerts

## Release checklist

Before pilot builds:

- Run `npm run typecheck`, `npm test` and `npm run check:deps`
- Run `npm run doctor`
- Confirm Supabase Auth redirect URLs include `danceflow://auth/callback`
- Confirm the Magic Link and Confirm Signup email templates reach the app with a `token_hash` and `type`. A `{{ .ConfirmationURL }}` link signs in through a PKCE code, which records no email proof
- Confirm push notification migrations have been applied in dev and production, including `20270213080000_mobile_push_token_claim.sql`. Apply it before shipping a build: this app registers through that function
- Confirm the web release serving this build returns `stripeAccountId` from event checkout. Without it, the app falls back to hosted checkout on registration and shows an error when resuming a payment
- Confirm `extra.eas.projectId` is set in `app.json`
- Confirm app icon and splash assets are final enough for pilot
- Confirm privacy and terms pages are live on DanceFlow web
