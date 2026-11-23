# CF1 database-backed settlement QA (local, isolated)

Scope: Competition registration **payment settlement** only (no refunds, no competition rules). Path A context: hosted Checkout payment
completion stays **NOT PROVEN**; a replayed or synthetic event must never independently authorize fulfilment; Stripe state is re-read through
documented APIs before settlement. These suites prove the **SQL-backed** half locally, with Stripe's reader faked.

## What runs where

| Layer | Real | Faked |
|---|---|---|
| SQL (`localStack.settlementSql.cf1.test.ts`) | `finalize_competition_registration`, `release_competition_registration` as `service_role` on real Postgres, real concurrent backends | nothing |
| Route (`localStack.competitionWebhook.cf1.test.ts`) | the real `POST /api/payments/webhook`, real Stripe test signatures (`generateTestHeaderString`, no network), `verifySettlementWithStripe`, `claim_payment_provider_event` / `complete_payment_provider_event`, finalize/release | Stripe `checkout.sessions.retrieve`, fee sync, confirmation queue |
| Repair (`localStack.settlementRepair.cf1.test.ts`) | `settlementRepair.ts`, the cron route, the candidate query on real rows, a webhook racing the repair | Stripe reader, fee sync, confirmation queue |

Connections: every database call is its own `docker exec ... psql` process, i.e. its own backend, so concurrency is real. PostgREST is never
used (calling REVOKEd service functions through it segfaults the local image; see `docs/twilio/TW-4F_Isolated_QA.md` section 1). RPCs run as
`set role service_role`, so the grants are exercised too. The helper pins the container name to the `df-cf1r1-` prefix.

Orders are inserted directly in the settlement-relevant state (binding, price snapshot, status, signing flag, age). The order *creation* path
(`start_competition_registration` -> prepare -> attach) is covered by `src/lib/supabase/migrations/sql-tests/test_T_phase10c_competitor_registration.sql`;
entry/dance activation inside finalize is covered there too (these fixtures carry no entries).

## Run

Prerequisites: Docker, the local baseline image `df-isoqa/base:20261205090000` (built by the TW-4F isolated-QA tooling), `npm ci` run **in this
worktree** (never through a node_modules junction).

```bash
node scripts/qa/cf1-db-settlement.mjs            # takes C:\dfr\heavy.lock (waits up to 45 min), starts df-cf1r1-<pid>, applies competition migrations, runs the 3 suites, removes the container, releases the lock
node scripts/qa/cf1-db-settlement.mjs --keep     # leave the container for inspection (remove with: ... down)
node scripts/qa/cf1-db-settlement.mjs down       # remove leftover df-cf1r1-* containers
```

Exit codes: 0 pass, 1 test failure, 3 infrastructure, 4 BLOCKED (nothing is reported as passed when docker, the image, a required function, the lock
or vitest is unavailable, or when any test was skipped). Results: `.qa-out/cf1-db-settlement/report.json` and `vitest.json` (untracked).

Without `CF1_DBQA_CONTAINER` the suites are skipped, so the ordinary `vitest run` is unaffected.

## Limits

* Stripe is faked; nothing here proves a hosted Checkout payment completes, Stripe's real field shapes, or webhook delivery from Stripe.
* Refunds and competition rules are out of scope.
* Direct-insert fixtures do not carry competition entries; entry activation is covered by the Phase 10C SQL suite.

## Notes from review

* The free-order path is proved at the SQL layer only (the webhook never receives a free order).
* The Stripe reader fake returns the same session for any id/account, so the "foreign session" and "attacker account" webhook cases rely on the DATABASE binding refusal (which they assert); the route's own re-read binding is covered by the offline Path A suite.
* The finalize-vs-release and webhook-vs-repair races run on separate real connections but their interleaving is up to the scheduler; every round asserts its own invariants, and no assertion requires a particular interleaving.
* The runner reports BLOCKED if any applied migration fails or if host/container clocks differ by more than 60 s (the repair age windows use both clocks). It hands vitest an environment without SUPABASE/STRIPE/TWILIO/CRON variables.
* `down` removes every `df-cf1r1-*` container, including another live run of this tool.
