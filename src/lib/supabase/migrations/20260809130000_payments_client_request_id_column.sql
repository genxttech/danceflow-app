-- Adds the client-generated request id column used for ad-hoc terminal
-- Quick Charge / Quick Pay payment-creation deduplication
-- (src/lib/payments/terminal-quick-charge.ts, resolveAdHocPayment).
--
-- Split from the unique index that enforces the dedupe -- see
-- 20260809130100_payments_client_request_id_dedupe_index_concurrent.sql --
-- specifically so that index can be built CONCURRENTLY without being
-- forced into the same transaction as this column add. See that file for
-- why CONCURRENTLY matters here.
--
-- Safe to run transactionally: a plain nullable column add takes only the
-- brief metadata-only lock Postgres already takes for any DDL, not a
-- table-rewrite lock, and has no effect on existing rows or queries until
-- the paired index migration is applied and the application starts
-- populating it.

alter table "public"."payments"
  add column if not exists "client_request_id" text;
