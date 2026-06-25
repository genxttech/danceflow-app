# DanceFlow Student App

Native Expo app for the DanceFlow student experience.

## First Run

1. Copy `.env.example` to `.env`.
2. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
3. Install dependencies from this folder:

```bash
npm install
```

4. Start Expo:

```bash
npm run start
```

## Scope

This first scaffold includes:

- Supabase mobile auth session storage
- Sign in and password reset screens
- Protected app tabs
- Home, Schedule, Learn, Discover, Wallet, and LUMI placeholders

The app is intentionally separate from the Next.js web app so web deployment remains unchanged.
