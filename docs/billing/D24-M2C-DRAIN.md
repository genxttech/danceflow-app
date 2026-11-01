# D24 M2-C — deferred drain and dead-letter recovery

Status: **local only. Not applied to any hosted database, no cron job registered, no route added, draining not activated.** Every hosted step below needs its own owner authorization.

Migration `src/lib/supabase/migrations/20270206090000_d24_m2c_drain_recovery.sql` (rollback in `rollback/`), requires M1 (`20270203110000`). App helper `src/lib/payments/hostedInvoice/drain.ts` (not wired to anything).

## What exists

| Object | Purpose |
|---|---|
| `d24_drain_deferred(p_limit)` (replaced, same signature) | Internal batch worker, per-event savepoint, 20 s loop budget. Adds `last_error_code`, `last_attempt_at`, `picked`. **M2-C revokes its M1 `service_role` grant**: callers use `d24_run_drain` (M1 rollout step 4 now reads `select public.d24_run_drain(25,'manual');`). Rollback restores the grant. |
| `d24_run_drain(p_batch_size, p_trigger)` | **The controlled entry point.** One bounded batch (cap 100), singleton, audited. Service role. |
| `d24_record_drain_failure(p_trigger, p_error_code)` | Audit row for a run that failed before it could audit itself (code only). |
| `d24_drain_health(p_stale_pending_seconds, p_run_gap_seconds)` | Read-only monitoring JSON: counts, ages, attempts, error **codes**, alarms. |
| `d24_requeue_deferred_event(p_provider_event_id, p_actor, p_reason)` | Audited manual requeue of a *rejected* event. Service role only. |
| `hosted_invoice_drain_runs` | Append-only: one row per completed run, plus error rows. |
| `hosted_invoice_deferred_requeues` | Append-only: one row per requeue (actor, reason, prior error). |

All new tables: RLS on, no policies, `service_role` SELECT only, no grants to `anon`/`authenticated`; writes only through the functions (writer-flag trigger, update/delete/truncate refused).

## Automatic recovery (the drain) vs manual recovery (requeue)

They never call each other.

**Drain, per event (own savepoint, so one poison event never blocks or rolls back the others):**

| Failure | Result |
|---|---|
| success | `applied`, error cleared |
| `22023` (validation) | `rejected` immediately, code kept |
| transient `40xxx`, `53xxx`, `55P03`, `57014` | stays `pending`, **not counted** toward quarantine, queued behind other events of the same tier |
| anything else | counted; the 5th counted attempt since `attempt_base` → `rejected` |

Ordering: fewest recent attempts first, then never-attempted / least-recently-attempted, then `event_created`. A stuck or transiently failing event can never starve newer events (tested with batch size 2).

**Recovery classes** (reported by `d24_drain_health().recovery`): `pending_fresh`, `pending_retrying` (has an error code), `pending_requeued`, `rejected_validation` (`22023`), `rejected_exhausted` (anything else), `applied_after_requeue`.

**Requeue** (`rejected` → `pending`, nothing else):
- reason (1–500 chars) and actor are required; the event must be `rejected`; max **5 requeues** per event.
- `attempts` is preserved (never decreases); `attempt_base` is set to it, so the event gets a **fresh budget of 5 counted attempts**. A forged flag cannot reset attempts (guard trigger enforces exactly +1 `requeue_count`, same `attempts`).
- the evidence (snapshot, hash, `received_at`) is immutable; the prior error and attempt count are copied into `hosted_invoice_deferred_requeues` before the live error columns are cleared; no row is ever deleted.
- A `22023` poison requeued without a fix is rejected again after one attempt. Requeue is for after a code/validator fix or after an infrastructure cause is cleared; the cap stops endless loops.
- **`p_actor` is NOT verified in SQL.** The function is service-role only and called by no application code. **M2-B owns the authorization wrapper** and must pass a verified identity (and tenant/admin check) as `p_actor`; do not expose this function to any endpoint before that wrapper exists. (Same limitation as `d24_acknowledge_anomalies` in M1.)

## Controlled invocation

