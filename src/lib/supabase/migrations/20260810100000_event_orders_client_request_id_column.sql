-- Adds the client-generated request id column used for student mobile
-- event-ticket checkout order-creation deduplication
-- (src/lib/events/event-order-payment.ts, resolveEventOrderForCheckout).
--
-- Split from the unique index that enforces the dedupe -- see
-- 20260810100100_event_orders_client_request_id_dedupe_index_concurrent.sql
-- -- specifically so that index can be built CONCURRENTLY without being
-- forced into the same transaction as this column add. See that file for
-- why CONCURRENTLY matters here. Same split pattern as
-- 20260809130000_payments_client_request_id_column.sql /
-- 20260809130100_payments_client_request_id_dedupe_index_concurrent.sql
-- (Payments P0.1).
--
-- Safe to run transactionally: a plain nullable column add takes only the
-- brief metadata-only lock Postgres already takes for any DDL, not a
-- table-rewrite lock, and has no effect on existing rows or queries until
-- the paired index migration is applied and the application starts
-- populating it.
--
-- Rollback (not run as part of this migration; additive-only, no
-- dependents other than the paired index migration, which must be rolled
-- back first if this is ever reverted):
--   drop index concurrently if exists "event_orders_studio_client_request_id_key";
--   alter table "public"."event_orders" drop column if exists "client_request_id";

alter table "public"."event_orders"
  add column if not exists "client_request_id" text;
