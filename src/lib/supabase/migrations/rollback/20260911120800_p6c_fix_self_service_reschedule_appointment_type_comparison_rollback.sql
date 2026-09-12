-- Rollback for
-- 20260911120800_p6c_fix_self_service_reschedule_appointment_type_comparison.sql
--
-- DELIBERATE NO-OP, same discipline as
-- 20260911120700_p6b_fix_generated_duration_column_writes_rollback.sql.
-- Read this in full before running it.
--
-- P6c changed ONLY the BODY of one already-applied P6 function
-- (public.update_private_lesson_membership_appointment_self_service) via
-- CREATE OR REPLACE FUNCTION -- no signature change, no new function
-- created, no function dropped. It corrected a confirmed defect: the
-- pre-P6c body compared/passed a public.appointment_type enum value
-- (v_old.appointment_type) directly where a concrete `text`/`text[]`
-- value was required, in three places -- Postgres has no implicit or
-- assignment cast for this enum (confirmed via an empty pg_cast query
-- against DEV), so every invocation failed with error 42883 ("operator
-- does not exist" / "function ... does not exist").
--
-- Because the pre-P6c body is confirmed broken against the live schema,
-- this rollback intentionally does NOT restore it. A rollback must never
-- trade a known-working database state for a known-broken one.
--
-- PRECONDITION: this file is only meaningful as part of rolling back the
-- entire P6 feature chain. Run it (if at all) alongside
-- 20260911120600_p6_atomic_private_lesson_membership_rpcs_rollback.sql,
-- which already issues `drop function if exists` against the exact
-- signature of update_private_lesson_membership_appointment_self_service
-- (and every other P6 function). Since P6c never changed that signature,
-- the existing P6 rollback drops the corrected (P6c) body exactly as
-- cleanly as it would have dropped the original one -- nothing further
-- is needed here, and adding a redundant DROP in this file would only
-- race or duplicate that statement.
--
-- Do NOT run this file while intending to keep P6's wrappers live and
-- functional. There is no partial-rollback path for P6c alone that both
-- (a) undoes this correction and (b) leaves DEV/PROD in a working state,
-- because the only pre-P6c state was broken. If the intent is not to roll
-- back all of P6, there is nothing safe for this file to do -- so it does
-- nothing.

begin;

do $$
begin
  raise notice 'P6c rollback is a deliberate no-op -- see file header. To actually remove this function, run the full P6 rollback (20260911120600_p6_atomic_private_lesson_membership_rpcs_rollback.sql), which drops it by signature regardless of which body (pre-P6c or post-P6c) is currently installed.';
end $$;

commit;
