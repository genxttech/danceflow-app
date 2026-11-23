-- Calendar feeds v1, step 2: carry the existing instructor feed tokens into the hash-only table and keep the two in sync.
-- Requires 20270223090000_calendar_feeds_tokens_v1. DARK: a migrated token only resolves when CALENDAR_FEEDS_ENABLED=true AND the
-- studio is enabled in calendar_feed_settings; until then the legacy route keeps serving the same URL exactly as before.
--
-- Backfill: for every ACTIVE instructor_calendar_feeds row whose instructor is active, linked to a user that still has an active role in
-- the studio, store sha256(token) in calendar_feed_tokens (subject_kind 'staff', legacy_source 'instructor_feed', detail 'minimal') so the
-- same subscription URL keeps working but is served by the new renderer once the studio is enabled. Migrated tokens do not expire
-- (legacy URLs never did); owners can still revoke them. The plaintext column is NOT touched (dropping it is a later cutover step).
--
-- Two-way sync so a revoked URL stays revoked in BOTH systems:
--   legacy -> new: regenerating a feed token, deactivating or deleting a feed revokes the old hash; a new/regenerated active, eligible feed
--                  gets its hash registered (so feeds created AFTER this migration are carried over too);
--   new -> legacy: when a migrated token is revoked (user/admin turn-off, rotation, deactivation or role loss hooks) the matching legacy
--                  feed is set inactive, so the old route cannot fall back to the richer legacy response for a dead URL.
-- Not migrated: feeds of unlinked/inactive instructors, subjects that already have a current token. Coach-schedule feeds are out of scope.
-- Idempotent: re-running adds nothing. Rollback is only safe BEFORE any studio is enabled (see the rollback file).

begin;
set local lock_timeout = '5s';

create or replace function public.calendar_feed_legacy_hash(p_token text)
returns text language sql immutable set search_path = public, pg_temp as $fn$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$fn$;

-- Register one legacy feed row in the hash-only table if it is eligible and its subject has no current token. Returns true if inserted.
create or replace function public.calendar_feed_register_legacy_instructor(p_feed_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_row record;
  v_id uuid;
begin
  select f.studio_id, f.token, f.active, i.user_id, i.active as instructor_active
    into v_row
    from public.instructor_calendar_feeds f
    join public.instructors i on i.id = f.instructor_id and i.studio_id = f.studio_id
   where f.id = p_feed_id;
  if not found then return false; end if;
  if v_row.active is not true or v_row.instructor_active is not true or v_row.user_id is null then return false; end if;
  if v_row.token !~ '^[A-Za-z0-9_-]{43}$' then return false; end if;
  if not exists (select 1 from auth.users u where u.id = v_row.user_id) then return false; end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = v_row.user_id and r.studio_id = v_row.studio_id and r.active is true) then return false; end if;
  if exists (select 1 from public.calendar_feed_tokens t where t.studio_id = v_row.studio_id and t.subject_kind = 'staff'
              and t.subject_user_id = v_row.user_id and t.status = 'active' and t.superseded_at is null) then return false; end if;

  insert into public.calendar_feed_tokens
    (studio_id, subject_kind, subject_user_id, token_hash, token_prefix, detail_level, legacy_source, expires_at)
  values
    (v_row.studio_id, 'staff', v_row.user_id, public.calendar_feed_legacy_hash(v_row.token), left(v_row.token, 6), 'minimal', 'instructor_feed',
     now() + interval '100 years')
  on conflict (token_hash) do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  perform public.calendar_feed_audit(v_row.studio_id, v_id, null, 'system', 'migrated', null, jsonb_build_object('source', 'instructor_feed'));
  return true;
end;
$fn$;

-- legacy -> new
create or replace function public.calendar_feed_sync_from_legacy_instructor()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_old_hash text;
  v_row record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if tg_op = 'DELETE' or old.token is distinct from new.token or new.active is not true then
      v_old_hash := public.calendar_feed_legacy_hash(old.token);
      for v_row in
        update public.calendar_feed_tokens
           set status = 'revoked', revoked_at = now(),
               revoked_reason = case when tg_op = 'UPDATE' and old.token is distinct from new.token then 'rotated' else 'admin' end
         where token_hash = v_old_hash and legacy_source = 'instructor_feed' and status = 'active'
        returning id, studio_id, revoked_reason
      loop
        perform public.calendar_feed_audit(v_row.studio_id, v_row.id, null, 'system', 'revoked', v_row.revoked_reason, '{}'::jsonb);
      end loop;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.calendar_feed_register_legacy_instructor(new.id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

drop trigger if exists calendar_feed_sync_legacy_instructor_trg on public.instructor_calendar_feeds;
create trigger calendar_feed_sync_legacy_instructor_trg
  after insert or update of token, active or delete on public.instructor_calendar_feeds
  for each row execute function public.calendar_feed_sync_from_legacy_instructor();

-- new -> legacy: a revoked migrated token must not leave its URL working through the legacy route
create or replace function public.calendar_feed_sync_to_legacy_instructor()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.legacy_source = 'instructor_feed' and new.status = 'revoked' and old.status is distinct from 'revoked' then
    update public.instructor_calendar_feeds f
       set active = false
     where f.studio_id = new.studio_id and f.active is true
       and public.calendar_feed_legacy_hash(f.token) = new.token_hash;
  end if;
  return new;
end;
$fn$;

drop trigger if exists calendar_feed_sync_to_legacy_instructor_trg on public.calendar_feed_tokens;
create trigger calendar_feed_sync_to_legacy_instructor_trg
  after update of status on public.calendar_feed_tokens
  for each row execute function public.calendar_feed_sync_to_legacy_instructor();

revoke all on function public.calendar_feed_legacy_hash(text) from public, anon, authenticated, service_role;
revoke all on function public.calendar_feed_register_legacy_instructor(uuid) from public, anon, authenticated, service_role;
revoke all on function public.calendar_feed_sync_from_legacy_instructor() from public, anon, authenticated, service_role;
revoke all on function public.calendar_feed_sync_to_legacy_instructor() from public, anon, authenticated, service_role;

-- Backfill (same eligibility as the trigger path)
select count(*) filter (where public.calendar_feed_register_legacy_instructor(f.id)) as migrated
  from public.instructor_calendar_feeds f
 where f.active is true;

commit;
