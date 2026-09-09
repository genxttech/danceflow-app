-- GC-1.2 membership-usage index widen ROLLBACK -- STEP 2 of 5.
--
-- Only run this file after
-- 20260908120190_gc1_2_membership_usage_index_widen_rollback_step1_gate_check.sql
-- has completed WITHOUT raising.
--
-- Build the old, narrower index under a temporary name. The current
-- (widened) index remains untouched and still enforcing uniqueness during
-- this step and the next.
--
-- This file contains exactly one statement and must be executed as its own
-- `supabase db query --linked -f` invocation -- CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block; issuing this alongside any other
-- statement in one file/call causes Postgres to reject it immediately
-- (25001) before anything executes.
--
-- NEXT: run 20260908120210_gc1_2_membership_usage_index_widen_rollback_step3_verify_restored_valid.sql

create unique index concurrently if not exists
  client_membership_usage_appointment_unique_idx_restored
on public.client_membership_usage (reference_type, reference_id)
where reference_type = 'appointment' and reference_id is not null;
