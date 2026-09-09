-- GC-1.2: lesson_transactions deduction idempotency -- real DB-level
-- uniqueness, replacing the previous check-then-insert-only guarantee.
--
-- Net-new constraint (no prior index exists on this key), so no zero-gap
-- sequence is required here -- a single CREATE UNIQUE INDEX CONCURRENTLY is
-- sufficient and safe. This must run as its own non-transactional
-- statement (CONCURRENTLY cannot execute inside BEGIN/COMMIT), matching the
-- established precedent for this exact "actively-written production table"
-- (20260830100000_lesson_transactions_refund_uniqueness_index_concurrent.sql).
--
-- Scoped to transaction_type='lesson_deduction' only. 'appointment_attendance'
-- (the legacy marker the existing RPC's idempotency check also recognizes)
-- is NOT a member of the live transaction_type enum -- confirmed via
-- `select enumlabel from pg_enum ... where typname='transaction_type'`
-- immediately before this migration was written -- so no writer, audited or
-- not, can ever produce that value; Postgres rejects the type cast before
-- any such INSERT could execute. Widening this index's predicate to also
-- cover a value that cannot exist would add unreachable-by-construction
-- complexity, not additional protection.
--
-- PREREQUISITE, run immediately before this statement, every environment:
--
--   select appointment_id, client_id, count(*) from public.lesson_transactions
--     where transaction_type='lesson_deduction' and appointment_id is not null
--     group by appointment_id, client_id having count(*) > 1;
--   -- must return zero rows
--
--   select count(*) filter (where client_package_id is null) as null_package,
--          count(*) filter (where appointment_id is null) as null_appointment,
--          count(*) filter (where client_id is null) as null_client
--     from public.lesson_transactions where transaction_type='lesson_deduction';
--   -- all three must be zero
--
--   select transaction_type, count(*) from public.lesson_transactions group by transaction_type;
--   -- inspect for any unexpected value; confirm no 'appointment_attendance' rows
--
-- If any of these differ materially from the expected result on a given
-- environment: STOP. Do not proceed with this statement on that
-- environment, and do not silently clean or dedupe production financial
-- transaction history.

create unique index concurrently if not exists
  uq_lesson_transactions_appointment_client_deduction
on public.lesson_transactions (appointment_id, client_id)
where transaction_type = 'lesson_deduction' and appointment_id is not null;
