-- GC-1.2 membership-usage index widen ROLLBACK -- STEP 3 of 5 (validation gate).
--
-- MANDATORY GATE. Do not proceed to step 4 (dropping the widened index)
-- until this query's output has been read and confirmed to be `true`.
--
-- Run as its own `supabase db query --linked -f` invocation. Read-only --
-- makes no schema or data change, safe to re-run any number of times.
--
-- If the result is `true`: proceed to
--   20260908120220_gc1_2_membership_usage_index_widen_rollback_step4_drop_widened_concurrent.sql
--
-- If the result is `false` or no row is returned: STOP. The widened index
-- is untouched and still enforcing uniqueness at this point. Drop the
-- invalid index (`drop index concurrently if exists
-- public.client_membership_usage_appointment_unique_idx_restored;`, its own
-- invocation) and investigate before retrying step 2.

select indisvalid
from pg_index
where indexrelid = 'public.client_membership_usage_appointment_unique_idx_restored'::regclass;
