-- Package Refund P0, Slice 2a: schema foundation only. Migration C of 3
-- for lesson_transactions.
--
-- Partial index supporting "find every credit mutation caused by this
-- refund reconciliation" (reversal lookups, staff review UI) without
-- scanning the whole table for the overwhelming majority of rows where
-- refund_reconciliation_id is null (ordinary attendance/manual-adjustment
-- transactions, unrelated to any refund).
--
-- ============================================================================
-- IMPORTANT -- DO NOT RUN THIS INSIDE A TRANSACTION.
-- ============================================================================
-- This uses CREATE INDEX CONCURRENTLY specifically so it does not take a
-- lock that blocks writes to lesson_transactions -- an actively written,
-- live production table (every attendance event inserts a row) -- for the
-- duration of the index build. A plain CREATE INDEX would block
-- INSERT/UPDATE/DELETE on lesson_transactions for that whole window;
-- CONCURRENTLY avoids that at the cost of a longer, non-blocking build.
-- Matches the identical precedent already established twice on `payments`
-- (20260809130100_payments_client_request_id_dedupe_index_concurrent.sql,
-- 20260811100000_payments_floor_rental_pending_dedupe_index_concurrent.sql).
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block --
-- Postgres will reject it outright rather than silently falling back to a
-- blocking build. This file must be run standalone (its own psql/runner
-- invocation), not batched with other migrations, and must run AFTER
-- ...090300_lesson_transactions_refund_fk_validate.sql has committed.
--
-- If a concurrent build fails partway through, Postgres can leave behind
-- an INVALID index of the same name. Check pg_index.indisvalid / retry
-- with DROP INDEX CONCURRENTLY first if re-running.

create index concurrently if not exists lesson_transactions_refund_reconciliation_id_idx
  on public.lesson_transactions (refund_reconciliation_id)
  where refund_reconciliation_id is not null;
