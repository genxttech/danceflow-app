# AI usage ledger: design and non-applied implementation proposal

Status: proposal (owner dispositions E5, E6, 2026-11-26; gaps raised by the A2 assistant design, `docs/mobile/assistant/A2_Design.md` section 5, PR #912). **Nothing here is applied to any hosted database, and no flag or application code changes with it.** SQL: `proposals/ai_usage_ledger_v1.sql`, rollback `proposals/ai_usage_ledger_v1_rollback.sql`. They sit outside the migrations directory on purpose. No price, plan or paid feature is proposed. The file keeps the name `v1` because no version of it was ever applied.

## What it solves

| Gap after PR #769 | Ledger answer |
|---|---|
| No durable global cap; public knowledgebase AI cannot be activated (E4, K2) | `ai_spend_controls` row `*` and per-feature rows hold on/off switches and **daily and monthly cost ceilings** checked in the database |
| Studio actions check, call, then record: parallel overshoot, unmetered failures | One `ai_reserve` before every provider call, `ai_settle` after |
| Under a studio payer one account can use up the studio's day | **Per-actor** daily limit, whoever pays |
| Burst and concurrency limited only by per-instance memory | **Per-actor per-minute and in-flight** limits inside `ai_reserve` |
| Reserve-then-verify in application code over-refuses under bursts, and a database outage can leave rows reserved (seen in the local check) | One locked transaction: exact admission, no cleanup write needed to refuse |
| A slow lock could eat the request's time budget | `lock_timeout` 2 s; refused as `lock_timeout`, nothing written |
| Retries can call the provider twice | Idempotency key unique per feature and actor; a duplicate is not admitted and gets no reservation id |
| No cost visibility | Tokens, model, outcome and cost per request; no content |

## Model

**`ai_spend_controls`** (one row per feature, plus `*` for the platform). No row or disabled = refused; every limit defaults to 0.

| Column | Meaning |
|---|---|
| `enabled` | switch |
| `payer_scope` | the only payer this feature may charge (null on `*`) |
| `per_payer_day`, `per_payer_month` | ceilings per payer; `ai_reserve` also takes the payer's own allowance (`p_payer_day_limit`, `p_payer_month_limit`) and enforces the smaller, atomically. A studio payer must pass the monthly one |
| `per_actor_day` | count per person within the feature, whoever pays |
| `per_actor_minute` | burst: admitted attempts in the last 60 s, released ones included |
| `per_actor_in_flight`, `in_flight_window_seconds` | unsettled reservations younger than the window (default 60 s) |
| `day_cost_cap_micros`, `month_cost_cap_micros` | cost ceilings; on `*` they cover every feature |

**`ai_usage_ledger`**: payer (`platform_personal`, `platform_public`, `studio_ops`, `studio_lumi_pool`), `actor_key`, actor user, studio context (whose data was used, separate from who pays), idempotency key, status `reserved`/`settled`/`released`, worst-case and settled cost, tokens.

- Personal dancer allowance is **platform-funded** (E6): `platform_personal`, and the database requires payer = actor. **Studio sponsorship is off**: it has no payer scope, so it cannot be charged by accident; adding it is a later, separately approved change.
- Pools stay separate (E2): `studio_ops` (today's `ai_action`), `studio_lumi_pool`, personal, public.
- Costs are micro-dollars. The application reserves the worst case (input cap and output cap at the model price) and settles the reported tokens. Unsettled rows count at worst case. Prices live in application configuration and must be reviewed when the model changes.
- Days and months are UTC calendar periods.

## Server obligations (the database cannot prove these)

1. Derive `payer_id`, `actor_key`, `actor_user_id` and the studio **from the authenticated identity on the server**; never from the request body. For a studio payer, check membership before reserving; the database does not.
2. Signed-in: `actor_key` = the user id (enforced to match `actor_user_id`). Anonymous (`platform_public` only, with the all-zero payer id and no user id): a keyed hash of the client address made on the server; never the raw address. Anonymous per-actor limits are only as good as that key, so the cost ceilings are the real bound there.
3. Dispatch to the provider **only when `admitted` is true**. Settle only the reservation id received.
4. Any error, `lock_timeout` included, means no provider call. No fallback counter.
5. Provider timeout plus settlement must be shorter than the in-flight window.
6. Reserve at least the worst-case cost. Report and alert on rows where the settled cost exceeds the reserved cost.
7. Pass the studio's allowance (plan plus credit packs, after the complimentary cap) as `p_payer_month_limit`. While some paths still record only in `usage_events`, subtract what those paths have used; do not subtract calls already in the ledger.
8. Call the RPC with all of the first eight parameters, nulls explicit, and set a client deadline: `lock_timeout` applies to each wait, so the total can exceed 2 s.

## Refusal reasons

| `reason` | Suggested HTTP (A2 mapping) |
|---|---|
| `actor_in_flight`, `actor_burst`, `actor_day`, `payer_day`, `payer_month` | 429 `rate_limited` |
| `disabled`, `feature_day_cost`, `feature_month_cost`, `global_day_cost`, `global_month_cost`, `lock_timeout` | 503 `unavailable` |
| `duplicate_reserved`, `duplicate_settled`, `duplicate_released` | 409 |
| `invalid_request`, `invalid_payer`, `invalid_isolation` | 500: a server defect; log it |

## A1 contract change: a per-attempt `requestId` (specified here, not implemented)

`AssistantRequest` (`mobile/shared/assistant/types.ts`) gains one required field:

- `requestId: string` = `{conversationId}:{pendingId}`, set by the provider's `run` for each attempt.
- Server accepts only `^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$` and passes it unchanged as the idempotency key.
- A user **Retry** creates a new pending id, so it is a new attempt and counts again if the earlier one was billed.
- A transport-level resend of the same attempt reuses the id and is refused as a duplicate. The app must not auto-resend; no reply is stored to replay.
- Uniqueness is needed only per actor. Ids are built from time and a counter, which is enough at that scope; they are not secrets and authorize nothing.

Delivery belongs to the A2 slices (types, provider, both app copies, parity tests), with flags off.

## Proposed control values (owner approves at activation; none loaded)

| Feature | Payer | Payer day / month | Actor day / minute / in flight | Cost day / month |
|---|---|---|---|---|
| `*` | – | – | – | $10 / $40 |
| `lumi` | personal | 5 / 20 (E3) | 5 / 3 / 2 | $3 / $20 |
| `lumi_web` | studio LUMI pool | ceiling 500 / 2,500; the studio's allowance passed per call | 5 / 3 / 2 | $3 / $20 |
| `studio_assist` | studio operations | ceiling 500 / 2,500; the studio's allowance passed per call | 50 / 3 / 2 | $5 / $20 |
| `kb_public` | public | **disabled** | – | – |
| `aria_chat` | undecided (roadmap Decision #8) | **no row** | – | – |

Allowance sizes stay in the application (as now) and are enforced by the database at reservation time. The per-payer values in the row are the most any payer may get.

## Application changes (later slices)

1. A single metering port next to `callOpenAiResponses`: reserve → call → settle with `mayHaveBilled`, or release.
2. Migrate: public knowledgebase (stays off until proven), LUMI, then the studio assistants. The `usage_events` writes for `ai_action` continue during a dual-write period so billing pages keep reading the same numbers.
3. Stale `reserved` rows stay counted at worst case; a later report lists those older than an hour.

## Local validation (2026-11-26, throwaway `postgres:17`, Supabase-style default privileges, no hosted database)

Applied cleanly on a minimal bootstrap. No control rows and all-zero limits refused. 60 parallel requests, actor day limit 5: exactly 5. Studio payer with actor limit 3: one actor got exactly 3, another was still admitted. 30 parallel with in-flight 2: exactly 2; settling freed one; reservations older than the window stopped counting as in flight. Burst 3 per minute held with released attempts. Daily, monthly and platform cost ceilings refused. 200 parallel public requests against 50,000 micro-dollars: exactly 50 admitted, 107 refused on cost and **43 refused on lock timeout**. A held lock refused with `lock_timeout` and later succeeded. Wrong payer, wrong scope, repeatable-read isolation and global switch off refused. The same requestId from two actors was admitted for both; a resend was refused with no reservation id. `service_role` can only read the ledger; `anon` cannot execute; rollback removed every object. Not covered: hosted Supabase image, PostgREST RPC calls, a real month boundary, load.

## Throughput limit (accepted for a pilot, to be measured)

Every reservation locks the platform row, so reservations run one at a time across all features. That is what makes the caps exact. Under the local 40-way burst about one request in five waited more than 2 s and was refused. At pilot volume this is acceptable and fails closed; before wider release, measure it on DEV and, if needed, replace the sums with counter rows or lock per feature with a separate platform counter.

## Open for the database review or later

- Cost sums scan the month's rows per reservation; counter rows become necessary with volume.
- Retention and deletion of ledger rows (they hold a user id or a hashed client key) needs a schedule.
- `service_role` is trusted to settle truthfully, to release only unbilled calls, to pass correct allowances and to change controls.
- Before public traffic: refusals (disabled and over-limit included) queue on the same platform lock, so a public flood can cause `lock_timeout` for paid features. Needs a non-locking pre-check, upstream throttling and counter rows.
- Change controls one row at a time, the `*` row alone: a multi-row update can deadlock with a reservation. There is no control-change audit and `updated_at` is not maintained. Changing a feature's payer scope restarts its payer counts.
- The user id also survives user deletion in `actor_key` and `payer_id`; the two nullable foreign keys are unindexed. Any purge must keep the current month and recent idempotency keys.
- `ai_settle` returns false alike for a bad value, an unknown id and an already settled row.

## Gates, in order

1. Independent database review of the SQL. **Done once (2026-11-26, static):** three must-fix findings (per-studio allowance not atomic, settlement could erase or inflate cost, no lock timeout on apply and rollback) are fixed and re-checked locally; the fixes have not been reviewed again.
2. Move to `src/lib/supabase/migrations` with rollback and tests in a separate PR (owner-gated path).
3. DEV apply with fingerprint, then isolated QA including PostgREST calls.
4. Owner gate for PROD SQL; SQL before application.
5. Application slices dark; activation values approved by the owner.
