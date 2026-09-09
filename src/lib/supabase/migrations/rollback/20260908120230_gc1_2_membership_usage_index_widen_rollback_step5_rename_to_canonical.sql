-- GC-1.2 membership-usage index widen ROLLBACK -- STEP 5 of 5 (final step).
--
-- Only run this file after step 4
-- (20260908120220_gc1_2_membership_usage_index_widen_rollback_step4_drop_widened_concurrent.sql)
-- has completed. Metadata-only rename, kept as its own file/invocation for
-- a clean, unambiguous one-statement-per-file execution record matching
-- steps 1-4.
--
-- After this file runs, client_membership_usage_appointment_unique_idx is
-- the restored, narrow (reference_type, reference_id) index -- the
-- rollback is complete.

alter index public.client_membership_usage_appointment_unique_idx_restored
  rename to client_membership_usage_appointment_unique_idx;
