-- GC-1.2 membership-usage index widen ROLLBACK -- STEP 1 of 5 (stop gate).
--
-- Unlike the forward direction (mathematically guaranteed safe, since the
-- existing narrow constraint already prevented any duplicate before the
-- widen), restoring the narrow index is NOT guaranteed safe: if any code
-- after GC-1.2 ever wrote a second client_membership_usage row for the
-- same (reference_type, reference_id) with a different client_membership_id
-- (legitimate multi-student class membership usage -- not possible from any
-- code shipped in GC-1.2 itself, but possible from a later slice),
-- restoring the old narrower index would either fail outright or force
-- silently discarding one of several legitimate rows.
--
-- This file contains exactly one statement (a single DO block) and is
-- read-only/non-mutating -- it performs no schema or data change, so it is
-- safe to run as its own `supabase db query --linked -f` invocation, and
-- safe to re-run any number of times.
--
-- If this raises: STOP. Do not run step 2 or any later rollback step for
-- this index. Report the conflicting groups named in the error and obtain
-- an explicit resolution decision (merge, re-key, or abandon this rollback
-- for this index) before proceeding. No DDL has been executed by this
-- script.
--
-- If this completes without raising: proceed to
--   20260908120200_gc1_2_membership_usage_index_widen_rollback_step2_create_restored_concurrent.sql

do $$
declare
  v_conflict_count int;
begin
  select count(*) into v_conflict_count
  from (
    select reference_type, reference_id
    from public.client_membership_usage
    where reference_type = 'appointment' and reference_id is not null
    group by reference_type, reference_id
    having count(*) > 1
  ) conflicts;

  if v_conflict_count > 0 then
    raise exception 'GC-1.2 membership index rollback STOPPED: % (reference_type, reference_id) group(s) now have more than one client_membership_usage row -- restoring the narrower unique index would require discarding legitimate data. Report the conflicting groups and obtain an explicit resolution decision (merge, re-key, or abandon this rollback for this index) before proceeding. No DDL has been executed by this script.', v_conflict_count;
  end if;
end $$;
