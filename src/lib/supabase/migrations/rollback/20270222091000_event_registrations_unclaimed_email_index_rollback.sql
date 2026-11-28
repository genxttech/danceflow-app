-- Rollback of 20270222091000_event_registrations_unclaimed_email_index.sql. Performance only; the claim function works without it.
begin;
drop index if exists public.event_registrations_unclaimed_email_idx;
commit;
