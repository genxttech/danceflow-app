# TW-4F: independent Docker acceptance work packages (post-DEV-migration)

Prepared 2026-10-30 against `main` `e749427c`. **Nothing here has been run as part of this document**, and nothing here touches DEV, PROD, Twilio, Stripe or Resend. Every package runs on a disposable local database and, where an application is needed, on a localhost build with fake adapters and dummy secrets. All activation, pilot and billing switches stay OFF unless a test turns one ON inside its own throwaway database.

## 0. Common baseline (WP-D0, prerequisite for all packages)

**DEV-equivalent database.** Image `df-isoqa/base:20261119092100`, plus migrations `20261120090000` to `20261122090000`, plus the 41 files of manifest section 4.1. This was shown to be an exact predictor of hosted DEV: the hosted pre-apply fingerprint equalled the local one in all 296 rows and the hosted post-apply state equalled it row for row after every one of the 41 steps (final `rollup:ALL` `3a38f6b6`). Packages may therefore claim "DEV-schema equivalent" but **not** "DEV-data equivalent": DEV holds 900 profiles, 75 studios and other real-shaped data that the Docker database lacks.

| Item | How | Notes |
|---|---|---|
| Runner | `node scripts/qa/tw4f/run-chain.mjs suites --base e749427c --image df-isoqa/base:20261119092100 --cutoff 20261119092100 --suite <file>` (and `chain` for the round trip) | Reads migrations and tests from Git refs; one fresh database per suite; own network and label; refuses to touch other containers |
| Function coverage meter (new, small) | start the database with `track_functions=all`; after a run read `pg_stat_user_functions` | gives a measurable coverage figure for the 277 volatile functions |
| Known failures | `scripts/qa/tw4f/known-failures.json` | the stale or gated suites (`f3recon`, `j2owner`, `r2a`, `r2b`, `tw4fj1`, skipped canary) must be fixed or explicitly waived first, or each package reports them as pre-existing |
| Host | Docker, about 4 GB free RAM per database plus services; run on an idle host (some assertions are wall-clock sensitive) | |

**Dependencies for everything below:** WP-D0 working, `e749427c` checked out in a clean worktree, no hosted credential in the environment.

## 1. WP-D1: owner-facing application behavior

- **Goal:** prove the studio-owner pages and actions (`/app/settings/sms`, `/location`, onboarding draft, credit view, recurring, monthly limits, number offers and approval) work against the migrated schema with a studio-role session, which the hosted walkthrough could not show.
- **Existing coverage:** `localStack.j2owner` (12 tests: privileges, owner-only matrix, provisioning read), `localStack.j3owner` (11: owner approval of a number offer, refusals for staff, other studios and admins, price gates, pilot ceiling, real server action), `localStack.tw4a` (onboarding), billing suites `tw4f3bui`, `tw4recurring`, `tw4monthly`.
- **Gap:** no test renders the real Next pages with a real signed-in studio user.
- **Method:** local Supabase e2e stack (GoTrue + PostgREST + Kong) on the DEV-equivalent schema; seed one synthetic studio, owner, staff user and a second studio via `localStackFixtures.sql`; enable pilot access **inside the throwaway database**; build the app against the local stack with dummy provider values or none; Playwright signs in each synthetic user and GET-renders the pages; assert content for owner, redirect or refusal for staff, other-studio owner and platform admin.
- **Acceptance:** every page renders for the owner; refusals are clean (no 5xx); no provider adapter is constructed; page loads change no row (compare table counts); suites above green or waived.
- **Dependencies:** WP-D0; local e2e stack (containers already used for e2e QA); `playwright` browsers installed (one-time download, a package fetch not a provider call); fixtures. **Cannot prove:** behavior on real DEV data or hosted Auth.

## 2. WP-D2: AAL1 database refusal

