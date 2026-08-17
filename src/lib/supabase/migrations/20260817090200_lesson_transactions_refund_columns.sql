-- Package Refund P0, Slice 2a: schema foundation only. Migration A of 3
-- for lesson_transactions (existing, actively-written production table --
-- every attendance event inserts a row).
--
-- lesson_transactions today can identify WHICH PACKAGE a row belongs to
-- (client_package_id) but not WHICH ITEM/usage type, and has no link at
-- all to a refund/reconciliation event. These two nullable columns are the
-- smallest semantically-correct extension: a refund that voids credit
-- across multiple usage types produces one lesson_transactions row per
-- affected item, each tagged with the same refund_reconciliation_id, so a
-- future reversal can query "what did this refund do" precisely instead of
-- re-deriving a guess.
--
-- Column adds are metadata-only/low-lock and safe inline. The FK
-- constraints are added NOT VALID here specifically so this migration does
-- NOT scan/lock the existing table -- validation happens in a separate
-- migration (...090300_lesson_transactions_refund_fk_validate.sql) after
-- this one commits, using the much lighter SHARE UPDATE EXCLUSIVE lock
-- instead of validating inline under whatever lock ADD CONSTRAINT would
-- otherwise hold for the scan's duration. Both new columns are NULL for
-- every existing row (no default), so the later validation scan is
-- expected to be fast in practice -- but the safe pattern is followed
-- regardless rather than assuming that in advance.
--
-- No application/trigger/entitlement behavior changes in this migration.

alter table public.lesson_transactions
  add column if not exists client_package_item_id uuid,
  add column if not exists refund_reconciliation_id uuid;

alter table public.lesson_transactions
  drop constraint if exists lesson_transactions_client_package_item_id_fkey;
alter table public.lesson_transactions
  add constraint lesson_transactions_client_package_item_id_fkey
  foreign key (client_package_item_id) references public.client_package_items(id)
  on delete set null
  not valid;

alter table public.lesson_transactions
  drop constraint if exists lesson_transactions_refund_reconciliation_id_fkey;
alter table public.lesson_transactions
  add constraint lesson_transactions_refund_reconciliation_id_fkey
  foreign key (refund_reconciliation_id) references public.package_refund_reconciliations(id)
  on delete set null
  not valid;
