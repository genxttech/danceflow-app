-- GC-1.2 membership-usage index widen -- STEP 3 of 4.
--
-- Only run this file after
-- 20260908120210_gc1_2_membership_usage_index_widen_step2_verify_widened_valid.sql
-- has been executed and returned indisvalid = true for
-- client_membership_usage_appointment_unique_idx_widened. At that point the
-- new, wider index is already live and enforcing uniqueness, redundantly
-- alongside this old, narrower one -- dropping the old index here never
-- creates a window with zero uniqueness protection.
--
-- This file contains exactly one statement and must be executed as its own
-- `supabase db query --linked -f` invocation, for the same CONCURRENTLY/
-- transaction-block reason as step 1.
--
-- NEXT: run 20260908120230_gc1_2_membership_usage_index_widen_step4_rename_to_canonical.sql

drop index concurrently if exists public.client_membership_usage_appointment_unique_idx;
