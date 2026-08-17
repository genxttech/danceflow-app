-- Package Refund P0, Slice 2a: schema foundation only.
--
-- Additive, nullable, no backfill. `refund_status`/`refunded_at` are a
-- convenience projection recomputed from `package_refund_reconciliations`
-- (the authoritative Stripe-Refund-object event history added in the
-- companion migration 20260817090100_package_refund_reconciliations.sql) --
-- application code must never set these directly from a single refund
-- event. See the Package Refund P0 design doc for the exact recomputation
-- rule and the reason `refund_reason`/entitlement-override fields are
-- deliberately NOT included here.
--
-- No application/trigger/entitlement behavior changes in this migration --
-- nothing yet reads or writes these columns.

alter table public.client_packages
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_status text
    check (refund_status is null or refund_status in ('partial', 'full'));
