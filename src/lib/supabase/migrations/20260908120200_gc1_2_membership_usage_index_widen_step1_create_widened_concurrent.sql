-- GC-1.2 membership-usage index widen -- STEP 1 of 4.
--
-- Zero-gap replacement of client_membership_usage_appointment_unique_idx:
-- build the new, wider index under a temporary name. The existing narrow
-- index is untouched and remains fully enforced throughout this step and
-- the next.
--
-- This file contains exactly one statement and must be executed as its own
-- `supabase db query --linked -f` invocation. CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block; issuing this alongside any other
-- statement in one file/call causes Postgres to reject it immediately
-- (25001) before anything executes.
--
-- PREREQUISITE (read-only, run before this file, every environment):
--
--   select indexdef from pg_indexes where schemaname='public'
--     and indexname='client_membership_usage_appointment_unique_idx';
--   -- confirm it matches the expected current (narrow) definition
--
--   select reference_type, reference_id, count(*) from public.client_membership_usage
--     where reference_type='appointment' and reference_id is not null
--     group by reference_type, reference_id having count(*) > 1;
--   -- must return zero rows (guaranteed by the existing constraint's own
--   -- enforcement; if this ever returns rows, the existing index has
--   -- somehow already been violated -- stop and investigate)
--
-- NEXT: run 20260908120210_gc1_2_membership_usage_index_widen_step2_verify_widened_valid.sql
-- and confirm indisvalid=true before proceeding to step 3.

create unique index concurrently if not exists
  client_membership_usage_appointment_unique_idx_widened
on public.client_membership_usage (reference_type, reference_id, client_membership_id)
where reference_type = 'appointment' and reference_id is not null;
