# DanceFlow Business walkthrough (local, real auth)

A Playwright walkthrough of `mobile/business` against real GoTrue sessions. It runs against an iso-qa stack started with `--auth`, plus a local Next server serving `/api/staff/*`. No DEV or PROD access is needed.

You need a checkout that has both `mobile/business` and `/api/staff` (draft PRs #439 and #448 until they merge), Docker with the iso-qa images, and Chrome or Playwright's Chromium.

```bash
# 1. stack with auth, seeded
node scripts/qa/iso-qa.mjs up baseline --auth --name biz > stack.json
node scripts/qa/auth-profile/business-shell/seed-staff.mjs stack.json seed.json

# 2. the web app's API: next dev against the stack (the profile's Kong serves /auth/v1 and /rest/v1)
NEXT_PUBLIC_SUPABASE_URL=$(node -p "require('./stack.json').TW4A_LOCAL_URL") \
NEXT_PUBLIC_SUPABASE_ANON_KEY=$(node -p "require('./stack.json').ISO_QA_ANON_KEY") \
SUPABASE_SERVICE_ROLE_KEY=$(node -p "require('./stack.json').ISO_QA_SERVICE_ROLE_KEY") \
npx next dev --webpack -p 3100 -H 127.0.0.1

# 3. the app, exported for web against the stack (--clear: EXPO_PUBLIC values are inlined and cached)
cd mobile/business
EXPO_PUBLIC_SUPABASE_URL=$(node -p "require('../../stack.json').TW4A_LOCAL_URL") \
EXPO_PUBLIC_SUPABASE_ANON_KEY=$(node -p "require('../../stack.json').ISO_QA_ANON_KEY") \
EXPO_PUBLIC_DANCEFLOW_WEB_URL=http://localhost:8790 \
npx expo export --clear --platform web --output-dir ../../dist-web
cd ../..
node scripts/qa/auth-profile/business-shell/dev-web-proxy.mjs dist-web --port 8790 --next http://127.0.0.1:3100

# 4. walk (PW_CHANNEL=chrome to use installed Chrome instead of Playwright's Chromium)
node scripts/qa/auth-profile/business-shell/walk.mjs stack.json seed.json out/

# 5. tear down
node scripts/qa/iso-qa.mjs down --name biz
```

The walk covers:

- magic-link sign-in (the email arrives in Mailpit, `/verify` redirects to `danceflow-business://auth/callback?code=…`, and the app redeems the PKCE code)
- tabs driven by `/me`
- Today with data, plus private-lesson and group-class detail
- an empty day
- 403 for another studio's appointment, and 403 after a role is removed mid-session
- sign-out, after which the old token gets a 401
- the in-app 401 after sessions are revoked
- owner sign-in by password, with Pulse

It writes a PNG per state and `evidence.json` (status codes and tab lists, no tokens). It exits 0 only if every step passed.

**`dev-web-proxy.mjs` is dev and QA only.** `/api/staff` sends no CORS headers by design, because its clients are native apps. A browser build can therefore only reach it from the same origin. The proxy serves the export and forwards `/api/*` to the local Next server. It is not part of any deployment, and the API is not changed for it.

`seed.json` contains the generated test password and `stack.json` the stack's keys. Both are for that disposable stack only; keep them out of the repo.
