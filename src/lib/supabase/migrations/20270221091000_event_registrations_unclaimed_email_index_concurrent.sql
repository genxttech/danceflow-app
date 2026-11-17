-- Supports public.claim_my_event_registrations() (20270221090000): finds unclaimed registrations by normalised buyer email
-- without a sequential scan. Partial, so it stays small and shrinks as rows are claimed.
--
-- ============================================================================
-- DO NOT RUN THIS INSIDE A TRANSACTION (CREATE INDEX CONCURRENTLY). Run it standalone, as with the other *_concurrent
-- migrations in this directory. If a build fails midway, drop the INVALID index (DROP INDEX CONCURRENTLY IF EXISTS ...) and retry.
-- The function works without this index (slower); the index is a performance step only.
-- ============================================================================

create index concurrently if not exists event_registrations_unclaimed_email_idx
  on public.event_registrations (lower(btrim(attendee_email)))
  where user_id is null and attendee_email is not null;
