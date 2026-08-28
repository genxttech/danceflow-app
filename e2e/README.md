# Public Event Registration E2E Harness

Browser-driven (Playwright) E2E coverage for the public event registration
flow: `/events/[slug]` → registration form → (later slices: required-document
signing → Stripe Checkout). Slice 1 covers only the "0 required waivers"
happy path up through an interactable registration form.

## Why this is separate from `npm test`

`npm test` (Vitest) is unit/integration coverage against fakes -- no real
network, no real database, no real browser. This harness is the opposite:
it seeds real rows into a real Supabase instance and drives a real Chromium
browser against a real running Next.js server. `vitest.config.mts` only
looks at `src/**/*.test.ts`, and this harness's tests live under `e2e/`, so
the two suites can never accidentally pick up each other's files.

## Prerequisites

1. **A non-production Next.js server running and reachable.** This harness
   fails closed (refuses to run) unless `E2E_BASE_URL` is `localhost`,
   `127.0.0.1`, or `[::1]` -- see `src/lib/e2e/guards.ts`. The usual case is
   your own local `npm run dev` at `http://localhost:3000`. A remote Vercel
   preview deployment is **not** built-in-safe: Vercel assigns every
   deployment a `*.vercel.app` address, production included, so there's no
   way to tell preview from production by hostname shape alone. To target
   one, add its *exact* hostname to `E2E_ALLOW_HOSTS` -- never a wildcard,
   and never anything you haven't personally confirmed is a preview, not
   production, deployment. The known production domains
   (`idanceflow.com`/`www.idanceflow.com`) are hard-blocked even if you try
   to add them to `E2E_ALLOW_HOSTS`.
2. **That server's Supabase config must point at the *same* Supabase
   instance this harness seeds fixtures into.** This is the one manual step
   the harness cannot verify for you: if your `.env.local` points
   `NEXT_PUBLIC_SUPABASE_URL` at the hosted project (as it does by default
   in this repo today), the app won't see the rows this harness inserts.
   Either:
   - Temporarily point `.env.local` at the local Docker Supabase instance
     (see below) and restart `npm run dev`, or
   - Run against a Vercel preview deployment that is itself wired to a
     non-production Supabase project, and seed fixtures into *that*
     project instead (set `E2E_SUPABASE_URL`/`E2E_SUPABASE_SERVICE_ROLE_KEY`
     accordingly).

   **This is the one remaining external prerequisite Slice 1 cannot wire up
   on its own** -- which Supabase instance the running app talks to is a
   local/deployment-environment decision, not something this harness's own
   code can or should silently change.
3. **A local Supabase instance to seed fixtures into.** If you already have
   the local Docker Supabase staging environment running (the same one used
   for this project's SQL regression suites, container
   `supabase_kong_danceflow-local-staging` on `127.0.0.1:54321`), the
   default values in `.env.e2e.example` work as-is. Otherwise, run
   `supabase start` against a fresh/empty local project and apply this
   repo's migrations first (`src/lib/supabase/migrations/`) -- the base
   tables the fixture writes to (`studios`, `events`, `event_ticket_types`)
   predate migration tracking, so a truly from-scratch local instance also
   needs the pre-migration base schema, not just the tracked migrations.
4. **Playwright's Chromium browser installed locally.** If `npx playwright
   test` reports a missing browser, run `npx playwright install chromium`
   once (requires network access to download it).

## Setup

```bash
cp .env.e2e.example .env.e2e.local
# edit .env.e2e.local if your setup differs from the defaults
```

## Running

```bash
# Terminal 1 -- the app itself, pointed at your non-production Supabase instance
npm run dev

# Terminal 2 -- load the E2E env and run the suite
set -a; source .env.e2e.local; set +a
npm run test:e2e
```

On Windows PowerShell, load the env file with:

```powershell
Get-Content .env.e2e.local | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "Env:$($Matches[1])" $Matches[2] }
}
npm run test:e2e
```

## What Slice 1 does and does not cover

- Seeds a self-contained, deterministic studio/event/ticket-type fixture
  (fixed `e2e00000-...` ids, upserted -- safe to rerun) with **zero
  required documents**.
- Opens the public event page, expands the registration form, selects a
  ticket, fills attendee details, and asserts the checkout button is
  enabled and correctly labeled.
- Does **not** submit the form. Submitting requires either a genuinely
  Stripe-Connect-onboarded test account (for the 0-waiver case) or a real
  DanceFlow Sign document template (for the 1/2-waiver cases) -- both
  explicitly out of scope for Slice 1 and left for a later slice.
- Does **not** yet exercise required-document signing, the resume-after-
  signing flow, or Stripe Checkout at all. `src/lib/payment-harness/`
  (a different, pre-existing harness for a different flow) already
  documents that Stripe's hosted Checkout resists automated card entry in
  headless Chromium -- a later slice extending this harness into that
  territory should expect the same and plan for a human-in-the-loop step,
  the same way that harness does.
- There is no CI job wired up for this yet (no `.github/workflows/`
  directory exists anywhere in this repo currently) -- running today is a
  local-only, manual step.

## Files

- `playwright.config.ts` (repo root) -- Playwright config; fails closed at
  load time if `E2E_BASE_URL` is missing or unsafe.
- `src/lib/e2e/guards.ts` -- the fail-closed host-safety check (unit-tested
  in `src/lib/e2e/guards.test.ts`, runs under normal `npm test`).
- `src/lib/e2e/config.ts` -- required-env-var loader, no defaults.
- `src/lib/e2e/fixture.ts` -- real-Supabase fixture create/reset helpers.
- `e2e/helpers/registrationPage.ts` -- reusable Playwright page helpers for
  the registration form.
- `e2e/tests/public-event-registration.spec.ts` -- the Slice 1 happy path.
