-- Rollback for 20270223120000_calendar_feeds_legacy_instructor_tokens_v1: removes only the migrated rows.
-- Their audit events stay (the audit table is append-only); the legacy plaintext feeds were never changed.
begin;
set local lock_timeout = '5s';
delete from public.calendar_feed_tokens where legacy_source = 'instructor_feed';
commit;
