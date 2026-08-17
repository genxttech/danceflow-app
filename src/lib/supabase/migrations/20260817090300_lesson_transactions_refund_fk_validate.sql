-- Package Refund P0, Slice 2a: schema foundation only. Migration B of 3
-- for lesson_transactions.
--
-- Validates the two FK constraints added NOT VALID in
-- ...090200_lesson_transactions_refund_columns.sql. Deliberately kept in
-- its own migration/transaction, applied AFTER that one has committed:
-- running VALIDATE CONSTRAINT in the *same* transaction as the ADD
-- CONSTRAINT ... NOT VALID step would provide no lock-avoidance benefit at
-- all, since Postgres holds every lock acquired within a transaction until
-- COMMIT regardless of which individual statement requested it -- the
-- point of the split is to let the first migration's lock release before
-- this scan begins. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE,
-- which does not block concurrent reads or writes on lesson_transactions.
--
-- Both new columns are NULL for every pre-existing row (added with no
-- default in the prior migration), so this scan is expected to complete
-- quickly in practice -- but the safe pattern is followed regardless.
--
-- No application/trigger/entitlement behavior changes in this migration.

alter table public.lesson_transactions
  validate constraint lesson_transactions_client_package_item_id_fkey;

alter table public.lesson_transactions
  validate constraint lesson_transactions_refund_reconciliation_id_fkey;
