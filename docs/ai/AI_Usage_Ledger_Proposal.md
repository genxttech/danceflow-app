# AI usage ledger: design and non-applied implementation proposal

Status: proposal (owner dispositions E5, E6, 2026-11-26). **Nothing here is applied to any hosted database.** SQL: `proposals/ai_usage_ledger_v1.sql`, rollback `proposals/ai_usage_ledger_v1_rollback.sql`. They sit outside the migrations directory on purpose. No price, plan or paid feature is proposed.

## What it solves

| Gap after PR #769 | Ledger answer |
|---|---|
| No durable global cap; public knowledgebase AI cannot be activated (E4, K2) | `ai_spend_controls` row `*` and per-feature rows hold on/off switches and **daily cost ceilings** checked in the database |
| Studio actions check, call, then record: parallel overshoot, unmetered failures | One `ai_reserve` before every provider call, `ai_settle` after |
| Reserve-then-verify in application code over-refuses under bursts, and a database outage can leave rows reserved (seen in the local check) | One locked transaction: exact admission, no cleanup write needed to refuse |
| Retries can call the provider twice | Idempotency key unique per feature and payer; a duplicate is reported and must not be dispatched again |
| No cost visibility | Tokens, model, outcome and cost per request; no content |

## Model

- `ai_spend_controls`: `feature` (`*` = whole platform), `enabled`, `per_payer_day`, `per_payer_month`, `day_cost_cap_micros`. **No row or disabled = refused.**
- `ai_usage_ledger`: payer (`platform_personal`, `platform_public`, `studio_ops`, `studio_lumi_pool`), actor, studio context (whose data was used, separate from who pays), idempotency key, status `reserved`/`settled`/`released`, worst-case and settled cost, tokens.
- Personal dancer allowance is **platform-funded** (E6): `payer_scope = 'platform_personal'`, `payer_id` = the user. **Studio sponsorship is off**: it has no payer scope, so it cannot be charged by accident; adding it is a later, separately approved change.
- Pools stay separate (E2): `studio_ops` (today's `ai_action`), `studio_lumi_pool`, personal, public.

Costs are in micro-dollars. The application reserves the worst case (input cap and output cap at the model price) and settles the reported tokens. Prices live in application configuration and must be reviewed when the model changes.

Pilot control values to load at activation (proposal, owner approves): `*` $10/day; `lumi` 5/day, 20/month per dancer (E3), $3/day; studio assistants $5/day; `kb_public` **disabled**.

## Application changes (later slices)

1. A single metering port next to `callOpenAiResponses`: reserve (with an idempotency key made from the action's request id) → call → settle with `mayHaveBilled`, or release.
2. Allowance sizes stay where they are today; the port passes the payer, the database enforces counts and cost.
3. Migrate: public knowledgebase (stays off until proven), LUMI, then the studio assistants. The `usage_events` writes for `ai_action` continue during a dual-write period so billing pages keep reading the same numbers.
4. Stale `reserved` rows stay counted at worst case; a later report lists those older than an hour.

## Local validation (2026-11-26, throwaway `postgres:17`, no hosted database)

Applied cleanly on top of a minimal bootstrap; no control rows → refused; 60 parallel reservations for one payer with a daily limit of 5 → **exactly 5** admitted; 200 parallel public reservations against a 50,000 micro-dollar ceiling at 1,000 each → **exactly 50**; duplicate key returned the same reservation as a duplicate; release works once; global switch off → refused; `anon` cannot execute, `authenticated` cannot read, `service_role` can execute; rollback removed every object. Not covered: hosted Supabase image, PostgREST RPC calls, load, month boundaries.

## Gates, in order

1. Independent database review of the SQL.
2. Move to `src/lib/supabase/migrations` with rollback and tests in a separate PR (owner-gated path).
3. DEV apply with fingerprint, then isolated QA including PostgREST calls.
4. Owner gate for PROD SQL; SQL before application.
5. Application slices dark; activation values approved by the owner.

Throughput note: every reservation locks the platform row, so reservations are serialized. That is intended at pilot volume; shard by feature if sustained volume ever reaches tens per second.