`d24_run_drain` runs **one** batch in **one** transaction: advisory lock `d24:drain-run` (`pg_try_advisory_xact_lock`; a second concurrent caller gets `{"outcome":"busy"}` and writes nothing), `lock_timeout = 1s` and a 20 s per-batch loop budget (so a blocked key cannot stack lock waits until the caller's statement timeout rolls the whole batch back) (a lock wait becomes a transient `55P03` for that event), batch capped at 100, then the audit row in the same transaction. Locks are held until commit, so batches stay small; the loop lives in the app.

`runBoundedDrain({ supabase /* service role */, trigger, batchSize=25, maxBatches=10, maxMs=20000 })` loops that RPC and stops on: queue drained (`drained`, or `pending_remaining` when a batch ends with stuck events still pending), `busy`, `maxBatches`, wall-clock budget, two consecutive batches that settle nothing, or a database error (recorded by code via `d24_record_drain_failure`; the summary says `failureAudited`; never retried in-process). Safe to call from several workers: events are claimed `for update skip locked` and every apply is idempotent (event-id evidence, payment/credit-note keys, per-invoice advisory lock), so overlapping runs and the live route (`D24_HOSTED_INVOICE_EVENTS=on`) cannot double-record anything. The live route settles a pending deferred copy when it applies the same event.

Known residual: a deadlock (`40P01`) between a drain and a registration is aborted by PostgreSQL for one event only (transient, retried next run), as documented in M1.

## Monitoring and alarms

`select public.d24_drain_health();` (service role). No payloads, event ids, invoice ids or error messages are returned — only counts, ages, attempts and SQLSTATE codes. Alarms returned in `alarms`:

| Alarm | Meaning | Suggested response |
|---|---|---|
| `pending_stale` | oldest pending older than `p_stale_pending_seconds` (default 900) | check scheduler, `error_codes`, lock waits |
| `drain_not_running` | pending exists, no completed run within `p_run_gap_seconds` (default 1800) | scheduler down or always `busy` |
| `drain_errors` | last run errored, or ≥3 errored runs in the last hour | inspect `last_run.error_code`, DB logs |
| `rejected_present` | one or more rejected events | triage: `22023` → fix validator/data then requeue; others → investigate cause, then requeue |
| `payload_mismatch_present` | a deferred event was replayed with a different payload hash | review the affected invoice (`replay_payload_mismatch` anomaly) |

Raw detail for an operator (service role, SQL): `hosted_invoice_deferred_events` (`last_error` is the truncated database message; it can contain data fragments, so treat query output as sensitive and never forward it to dashboards/logs), `hosted_invoice_drain_runs`, `hosted_invoice_deferred_requeues`.

## Scheduling and activation plan (NOT executed)

Proposed, to be authorized separately:
- **Cadence:** every 1 minute while D24 is in `defer` or in the first days of `on`; relax to 5 minutes afterwards. Each invocation: `runBoundedDrain({ trigger: "scheduled", batchSize: 25, maxBatches: 10, maxMs: 20000 })`. Overlap is harmless (`busy`), so no external mutex is needed.
- **Locks:** the DB singleton `d24:drain-run` is the only coordination; do not add a second lock layer. Health reads are index-bounded (last run, 1-hour error window); `hosted_invoice_drain_runs` grows ~1 row per run, so decide a retention/export policy before a 1-minute cadence runs for months (rows are append-only; archival needs a deliberate migration).
- **Alarms:** poll `d24_drain_health()` every 5 minutes; page on `drain_errors` and `drain_not_running`, ticket on `rejected_present` / `pending_stale`.
- **Scheduler registration:** a Vercel cron / Supabase pg_cron entry calling a secret-protected server route is a *future* change (route must authenticate with the platform's cron secret and use the service-role client). It is deliberately not part of this PR.

Activation checklist (each item requires explicit owner authorization where it touches hosted systems):
1. M1 migration applied; M2-C migration applied **after** it; apply SQL before any app that calls it. Postflight: `select public.d24_drain_health();` shows empty queues, no alarms.
2. `D24_HOSTED_INVOICE_EVENTS=defer` deployed; deferred rows appear as `pending`.
3. One manual, supervised run: `select public.d24_run_drain(25,'manual');` repeat until `more=false`; verify `by_state`, no unexpected `rejected`.
4. Triage any `rejected` event before enabling the scheduler.
5. Register the scheduler (separate authorization), watch alarms for a full cycle.
6. Only then consider `D24_HOSTED_INVOICE_EVENTS=on`.
Rollback: stop the scheduler; app rollback first; `rollback/20270206090000_d24_m2c_drain_recovery_rollback.sql` (refuses while audit evidence exists — export it first). The M1 `d24_drain_deferred` is restored verbatim.

## Events processed while D24 was OFF need a Stripe resend

Events the route acknowledged with outcome `d24_not_enabled` stored **nothing** (no deferred row, no fact). **Nothing in M2-C can recover them**, the drain only sees rows that `defer` mode wrote. They are recoverable only by a Stripe event resend, chosen and performed by the owner. M2-C never resends, never reads or mutates `payment_provider_events` (asserted by a static check in the SQL QA script), and never marks such events reconciled. List them (read-only):
`select provider_event_id, event_type, created_at from public.payment_provider_events where outcome = 'd24_not_enabled' order by created_at;`
(Verify the column name against the hosted schema before running; M1's rollout doc uses the same query.)

## Verification

`bash scripts/qa/d24-m2c-sql.sh` — disposable Docker Postgres 17 (no ports, no volumes, removed on exit); applies the PAY-WH-1 claim migration, M1, M2-C, then runs the checks, including: privileges/RLS, duplicates, out-of-order, batch cap, 4 concurrent bare drains and 4 concurrent controlled runs, singleton `busy`, live-route vs drain, partial failure rollback, validation and XX001 poison, transient retry without quarantine, anti-starvation, requeue (guards, fresh budget, cap, append-only), health output without leakage, rollback and re-apply. Plus `npx vitest run src/lib/payments/hostedInvoice` for the app loop and the parameter-name contract.

## Independent review (static) and disposition
Findings from the independent security review and what was done: (1) one blocked key could stack 5 s lock waits and roll the whole batch back → lock_timeout 1 s + 20 s loop budget; (2) failure-audit result ignored, `drained` hid a stuck backlog → `failureAudited`, `pending_remaining`; (3) health full scan → index-bounded; (4) bare drain callable by service_role bypassing the singleton → grant revoked; (5) any service-role caller can write error-code audit rows (accepted: service role is the trust boundary; alarm thresholds assume honest callers); (6) rollback drops `last_error_code`/`last_attempt_at` columns (accepted; `last_error` text remains; the evidence tables refuse rollback); (7) `last_error` is overwritten per attempt (accepted; the requeue log keeps the error at each requeue, drain runs keep counts).
