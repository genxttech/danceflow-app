-- Rollback for 20270223090000_calendar_feeds_tokens_v1. Removes the dark calendar-feed objects only.
-- WARNING: drops every feed token and audit row. Run only while CALENDAR_FEEDS_ENABLED is off everywhere.
begin;
set local lock_timeout = '5s';
-- The legacy-token step (20270223120000) writes into these tables from a trigger on instructor_calendar_feeds: roll it back FIRST,
-- otherwise every legacy feed write would fail after the tables are gone.
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'calendar_feed_sync_legacy_instructor_trg' and not tgisinternal) then
    raise exception 'run the 20270223120000 rollback first. Nothing was changed.';
  end if;
end $$;
drop trigger if exists calendar_feed_instructor_deactivated_trg on public.instructors;
drop trigger if exists calendar_feed_role_deactivated_trg on public.user_studio_roles;
drop function if exists public.calendar_feed_on_instructor_deactivated();
drop function if exists public.calendar_feed_on_role_deactivated();
drop function if exists public.calendar_feed_rate_check(text, integer, integer);
drop function if exists public.calendar_feed_resolve(text);
drop function if exists public.calendar_feed_set_studio_enabled(uuid, boolean, uuid);
drop function if exists public.calendar_feed_set_detail(uuid, uuid, uuid, text, uuid[], uuid);
drop function if exists public.calendar_feed_revoke_studio(uuid, text, uuid);
drop function if exists public.calendar_feed_revoke_subject(uuid, text, uuid, text, uuid, text);
drop function if exists public.calendar_feed_revoke(uuid, uuid, uuid, text, uuid, text);
drop function if exists public.calendar_feed_issue_token(uuid, text, uuid, text, text, text, uuid[], uuid, integer);
drop function if exists public.calendar_feed_audit(uuid, uuid, uuid, text, text, text, jsonb);
drop table if exists public.calendar_feed_rate_buckets;
drop table if exists public.calendar_feed_audit_events;
drop function if exists public.calendar_feed_audit_no_update();
drop table if exists public.calendar_feed_tokens;
drop function if exists public.calendar_feed_token_guard();
drop table if exists public.calendar_feed_settings;
notify pgrst, 'reload schema';
commit;
