-- GC-1.2 membership-usage index widen ROLLBACK -- STEP 4 of 5.
--
-- Only run this file after
-- 20260908120210_gc1_2_membership_usage_index_widen_rollback_step3_verify_restored_valid.sql
-- has returned indisvalid = true for
-- client_membership_usage_appointment_unique_idx_restored. At that point
-- the restored, narrower index is already live and enforcing uniqueness --
-- dropping the widened index here never creates a window with zero
-- uniqueness protection.
--
-- This file contains exactly one statement and must be executed as its own
-- `supabase db query --linked -f` invocation, for the same CONCURRENTLY/
-- transaction-block reason as step 2.
--
-- NEXT: run 20260908120230_gc1_2_membership_usage_index_widen_rollback_step5_rename_to_canonical.sql

drop index concurrently if exists public.client_membership_usage_appointment_unique_idx;
