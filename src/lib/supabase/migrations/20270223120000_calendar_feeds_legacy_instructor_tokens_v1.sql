-- Calendar feeds v1, step 2: carry the existing instructor feed tokens into the hash-only table.
-- Requires 20270223090000_calendar_feeds_tokens_v1. DARK: a migrated token only resolves when CALENDAR_FEEDS_ENABLED=true AND the
-- studio is enabled in calendar_feed_settings; until then the legacy route keeps serving the same URL exactly as before.
--
-- What it does: for every ACTIVE instructor_calendar_feeds row whose instructor is active and linked to a user, store
-- sha256(token) in calendar_feed_tokens (subject_kind 'staff', legacy_source 'instructor_feed', detail 'minimal'), so the same
-- subscription URL keeps working but is served by the new renderer once the studio is enabled. The plaintext column in
-- instructor_calendar_feeds is NOT touched here (dropping it is a later cutover step after the feeds are enabled and verified).
-- Not migrated: feeds of unlinked or inactive instructors, and any subject that already has a current token. Coach-schedule
-- feeds are intentionally out of scope (their holders are external guest coaches, not user accounts).
-- Idempotent: re-running adds nothing.

begin;
set local lock_timeout = '5s';

with candidates as (
  select
    f.studio_id,
    i.user_id,
    encode(sha256(convert_to(f.token, 'UTF8')), 'hex') as token_hash,
    left(f.token, 6) as token_prefix
  from public.instructor_calendar_feeds f
  join public.instructors i on i.id = f.instructor_id and i.studio_id = f.studio_id
  where f.active is true
    and i.active is true
    and i.user_id is not null
    and f.token ~ '^[A-Za-z0-9_-]{43}$'
    and exists (select 1 from auth.users u where u.id = i.user_id)
), inserted as (
  insert into public.calendar_feed_tokens
    (studio_id, subject_kind, subject_user_id, token_hash, token_prefix, detail_level, legacy_source)
  select c.studio_id, 'staff', c.user_id, c.token_hash, c.token_prefix, 'minimal', 'instructor_feed'
  from candidates c
  where not exists (
    select 1 from public.calendar_feed_tokens t
    where t.studio_id = c.studio_id and t.subject_kind = 'staff' and t.subject_user_id = c.user_id
      and t.status = 'active' and t.superseded_at is null
  )
  on conflict (token_hash) do nothing
  returning id, studio_id
)
insert into public.calendar_feed_audit_events (studio_id, token_id, actor_kind, action, reason, metadata)
select studio_id, id, 'system', 'migrated', null, jsonb_build_object('source', 'instructor_feed')
from inserted;

commit;
