-- Rollback of 20270221091000_event_registrations_unclaimed_email_index_concurrent.sql (run standalone, not in a transaction).
drop index concurrently if exists public.event_registrations_unclaimed_email_idx;
