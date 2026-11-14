-- Competition O1 -- day-of round operations (K0 slot 20270106090000).
--
-- Scope (K0 section 4, owner-approved O1 slice):
--   1. Round transition writers, exactly one per transition, SECURITY DEFINER, row lock on the round,
--      idempotent on a client request id, one audit row each:
--        schedule_competition_round  draft -> scheduled
--        start_competition_round     scheduled -> active   (needs E1 competition_round_panel_ready)
--        cancel_competition_round    any non-terminal -> cancelled (refused once a publication exists)
--   2. Heat day-of writer (scheduled -> staging -> active -> complete) for the numbered floor heat; reuses the
--      existing heat statuses and the 10A heat lock state (locked / certified heats are refused). It never edits
--      entries, placements or marks.
--   3. Guards: API roles can no longer write event_competition_rounds.status or the day-of heat statuses
--      directly; the O1 transitions additionally require the audit row written in the same transaction.
--
-- Audit table: K0 reserves event_competition_result_events for F2 (slot 20270104090000), which is not merged. O1 owns a
-- minimal, append-only event_competition_round_transition_events instead (same append-only trigger as 10A history).
-- F2 may keep both or fold this table into result_events later; nothing here depends on F2.
--
-- Hard dependency: E1 competition_round_panel_ready(uuid) (migration 20270101090000), checked by the preflight below.
-- Soft: event_competition_result_publications (F3) is looked up with to_regclass at call time (F3 is not merged yet).

do $$
begin
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null
     or to_regprocedure('public.set_competition_heat_lock_state(uuid,text,text)') is null then
    raise exception 'O1 preflight: 10A competition authority is not installed.';
  end if;
  if to_regprocedure('public.competition_round_panel_ready(uuid)') is null then
    raise exception 'O1 preflight: E1 officials (competition_round_panel_ready) is not installed.';
  end if;
  if to_regclass('public.event_competition_floor_heats') is null then
    raise exception 'O1 preflight: 10D floor heats are not installed.';
  end if;
  if to_regclass('public.event_competition_round_transition_events') is not null then
    raise exception 'O1 preflight: event_competition_round_transition_events already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Audit table (append-only)
