-- Rollback for 20260911120700_p6b_fix_generated_duration_column_writes.sql
--
-- DELIBERATE NO-OP. Read this in full before running it.
--
-- P6b changed ONLY the function BODIES of the two already-applied P6 core
-- functions (public._lesson_membership_reservation_core_create and
-- public._lesson_membership_reservation_core_update) via CREATE OR
-- REPLACE FUNCTION -- no signature change, no new function created, no
-- function dropped. It corrected a confirmed defect: the pre-P6b bodies
-- explicitly wrote a value into public.appointments.duration_minutes,
-- which is a live GENERATED ALWAYS ... STORED column -- every invocation
-- of either function failed with Postgres error 428C9 ("cannot insert a
-- non-DEFAULT value into column duration_minutes").
--
-- Because the pre-P6b body is confirmed broken against the live schema,
-- this rollback intentionally does NOT restore it. A rollback must never
-- trade a known-working database state for a known-broken one, and
-- reintroducing that write would do exactly that on any environment where
-- duration_minutes is a generated column -- which, as far as this audit
-- found, is every environment this migration set targets.
--
-- PRECONDITION: this file is only meaningful as part of rolling back the
-- entire P6 feature chain. Run it (if at all) immediately alongside
-- 20260911120600_p6_atomic_private_lesson_membership_rpcs_rollback.sql,
-- which already issues `drop function if exists` against the exact
-- signatures of both core functions (and all four public wrappers that
-- depend on them). Since P6b never changed either function's signature,
-- that existing P6 rollback drops the corrected (P6b) bodies exactly as
-- cleanly as it would have dropped the original ones -- nothing further
-- is needed here, and adding a redundant DROP in this file would only
-- race or duplicate that statement.
--
-- Do NOT run this file while intending to keep P6's wrappers live and
-- functional. There is no partial-rollback path for P6b alone that both
-- (a) undoes this correction and (b) leaves DEV/PROD in a working state,
-- because the only pre-P6b state was broken. If the intent is not to roll
-- back all of P6, there is nothing safe for this file to do -- so it does
-- nothing.

begin;

do $$
begin
  raise notice 'P6b rollback is a deliberate no-op -- see file header. To actually remove these functions, run the full P6 rollback (20260911120600_p6_atomic_private_lesson_membership_rpcs_rollback.sql), which drops them by signature regardless of which body (pre- or post-P6b) is currently installed.';
end $$;

commit;
