-- Rollback for 20270223120000_calendar_feeds_legacy_instructor_tokens_v1.
-- ONLY SAFE BEFORE ANY STUDIO IS ENABLED: it deletes every migrated row, including revoked ones, so a URL the new system had revoked would
-- be served again by the legacy route (legacy feeds deactivated by the sync trigger stay inactive, but rows never revoked-and-deactivated would reopen).
-- Audit events stay (append-only table). The legacy plaintext feeds themselves were never changed except by the new -> legacy sync (active=false).
begin;
set local lock_timeout = '5s';
drop trigger if exists calendar_feed_sync_to_legacy_instructor_trg on public.calendar_feed_tokens;
drop trigger if exists calendar_feed_sync_legacy_instructor_trg on public.instructor_calendar_feeds;
drop function if exists public.calendar_feed_sync_to_legacy_instructor();
drop function if exists public.calendar_feed_sync_from_legacy_instructor();
drop function if exists public.calendar_feed_register_legacy_instructor(uuid);
drop function if exists public.calendar_feed_legacy_hash(text);
delete from public.calendar_feed_tokens where legacy_source = 'instructor_feed';
commit;
