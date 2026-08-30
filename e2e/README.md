# Public Event Registration E2E Harness

Browser-driven (Playwright) E2E coverage for the public event registration
flow: `/events/[slug]` → registration form → required-document signing (if
any) → the real (fixture-doomed) Stripe-initiation attempt. Slice 1 covers
the registration-form happy path; Slice 2 adds the 0/1/2-required-waiver
signing matrix (Cases A/B/C below) and redirect/navigation-origin safety.
Real hosted Stripe Checkout completion is intentionally still out of scope
(see "Stripe boundary" below).

## Why this is separate from `npm test`

`npm test` (Vitest) is unit/integration coverage against fakes -- no real
network, no real database, no real browser. This harness is the opposite:
it seeds real rows into a real Supabase instance and drives a real Chromium
browser against a real running Next.js server. `vitest.config.mts` only
looks at `src/**/*.test.ts`, and this harness's tests live under `e2e/`, so
the two suites can never accidentally pick up each other's files.

## Prerequisites

1. **A non-production Next.js server running and reachable, started with
   Turbopack (`npx next dev`), not this repo's own `npm run dev` script.**
   `package.json`'s `dev` script hardcodes `next dev --webpack`, and that
   webpack dev path has a real, reproducible **local-development-only**
   hydration/interactivity bug on `/sign/[token]` -- the signing canvas
   doesn't respond to clicks under `next dev --webpack`, which breaks Cases
   B and C (the 1- and 2-waiver flows) before they can even reach the
   signature step. Plain `npx next dev` (Turbopack, the same bundler
   `next build`/production uses) does not have this problem. **This is a
   local dev-server quirk, not a production issue** -- production is built
   with `next build`, which always uses the production bundler regardless
   of this dev-only flag, so this bug cannot occur there. Case A (0
   waivers) never touches `/sign/[token]` and is unaffected either way, but
   using Turbopack for all three cases keeps the local dev server consistent
   with what's actually shipped.
   This harness fails closed (refuses to run) unless `E2E_BASE_URL` is
   `localhost`, `127.0.0.1`, or `[::1]` -- see `src/lib/e2e/guards.ts`. A
   remote Vercel preview deployment is **not** built-in-safe: Vercel assigns
   every
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
     (see below) and restart `npx next dev`, or
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
   `E2E_SUPABASE_URL` is validated fail-closed the same way `E2E_BASE_URL`
   is (`src/lib/e2e/guards.ts`'s `assertE2ESupabaseUrlIsSafe`) -- loopback
   hosts always work, the known DanceFlow production Supabase project is
   always rejected even if allowlisted, and any other host (e.g. a
   dedicated CI/staging Supabase project) needs its exact hostname in the
   optional `E2E_SUPABASE_ALLOW_HOSTS`.
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
# Terminal 1 -- the app itself, pointed at your non-production Supabase
# instance. Use plain Turbopack, NOT `npm run dev` -- see Prerequisite 1
# above for why the repo's own dev script breaks Cases B/C locally.
npx next dev

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

To run a single case (matches Playwright's file-name filtering):

```bash
npx playwright test e2e/tests/registration-1-waiver.spec.ts
```

## Rate limiting during repeated local runs

`/api/events/cart/checkout` has a real, unmodified anti-abuse limit of 8
requests per 15 minutes per source IP (`src/app/api/events/cart/checkout/route.ts`).
Repeated local E2E runs from the same machine share one IP and would trip
that limit and start seeing `429`s a handful of runs in. `e2e/helpers/rateLimitBypass.ts`'s
`useUniqueE2ESourceIp(page)` gives each test its own synthetic, random
`x-forwarded-for` request header so local runs stay independent of each
other and of prior runs. **This exists only in the test client's own
request headers** -- it is not a code change to the rate limiter itself,
does not touch `src/app/api/events/cart/checkout/route.ts`, and the real
production limit remains exactly as strict for a genuine single IP. Do not
weaken or bypass the limiter itself to work around rate limiting; use this
helper instead.

## Stripe boundary

Real hosted Stripe Checkout is intentionally **not** exercised by this
harness, in any case (A/B/C). There is no approved Stripe Connect
test-mode account attached to the fixture studio, so every case is
expected to reach the real Stripe-initiation call and stop at that
boundary (a genuine, fixture-expected failure/outcome page) rather than
complete an actual charge. See `registration-0-waivers.spec.ts`'s doc
comment for the full reasoning; provisioning a real test-mode Connect
account for the fixture studio remains deferred to a later slice.

## What this harness covers (Slices 1-3)

- Seeds a self-contained, deterministic studio/event/ticket-type fixture
  (fixed `e2e00000-...` ids, upserted -- safe to rerun), plus dedicated
  event fixtures per case (1/2-waiver, document-setup-failure,
  cancellation, and the Slice 1 foundation test) so parallel runs can never
  race over shared rows -- see `src/lib/e2e/fixture.ts`.
- **Case A** (`registration-0-waivers.spec.ts`, 0 required waivers):
  registration → the real server checkout path → the real (fixture-doomed)
  Stripe-initiation attempt.
- **Case B** (`registration-1-waiver.spec.ts`, 1 required waiver):
  registration → real DanceFlow Sign waiver → successful continuation →
  `/api/events/cart/resume-after-signing` → the pre-Stripe outcome.
- **Case C** (`registration-2-waivers.spec.ts`, 2 required waivers): same
  as Case B, but two distinct waivers signed in sequence before resuming.
- Asserts navigation-origin safety throughout (`e2e/helpers/navigationGuard.ts`)
  -- the harness fails a test if the browser is ever driven to a
  non-allowlisted origin, not just at the final URL. Sub-frame/iframe
  navigations are a deliberate, documented exclusion from that check --
  see that file's own header comment for why the one iframe this harness's
  flow actually renders (the `/sign/[token]` PDF preview) is safe anyway.
- Does **not** complete a real Stripe Checkout payment (see "Stripe
  boundary" above).

### Failure/retry matrix (Slice 3)

- **`registration-failure-document-setup.spec.ts`**: a required document
  whose template is deliberately oversized (exceeds the real storage
  bucket's file-size limit) so the real, unmodified document-creation code
  fails deterministically -- proves the user sees a real error banner (not
  a blank form), the order/registration/checkpoint are left in the app's
  own documented cancelled state, and a retry creates an independent order
  rather than reusing or getting stuck on the failed one. This is
  genuinely slow (real ~20MB+ PDF render + upload) -- see the fixture's own
  doc comment (`establishE2EDocumentSetupFailureFixture`) before changing
  its timeout.
- **`registration-failure-signing-continuation.spec.ts`**: deterministically
  expires the real signing checkpoint (via the admin client, the same way
  the real 30-minute expiry would) between reaching the signing page and
  completing the signature, reproducing a genuine (non-`NEXT_REDIRECT`)
  continuation failure -- proves it's surfaced visibly, the signature that
  *did* complete isn't lost, and reloading the completed link afterward
  doesn't re-process or duplicate it.
- **`registration-cancellation.spec.ts`**: drives the browser directly to
  the real `/api/events/cart/release` route with a real order's captured
  hold token (the same destination Stripe's own cancel button would have
  sent the user to), proving that outcome (`checkout_cancelled`) is a
  genuinely different error code and banner than a technical checkout
  failure (`cart_checkout_failed`), not the same assertion reused for both.
- Resume-error visibility itself (Case C in the task sense) is proven by
  `registration-1-waiver.spec.ts`/`registration-2-waivers.spec.ts`'s own
  final assertions, updated in Slice 3 to expect the preserved
  `?error=checkout_resume_failed` query string and its banner now that the
  `/events` → `/discover/events` bug (below) is fixed.

### `/events` → `/discover/events` query-string preservation (Slice 3 bugfix)

`/api/events/cart/resume-after-signing` has no event slug in scope when it
needs to report a failure, so its redirects target the slug-less
`/events?error=...` path. `/events/page.tsx` used to redirect that
unconditionally to `/discover/events`, silently dropping every query
parameter -- including the one the resume error needed to stay visible.
Fixed to forward the full query string onto the same, hardcoded
`/discover/events` destination (not an open redirect: the destination is a
compile-time constant, never derived from request input). `/discover/events/resumeBanner.ts`
is the other half of the fix -- it renders a banner for the five codes
resume-after-signing can emit; see `src/app/events/__tests__/page.test.ts`
and `src/app/discover/events/__tests__/resumeBanner.test.ts` for the
focused regression coverage.

### CI

`.github/workflows/e2e-public-event-registration.yml` runs `tsc`/`build`/full
Vitest unconditionally on PRs touching registration/signing/checkout/payment-initiation/E2E-harness
files (or manual `workflow_dispatch`). ESLint runs too, but only against the
`.ts`/`.tsx` files the PR actually changed (diffed against the PR's base
commit) -- not the whole repo, so a PR is never blocked by pre-existing lint
debt in files it doesn't touch, and `workflow_dispatch` (which has no PR to
diff against) skips this one step while still running the others. The
actual Playwright browser suite runs as a separate job, gated fail-closed on
`E2E_SUPABASE_URL`/`E2E_SUPABASE_SERVICE_ROLE_KEY` repo secrets being
configured -- see that workflow file's own trailing comment block for the
exact infrastructure prerequisite (a base-schema snapshot and a
`supabase/config.toml`, neither of which exists in this repo yet) still
needed before local Docker Supabase specifically can run inside GitHub
Actions, and why the job instead accepts any already-migrated,
non-production Supabase instance in the meantime -- via
`E2E_SUPABASE_URL`, validated the same fail-closed way `E2E_BASE_URL` is
(see "Prerequisite 1" above): the known DanceFlow production Supabase
project is hard-blocked even if someone tries to allowlist it via the
optional `E2E_SUPABASE_ALLOW_HOSTS` secret (only ever read from that
explicit secret in CI, never defaulted).

Playwright note: directly invoking the heavy Case A spec alone
(`npx playwright test e2e/tests/registration-failure-document-setup.spec.ts`)
still runs the entire fast suite first -- Playwright's `dependencies`
mechanism (see `playwright.config.ts`) runs a dependency project's full test
set as a prerequisite, not just tests related to the file you asked for.
This is correct and safe, just slower than it might look at first.

## Files

- `playwright.config.ts` (repo root) -- Playwright config; fails closed at
  load time if `E2E_BASE_URL` is missing or unsafe.
- `src/lib/e2e/guards.ts` -- the fail-closed host-safety check (unit-tested
  in `src/lib/e2e/guards.test.ts`, runs under normal `npm test`).
- `src/lib/e2e/config.ts` -- required-env-var loader, no defaults.
- `src/lib/e2e/fixture.ts` -- real-Supabase fixture create/reset helpers,
  including the 1- and 2-waiver event fixtures for Cases B/C.
- `src/lib/e2e/navigationGuard.ts` -- framework-agnostic navigation-origin
  allowlist logic backing `e2e/helpers/navigationGuard.ts` (unit-tested in
  `src/lib/e2e/navigationGuard.test.ts`, runs under normal `npm test`).
- `e2e/helpers/registrationPage.ts` -- reusable Playwright page helpers for
  the registration form.
- `e2e/helpers/signingPage.ts` -- reusable Playwright page helpers for
  driving the real DanceFlow Sign signing UI and waiting out the
  resume-after-signing route.
- `e2e/helpers/navigationGuard.ts` -- installs the always-on Playwright
  navigation listener (plus explicit post-action checks) that fails a test
  the moment the browser is driven to a non-allowlisted origin.
- `e2e/helpers/rateLimitBypass.ts` -- per-test synthetic source IP so
  repeated local runs don't trip the real checkout rate limiter (see
  "Rate limiting during repeated local runs" above).
- `e2e/tests/registration-0-waivers.spec.ts` -- Case A.
- `e2e/tests/registration-1-waiver.spec.ts` -- Case B.
- `e2e/tests/registration-2-waivers.spec.ts` -- Case C.
- `e2e/tests/registration-failure-document-setup.spec.ts` -- Slice 3
  document/signing setup failure + retry.
- `e2e/tests/registration-failure-signing-continuation.spec.ts` -- Slice 3
  signing continuation application failure + retry idempotency.
- `e2e/tests/registration-cancellation.spec.ts` -- Slice 3 genuine
  cancellation, kept distinct from technical failure.
- `src/app/events/page.tsx` / `src/app/discover/events/resumeBanner.ts` --
  the Slice 3 query-string-preservation bugfix and its banner.
- `.github/workflows/e2e-public-event-registration.yml` -- the CI release
  gate (see "CI" above).
