-- Payment Harness (dev/QA Stripe test-mode) -- evidence model.
--
-- Design source: this session's approved Payment Harness design (rev. 2,
-- redelivery correction). Owners: Ethan Brooks (technical), Daniel Hayes
-- (quality/release), Maya Reed (security).
--
-- Deliberately a SEPARATE table from "public"."synthetic_test_runs", not a
-- reuse of it -- see 20260810090000_synthetic_test_runs.sql's own comment:
-- that table is governed as the Production Synthetic Harness's audit
-- surface, scoped to a harness that is structurally incapable of creating
-- payments ("never contains customer data"). This table's entire purpose
-- is the opposite: real Stripe test-mode Checkout Sessions/PaymentIntents
-- in dev/QA only, with the ids that come from them. Writing that data into
-- the synthetic harness's own audit table would mix two deliberately
-- different risk profiles into one surface -- exactly what "must be
-- separate" (this session's explicit Payment Harness requirement) exists
-- to avoid.
--
-- One row per Payment Harness scenario run (not per checkpoint -- a run
-- progresses through several checkpoints, each appended to the
-- `checkpoints` jsonb array on the same row, so a partial/aborted run's
-- evidence is never lost).
--
-- This table is additive-only: it does not add columns, triggers, or
-- flags to any existing production table (payments, appointments, clients,
-- etc), and nothing in this migration writes to or mutates any financial
-- or application record. Tenant scoping is enforced entirely at the
-- application layer (src/lib/payment-harness/guards.ts's
-- assertPaymentHarnessStudio/assertPaymentHarnessClient, invoked before
-- every write in src/lib/payment-harness/evidence.ts), the same way the
-- Production Synthetic Harness enforces its own tenant boundary.

create table if not exists "public"."payment_harness_runs" (
  "id" uuid primary key default gen_random_uuid(),

  -- Shared by every checkpoint update belonging to the same scenario run.
  "run_id" text not null,

  -- Which scenario this run exercised, e.g. "floor-rental-open-balance".
  -- Room for additional scenarios later without a new table.
  "scenario" text not null,

  "environment" text not null,
  "deployment_sha" text not null,

  -- The one hard-configured Payment Harness studio/client this run
  -- operated against (src/lib/payment-harness/config.ts). NOT NULL
  -- deliberately -- a row can never exist without recording the tenant
  -- boundary it was scoped to, the audit-side half of the guard checks
  -- performed before every write to this table.
  "studio_id" uuid not null,
  "client_id" uuid not null,

  "expected_balance_cents" integer not null
    constraint "payment_harness_runs_expected_balance_cents_check" check ("expected_balance_cents" >= 0),

  -- Populated as the run progresses -- null until each fact actually
  -- becomes known, never guessed or defaulted to a placeholder.
  "payment_id" uuid,
  "stripe_checkout_session_id" text,
  "stripe_payment_intent_id" text,

  -- Explicit stored facts, not re-derived later: the exact session id
  -- captured on first submit, and the session id observed on the second
  -- (reuse-check) submit, so "was the second submit actually a reuse" is
  -- a recorded comparison, not something reconstructed after the fact.
  "first_session_id" text,
  "reused_session_id" text,

  "stripe_webhook_event_id" text,
  "stripe_connected_account_id" text,

  -- { "<appointment_id>": "<payment_status>", ... } snapshots, so
  -- "cancelled/non-payable appointments remained untouched" is a stored,
  -- diffable fact rather than an assumption.
  "appointment_ids_before" jsonb,
  "appointment_ids_after" jsonb,

  -- Redelivery: trigger mechanism and verification result are tracked
  -- separately and deliberately (see the design's redelivery correction).
  -- `redelivery_trigger_mechanism` records *which* candidate mechanism
  -- was actually used, once one is validated by a later slice; null/absent
  -- when none was available for this run.
  "redelivery_trigger_mechanism" text,

  -- Tri-state and deliberately NOT collapsible to a boolean:
  -- `not_available` (no validated trigger mechanism exists yet for this
  -- Stripe/Connect/test-mode configuration) and `not_verified` (a trigger
  -- was attempted but its own success/failure couldn't be confirmed) must
  -- both remain distinguishable from `passed` (a duplicate delivery was
  -- actually triggered AND verified idempotent) forever -- absence of a
  -- trigger is not evidence of idempotency and must never be reported as
  -- if it were.
  "redelivery_check_result" text not null default 'not_run',

  "status" text not null default 'running',
  "failure_reason" text,

  -- [{ "name": ..., "status": "passed"|"failed", "at": ..., "detail": ... }, ...]
  -- one entry per checkpoint, appended (never overwritten) as the run
  -- progresses.
  "checkpoints" jsonb not null default '[]'::jsonb,

  -- Same shape/purpose as synthetic_test_runs.created_record_refs:
  -- { "appointments": ["<uuid>"], ... } -- every record this run itself
  -- created, keyed by table name, so cleanup can never touch anything a
  -- run didn't create.
  "created_record_refs" jsonb not null default '{}'::jsonb,

  "started_at" timestamp with time zone not null default now(),
  "completed_at" timestamp with time zone,

  "triggered_by_actor" text,

  constraint "payment_harness_runs_status_check"
    check ("status" in ('running', 'passed', 'failed', 'error')),
  constraint "payment_harness_runs_redelivery_check_result_check"
    check ("redelivery_check_result" in ('not_run', 'not_available', 'not_verified', 'passed', 'failed'))
);

comment on table "public"."payment_harness_runs" is
  'Evidence trail for the Payment Harness (dev/QA Stripe test-mode only). One row per scenario run, updated across checkpoints. Deliberately separate from synthetic_test_runs -- see this table''s own header comment.';

-- unique, not just indexed: every read/write path in
-- src/lib/payment-harness/evidence.ts looks a run up via
-- `.eq("run_id", runId).maybeSingle()` and assumes at most one row can
-- ever match. Without a real DB-enforced uniqueness guarantee, that's only
-- an application-level convention -- a genuine run_id collision would (at
-- best) make every subsequent .maybeSingle() call for that run error out
-- ("multiple rows returned"), and at worst make row selection depend on
-- table scan order. This table has no existing rows and no live traffic
-- (nothing has ever written to it), so a plain (non-CONCURRENTLY) unique
-- index build is safe here -- unlike the payments-table precedents in this
-- session, there is nothing to avoid blocking.
create unique index if not exists "payment_harness_runs_run_id_key"
  on "public"."payment_harness_runs" ("run_id");

create index if not exists "payment_harness_runs_studio_client_idx"
  on "public"."payment_harness_runs" ("studio_id", "client_id");

create index if not exists "payment_harness_runs_status_idx"
  on "public"."payment_harness_runs" ("status")
  where "status" in ('running', 'failed', 'error');

-- RLS: this table is written only by the harness's own CLI-driven runner,
-- via a service-role client (src/lib/payment-harness/evidence.ts) --
-- exactly the same posture as synthetic_test_runs, for the same reason.
-- Never written by a browser session, never exposed to any HTTP route (the
-- Payment Harness has no HTTP route at all -- CLI-only, per its own safety
-- design). Enable RLS with no policies so even a future code path that
-- accidentally reached this table with a non-admin client would be denied
-- by default rather than silently allowed.
alter table "public"."payment_harness_runs" enable row level security;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Purely additive (one new, self-contained table; no existing table is
-- altered, no trigger added anywhere). Not run as part of this migration --
-- kept here as the explicit, confirmed rollback path, to be executed
-- manually and separately if this table needs to be removed:
--
--   drop table if exists "public"."payment_harness_runs";
