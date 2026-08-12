-- Adds a per-payment attempt counter used to give
-- src/app/api/stripe/client-checkout/route.ts an attempt-numbered Stripe
-- idempotency key (`client-payment:${paymentId}:checkout-session:${n}`)
-- instead of a flat one, and to atomically serialize concurrent requests
-- for the same paymentId via a compare-and-swap update
-- (`.eq("checkout_session_attempt_count", currentCount)`) before any
-- Stripe call is made -- the same CAS-on-a-counter shape already proven
-- for this table's existing `.eq("status","pending")` guard in this same
-- route, and for the `event_orders`/`terminal_payment_sessions` attempt
-- counters in the two already-shipped idempotency tranches.
--
-- `payments` has no jsonb metadata column to piggyback on (checked all
-- migrations that ever added a column to this table -- none did), so this
-- is a dedicated column rather than a metadata key, unlike the
-- `event_orders.metadata.payment_intent_attempt_count` precedent.
--
-- Safe to run transactionally: `not null default 0` on a new column is a
-- metadata-only change in modern Postgres (no table rewrite, no need to
-- backfill), and every existing row reads as 0 -- exactly "no prior
-- attempts recorded" -- with no special-casing required anywhere that
-- reads it.
--
-- Rollback (not run as part of this migration; additive-only, no
-- dependents):
--   alter table "public"."payments" drop column if exists "checkout_session_attempt_count";

alter table "public"."payments"
  add column if not exists "checkout_session_attempt_count" integer not null default 0;
