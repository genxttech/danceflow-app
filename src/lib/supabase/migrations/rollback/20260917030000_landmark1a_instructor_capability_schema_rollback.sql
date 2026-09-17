-- Rollback for 20260917030000_landmark1a_instructor_capability_schema.sql
--
-- Removes exactly the Slice 1 objects: the immutability trigger/function,
-- the instructor_audit_events table (which drops its own RLS policies
-- and indexes automatically), and instructors.can_instruct. Touches no
-- pre-existing instructor/account/scheduling/payroll object or row.

begin;

drop trigger if exists instructor_audit_events_immutable on public.instructor_audit_events;
drop function if exists public.prevent_instructor_audit_event_mutation();
drop table if exists public.instructor_audit_events;

alter table public.instructors
  drop column if exists can_instruct;

commit;
