-- Package Refund P0, Pre-Activation Hardening PR 1: refund-ledger uniqueness.
--
-- Enforces at most one well-formed 'refund'-typed lesson_transactions row per
-- (refund_reconciliation_id, client_package_item_id) pair. Both existing
-- voiding writers (reconcile_package_stripe_refund, 20260822090000; and
-- resolve_partial_refund_credit_review, 20260823090000) already guarantee
-- this by construction -- each is gated by its own idempotency/outcome check
-- before ever reaching its insert loop, and neither can iterate the same
-- item twice in one call. This index is defense-in-depth against a future
-- regression to that guarantee, not a replacement for it: it does NOT
-- change either RPC's idempotency mechanism, does NOT add
-- ON CONFLICT/exception handling to either writer, and does NOT add a
-- NOT NULL constraint to either column. A duplicate insert after this index
-- exists must remain a loud, uncaught 23505 unique_violation -- since each
-- RPC is a single plpgsql function (one implicit transaction), that failure
-- aborts the whole call atomically, exactly like every other
-- invariant-violation guard already in this subsystem (e.g. 2c-3's own
-- zero-source-rows fail-closed check). Silently swallowing it would weaken,
-- not harden, idempotency.
--
-- 'restored_lesson' rows (2c-3's restoration writes, 20260830090000) are
-- deliberately excluded by this index's own predicate
-- (transaction_type = 'refund' only) -- a reconciliation legitimately gets
-- one 'refund' row and, on reversal, one 'restored_lesson' row per item;
-- this index says nothing about that second row.
--
-- The refund_reconciliation_id/client_package_item_id IS NOT NULL guards are
-- explicit rather than assumed: both columns are plain nullable columns
-- (20260817090200_lesson_transactions_refund_columns.sql), and Postgres
-- unique indexes treat every NULL as distinct from every other NULL -- a
-- bare `where transaction_type = 'refund'` predicate would silently fail to
-- catch duplicates among any hypothetical future null-item 'refund' rows.
-- Both writers today always populate both columns (confirmed by direct
-- reading of both insert statements), so this guard currently changes
-- nothing observable -- it only makes the index's actual coverage match the
-- stated invariant exactly, rather than leaving an unstated gap.
--
-- ============================================================================
-- IMPORTANT -- DO NOT RUN THIS INSIDE A TRANSACTION.
-- ============================================================================
-- This uses CREATE UNIQUE INDEX CONCURRENTLY specifically so it does not
-- take a lock that blocks writes to lesson_transactions -- an actively
-- written, live production table (every attendance event inserts a row) --
-- for the duration of the index build. A plain CREATE UNIQUE INDEX would
-- block INSERT/UPDATE/DELETE on lesson_transactions for that whole window;
-- CONCURRENTLY avoids that at the cost of a longer, non-blocking build.
-- Matches the identical precedent already established on this same table
-- (20260817090400_lesson_transactions_refund_reconciliation_id_index_concurrent.sql)
-- and on `payments` (20260809130100_payments_client_request_id_dedupe_index_concurrent.sql,
-- 20260811100000_payments_floor_rental_pending_dedupe_index_concurrent.sql).
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block --
-- Postgres will reject it outright rather than silently falling back to a
-- blocking build. This file must be run standalone (its own psql/runner
-- invocation), not batched with other migrations.
--
-- If a concurrent build fails partway through, Postgres can leave behind an
-- INVALID index of the same name. Check pg_index.indisvalid / investigate
-- the failure cause, and retry with DROP INDEX CONCURRENTLY first if
-- re-running -- do not assume a retry is automatically safe without
-- confirming why the first attempt failed.
--
-- EMPIRICALLY VERIFIED PITFALL -- IF NOT EXISTS does not make a bare re-run
-- safe: if an INVALID index with this exact name is already present (from a
-- prior failed build), simply re-running this file does NOT repair it and
-- does NOT fail -- IF NOT EXISTS only checks whether a relation with this
-- name exists, never whether it's valid. Postgres emits only a NOTICE
-- ("relation ... already exists, skipping") and reports success, while the
-- index remains invalid and the uniqueness guarantee stays unenforced. A
-- successful command exit alone is therefore NOT sufficient proof the
-- constraint is active -- always inspect pg_index.indisvalid for this index
-- after running this migration in any environment. If it is false,
-- investigate why the original build failed, then explicitly
-- DROP INDEX CONCURRENTLY before retrying -- never just re-run this file
-- and assume the NOTICE-only "success" means the index was rebuilt.

create unique index concurrently if not exists
  lesson_transactions_refund_reconciliation_item_unique_idx
on public.lesson_transactions (
  refund_reconciliation_id,
  client_package_item_id
)
where transaction_type = 'refund'
  and refund_reconciliation_id is not null
  and client_package_item_id is not null;
