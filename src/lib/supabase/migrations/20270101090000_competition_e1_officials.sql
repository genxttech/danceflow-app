-- 20270101090000_competition_e1_officials.sql
--
-- PHASE 10 -- E1: Competition officials and round panel assignments (K0 section 3, slot 20270101090000).
--
-- New (no existing object is rewritten, except one guard trigger added to event_competition_rounds):
--   event_competition_officials          one row per (event, account): role judge | scorer | chair, status active | inactive
--   event_competition_panel_assignments  (round, official, judge_letter); frozen once the round leaves draft/scheduled
--   event_competition_official_events    append-only audit (fixed kinds, idempotency request ids)
--   manager RPCs (SECURITY DEFINER, can_manage_event_competition, advisory-locked per event, idempotent on a request id):
--     add_competition_official, deactivate_competition_official, set_competition_chair, clear_competition_chair,
--     assign_competition_panel_member, unassign_competition_panel_member, list_competition_official_candidates
--   reads: my_competition_judging_assignments() (a signed-in official's own events/rounds/letter only)
--   readiness: competition_round_panel_ready(round_id) boolean, competition_round_panel_status(round_id) jsonb (for O1)
--
-- Identity: an official is a user_id (never an email match). The account must have a bound verified-email credential
-- (verified_email_for_user, LAUNCH-SEC-1C-B) when added, reactivated and when read, and must be an active member of the
-- event's studio or organizer team. Writes happen only through the RPCs (table writes are revoked for every API role).
-- Judge identity is never exposed to entrants/public: no public or entrant reader exists in this slice (K0 O3).
--
-- Rollback: rollback/20270101090000_competition_e1_officials_rollback.sql (refuses while any evidence exists).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_officials') is not null
     or to_regclass('public.event_competition_panel_assignments') is not null
     or to_regclass('public.event_competition_official_events') is not null then
    raise exception 'E1 preflight: an E1 table already exists.';
  end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regclass('public.event_competition_rounds') is null then
    raise exception 'E1 preflight: 10A / LAUNCH-SEC-1C-B objects are missing.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.event_competition_officials (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null,
  status text not null default 'active',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  deactivated_by uuid,
  deactivation_reason text,
  constraint event_competition_officials_role_check check (role in ('judge', 'scorer', 'chair')),
  constraint event_competition_officials_status_check check (status in ('active', 'inactive')),
  constraint event_competition_officials_deactivation_shape check (
    (status = 'active' and deactivated_at is null)
    or (status = 'inactive' and deactivated_at is not null and length(btrim(coalesce(deactivation_reason, ''))) > 0)
  ),
  unique (id, event_id),
  unique (event_id, user_id)
);

-- At most one active chair per event.
create unique index event_competition_officials_one_chair_idx
  on public.event_competition_officials(event_id) where role = 'chair' and status = 'active';
create index event_competition_officials_user_idx on public.event_competition_officials(user_id) where status = 'active';

create table public.event_competition_panel_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  official_id uuid not null,
  judge_letter text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint event_competition_panel_assignments_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_panel_assignments_official_fk
    foreign key (official_id, event_id) references public.event_competition_officials(id, event_id) on delete restrict,
  constraint event_competition_panel_assignments_letter_check
    check (judge_letter is null or judge_letter ~ '^[A-Z]{1,2}$'),
  unique (round_id, official_id)
);

-- Unique judge letter per round (scorers carry no letter).
create unique index event_competition_panel_assignments_letter_idx
  on public.event_competition_panel_assignments(round_id, judge_letter) where judge_letter is not null;
create index event_competition_panel_assignments_official_idx on public.event_competition_panel_assignments(official_id);

create table public.event_competition_official_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  kind text not null,
  actor_user_id uuid,
  occurred_at timestamptz not null default now(),
  official_id uuid,
  round_id uuid,
  request_id uuid,
  request_fingerprint text,
  reason text,
  refs jsonb not null default '{}'::jsonb,
  constraint event_competition_official_events_kind_check check (kind in (
    'official_added', 'official_reactivated', 'official_deactivated', 'chair_set', 'chair_cleared',
    'panel_assigned', 'panel_unassigned'))
);
create unique index event_competition_official_events_request_idx
  on public.event_competition_official_events(event_id, request_id) where request_id is not null;
