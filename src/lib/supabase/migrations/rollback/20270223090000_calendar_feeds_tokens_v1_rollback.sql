-- Rollback for 20270223090000_calendar_feeds_tokens_v1. Removes the dark calendar-feed objects only.
-- WARNING: drops every feed token and audit row. Run only while CALENDAR_FEEDS_ENABLED is off everywhere.
begin;
drop trigger if exists calendar_feed_instructor_deactivated_trg on public.instructors;
drop trigger if exists calendar_feed_role_deactivated_trg on public.user_studio_roles;
drop function if exists public.calendar_feed_on_instructor_deactivated();
drop function if exists public.calendar_feed_on_role_deactivated();
drop function if exists public.calendar_feed_rate_check(text, integer, integer);
drop function if exists public.calendar_feed_resolve(text);
drop function if exists public.calendar_feed_set_studio_enabled(uuid, boolean, uuid);
drop function if exists public.calendar_feed_set_detail(uuid, text, uuid[], uuid);
drop function if exists public.calendar_feed_revoke_studio(uuid, text, uuid);
drop function if exists public.calendar_feed_revoke_subject(uuid, text, uuid, text, uuid, text);
drop function if exists public.calendar_feed_revoke(uuid, text, uuid, text);
drop function if exists public.calendar_feed_issue_token(uuid, text, uuid, text, text, text, uuid[], uuid, integer);
drop function if exists public.calendar_feed_audit(uuid, uuid, uuid, text, text, text, jsonb);
drop table if exists public.calendar_feed_rate_buckets;
drop table if exists public.calendar_feed_audit_events;
drop function if exists public.calendar_feed_audit_no_update();
drop table if exists public.calendar_feed_tokens;
drop table if exists public.calendar_feed_settings;
notify pgrst, 'reload schema';
commit;
