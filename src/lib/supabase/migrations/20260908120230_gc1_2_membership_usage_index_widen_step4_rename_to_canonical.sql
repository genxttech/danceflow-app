-- GC-1.2 membership-usage index widen -- STEP 4 of 4 (final step).
--
-- Only run this file after step 3
-- (20260908120220_gc1_2_membership_usage_index_widen_step3_drop_old_concurrent.sql)
-- has completed. ALTER INDEX ... RENAME is a fast, metadata-only catalog
-- update -- it does not rebuild the index and does not require
-- CONCURRENTLY -- but is kept as its own file/invocation for a clean,
-- unambiguous one-statement-per-file execution record matching steps 1-3.
--
-- After this file runs, client_membership_usage_appointment_unique_idx is
-- the widened (reference_type, reference_id, client_membership_id) index --
-- the rollout is complete.

alter index public.client_membership_usage_appointment_unique_idx_widened
  rename to client_membership_usage_appointment_unique_idx;