create index event_competition_official_events_event_idx
  on public.event_competition_official_events(event_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 2. Row protection triggers
-- ---------------------------------------------------------------------------
-- Audit: append-only (10A evidence trigger).
create trigger protect_competition_official_event_history
  before update or delete on public.event_competition_official_events
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_competition_official_event_history_truncate
  before truncate on public.event_competition_official_events
  for each statement execute function public.protect_competition_history_evidence();

-- Officials: deactivate instead of delete; identity fields immutable; verified account required to be active.
create or replace function public.guard_competition_official()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'COMP_OFFICIAL_IMMUTABLE: officials cannot be truncated.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    -- Only the cascade of a deleted event removes officials; otherwise deactivate.
    if not exists (select 1 from public.events e where e.id = old.event_id) then
      return old;
    end if;
    raise exception 'COMP_OFFICIAL_IMMUTABLE: officials are deactivated, never deleted.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id or new.user_id is distinct from old.user_id
       or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
      raise exception 'COMP_OFFICIAL_IMMUTABLE: event, account and creation fields cannot change.' using errcode = '42501';
    end if;
    -- judge/chair <-> scorer would change which assignments are valid; allowed only with no assignments.
    if (old.role = 'scorer') is distinct from (new.role = 'scorer')
       and exists (select 1 from public.event_competition_panel_assignments a where a.official_id = old.id) then
      raise exception 'COMP_OFFICIAL_HAS_ASSIGNMENTS: remove assignments before switching between scorer and judge roles.' using errcode = 'P0001';
    end if;
    new.updated_at := now();
  end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    if public.verified_email_for_user(new.user_id) is null then
      raise exception 'COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED: the account must have a verified, password-bound email.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_competition_official() from public, anon, authenticated, service_role;

create trigger guard_competition_official_row
  before insert or update or delete on public.event_competition_officials
  for each row execute function public.guard_competition_official();
create trigger guard_competition_official_truncate
  before truncate on public.event_competition_officials
  for each statement execute function public.guard_competition_official();

-- Assignments: frozen once the round leaves draft/scheduled; letter shape follows the official's role.
create or replace function public.guard_competition_panel_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.event_competition_panel_assignments;
  v_status text;
  v_off public.event_competition_officials;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'COMP_PANEL_FROZEN: panel assignments cannot be truncated.' using errcode = '42501';
  end if;
  v_row := case when tg_op = 'DELETE' then old else new end;

  -- Cascade of a deleted event (independent of which cascade trigger fires first).
  if tg_op = 'DELETE' and not exists (select 1 from public.events e where e.id = old.event_id) then
    return old;
  end if;

  -- FOR SHARE serializes against start_competition_round (O1), which locks the round FOR UPDATE.
  select r.status into v_status
  from public.event_competition_rounds r
  where r.id = v_row.round_id and r.event_id = v_row.event_id
  for share;

  if v_status is null and tg_op = 'DELETE' then
    return old; -- cascade of a deleted round / event
  end if;
  if v_status is null or v_status not in ('draft', 'scheduled') then
    raise exception 'COMP_PANEL_FROZEN: the panel of a round is frozen once the round leaves draft/scheduled (round status: %).',
      coalesce(v_status, 'missing') using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.round_id is distinct from old.round_id or new.official_id is distinct from old.official_id
                           or new.event_id is distinct from old.event_id) then
    raise exception 'COMP_PANEL_FROZEN: assignment identity cannot change.' using errcode = 'P0001';
  end if;

  select * into v_off from public.event_competition_officials o where o.id = new.official_id and o.event_id = new.event_id;
  if tg_op = 'INSERT' and v_off.status is distinct from 'active' then
    raise exception 'COMP_OFFICIAL_INACTIVE: only an active official can be assigned.' using errcode = 'P0001';
  end if;
  if v_off.role = 'scorer' and new.judge_letter is not null then
    raise exception 'COMP_PANEL_LETTER_INVALID: scorers carry no judge letter.' using errcode = 'P0001';
  end if;
  if v_off.role in ('judge', 'chair') and new.judge_letter is null then
    raise exception 'COMP_PANEL_LETTER_INVALID: a judge letter is required.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_competition_panel_assignment() from public, anon, authenticated, service_role;

