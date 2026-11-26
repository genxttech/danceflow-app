-- Calendar feeds v1 (priority 1, docs/integrations/Calendar_Feeds_Design.md): hash-only subscription tokens for
-- dancer and staff ICS feeds, per-studio kill switch, append-only audit, DB-backed rate-limit buckets.
--
-- DARK: nothing reads these tables until the app code ships behind CALENDAR_FEEDS_ENABLED and a per-studio
-- calendar_feed_settings.enabled row. No existing table or policy is changed here (the existing instructor feed
-- plaintext tokens are handled by a separate, later migration).
--
-- Access model: every object is service-role only. RLS is enabled with NO policies and all table/function privileges
-- are revoked from PUBLIC, anon and authenticated, so a browser session can never read a token hash or call a function.
-- The app authorises the caller (role, ownership) in server code and then calls these SECURITY DEFINER functions with
-- the service-role client.

begin;

-- Fail fast instead of queueing behind long-running queries on hot tables (instructors, user_studio_roles, studios, auth.users).
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------
-- Per-studio enablement (allowlist). Absent row = disabled.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.calendar_feed_settings (
  studio_id  uuid primary key references public.studios(id) on delete cascade,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- ---------------------------------------------------------------------------------------------------------------
-- Tokens (hash only). The plaintext secret exists only in the HTTP response that creates it.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.calendar_feed_tokens (
  id               uuid primary key default gen_random_uuid(),
  studio_id        uuid not null references public.studios(id) on delete cascade,
  subject_kind     text not null,
  subject_user_id  uuid not null references auth.users(id) on delete cascade,
  token_hash       text not null,
  token_prefix     text not null,
  detail_level     text not null default 'minimal',
  include_client_ids uuid[],
  status           text not null default 'active',
  created_at       timestamptz not null default now(),
  created_by       uuid,
  expires_at       timestamptz not null default (now() + interval '24 months'),
  rotated_from     uuid references public.calendar_feed_tokens(id) on delete set null,
  superseded_at    timestamptz,
  valid_until      timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text,
  last_accessed_at timestamptz,
  legacy_source    text,
  constraint calendar_feed_tokens_kind_check
    check (subject_kind in ('dancer_account', 'staff')),
  constraint calendar_feed_tokens_detail_check
    check (detail_level in ('minimal', 'standard')),
  constraint calendar_feed_tokens_status_check
    check (status in ('active', 'revoked')),
  constraint calendar_feed_tokens_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint calendar_feed_tokens_prefix_check
    check (char_length(token_prefix) between 4 and 8),
  constraint calendar_feed_tokens_reason_check
    check (revoked_reason is null or revoked_reason in (
      'user', 'admin', 'rotated', 'account_removed', 'role_lost', 'staff_deactivated',
      'link_removed', 'studio_offboarded', 'incident', 'expired')),
  constraint calendar_feed_tokens_legacy_check
    check (legacy_source is null or legacy_source in ('instructor_feed', 'coach_feed')),
  constraint calendar_feed_tokens_revoked_consistency
    check ((status = 'revoked') = (revoked_at is not null))
);

create unique index if not exists calendar_feed_tokens_hash_uidx
  on public.calendar_feed_tokens (token_hash);

-- At most one CURRENT (not superseded) active token per studio + subject. Superseded tokens may overlap briefly.
create unique index if not exists calendar_feed_tokens_current_uidx
  on public.calendar_feed_tokens (studio_id, subject_kind, subject_user_id)
  where status = 'active' and superseded_at is null;

create index if not exists calendar_feed_tokens_subject_idx
  on public.calendar_feed_tokens (studio_id, subject_kind, subject_user_id);
create index if not exists calendar_feed_tokens_user_idx
  on public.calendar_feed_tokens (subject_user_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Audit (append-only: updates are refused; rows go only with their studio).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.calendar_feed_audit_events (
  id            uuid primary key default gen_random_uuid(),
  studio_id     uuid not null references public.studios(id) on delete cascade,
  token_id      uuid,
  actor_user_id uuid,
  actor_kind    text not null,
  action        text not null,
  reason        text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint calendar_feed_audit_actor_kind_check
    check (actor_kind in ('user', 'admin', 'system', 'aria')),
  constraint calendar_feed_audit_action_check
    check (action in ('created', 'rotated', 'revoked', 'detail_changed', 'enabled', 'disabled', 'migrated'))
);
create index if not exists calendar_feed_audit_studio_idx
  on public.calendar_feed_audit_events (studio_id, created_at desc);

create or replace function public.calendar_feed_audit_no_update()
returns trigger language plpgsql as $fn$
begin
  raise exception 'calendar_feed_audit_events is append-only';
end;
$fn$;

drop trigger if exists calendar_feed_audit_no_update_trg on public.calendar_feed_audit_events;
create trigger calendar_feed_audit_no_update_trg
  before update on public.calendar_feed_audit_events
  for each row execute function public.calendar_feed_audit_no_update();

-- ---------------------------------------------------------------------------------------------------------------
-- Rate-limit buckets (fixed window, DB-backed so limits hold across serverless instances).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.calendar_feed_rate_buckets (
  bucket_key   text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket_key, window_start),
  constraint calendar_feed_rate_key_len check (char_length(bucket_key) between 1 and 128)
);
create index if not exists calendar_feed_rate_window_idx on public.calendar_feed_rate_buckets (window_start);

-- ---------------------------------------------------------------------------------------------------------------
-- Lockdown: RLS on, no policies, no browser privileges.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.calendar_feed_settings      enable row level security;
alter table public.calendar_feed_tokens        enable row level security;
alter table public.calendar_feed_audit_events  enable row level security;
alter table public.calendar_feed_rate_buckets  enable row level security;

revoke all on public.calendar_feed_settings     from public, anon, authenticated;
revoke all on public.calendar_feed_tokens       from public, anon, authenticated;
revoke all on public.calendar_feed_audit_events from public, anon, authenticated;
revoke all on public.calendar_feed_rate_buckets from public, anon, authenticated;

-- Writes go ONLY through the SECURITY DEFINER functions below: the API service role keeps read access and nothing else,
-- so a revocation cannot be undone and audit rows cannot be removed through the API.
revoke insert, update, delete, truncate on public.calendar_feed_settings     from service_role;
revoke insert, update, delete, truncate on public.calendar_feed_tokens       from service_role;
revoke insert, update, delete, truncate on public.calendar_feed_audit_events from service_role;
revoke insert, update, delete, truncate on public.calendar_feed_rate_buckets from service_role;

-- A token's identity is fixed and revocation is final, whoever performs the update.
create or replace function public.calendar_feed_token_guard()
returns trigger language plpgsql as $fn$
begin
  if old.status = 'revoked' and new.status is distinct from 'revoked' then
    raise exception 'a revoked calendar feed token cannot be reactivated';
  end if;
  if new.token_hash is distinct from old.token_hash or new.studio_id is distinct from old.studio_id
     or new.subject_kind is distinct from old.subject_kind or new.subject_user_id is distinct from old.subject_user_id then
    raise exception 'calendar feed token identity cannot be changed';
  end if;
  return new;
end;
$fn$;
drop trigger if exists calendar_feed_token_guard_trg on public.calendar_feed_tokens;
create trigger calendar_feed_token_guard_trg
  before update on public.calendar_feed_tokens
  for each row execute function public.calendar_feed_token_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Functions (all SECURITY DEFINER, service_role only).
-- ---------------------------------------------------------------------------------------------------------------

-- Internal: write an audit row.
create or replace function public.calendar_feed_audit(
  p_studio uuid, p_token uuid, p_actor uuid, p_actor_kind text, p_action text, p_reason text, p_meta jsonb
) returns void
language sql security definer set search_path = public, pg_temp as $fn$
  insert into public.calendar_feed_audit_events (studio_id, token_id, actor_user_id, actor_kind, action, reason, metadata)
  values (p_studio, p_token, p_actor, p_actor_kind, p_action, p_reason, coalesce(p_meta, '{}'::jsonb));
$fn$;

-- Create a token, or rotate the subject's current one. Overlap (seconds, clamped 0..86400) keeps the previous token
-- valid briefly; 0 revokes it immediately. Returns the new token id. The caller supplies only the HASH.
create or replace function public.calendar_feed_issue_token(
  p_studio uuid,
  p_kind text,
  p_user uuid,
  p_token_hash text,
  p_prefix text,
  p_detail text,
  p_include_client_ids uuid[],
  p_actor uuid,
  p_overlap_seconds integer default 0
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_enabled boolean;
  v_old public.calendar_feed_tokens%rowtype;
  v_new uuid;
  v_had boolean;
  v_stale record;
  v_overlap integer := greatest(0, least(coalesce(p_overlap_seconds, 0), 86400));
begin
  if p_include_client_ids is not null and coalesce(array_length(p_include_client_ids, 1), 0) > 50 then
    raise exception 'too many included profiles' using errcode = '22023';
  end if;
  select enabled into v_enabled from public.calendar_feed_settings where studio_id = p_studio for share;
  if coalesce(v_enabled, false) is not true then
    raise exception 'calendar feeds are not enabled for this studio' using errcode = 'P0001';
  end if;

  -- Serialise issue/rotate per subject.
  perform pg_advisory_xact_lock(hashtextextended(p_studio::text || ':' || p_kind || ':' || p_user::text, 0));

  -- Any previously superseded token still inside its overlap window dies now: at most ONE previous token is ever valid.
  for v_stale in
    update public.calendar_feed_tokens
       set status = 'revoked', revoked_at = now(), revoked_reason = 'rotated'
     where studio_id = p_studio and subject_kind = p_kind and subject_user_id = p_user
       and status = 'active' and superseded_at is not null
    returning id
  loop
    perform public.calendar_feed_audit(p_studio, v_stale.id, p_actor, 'user', 'revoked', 'rotated', '{}'::jsonb);
  end loop;

  select * into v_old from public.calendar_feed_tokens
   where studio_id = p_studio and subject_kind = p_kind and subject_user_id = p_user
     and status = 'active' and superseded_at is null
   for update;
  v_had := found;

  if v_had then
    if v_overlap > 0 then
      update public.calendar_feed_tokens
         set superseded_at = now(), valid_until = now() + make_interval(secs => v_overlap)
       where id = v_old.id;
    else
      update public.calendar_feed_tokens
         set status = 'revoked', revoked_at = now(), revoked_reason = 'rotated', superseded_at = now()
       where id = v_old.id;
      perform public.calendar_feed_audit(p_studio, v_old.id, p_actor, 'user', 'revoked', 'rotated', '{}'::jsonb);
    end if;
  end if;

  insert into public.calendar_feed_tokens
    (studio_id, subject_kind, subject_user_id, token_hash, token_prefix, detail_level, include_client_ids,
     created_by, rotated_from)
  values
    (p_studio, p_kind, p_user, p_token_hash, p_prefix, coalesce(p_detail, 'minimal'), p_include_client_ids,
     p_actor, case when v_had then v_old.id else null end)
  returning id into v_new;

  perform public.calendar_feed_audit(p_studio, v_new, p_actor, 'user',
    case when v_had then 'rotated' else 'created' end, null,
    jsonb_build_object('subject_kind', p_kind, 'overlap_seconds', v_overlap, 'rotated_from', case when v_had then v_old.id else null end));
  return v_new;
end;
$fn$;

-- Revoke one token. Returns true if a live token was revoked.
create or replace function public.calendar_feed_revoke(
  p_token_id uuid, p_studio uuid, p_subject_user uuid, p_reason text, p_actor uuid, p_actor_kind text default 'user'
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_studio uuid;
begin
  if p_reason is null or p_studio is null then
    raise exception 'reason and studio are required' using errcode = '22023';
  end if;
  update public.calendar_feed_tokens
     set status = 'revoked', revoked_at = now(), revoked_reason = p_reason
   where id = p_token_id and studio_id = p_studio
     and (p_subject_user is null or subject_user_id = p_subject_user)
     and status = 'active' and (valid_until is null or valid_until > now())
  returning studio_id into v_studio;
  if v_studio is null then
    return false;
  end if;
  perform public.calendar_feed_audit(v_studio, p_token_id, p_actor, p_actor_kind, 'revoked', p_reason, '{}'::jsonb);
  return true;
end;
$fn$;

-- Revoke every live token of a subject (current and overlapping). Returns the number revoked.
create or replace function public.calendar_feed_revoke_subject(
  p_studio uuid, p_kind text, p_user uuid, p_reason text, p_actor uuid, p_actor_kind text default 'system'
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_row record;
  v_count integer := 0;
begin
  if p_reason is null then
    raise exception 'reason is required' using errcode = '22023';
  end if;
  for v_row in
    update public.calendar_feed_tokens
       set status = 'revoked', revoked_at = now(), revoked_reason = p_reason
     where studio_id = p_studio and subject_kind = p_kind and subject_user_id = p_user and status = 'active'
       and (valid_until is null or valid_until > now())
    returning id
  loop
    perform public.calendar_feed_audit(p_studio, v_row.id, p_actor, p_actor_kind, 'revoked', p_reason, '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$fn$;

-- Revoke every live token of a studio (incident / offboarding). Returns the number revoked.
create or replace function public.calendar_feed_revoke_studio(
  p_studio uuid, p_reason text, p_actor uuid
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_row record;
  v_count integer := 0;
begin
  if p_reason is null then
    raise exception 'reason is required' using errcode = '22023';
  end if;
  for v_row in
    update public.calendar_feed_tokens
       set status = 'revoked', revoked_at = now(), revoked_reason = p_reason
     where studio_id = p_studio and status = 'active' and (valid_until is null or valid_until > now())
    returning id
  loop
    perform public.calendar_feed_audit(p_studio, v_row.id, p_actor, 'admin', 'revoked', p_reason, '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$fn$;

-- Change detail level / included profiles of a live token.
create or replace function public.calendar_feed_set_detail(
  p_token_id uuid, p_studio uuid, p_subject_user uuid, p_detail text, p_include_client_ids uuid[], p_actor uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_studio uuid;
begin
  if p_detail is null or p_detail not in ('minimal', 'standard') or p_studio is null then
    raise exception 'invalid detail level' using errcode = '22023';
  end if;
  if p_include_client_ids is not null and coalesce(array_length(p_include_client_ids, 1), 0) > 50 then
    raise exception 'too many included profiles' using errcode = '22023';
  end if;
  update public.calendar_feed_tokens
     set detail_level = p_detail, include_client_ids = p_include_client_ids
   where id = p_token_id and studio_id = p_studio
     and (p_subject_user is null or subject_user_id = p_subject_user)
     and status = 'active' and (valid_until is null or valid_until > now())
  returning studio_id into v_studio;
  if v_studio is null then
    return false;
  end if;
  perform public.calendar_feed_audit(v_studio, p_token_id, p_actor, 'user', 'detail_changed', null,
    jsonb_build_object('detail_level', p_detail));
  return true;
end;
$fn$;

-- Per-studio switch (audited).
create or replace function public.calendar_feed_set_studio_enabled(
  p_studio uuid, p_enabled boolean, p_actor uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_prev boolean;
begin
  if p_enabled is null then
    raise exception 'enabled is required' using errcode = '22023';
  end if;
  select enabled into v_prev from public.calendar_feed_settings where studio_id = p_studio for update;
  insert into public.calendar_feed_settings (studio_id, enabled, updated_at, updated_by)
  values (p_studio, p_enabled, now(), p_actor)
  on conflict (studio_id) do update set enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by;
  -- Disabling is a SOFT switch (feeds answer 404, tokens kept). Incidents and offboarding call calendar_feed_revoke_studio separately.
  if v_prev is distinct from p_enabled then
    perform public.calendar_feed_audit(p_studio, null, p_actor, 'admin',
      case when p_enabled then 'enabled' else 'disabled' end, null, '{}'::jsonb);
  end if;
end;
$fn$;

-- Resolve a presented token HASH to its subject. Returns zero rows for unknown, revoked, expired, superseded-past-overlap
-- tokens and for studios that are not enabled (callers must treat all of those identically). Touches last_accessed_at at
-- most once per 15 minutes.
create or replace function public.calendar_feed_resolve(p_token_hash text)
returns table (
  token_id uuid, studio_id uuid, subject_kind text, subject_user_id uuid,
  detail_level text, include_client_ids uuid[]
)
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v public.calendar_feed_tokens%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select t.* into v
    from public.calendar_feed_tokens t
    join public.calendar_feed_settings s on s.studio_id = t.studio_id and s.enabled
   where t.token_hash = p_token_hash
     and t.status = 'active'
     and t.expires_at > now()
     and (t.valid_until is null or t.valid_until > now());
  if not found then
    return;
  end if;
  if v.last_accessed_at is null or v.last_accessed_at < now() - interval '15 minutes' then
    update public.calendar_feed_tokens set last_accessed_at = now() where id = v.id;
  end if;
  return query select v.id, v.studio_id, v.subject_kind, v.subject_user_id, v.detail_level, v.include_client_ids;
end;
$fn$;

-- Fixed-window rate limiter. Always counts the hit; allowed = hits <= limit.
create or replace function public.calendar_feed_rate_check(
  p_key text, p_limit integer, p_window_seconds integer
) returns table (allowed boolean, hits integer, retry_after_seconds integer)
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_key is null or p_limit is null or p_window_seconds is null
     or char_length(p_key) not between 1 and 128
     or p_limit not between 1 and 100000 or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.calendar_feed_rate_buckets as b (bucket_key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (bucket_key, window_start) do update set hits = b.hits + 1
  returning b.hits into v_hits;
  if random() < 0.01 then
    delete from public.calendar_feed_rate_buckets
     where ctid in (select ctid from public.calendar_feed_rate_buckets where window_start < now() - interval '1 day' limit 1000);
  end if;
  return query select v_hits <= p_limit, v_hits,
    greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$fn$;

-- ---------------------------------------------------------------------------------------------------------------
-- Automatic revocation hooks on existing tables (account deletion is covered by ON DELETE CASCADE on auth.users).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.calendar_feed_on_instructor_deactivated()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  -- Part of a studio delete cascade: the tokens go with the studio, and an audit row could no longer reference it.
  if not exists (select 1 from public.studios s where s.id = old.studio_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.user_id is not null then
      perform public.calendar_feed_revoke_subject(old.studio_id, 'staff', old.user_id, 'staff_deactivated', null, 'system');
    end if;
    return old;
  end if;
  if old.user_id is not null and (
       (old.active is true and new.active is not true)
       or new.user_id is distinct from old.user_id
       or new.studio_id is distinct from old.studio_id) then
    perform public.calendar_feed_revoke_subject(old.studio_id, 'staff', old.user_id, 'staff_deactivated', null, 'system');
  end if;
  return new;
end;
$fn$;

create or replace function public.calendar_feed_on_role_deactivated()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not exists (select 1 from public.studios s where s.id = old.studio_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    perform public.calendar_feed_revoke_subject(old.studio_id, 'staff', old.user_id, 'role_lost', null, 'system');
    return old;
  end if;
  if (old.active is true and new.active is not true)
     or new.user_id is distinct from old.user_id
     or new.studio_id is distinct from old.studio_id then
    perform public.calendar_feed_revoke_subject(old.studio_id, 'staff', old.user_id, 'role_lost', null, 'system');
  end if;
  return new;
end;
$fn$;

drop trigger if exists calendar_feed_instructor_deactivated_trg on public.instructors;
create trigger calendar_feed_instructor_deactivated_trg
  after update of active, user_id, studio_id or delete on public.instructors
  for each row execute function public.calendar_feed_on_instructor_deactivated();

drop trigger if exists calendar_feed_role_deactivated_trg on public.user_studio_roles;
create trigger calendar_feed_role_deactivated_trg
  after update of active, user_id, studio_id or delete on public.user_studio_roles
  for each row execute function public.calendar_feed_on_role_deactivated();

-- Function privileges: service_role only.
revoke all on function public.calendar_feed_audit(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.calendar_feed_issue_token(uuid, text, uuid, text, text, text, uuid[], uuid, integer) from public, anon, authenticated;
revoke all on function public.calendar_feed_revoke(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.calendar_feed_revoke_subject(uuid, text, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.calendar_feed_revoke_studio(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.calendar_feed_set_detail(uuid, uuid, uuid, text, uuid[], uuid) from public, anon, authenticated;
revoke all on function public.calendar_feed_set_studio_enabled(uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public.calendar_feed_resolve(text) from public, anon, authenticated;
revoke all on function public.calendar_feed_rate_check(text, integer, integer) from public, anon, authenticated;
revoke all on function public.calendar_feed_on_instructor_deactivated() from public, anon, authenticated;
revoke all on function public.calendar_feed_on_role_deactivated() from public, anon, authenticated;
revoke all on function public.calendar_feed_audit_no_update() from public, anon, authenticated;
-- Internal helpers and trigger functions are not part of the API surface, not even for service_role.
revoke all on function public.calendar_feed_audit(uuid, uuid, uuid, text, text, text, jsonb) from service_role;
revoke all on function public.calendar_feed_on_instructor_deactivated() from service_role;
revoke all on function public.calendar_feed_on_role_deactivated() from service_role;
revoke all on function public.calendar_feed_audit_no_update() from service_role;
revoke all on function public.calendar_feed_token_guard() from public, anon, authenticated, service_role;

grant execute on function public.calendar_feed_issue_token(uuid, text, uuid, text, text, text, uuid[], uuid, integer) to service_role;
grant execute on function public.calendar_feed_revoke(uuid, uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.calendar_feed_revoke_subject(uuid, text, uuid, text, uuid, text) to service_role;
grant execute on function public.calendar_feed_revoke_studio(uuid, text, uuid) to service_role;
grant execute on function public.calendar_feed_set_detail(uuid, uuid, uuid, text, uuid[], uuid) to service_role;
grant execute on function public.calendar_feed_set_studio_enabled(uuid, boolean, uuid) to service_role;
grant execute on function public.calendar_feed_resolve(text) to service_role;
grant execute on function public.calendar_feed_rate_check(text, integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;