- **Goal:** show the `1231` refusal of an aal1 platform-admin token at the database, which the hosted walkthrough could not reach.
- **Existing coverage:** `src/app/platform/sms/__tests__/localStack.aal2.test.ts` (4 tests): helper true only for an aal2 admin token; registration RLS admits aal2 and refuses aal1 on all three policies; four admin RPCs answer `42501` for aal1 and answer aal2; helper keeps definition shape and grants. Claims are set the way PostgREST sets them, in a rolled-back transaction.
- **Gap:** synthetic claims, not tokens issued by an auth server.
- **Method (two layers):** (a) run the existing suite on the DEV-equivalent database (record pass and the exact test count); (b) extend with real tokens: on the local GoTrue, create a synthetic admin, enrol a TOTP factor with a test-generated secret (never a real person's), obtain an aal1 token (password only) and an aal2 token (after the code), send both through Kong/PostgREST to a stable admin RPC and to the `studio_sms_registrations` select.
- **Acceptance:** aal1 request refused (`42501`, HTTP 401 or 403); aal2 answered; refusal holds for every function that calls the admin helper (list them from the catalog and assert each).
- **Dependencies:** WP-D0; local GoTrue with MFA enabled; test TOTP generation. **Cannot prove:** the hosted Supabase Auth version's claim issuance details beyond what the hosted walkthrough already showed (aal2 reached and accepted).

## 3. WP-D3: mutating-path and fail-closed validation

- **Goal:** exercise every mutating function and every default-off switch, so the 277 volatile functions are covered by measured evidence instead of by the migration QA alone.
- **Existing coverage:** about 40 `localStack.*` suites (for example `tw4rfl` 87 tests, `tw4rflops` 64, `tw4pilothard` 25, plus credit, recurring, usage, inbound, sender, reconcile, number, provisioning, recovery and cancel-target suites).
- **Method:** (1) run the whole suite set on the DEV-equivalent database with `track_functions=all`; (2) produce the table "function, volatility, called by which suite, calls"; (3) for each uncovered mutating function, classify as "covered indirectly", "needs a new test" or "internal helper"; (4) write the missing tests (negative first: refusal with switch off, wrong actor, wrong state, replay); (5) fail-closed matrix: with each switch in its default state every mutating entry point refuses or no-ops; with a switch turned on inside the throwaway database only the intended function acts.
- **Acceptance:** coverage table committed; every volatile function either called by a green test or justified; every switch default-off assertion green; no suite leaves rows (or its own cleanup is asserted); the known-failure list is empty or waived item by item.
- **Dependencies:** WP-D0 and the coverage meter; time to fix the stale suites. **Cannot prove:** concurrency under the hosted pooler, or behavior with DEV-sized data.

## 4. WP-D4: dual-control simulation with two isolated test administrators

- **Goal:** prove dual control logic (request, approve, reject, consume, invalidate) with two distinct administrators, impossible on DEV with one.
- **Existing coverage:** the dual-control tests inside `localStack.tw4rfl`, `localStack.tw4rflops`, `localStack.r2brfl` and `localStack.f5canceltarget` (request, approval, rejection, one-time consumption, invalidation, cancellation target).
- **Method:** create two synthetic administrators A and B (distinct ids, both aal2 claims) and a non-admin C, in the throwaway database only; matrix: requester equals approver (must refuse), second admin approves, same approval replayed, approval after the facts changed, expiry, rejection, third party, aal1 second admin, deactivated admin; confirm audit rows and that approvals are single-use.
- **Acceptance:** every matrix cell asserted; the single-admin refusal reproduced (one admin cannot satisfy a dual-control action); the decision B-6 (does pricing change need dual control) recorded as an owner decision, with the test updated to whichever rule is chosen.
- **Dependencies:** WP-D0; owner decision B-6 for the pricing case only. **Cannot prove:** a real second human administrator's workflow or notification delivery.

## 5. WP-D5: provider-path simulations without live provider credentials

- **Goal:** exercise the code paths that talk to Twilio, Stripe and Resend against fakes, with deterministic provider payloads.
- **Existing coverage:** adapter and runtime unit tests with fake adapters (`activation.a9b`, `activation.j4`, `senderVerification`, `usageProvider`, `cancelRuntime.f5`, `dryRun.tw4r1`, `factory`, `runOrchestration.tw4fj1`); webhook route tests with signatures (Twilio inbound and status routes `route.tw1`, `a2p1`, `smsa2p2`, `usage`, `inboundUsage`, `recurring`; subaccount webhooks; Stripe payments webhook suites `paywh1`, `paydc2b`, `billingqa3/6`).
- **Method:** fixture library of provider responses (registration states, number search and purchase, fee lines, errors, timeouts, rate limits, malformed bodies) modeled on the providers' public documentation and on the shapes the code already parses; run the production build locally with dummy secrets; send locally signed webhooks (Twilio HMAC with a dummy token, Stripe test-style signature with a dummy secret) at the real routes; assert signature failures, replay, out-of-order delivery, duplicate events, unknown account, and that STOP/START/HELP stay compliant at zero balance; run the runner against fake adapters through its states; in every case assert that no outbound connection leaves the machine (the network guard from the DEV phase, allowing loopback only).
- **Acceptance:** each provider state machine path covered by a fixture and a green test; every failure path leaves money and consent state correct; guard log shows 0 outbound attempts.
- **Dependencies:** WP-D0; fixture authorship (largest effort); local build with dummy env. **Cannot prove:** that the real providers behave like the fixtures. That needs the hosted/provider items below.

## 6. What actually requires hosted DEV or real providers (not performed)

| Item | Why Docker cannot settle it | Needs | Authorization class |
|---|---|---|---|
| Owner pages on real DEV data (RLS and shaping with 900 profiles, 75 studios) | data shape and volume differ | a studio-role test user and enabling pilot access on DEV (writes) | hosted write, owner |
| Real Supabase Auth behavior (claims, MFA lifecycle, rate limits, mailer) | local GoTrue is a different version and has no real SMTP | hosted DEV session tests; email delivery | hosted auth, owner |
| aal1-token refusal as issued by hosted Auth | layer (b) of WP-D2 uses local GoTrue | an owner-assisted aal1 call on DEV (read only) | owner-assisted |
| Hosted pooler, connection limits, latency under concurrency | local topology differs | hosted DEV load of read paths | owner |
| Second human administrator and notification flow | no second administrator exists on DEV | owner supplies one | owner |
| Twilio: subaccount, brand, campaign, Messaging Service, number purchase, A2P review, carrier behavior, fee lines, undelivered-text fees | only the provider can answer; open items V-1 to V-5 in `TW-4F_Pilot_Readiness_Checklist.md` | Twilio credentials, fees, owner approval per step | provider operation, fee-bearing |
| Real webhook delivery (Twilio and Stripe: URL canonicalization behind the real host, real IPs, retries, ordering) | local tests sign their own requests | a deployed endpoint and live callbacks | deployment plus provider |
| Stripe: top-ups, refunds, disputes, tax | fakes encode assumptions | Stripe test-mode keys at minimum (still a provider call), written answer on closed-loop credit (B-4) | provider operation |
| Resend or other e-mail delivery of alerts and auth mail | deliverability and templates | provider credentials | provider operation |
| Vercel runtime (edge, environment scoping, cron registration) | Docker runs a plain Node server | a deployment | deployment |
| Pricing, counsel and CPA review, legal pages positive path | not engineering tests | owner and advisers | non-technical |

## 7. Suggested order and dependency graph

1. **WP-D0** (baseline + coverage meter + stale-suite triage). Blocks everything.
2. **WP-D2** and **WP-D4** in parallel (small, mostly existing tests, answer the two gaps the hosted DEV could not).
3. **WP-D3** next (largest measurable gain).
4. **WP-D1** after D2 (reuses the local auth stack).
5. **WP-D5** last (fixture-heavy; its results are the precondition for any provider authorization conversation).

Each package ends with a short report, a pass or fail per acceptance line, the commit it ran at, and the exact command. A package passing does not authorize any hosted or provider step; those stay separate, per the table above.