create trigger guard_competition_panel_assignment_row
  before insert or update or delete on public.event_competition_panel_assignments
  for each row execute function public.guard_competition_panel_assignment();
create trigger guard_competition_panel_assignment_truncate
  before truncate on public.event_competition_panel_assignments
  for each statement execute function public.guard_competition_panel_assignment();

-- A round that carries an assignment cannot be deleted once it left draft/scheduled (event cascade still works).
create or replace function public.guard_competition_round_panel_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status not in ('draft', 'scheduled')
     and exists (select 1 from public.events e where e.id = old.event_id)
     and exists (select 1 from public.event_competition_panel_assignments a where a.round_id = old.id) then
    raise exception 'COMP_PANEL_FROZEN: a round with a panel cannot be deleted once it has started (status: %).', old.status
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_competition_round_panel_delete() from public, anon, authenticated, service_role;

create trigger guard_competition_round_panel_delete
  before delete on public.event_competition_rounds
  for each row execute function public.guard_competition_round_panel_delete();

-- Active member of the event's studio or organizer team (checked at add time AND on every official read).
create or replace function public._comp_e1_is_team_member(p_event_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $
  select exists (
    select 1 from public.events e
    where e.id = p_event_id
      and (
        exists (select 1 from public.user_studio_roles usr where usr.studio_id = e.studio_id and usr.user_id = p_user_id and usr.active = true)
        or (e.organizer_id is not null and exists (
              select 1 from public.organizer_users ou where ou.organizer_id = e.organizer_id and ou.user_id = p_user_id and ou.active = true))
      )
  );
$;
revoke all on function public._comp_e1_is_team_member(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RLS and grants (K0 reader matrix: manager all; official own; everyone else nothing; anon nothing)
-- ---------------------------------------------------------------------------
alter table public.event_competition_officials enable row level security;
alter table public.event_competition_panel_assignments enable row level security;
alter table public.event_competition_official_events enable row level security;

create policy competition_officials_manager_read on public.event_competition_officials
  for select to authenticated using (public.can_manage_event_competition(event_id));

create or replace function public.competition_is_active_official(p_official_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.event_competition_officials o
    where o.id = p_official_id and o.user_id = auth.uid() and o.status = 'active'
      and public.verified_email_for_user(o.user_id) is not null
      and public._comp_e1_is_team_member(o.event_id, o.user_id)
  );
$;
revoke all on function public.competition_is_active_official(uuid) from public, anon;
grant execute on function public.competition_is_active_official(uuid) to authenticated, service_role;

create policy competition_officials_own_read on public.event_competition_officials
  for select to authenticated using (public.competition_is_active_official(id));
create policy competition_panel_manager_read on public.event_competition_panel_assignments
  for select to authenticated using (public.can_manage_event_competition(event_id));
create policy competition_panel_own_read on public.event_competition_panel_assignments
  for select to authenticated using (public.competition_is_active_official(official_id));

create policy competition_official_events_manager_read on public.event_competition_official_events
  for select to authenticated using (public.can_manage_event_competition(event_id));

revoke all on public.event_competition_officials from public, anon, authenticated, service_role;
revoke all on public.event_competition_panel_assignments from public, anon, authenticated, service_role;
revoke all on public.event_competition_official_events from public, anon, authenticated, service_role;
grant select on public.event_competition_officials to authenticated, service_role;
grant select on public.event_competition_panel_assignments to authenticated, service_role;
grant select on public.event_competition_official_events to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Internal helpers (no API grants)
-- ---------------------------------------------------------------------------
create or replace function public._comp_e1_authorize(p_event_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_event_id is null or not public.can_manage_event_competition(p_event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;
revoke all on function public._comp_e1_authorize(uuid) from public, anon, authenticated, service_role;

-- Replays a recorded request: returns its stored result, or null when new; raises when the id was used for a different request.
create or replace function public._comp_e1_replay(p_event_id uuid, p_request_id uuid, p_fingerprint text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev public.event_competition_official_events;
begin
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  select * into v_prev from public.event_competition_official_events
  where event_id = p_event_id and request_id = p_request_id;
  if not found then
    return null;
  end if;
  if v_prev.request_fingerprint is distinct from p_fingerprint then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;
  return coalesce(v_prev.refs -> 'result', '{}'::jsonb) || jsonb_build_object('replayed', true);
end;
$$;
revoke all on function public._comp_e1_replay(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public._comp_e1_audit(
  p_event_id uuid, p_kind text, p_actor uuid, p_official_id uuid, p_round_id uuid,
  p_request_id uuid, p_fingerprint text, p_reason text, p_result jsonb
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.event_competition_official_events
    (event_id, kind, actor_user_id, official_id, round_id, request_id, request_fingerprint, reason, refs)
  values (p_event_id, p_kind, p_actor, p_official_id, p_round_id, p_request_id, p_fingerprint, p_reason,
          jsonb_build_object('result', p_result));
$$;
revoke all on function public._comp_e1_audit(uuid, text, uuid, uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Manager RPCs
-- ---------------------------------------------------------------------------
create or replace function public.list_competition_official_candidates(p_event_id uuid)
returns table(user_id uuid, display_name text, email text, team text, account_verified boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
begin
  perform public._comp_e1_authorize(p_event_id);
  select * into v_event from public.events e where e.id = p_event_id;
  return query
  with team as (
    select usr.user_id as uid, 'studio'::text as team
    from public.user_studio_roles usr
    where usr.studio_id = v_event.studio_id and usr.active = true
    union
    select ou.user_id, 'organizer'::text
    from public.organizer_users ou
    where v_event.organizer_id is not null and ou.organizer_id = v_event.organizer_id and ou.active = true
  )
  select t.uid,
         coalesce(nullif(btrim(p.full_name), ''), u.email::text),
         u.email::text,
         min(t.team),
         public.verified_email_for_user(t.uid) is not null
  from team t
  join auth.users u on u.id = t.uid and u.deleted_at is null
  left join public.profiles p on p.id = t.uid
  group by t.uid, p.full_name, u.email
  order by 2;
end;
$$;

create or replace function public.add_competition_official(
  p_event_id uuid, p_user_id uuid, p_role text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_fp text := md5('add|' || coalesce(p_event_id::text, '') || '|' || coalesce(p_user_id::text, '') || '|' || coalesce(p_role, ''));
  v_replay jsonb;
  v_event public.events;
  v_off public.event_competition_officials;
  v_result jsonb;
  v_kind text;
begin
  v_actor := public._comp_e1_authorize(p_event_id);
  perform pg_advisory_xact_lock(hashtextextended('comp_e1:' || p_event_id::text, 0));
  v_replay := public._comp_e1_replay(p_event_id, p_request_id, v_fp);
  if v_replay is not null then return v_replay; end if;

  if p_user_id is null or p_role is null or p_role not in ('judge', 'scorer', 'chair') then
    raise exception 'COMP_OFFICIAL_INVALID: a user and a role (judge, scorer, chair) are required.' using errcode = 'P0001';
  end if;
  select * into v_event from public.events e where e.id = p_event_id;
  if not exists (select 1 from public.event_competition_programs p where p.event_id = p_event_id) then
    raise exception 'COMP_OFFICIAL_INVALID: the event has no competition program.' using errcode = 'P0001';
  end if;
  if not (
    exists (select 1 from public.user_studio_roles usr where usr.studio_id = v_event.studio_id and usr.user_id = p_user_id and usr.active = true)
    or (v_event.organizer_id is not null and exists (
         select 1 from public.organizer_users ou where ou.organizer_id = v_event.organizer_id and ou.user_id = p_user_id and ou.active = true))
  ) then
    raise exception 'COMP_OFFICIAL_NOT_TEAM_MEMBER: officials must be active members of the event studio or organizer team.' using errcode = 'P0001';
  end if;
  if public.verified_email_for_user(p_user_id) is null then
    raise exception 'COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED: the account must have a verified, password-bound email.' using errcode = 'P0001';
  end if;
  if p_role = 'chair' and exists (
       select 1 from public.event_competition_officials o
       where o.event_id = p_event_id and o.role = 'chair' and o.status = 'active' and o.user_id <> p_user_id) then
    raise exception 'COMP_CHAIR_EXISTS: this event already has a chair; use set chair to replace them.' using errcode = 'P0001';
  end if;

  select * into v_off from public.event_competition_officials o where o.event_id = p_event_id and o.user_id = p_user_id for update;
  if not found then
    insert into public.event_competition_officials (event_id, user_id, role, created_by)
    values (p_event_id, p_user_id, p_role, v_actor)
    returning * into v_off;
    v_kind := 'official_added';
  elsif v_off.status = 'active' then
    if v_off.role <> p_role then
      raise exception 'COMP_OFFICIAL_EXISTS: this person is already an active % for the event.', v_off.role using errcode = 'P0001';
    end if;
    return jsonb_build_object('official_id', v_off.id, 'noop', true);
  else
    update public.event_competition_officials
       set status = 'active', role = p_role, deactivated_at = null, deactivated_by = null, deactivation_reason = null
     where id = v_off.id
     returning * into v_off;
    v_kind := 'official_reactivated';
  end if;

  v_result := jsonb_build_object('official_id', v_off.id, 'role', v_off.role);
  perform public._comp_e1_audit(p_event_id, v_kind, v_actor, v_off.id, null, p_request_id, v_fp, null, v_result);
  return v_result;
end;
$$;

create or replace function public.deactivate_competition_official(
  p_official_id uuid, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_off public.event_competition_officials;
  v_fp text;
  v_replay jsonb;
  v_removed integer := 0;
  v_frozen integer := 0;
  v_result jsonb;
  r record;
begin
  select * into v_off from public.event_competition_officials o where o.id = p_official_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501'; -- no existence oracle
  end if;
  v_actor := public._comp_e1_authorize(v_off.event_id);
  perform pg_advisory_xact_lock(hashtextextended('comp_e1:' || v_off.event_id::text, 0));
  v_fp := md5('deactivate|' || p_official_id::text || '|' || coalesce(btrim(p_reason), ''));
  v_replay := public._comp_e1_replay(v_off.event_id, p_request_id, v_fp);
  if v_replay is not null then return v_replay; end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'COMP_REASON_REQUIRED: a reason is required.' using errcode = 'P0001';
  end if;
  select * into v_off from public.event_competition_officials o where o.id = p_official_id for update;
  if v_off.status = 'inactive' then
    return jsonb_build_object('official_id', v_off.id, 'noop', true);
  end if;

  -- Drop the official from rounds that can still change; frozen panels keep their history.
  for r in
    select a.id, a.round_id, rd.status
    from public.event_competition_panel_assignments a
    join public.event_competition_rounds rd on rd.id = a.round_id
    where a.official_id = v_off.id
  loop
    if r.status in ('draft', 'scheduled') then
      delete from public.event_competition_panel_assignments where id = r.id;
      v_removed := v_removed + 1;
    else
      v_frozen := v_frozen + 1;
    end if;
  end loop;

  update public.event_competition_officials
     set status = 'inactive', deactivated_at = now(), deactivated_by = v_actor, deactivation_reason = btrim(p_reason)
   where id = v_off.id;

  v_result := jsonb_build_object('official_id', v_off.id, 'assignments_removed', v_removed, 'frozen_assignments_kept', v_frozen);
  perform public._comp_e1_audit(v_off.event_id, 'official_deactivated', v_actor, v_off.id, null, p_request_id, v_fp, btrim(p_reason), v_result);
  return v_result;
end;
$$;

create or replace function public.set_competition_chair(p_event_id uuid, p_official_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_fp text := md5('chair|' || coalesce(p_event_id::text, '') || '|' || coalesce(p_official_id::text, ''));
  v_replay jsonb;
  v_off public.event_competition_officials;
  v_prev uuid;
  v_result jsonb;
begin
  v_actor := public._comp_e1_authorize(p_event_id);
  perform pg_advisory_xact_lock(hashtextextended('comp_e1:' || p_event_id::text, 0));
  v_replay := public._comp_e1_replay(p_event_id, p_request_id, v_fp);
  if v_replay is not null then return v_replay; end if;

  select * into v_off from public.event_competition_officials o
  where o.id = p_official_id and o.event_id = p_event_id for update;
  if not found or v_off.status <> 'active' then
    raise exception 'COMP_OFFICIAL_INACTIVE: choose an active official of this event.' using errcode = 'P0001';
  end if;
  if v_off.role = 'scorer' then
    raise exception 'COMP_OFFICIAL_INVALID: a scorer cannot be the chair.' using errcode = 'P0001';
  end if;
  if public.verified_email_for_user(v_off.user_id) is null then
    raise exception 'COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED: the account must have a verified, password-bound email.' using errcode = 'P0001';
  end if;
  if v_off.role = 'chair' then
    return jsonb_build_object('official_id', v_off.id, 'noop', true);
  end if;

  select o.id into v_prev from public.event_competition_officials o
  where o.event_id = p_event_id and o.role = 'chair' and o.status = 'active' for update;
  if v_prev is not null then
    update public.event_competition_officials set role = 'judge' where id = v_prev;
  end if;
  update public.event_competition_officials set role = 'chair' where id = v_off.id;

  v_result := jsonb_build_object('official_id', v_off.id, 'previous_chair_id', v_prev);
  perform public._comp_e1_audit(p_event_id, 'chair_set', v_actor, v_off.id, null, p_request_id, v_fp, null, v_result);
  return v_result;
end;
$$;

create or replace function public.clear_competition_chair(p_event_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_fp text := md5('clearchair|' || coalesce(p_event_id::text, ''));
  v_replay jsonb;
  v_prev uuid;
  v_result jsonb;
begin
  v_actor := public._comp_e1_authorize(p_event_id);
  perform pg_advisory_xact_lock(hashtextextended('comp_e1:' || p_event_id::text, 0));
  v_replay := public._comp_e1_replay(p_event_id, p_request_id, v_fp);
  if v_replay is not null then return v_replay; end if;

  select o.id into v_prev from public.event_competition_officials o
  where o.event_id = p_event_id and o.role = 'chair' and o.status = 'active' for update;
  if v_prev is null then
    return jsonb_build_object('noop', true);
  end if;
  update public.event_competition_officials set role = 'judge' where id = v_prev;
  v_result := jsonb_build_object('official_id', v_prev);
  perform public._comp_e1_audit(p_event_id, 'chair_cleared', v_actor, v_prev, null, p_request_id, v_fp, null, v_result);
  return v_result;
end;
$$;

create or replace function public.assign_competition_panel_member(
  p_round_id uuid, p_official_id uuid, p_judge_letter text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_event_id uuid;
  v_round public.event_competition_rounds;
  v_off public.event_competition_officials;
  v_letter text := nullif(upper(btrim(coalesce(p_judge_letter, ''))), '');
  v_fp text;
  v_replay jsonb;
  v_existing public.event_competition_panel_assignments;
  v_asg public.event_competition_panel_assignments;
  v_result jsonb;
  i integer;
begin
  select r.event_id into v_event_id from public.event_competition_rounds r where r.id = p_round_id;
  if v_event_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_actor := public._comp_e1_authorize(v_event_id);
  perform pg_advisory_xact_lock(hashtextextended('comp_e1:' || v_event_id::text, 0));
  v_fp := md5('assign|' || p_round_id::text || '|' || coalesce(p_official_id::text, '') || '|' || coalesce(v_letter, ''));
  v_replay := public._comp_e1_replay(v_event_id, p_request_id, v_fp);
  if v_replay is not null then return v_replay; end if;

  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for share;
  if v_round.status not in ('draft', 'scheduled') then
    raise exception 'COMP_PANEL_FROZEN: the panel is frozen once the round leaves draft/scheduled (status: %).', v_round.status using errcode = 'P0001';
  end if;
  select * into v_off from public.event_competition_officials o where o.id = p_official_id and o.event_id = v_event_id;
  if not found or v_off.status <> 'active' then
    raise exception 'COMP_OFFICIAL_INACTIVE: choose an active official of this event.' using errcode = 'P0001';
  end if;
  if public.verified_email_for_user(v_off.user_id) is null then
    raise exception 'COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED: the account must have a verified, password-bound email.' using errcode = 'P0001';
  end if;

  select * into v_existing from public.event_competition_panel_assignments a
  where a.round_id = p_round_id and a.official_id = p_official_id;
  if found then
    if v_existing.judge_letter is not distinct from v_letter or v_letter is null then
      return jsonb_build_object('assignment_id', v_existing.id, 'judge_letter', v_existing.judge_letter, 'noop', true);
    end if;
    raise exception 'COMP_PANEL_ALREADY_ASSIGNED: unassign first to change the letter.' using errcode = 'P0001';
  end if;

  if v_off.role = 'scorer' then
    v_letter := null;
  else
    if v_letter is null then -- next free letter A..Z
      for i in 0..25 loop
        if not exists (select 1 from public.event_competition_panel_assignments a
                       where a.round_id = p_round_id and a.judge_letter = chr(65 + i)) then
          v_letter := chr(65 + i);
          exit;
        end if;
      end loop;
      if v_letter is null then
        raise exception 'COMP_PANEL_LETTER_INVALID: no judge letter is free.' using errcode = 'P0001';
      end if;
    end if;
    if exists (select 1 from public.event_competition_panel_assignments a where a.round_id = p_round_id and a.judge_letter = v_letter) then
      raise exception 'COMP_PANEL_LETTER_TAKEN: judge letter % is already used in this round.', v_letter using errcode = 'P0001';
    end if;
  end if;

  insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter, created_by)
  values (v_event_id, p_round_id, p_official_id, v_letter, v_actor)
  returning * into v_asg;

  v_result := jsonb_build_object('assignment_id', v_asg.id, 'judge_letter', v_asg.judge_letter);
  perform public._comp_e1_audit(v_event_id, 'panel_assigned', v_actor, p_official_id, p_round_id, p_request_id, v_fp, null, v_result);
  return v_result;
end;
$$;

create or replace function public.unassign_competition_panel_member(
  p_round_id uuid, p_official_id uuid, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_event_id uuid;
  v_status text;
  v_fp text;
  v_replay jsonb;
  v_asg public.event_competition_panel_assignments;
  v_result jsonb;
begin
  select r.event_id, r.status into v_event_id, v_status from public.event_competition_rounds r where r.id = p_round_id;
  if v_event_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_actor := public._comp_e1_authorize(v_event_id);
  perform pg_advisory_xact_lock(hashtextextended('comp_e1:' || v_event_id::text, 0));
  v_fp := md5('unassign|' || p_round_id::text || '|' || coalesce(p_official_id::text, ''));
  v_replay := public._comp_e1_replay(v_event_id, p_request_id, v_fp);
  if v_replay is not null then return v_replay; end if;

  select * into v_asg from public.event_competition_panel_assignments a
  where a.round_id = p_round_id and a.official_id = p_official_id for update;
  if not found then
    return jsonb_build_object('noop', true);
  end if;
  if v_status not in ('draft', 'scheduled') then
    raise exception 'COMP_PANEL_FROZEN: the panel is frozen once the round leaves draft/scheduled (status: %).', v_status using errcode = 'P0001';
  end if;
  delete from public.event_competition_panel_assignments where id = v_asg.id;

  v_result := jsonb_build_object('assignment_id', v_asg.id, 'judge_letter', v_asg.judge_letter);
  perform public._comp_e1_audit(v_event_id, 'panel_unassigned', v_actor, p_official_id, p_round_id, p_request_id, v_fp, null, v_result);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Readiness (consumed by O1 start_competition_round)
-- ---------------------------------------------------------------------------
-- Ready = at least min_panel_judges (round.configuration->>'min_panel_judges', default 1) active, verified judge/chair
-- members with a letter are assigned. K0 and the engine specs fix no minimum, so none is invented here beyond 1.
-- Authorization: a result manager of the round's event, or a caller with no end-user identity (service_role/definer
-- code such as O1's RPC runs with the manager's identity). Anyone else, and any unknown round, gets ready = false.
create or replace function public.competition_round_panel_status(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_min integer := 1;
  v_judges integer;
  v_scorers integer;
  v_chair boolean;
  v_missing text[] := '{}';
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or (auth.uid() is not null and not public.can_manage_event_competition(v_round.event_id)) then
    return jsonb_build_object('ready', false, 'missing', jsonb_build_array('unavailable'));
  end if;
  if (v_round.configuration ->> 'min_panel_judges') ~ '^[0-9]{1,2}$' then
    v_min := greatest(1, (v_round.configuration ->> 'min_panel_judges')::integer);
  end if;
  select count(*) filter (where o.role in ('judge', 'chair') and a.judge_letter is not null),
         count(*) filter (where o.role = 'scorer')
    into v_judges, v_scorers
  from public.event_competition_panel_assignments a
  join public.event_competition_officials o on o.id = a.official_id and o.event_id = a.event_id
  where a.round_id = p_round_id and o.status = 'active'
    and public.verified_email_for_user(o.user_id) is not null
    and public._comp_e1_is_team_member(o.event_id, o.user_id);
  select exists (select 1 from public.event_competition_officials o
                 where o.event_id = v_round.event_id and o.role = 'chair' and o.status = 'active'
                   and public.verified_email_for_user(o.user_id) is not null
                   and public._comp_e1_is_team_member(o.event_id, o.user_id)) into v_chair;
  if v_judges < v_min then v_missing := array_append(v_missing, 'judges'); end if;
  return jsonb_build_object(
    'ready', v_judges >= v_min,
    'judge_count', v_judges,
    'min_judges', v_min,
    'scorer_count', v_scorers,
    'chair_designated', v_chair,
    'missing', to_jsonb(v_missing));
end;
$$;

create or replace function public.competition_round_panel_ready(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((public.competition_round_panel_status(p_round_id) ->> 'ready')::boolean, false);
$$;

-- ---------------------------------------------------------------------------
-- 7. Official-facing read (own events/rounds only; no other judge, no results, no tenant data)
-- ---------------------------------------------------------------------------
create or replace function public.my_competition_judging_assignments()
returns table(
  event_id uuid, event_name text, event_start_date text, official_id uuid, official_role text,
  round_id uuid, round_name text, round_type text, round_status text, division_name text, judge_letter text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id, e.name::text, e.start_date::text, o.id, o.role,
         r.id, r.name, r.round_type, r.status, d.name, a.judge_letter
  from public.event_competition_officials o
  join public.events e on e.id = o.event_id
  left join public.event_competition_panel_assignments a on a.official_id = o.id and a.event_id = o.event_id
  left join public.event_competition_rounds r on r.id = a.round_id and r.event_id = a.event_id
  left join public.event_competition_divisions d on d.id = r.division_id and d.event_id = r.event_id
  where auth.uid() is not null
    and o.user_id = auth.uid()
    and o.status = 'active'
    and public.verified_email_for_user(o.user_id) is not null
    and public._comp_e1_is_team_member(o.event_id, o.user_id)
  order by e.start_date, e.name, r.sequence_number, r.name;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function grants (manager/official RPCs: authenticated + service_role only; never anon)
-- ---------------------------------------------------------------------------
revoke all on function public.list_competition_official_candidates(uuid) from public, anon;
revoke all on function public.add_competition_official(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.deactivate_competition_official(uuid, text, uuid) from public, anon;
revoke all on function public.set_competition_chair(uuid, uuid, uuid) from public, anon;
revoke all on function public.clear_competition_chair(uuid, uuid) from public, anon;
revoke all on function public.assign_competition_panel_member(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.unassign_competition_panel_member(uuid, uuid, uuid) from public, anon;
revoke all on function public.competition_round_panel_status(uuid) from public, anon;
revoke all on function public.competition_round_panel_ready(uuid) from public, anon;
revoke all on function public.my_competition_judging_assignments() from public, anon;

grant execute on function public.list_competition_official_candidates(uuid) to authenticated, service_role;
grant execute on function public.add_competition_official(uuid, uuid, text, uuid) to authenticated, service_role;
grant execute on function public.deactivate_competition_official(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.set_competition_chair(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.clear_competition_chair(uuid, uuid) to authenticated, service_role;
grant execute on function public.assign_competition_panel_member(uuid, uuid, text, uuid) to authenticated, service_role;
grant execute on function public.unassign_competition_panel_member(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.competition_round_panel_status(uuid) to authenticated, service_role;
grant execute on function public.competition_round_panel_ready(uuid) to authenticated, service_role;
grant execute on function public.my_competition_judging_assignments() to authenticated, service_role;

comment on table public.event_competition_officials is
  'E1: competition officials (judge/scorer/chair) identified by account user_id. Deactivate, never delete. Writes only through manager RPCs.';
comment on table public.event_competition_panel_assignments is
  'E1: round panel assignments (judge_letter unique per round). Frozen once the round leaves draft/scheduled.';
comment on table public.event_competition_official_events is
  'E1: append-only audit of official/panel changes (fixed kinds, idempotency request ids).';
comment on function public.competition_round_panel_ready(uuid) is
  'E1: true when the round has its minimum number of active, verified, lettered judges. O1 start_competition_round must call this.';

commit;