-- ---------------------------------------------------------------------------
create table public.event_competition_round_transition_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  heat_id uuid,
  kind text not null,
  from_state text not null,
  to_state text not null,
  actor uuid not null,
  request_id uuid not null,
  reason text,
  refs jsonb not null default '{}'::jsonb,
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default now(),
  constraint event_competition_round_transition_events_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_round_transition_events_heat_fk
    foreign key (heat_id, event_id) references public.event_competition_heats(id, event_id),
  constraint event_competition_round_transition_events_kind_check
    check (kind in ('round_scheduled', 'round_started', 'round_cancelled', 'heat_staged', 'heat_started', 'heat_completed')),
  constraint event_competition_round_transition_events_scope_check
    check ((kind like 'round_%' and heat_id is null) or (kind like 'heat_%' and heat_id is not null)),
  constraint event_competition_round_transition_events_reason_check
    check (reason is null or length(reason) <= 500)
);
-- One request id can only ever describe one transition of one round (and, for heats, one scoring heat).
create unique index event_competition_round_transition_events_request_uidx
  on public.event_competition_round_transition_events(request_id, coalesce(heat_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index event_competition_round_transition_events_round_idx
  on public.event_competition_round_transition_events(round_id, created_at);
create index event_competition_round_transition_events_txn_idx
  on public.event_competition_round_transition_events(transaction_id, round_id);
create index event_competition_round_transition_events_event_idx
  on public.event_competition_round_transition_events(event_id, created_at);

comment on table public.event_competition_round_transition_events is
  'O1: append-only audit of day-of round and heat transitions. A row for the same round/heat, from and to state in the current transaction is the only authorization for the O1-owned status changes.';

alter table public.event_competition_round_transition_events enable row level security;
create policy competition_round_transition_events_manager_read on public.event_competition_round_transition_events
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_round_transition_events from public, anon, authenticated, service_role;
grant select on public.event_competition_round_transition_events to authenticated, service_role;

create trigger protect_competition_round_transition_event_history
  before update or delete on public.event_competition_round_transition_events
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_competition_round_transition_event_history_truncate
  before truncate on public.event_competition_round_transition_events
  for each statement execute function public.protect_competition_history_evidence();

-- ---------------------------------------------------------------------------
-- 2. Internal helpers
-- ---------------------------------------------------------------------------

create function public._compo1_live_version(p_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.id
  from public.event_competition_schedule_versions v
  where v.event_id = p_event_id and v.status in ('published', 'live')
  order by v.published_at desc nulls last, v.created_at desc
  limit 1;
$$;
revoke all on function public._compo1_live_version(uuid) from public, anon, authenticated, service_role;

-- Heats of the round that count for readiness: not cancelled, and not parked in a draft or superseded version.
create function public._compo1_round_heat_state(p_round_id uuid)
returns table (live_version_id uuid, live_heats integer, unplaced_heats integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with r as (select id, event_id from public.event_competition_rounds where id = p_round_id),
  lv as (select r.id as round_id, public._compo1_live_version(r.event_id) as version_id from r)
  select lv.version_id,
    (select count(*)::integer from public.event_competition_heats h
      where h.round_id = lv.round_id and h.status <> 'cancelled' and lv.version_id is not null and h.schedule_version_id = lv.version_id),
    (select count(*)::integer from public.event_competition_heats h
      where h.round_id = lv.round_id and h.status <> 'cancelled' and h.schedule_version_id is null)
  from lv;
$$;
revoke all on function public._compo1_round_heat_state(uuid) from public, anon, authenticated, service_role;

create function public._compo1_lock_event(p_event_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended('compo1:' || p_event_id::text, 0));
$$;
revoke all on function public._compo1_lock_event(uuid) from public, anon, authenticated, service_role;

create function public._compo1_record(
  p_event_id uuid, p_round_id uuid, p_heat_id uuid, p_kind text, p_from text, p_to text,
  p_actor uuid, p_request_id uuid, p_reason text, p_refs jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.event_competition_round_transition_events (
    event_id, round_id, heat_id, kind, from_state, to_state, actor, request_id, reason, refs
  ) values (
    p_event_id, p_round_id, p_heat_id, p_kind, p_from, p_to, p_actor, p_request_id, p_reason, coalesce(p_refs, '{}'::jsonb)
  );
$$;
revoke all on function public._compo1_record(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Guards: no direct status writes
-- ---------------------------------------------------------------------------
-- Security invoker on purpose: current_user is the role running the statement, which inside a SECURITY DEFINER
-- writer is the function owner and for a PostgREST call is authenticated / anon / service_role.
create function public._compo1_guard_round_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' and current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
      raise exception 'COMPO1_ROUND_STATUS_WRITER: new rounds start as draft; round status changes go through the round transition functions.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status in ('cancelled', 'complete') then
    raise exception 'COMPO1_ROUND_TERMINAL: a % round cannot change status.', old.status using errcode = '23514';
  end if;
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
    raise exception 'COMPO1_ROUND_STATUS_WRITER: round status changes go through the round transition functions.'
      using errcode = '42501';
  end if;
  -- O1-owned edges also need the audit row written by the O1 function in this transaction.
  if new.status in ('scheduled', 'cancelled') or (old.status = 'scheduled' and new.status = 'active') then
    if not exists (
      select 1 from public.event_competition_round_transition_events e
      where e.round_id = old.id and e.event_id = old.event_id and e.heat_id is null
        and e.from_state = old.status and e.to_state = new.status
        and e.transaction_id = txid_current()
    ) then
      raise exception 'COMPO1_ROUND_STATUS_WRITER: % -> % is written only by its O1 transition function.', old.status, new.status
        using errcode = '42501';
    end if;
  end if;
  -- Static K0 section 4 edge list (E2 lock/reopen, F2 calculate/approve/correct/complete, F3 publish). A new edge
  -- needs this list amended in the owning migration. Skip-ahead edges (draft -> active, scheduled -> calculated, any -> draft) are refused.
  if new.status <> 'cancelled' and (old.status, new.status) not in (
    ('draft', 'scheduled'), ('scheduled', 'active'),
    ('active', 'ballots_locked'), ('ballots_locked', 'active'),
    ('ballots_locked', 'calculated'), ('calculated', 'approved'), ('approved', 'published'), ('published', 'complete'),
    ('calculated', 'ballots_locked'), ('approved', 'ballots_locked'), ('published', 'ballots_locked')
  ) then
    raise exception 'COMPO1_ROUND_EDGE: % -> % is not a round transition in the K0 state machine.', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public._compo1_guard_round_status() from public, anon, authenticated, service_role;

create trigger compo1_guard_round_status
  before insert or update of status on public.event_competition_rounds
  for each row execute function public._compo1_guard_round_status();

create function public._compo1_guard_heat_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c_run constant text[] := array['staging', 'active', 'complete'];
begin
  if tg_op = 'INSERT' then
    if new.status = any (c_run) and current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
      raise exception 'COMPO1_HEAT_STATUS_WRITER: new heats start as scheduled; day-of status goes through advance_competition_floor_heat.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  -- A heat that has started running keeps its identity: it cannot move to another round, division, floor heat or version.
  if old.status = any (c_run)
     and (new.round_id, new.division_id, new.floor_heat_id, new.schedule_version_id)
         is distinct from (old.round_id, old.division_id, old.floor_heat_id, old.schedule_version_id) then
    raise exception 'COMPO1_HEAT_FROZEN: a heat that has started running cannot be moved.' using errcode = '23514';
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;
  if not (new.status = any (c_run) or old.status = any (c_run)) then
    return new;
  end if;
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
    raise exception 'COMPO1_HEAT_STATUS_WRITER: day-of heat status goes through advance_competition_floor_heat.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.event_competition_round_transition_events e
    where e.heat_id = old.id and e.event_id = old.event_id
      and e.from_state = old.status and e.to_state = new.status
      and e.transaction_id = txid_current()
  ) then
    raise exception 'COMPO1_HEAT_STATUS_WRITER: % -> % is written only by advance_competition_floor_heat.', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._compo1_guard_heat_status() from public, anon, authenticated, service_role;

create trigger compo1_guard_heat_status
  before insert or update of status, round_id, division_id, floor_heat_id, schedule_version_id on public.event_competition_heats
  for each row execute function public._compo1_guard_heat_status();

-- A new running order copies scoring heats as `scheduled` (10D), which would erase day-of progress. Publishing is
-- refused once any heat of the event has started running.
create function public._compo1_guard_publish_during_run()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_touches boolean;
begin
  v_touches := new.status in ('published', 'live');
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      return new;
    end if;
    v_touches := v_touches or old.status in ('published', 'live');
  end if;
  if v_touches then
    -- Same per-event lock as the day-of writers: a publish and a heat call serialize, so neither can miss the other's
    -- committed state (the next statement takes a fresh snapshot after the lock).
    perform public._compo1_lock_event(new.event_id);
    if exists (
      select 1 from public.event_competition_heats h
      where h.event_id = new.event_id and h.status in ('staging', 'active', 'complete')
    ) then
      raise exception 'COMPO1_RUN_IN_PROGRESS: heats have already started running; the running order cannot change status.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._compo1_guard_publish_during_run() from public, anon, authenticated, service_role;

create trigger compo1_guard_publish_during_run
  before insert or update of status on public.event_competition_schedule_versions
  for each row execute function public._compo1_guard_publish_during_run();

-- ---------------------------------------------------------------------------
-- 4. Round transition writers
-- ---------------------------------------------------------------------------
create function public.schedule_competition_round(p_round_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event uuid;
  v_status text;
  v_prior record;
  v_state record;
begin
  if v_actor is null or p_round_id is null or p_request_id is null then
    raise exception 'COMPO1_NOT_FOUND: round was not found or cannot be managed.' using errcode = '42501';
  end if;
  select event_id into v_event from public.event_competition_rounds where id = p_round_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'COMPO1_NOT_FOUND: round was not found or cannot be managed.' using errcode = '42501';
  end if;
  perform public._compo1_lock_event(v_event);
  select status into v_status from public.event_competition_rounds where id = p_round_id for update;

  select * into v_prior from public.event_competition_round_transition_events where request_id = p_request_id limit 1;
  if found then
    if v_prior.kind = 'round_scheduled' and v_prior.round_id = p_round_id and v_prior.actor = v_actor then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', v_prior.to_state);
    end if;
    raise exception 'COMPO1_REQUEST_REUSE: this request id was already used for a different operation.' using errcode = '23505';
  end if;

  if v_status <> 'draft' then
    raise exception 'COMPO1_BAD_STATE: only a draft round can be scheduled (round is %).', v_status using errcode = '23514';
  end if;
  select * into v_state from public._compo1_round_heat_state(p_round_id);
  if v_state.live_version_id is null then
    raise exception 'COMPO1_NOT_PUBLISHED: publish the running order before scheduling the round.' using errcode = '23514';
  end if;
  if v_state.unplaced_heats > 0 then
    raise exception 'COMPO1_HEATS_NOT_PUBLISHED: % heat(s) of this round are not in the published running order.', v_state.unplaced_heats
      using errcode = '23514';
  end if;
  if v_state.live_heats = 0 then
    raise exception 'COMPO1_NO_HEATS: the round has no heats in the published running order.' using errcode = '23514';
  end if;

  perform public._compo1_record(v_event, p_round_id, null, 'round_scheduled', 'draft', 'scheduled', v_actor, p_request_id, null,
    jsonb_build_object('schedule_version_id', v_state.live_version_id, 'heats', v_state.live_heats));
  update public.event_competition_rounds set status = 'scheduled', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'scheduled');
end;
$$;

create function public.start_competition_round(p_round_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event uuid;
  v_status text;
  v_prior record;
  v_state record;
  v_ready boolean;
  v_scoring text;
  v_target integer;
begin
  if v_actor is null or p_round_id is null or p_request_id is null then
    raise exception 'COMPO1_NOT_FOUND: round was not found or cannot be managed.' using errcode = '42501';
  end if;
  select event_id into v_event from public.event_competition_rounds where id = p_round_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'COMPO1_NOT_FOUND: round was not found or cannot be managed.' using errcode = '42501';
  end if;
  perform public._compo1_lock_event(v_event);
  select status, scoring_method, target_advancement_count into v_status, v_scoring, v_target from public.event_competition_rounds where id = p_round_id for update;

  select * into v_prior from public.event_competition_round_transition_events where request_id = p_request_id limit 1;
  if found then
    if v_prior.kind = 'round_started' and v_prior.round_id = p_round_id and v_prior.actor = v_actor then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', v_prior.to_state);
    end if;
    raise exception 'COMPO1_REQUEST_REUSE: this request id was already used for a different operation.' using errcode = '23505';
  end if;

  if v_status <> 'scheduled' then
    raise exception 'COMPO1_BAD_STATE: only a scheduled round can be started (round is %).', v_status using errcode = '23514';
  end if;
  -- A callback round needs its callback target T before it starts: the round configuration freezes once it is active,
  -- so an unset T could never be entered afterwards (same rule as the setup readiness check).
  if v_scoring = 'callback_tally' and v_target is null then
    raise exception 'COMPO1_CALLBACK_TARGET_UNSET: set the callback target for this round before starting it.' using errcode = '23514';
  end if;
  select * into v_state from public._compo1_round_heat_state(p_round_id);
  if v_state.live_version_id is null or v_state.unplaced_heats > 0 or v_state.live_heats = 0 then
    raise exception 'COMPO1_NO_HEATS: the round needs at least one heat in the published running order.' using errcode = '23514';
  end if;
  -- Panel readiness is E1's contract (20270101090000, a hard dependency checked by the preflight). The round row is
  -- already locked FOR UPDATE above, so E1's panel freeze (FOR SHARE on the round) cannot interleave with this check.
  v_ready := public.competition_round_panel_ready(p_round_id);
  if v_ready is distinct from true then
    raise exception 'COMPO1_PANEL_NOT_READY: assign the officials panel before starting the round.' using errcode = '23514';
  end if;

  perform public._compo1_record(v_event, p_round_id, null, 'round_started', 'scheduled', 'active', v_actor, p_request_id, null,
    jsonb_build_object('schedule_version_id', v_state.live_version_id, 'heats', v_state.live_heats));
  update public.event_competition_rounds set status = 'active', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'active');
end;
$$;

create function public.cancel_competition_round(p_round_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event uuid;
  v_status text;
  v_prior record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_published boolean := false;
begin
  if v_actor is null or p_round_id is null or p_request_id is null then
    raise exception 'COMPO1_NOT_FOUND: round was not found or cannot be managed.' using errcode = '42501';
  end if;
  select event_id into v_event from public.event_competition_rounds where id = p_round_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'COMPO1_NOT_FOUND: round was not found or cannot be managed.' using errcode = '42501';
  end if;
  perform public._compo1_lock_event(v_event);
  select status into v_status from public.event_competition_rounds where id = p_round_id for update;

  select * into v_prior from public.event_competition_round_transition_events where request_id = p_request_id limit 1;
  if found then
    if v_prior.kind = 'round_cancelled' and v_prior.round_id = p_round_id and v_prior.actor = v_actor then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', v_prior.to_state);
    end if;
    raise exception 'COMPO1_REQUEST_REUSE: this request id was already used for a different operation.' using errcode = '23505';
  end if;

  if v_reason is null or length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'COMPO1_REASON_REQUIRED: a cancellation reason (3-500 characters) is required.' using errcode = '23514';
  end if;
  if v_status in ('cancelled', 'complete') then
    raise exception 'COMPO1_BAD_STATE: a % round cannot be cancelled.', v_status using errcode = '23514';
  end if;
  if v_status = 'published' then
    v_published := true;
  elsif to_regclass('public.event_competition_result_publications') is not null then
    execute 'select exists (select 1 from public.event_competition_result_publications where round_id = $1)' into v_published using p_round_id;
  end if;
  if v_published then
    raise exception 'COMPO1_PUBLISHED: a round with a result publication cannot be cancelled.' using errcode = '23514';
  end if;
  if exists (select 1 from public.event_competition_heats h where h.round_id = p_round_id and h.status in ('staging', 'active')) then
    raise exception 'COMPO1_HEAT_RUNNING: finish or reset the heats that are on the floor before cancelling the round.' using errcode = '23514';
  end if;

  perform public._compo1_record(v_event, p_round_id, null, 'round_cancelled', v_status, 'cancelled', v_actor, p_request_id, v_reason, '{}'::jsonb);
  -- Heats that have not run leave the running order with the round, so a numbered heat shared with another round is not
  -- blocked by the cancelled one (complete heats stay as the record of what was danced).
  update public.event_competition_heats set status = 'cancelled', updated_at = now()
  where round_id = p_round_id and status in ('draft', 'scheduled') and lock_state = 'open';
  update public.event_competition_rounds set status = 'cancelled', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Heat day-of writer (floor heat = the numbered "Heat 12", which may hold several scoring heats)
-- ---------------------------------------------------------------------------
create function public.advance_competition_floor_heat(p_floor_heat_id uuid, p_to_status text, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event uuid;
  v_version uuid;
  v_floor uuid;
  v_number integer;
  v_from text;
  v_kind text;
  v_prior record;
  v_heat record;
  v_count integer := 0;
begin
  if v_actor is null or p_floor_heat_id is null or p_request_id is null
     or p_to_status is null or p_to_status not in ('staging', 'active', 'complete') then
    raise exception 'COMPO1_NOT_FOUND: heat was not found or cannot be managed.' using errcode = '42501';
  end if;
  select event_id, schedule_version_id, floor_id, heat_number into v_event, v_version, v_floor, v_number
  from public.event_competition_floor_heats where id = p_floor_heat_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'COMPO1_NOT_FOUND: heat was not found or cannot be managed.' using errcode = '42501';
  end if;
  perform public._compo1_lock_event(v_event);

  v_from := case p_to_status when 'staging' then 'scheduled' when 'active' then 'staging' else 'active' end;
  v_kind := case p_to_status when 'staging' then 'heat_staged' when 'active' then 'heat_started' else 'heat_completed' end;

  select * into v_prior from public.event_competition_round_transition_events
  where request_id = p_request_id order by created_at limit 1;
  if found then
    if v_prior.kind = v_kind and v_prior.actor = v_actor and v_prior.refs->>'floor_heat_id' = p_floor_heat_id::text then
      return jsonb_build_object('replayed', true, 'floor_heat_id', p_floor_heat_id, 'status', p_to_status);
    end if;
    raise exception 'COMPO1_REQUEST_REUSE: this request id was already used for a different operation.' using errcode = '23505';
  end if;

  if v_version is distinct from public._compo1_live_version(v_event) then
    raise exception 'COMPO1_NOT_LIVE: heat % is not in the live published running order.', v_number using errcode = '23514';
  end if;

  -- Lock the scoring heats in a stable order.
  perform 1 from public.event_competition_heats
  where floor_heat_id = p_floor_heat_id and status <> 'cancelled' order by id for update;
  for v_heat in
    select h.id, h.round_id, h.status, h.lock_state, r.status as round_status
    from public.event_competition_heats h
    join public.event_competition_rounds r on r.id = h.round_id
    where h.floor_heat_id = p_floor_heat_id and h.status <> 'cancelled'
    order by h.id
  loop
    v_count := v_count + 1;
    if v_heat.status <> v_from then
      raise exception 'COMPO1_BAD_STATE: heat % must be % to move to % (a scoring heat is %).', v_number, v_from, p_to_status, v_heat.status
        using errcode = '23514';
    end if;
    if v_heat.lock_state <> 'open' then
      raise exception 'COMPO1_HEAT_LOCKED: heat % has a % scoring heat.', v_number, v_heat.lock_state using errcode = '23514';
    end if;
    if v_heat.round_status <> 'active' then
      raise exception 'COMPO1_ROUND_NOT_ACTIVE: start the round before running heat % (a round is %).', v_number, v_heat.round_status
        using errcode = '23514';
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'COMPO1_NO_HEATS: heat % has no scoring heats.', v_number using errcode = '23514';
  end if;

  if p_to_status = 'active' and exists (
    select 1
    from public.event_competition_heats h
    join public.event_competition_floor_heats ff on ff.id = h.floor_heat_id
    where h.event_id = v_event and h.status = 'active' and h.floor_heat_id <> p_floor_heat_id
      and coalesce(ff.floor_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(v_floor, '00000000-0000-0000-0000-000000000000'::uuid)
  ) then
    raise exception 'COMPO1_FLOOR_BUSY: another heat is already on this floor; complete it before starting heat %.', v_number
      using errcode = '23514';
  end if;

  for v_heat in
    select id, round_id from public.event_competition_heats
    where floor_heat_id = p_floor_heat_id and status <> 'cancelled' order by id
  loop
    perform public._compo1_record(v_event, v_heat.round_id, v_heat.id, v_kind, v_from, p_to_status, v_actor, p_request_id, null,
      jsonb_build_object('floor_heat_id', p_floor_heat_id, 'heat_number', v_number));
  end loop;
  update public.event_competition_heats set status = p_to_status, updated_at = now()
  where floor_heat_id = p_floor_heat_id and status <> 'cancelled';
  return jsonb_build_object('replayed', false, 'floor_heat_id', p_floor_heat_id, 'status', p_to_status, 'scoring_heats', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.schedule_competition_round(uuid, uuid) from public, anon;
revoke all on function public.start_competition_round(uuid, uuid) from public, anon;
revoke all on function public.cancel_competition_round(uuid, text, uuid) from public, anon;
revoke all on function public.advance_competition_floor_heat(uuid, text, uuid) from public, anon;
grant execute on function public.schedule_competition_round(uuid, uuid) to authenticated;
grant execute on function public.start_competition_round(uuid, uuid) to authenticated;
grant execute on function public.cancel_competition_round(uuid, text, uuid) to authenticated;
grant execute on function public.advance_competition_floor_heat(uuid, text, uuid) to authenticated;

comment on function public.schedule_competition_round(uuid, uuid) is
  'O1: draft -> scheduled. Manager only; every heat of the round must be in the live published schedule version. Idempotent on the request id.';
comment on function public.start_competition_round(uuid, uuid) is
  'O1: scheduled -> active. Manager only; needs at least one published heat and E1 competition_round_panel_ready(round). Hard dependency on E1.';
comment on function public.cancel_competition_round(uuid, text, uuid) is
  'O1: any non-terminal -> cancelled with a reason. Refused when a result publication exists or a heat is on the floor.';
comment on function public.advance_competition_floor_heat(uuid, text, uuid) is
  'O1: scheduled -> staging -> active -> complete for every scoring heat of a floor heat in the live running order. Honors the 10A heat lock state; never edits entries or placements.';
