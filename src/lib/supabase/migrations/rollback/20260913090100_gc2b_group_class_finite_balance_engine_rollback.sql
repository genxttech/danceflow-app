-- Rollback for 20260913090100_gc2b_group_class_finite_balance_engine.sql
--
-- Genuinely new object, no defective-body concern (P6e's rollback
-- precedent) -- safe to drop outright and standalone.

begin;

drop function if exists public._group_class_finite_balance(uuid, uuid, timestamptz, uuid);

commit;
