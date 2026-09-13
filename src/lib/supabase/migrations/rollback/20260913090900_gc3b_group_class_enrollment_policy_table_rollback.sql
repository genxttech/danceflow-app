-- Rollback for 20260913090900_gc3b_group_class_enrollment_policy_table.sql
--
-- IMPORTANT PRECONDITION: only run this together with reverting gc3c
-- (20260913091000) FIRST -- gc3c's get_eligible_group_class_funding_candidates
-- and its CREATE OR REPLACE of enroll_class_attendee both read this table.
-- Rolling back gc3b while gc3c is still live will break on "relation does
-- not exist" the next time either function runs.
--
-- Guarded, preservation-first (matching GC-3.1's own rollback posture):
-- aborts if any policy row already exists, rather than silently discarding
-- configured policy data. If a genuine rollback is needed after real policy
-- rows have been created, reconcile or export them first, or skip this
-- revert and keep the table in place.

begin;

do $$
begin
  if exists (select 1 from public.group_class_enrollment_policies limit 1) then
    raise exception 'Cannot roll back group_class_enrollment_policies: policy rows already exist. Reconcile or export them before rolling back, or skip this revert and keep the table in place.';
  end if;
end;
$$;

drop trigger if exists group_class_enrollment_policies_enforce_shape on public.group_class_enrollment_policies;
drop function if exists public.enforce_group_class_enrollment_policy_shape();
drop table if exists public.group_class_enrollment_policies;

commit;
