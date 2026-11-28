-- Supports public.claim_my_event_registrations() (20270221090000, restricted by 20270222090000): finds unclaimed registrations by
-- normalised buyer email without a sequential scan. Partial, so it stays small and shrinks as rows are claimed.
--
-- REPLACES the never-applied CONCURRENTLY file 20270221091000 (retired in the same PR): the hosted runner path
-- (`supabase db query --linked -f`) cannot be proven to run a standalone CONCURRENTLY statement outside a transaction, and the table is
-- tiny (about 312 kB on PROD), so a plain transactional CREATE INDEX (brief SHARE lock) is the safer, fully ordered choice.
-- Sorts after every other claim file, so migration history order equals apply order: function, exclusion, index.
-- Git-only: do NOT apply to hosted databases without the owner's authorization.

begin;

create index if not exists event_registrations_unclaimed_email_idx
  on public.event_registrations (lower(btrim(attendee_email)))
  where user_id is null and attendee_email is not null;

commit;
