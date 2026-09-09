-- GC-1.2 membership-usage index widen -- STEP 2 of 4 (validation gate).
--
-- MANDATORY GATE. CREATE INDEX CONCURRENTLY (step 1) can leave an index
-- INVALID if the build is interrupted. Do not proceed to step 3 (dropping
-- the old, currently-enforced index) until this query's output has been
-- read and confirmed to be `true`.
--
-- Run as its own `supabase db query --linked -f` invocation. This is a
-- read-only SELECT -- it makes no schema or data change, and is safe to
-- re-run any number of times.
--
-- If the result is `true`: proceed to
--   20260908120220_gc1_2_membership_usage_index_widen_step3_drop_old_concurrent.sql
--
-- If the result is `false` or no row is returned: STOP. Do not run step 3.
-- The old (narrow) index is untouched and still enforcing uniqueness at
-- this point -- there is no urgency to proceed. Drop the invalid index
-- (`drop index concurrently if exists
-- public.client_membership_usage_appointment_unique_idx_widened;`, its own
-- invocation) and investigate before retrying step 1.

select indisvalid
from pg_index
where indexrelid = 'public.client_membership_usage_appointment_unique_idx_widened'::regclass;
