-- 20261111090000_phase10d_heats_floor_schedule.sql
--
-- PHASE 10 -- 10D: Heats + Floor Schedule v1.
--
-- Two heat concepts, two tables:
--   SCORING HEAT = public.event_competition_heats (existing, canonical): one division + round (+ dance for
--     per-dance divisions); entries are judged together. Entries are assigned through
--     public.event_competition_heat_entries (existing). 10A audited lock states are unchanged.
--   FLOOR HEAT   = public.event_competition_floor_heats (new): the numbered unit called to the floor
--     ("Heat 12"), scoped to event + schedule version. One floor heat holds one or more scoring heats that
--     share one music/run context. Heat numbers are contiguous positive integers = running order.
--
-- One schedule-version / publication authority, two planning modes:
--   SIMPLE   sequence-first numbered floor heats (this slice; canonical Schedule & Heats page);
--   ADVANCED existing June time-block planning (session -> block -> scoring heat), unchanged.
-- validate_competition_heat_schedule_placement, publish_competition_schedule_version,
-- build_competition_schedule_snapshot and create_competition_schedule_version are extended (bodies
-- otherwise identical to the reviewed DEV/PROD definitions, pinned below).
--
-- Hard rules (database): same event / version / division / round ownership (composite FKs); one floor-heat
-- placement per scoring heat; draft-only mutation of the running order (published versions are frozen;
-- edit by creating a new version, which copies the running order); one competitor appears in at most one
-- entry per floor heat (and per scoring heat), via heat entry -> entry -> entry participant -> competitor_id;
-- all scoring heats in a floor heat share one music key (_comp10d_heat_music_key). Floor-heat size is a soft
-- recommendation (app only).
--
-- Music key: 'dance:<key>' for a single dance, 'set:<k1,k2..>' for a prescribed set, and
-- 'exclusive:<heat id>' (never combinable) for routines/own-music (dance_selection_mode routine/none,
-- contest types showdance, cabaret, formation, team, spotlight) or when no dance is known (fail closed).
--
-- Scoring-heat numbers become unique per round PER SCHEDULE VERSION (was: per round across all versions),
-- so a new version can carry the same running order. Unversioned heats keep the old uniqueness.
--
-- Default scoring-heat capacity: 8 entries (DanceFlow product default, NOT a sanctioning rule), stored per
-- round in event_competition_rounds.configuration->>'max_entries_per_heat'.
--
-- Not in scope: officials, ballots, scoring, results, per-heat J&J pairing records, multi-floor UX, timing
-- forecasts, public heat sheet. Rollback: rollback/20261111090000_phase10d_heats_floor_schedule_rollback.sql.

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_floor_heats') is not null then
    raise exception '10D preflight: event_competition_floor_heats already exists.';
  end if;
  if md5(pg_get_functiondef('public.validate_competition_heat_schedule_placement()'::regprocedure)) <> 'ffa24e9295dad872ffb45c26329bd876'
     or md5(pg_get_functiondef('public.publish_competition_schedule_version(uuid)'::regprocedure)) <> '3a1fa54d6a9d8517cc14248239ae5274'
     or md5(pg_get_functiondef('public.build_competition_schedule_snapshot(uuid)'::regprocedure)) <> 'dd39df81a653ae9fead035ef00042d97'
     or md5(pg_get_functiondef('public.create_competition_schedule_version(uuid,text,uuid)'::regprocedure)) <> '3487229452fbf2dcb7a913933f940e27' then
    raise exception '10D preflight: schedule functions are not the reviewed definitions.';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.event_competition_heats'::regclass and conname = 'event_competition_heats_round_id_heat_number_key')
     is distinct from 'UNIQUE (round_id, heat_number)' then
    raise exception '10D preflight: event_competition_heats round/heat-number uniqueness is not the reviewed definition.';
  end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.set_competition_heat_lock_state(uuid,text,text)') is null then
    raise exception '10D preflight: 10A competition authority is not installed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Floor heats
-- ---------------------------------------------------------------------------
create table public.event_competition_floor_heats (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  schedule_version_id uuid not null,
  heat_number integer not null,
  floor_id uuid,
  planned_start_at timestamptz,
  planned_duration_seconds integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_floor_heats_pkey primary key (id),
  constraint event_competition_floor_heats_version_fk
    foreign key (schedule_version_id, event_id)
    references public.event_competition_schedule_versions(id, event_id) on delete cascade,
  constraint event_competition_floor_heats_floor_fk
    foreign key (floor_id, event_id)
    references public.event_competition_schedule_floors(id, event_id) on delete restrict,
  constraint event_competition_floor_heats_number_check check (heat_number > 0),
  constraint event_competition_floor_heats_duration_check check (planned_duration_seconds is null or planned_duration_seconds > 0),
  constraint event_competition_floor_heats_notes_check check (notes is null or length(notes) <= 500),
  constraint event_competition_floor_heats_id_event_key unique (id, event_id),
  constraint event_competition_floor_heats_id_version_event_key unique (id, schedule_version_id, event_id),
  constraint event_competition_floor_heats_number_key unique (schedule_version_id, heat_number) deferrable initially immediate
);
create index event_competition_floor_heats_event_idx on public.event_competition_floor_heats(event_id, schedule_version_id);
comment on table public.event_competition_floor_heats is
  '10D: numbered on-floor heat ("Heat 12") in a schedule version. Holds one or more scoring heats (event_competition_heats.floor_heat_id) that share one music/run context. heat_number = running order, contiguous 1..n, frozen once the version is published.';

create trigger set_event_competition_updated_at
  before update on public.event_competition_floor_heats
  for each row execute function public.set_event_competition_updated_at();

alter table public.event_competition_floor_heats enable row level security;
create policy competition_floor_heats_manager_read on public.event_competition_floor_heats
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_floor_heats from public, anon, authenticated;
grant select on public.event_competition_floor_heats to authenticated;
grant all on public.event_competition_floor_heats to service_role;

-- ---------------------------------------------------------------------------
-- 2. Scoring heat -> floor heat (same event, same version)
-- ---------------------------------------------------------------------------
alter table public.event_competition_heats add column floor_heat_id uuid;
alter table public.event_competition_heats
  add constraint event_competition_heats_floor_heat_fk
  foreign key (floor_heat_id, schedule_version_id, event_id)
  references public.event_competition_floor_heats(id, schedule_version_id, event_id);
create index event_competition_heats_floor_heat_idx on public.event_competition_heats(floor_heat_id) where floor_heat_id is not null;
comment on column public.event_competition_heats.floor_heat_id is
  '10D: the numbered floor heat this scoring heat runs in (SIMPLE planning). Mutually exclusive with schedule_block_id.';

-- Scoring-heat numbers are unique per round within one schedule version.
alter table public.event_competition_heats drop constraint event_competition_heats_round_id_heat_number_key;
create unique index event_competition_heats_round_version_number_uidx
  on public.event_competition_heats(round_id, coalesce(schedule_version_id, '00000000-0000-0000-0000-000000000000'::uuid), heat_number);

-- ---------------------------------------------------------------------------
-- 3. Validation authority (internal; definer so RLS can never hide a conflict)
-- ---------------------------------------------------------------------------
create function public._comp10d_heat_music_key(p_heat_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce(r.dance_selection_mode, '') in ('routine', 'none')
      or coalesce(c.contest_type, '') in ('showdance', 'cabaret', 'formation', 'team', 'spotlight')
      or dn.n = 0 then 'exclusive:' || h.id::text
    when dn.n = 1 then 'dance:' || dn.keys
    else 'set:' || dn.keys
  end
  from public.event_competition_heats h
  join public.event_competition_divisions dv on dv.id = h.division_id and dv.event_id = h.event_id
  left join public.event_competition_contests c on c.id = coalesce(h.contest_id, dv.contest_id) and c.event_id = h.event_id
  left join lateral (
    select rr.dance_selection_mode from public.event_competition_contest_registration_rules rr
    where rr.contest_id = c.id and rr.event_id = h.event_id limit 1
  ) r on true
  cross join lateral (
    select count(*)::int as n, string_agg(lower(btrim(hd.dance_key)), ',' order by hd.sequence_number) as keys
    from public.event_competition_heat_dances hd where hd.heat_id = h.id and hd.status <> 'cancelled'
  ) dn
  where h.id = p_heat_id;
$$;
comment on function public._comp10d_heat_music_key(uuid) is
  '10D: run/music context of a scoring heat. dance:<key> | set:<keys> | exclusive:<heat id> (routines, own music, unknown -> never combinable).';

create function public._comp10d_floor_heat_problems(p_floor_heat_id uuid)
returns table (problem text, competitor_id uuid, detail text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with heats as (
    select h.id from public.event_competition_heats h
    where h.floor_heat_id = p_floor_heat_id and h.status <> 'cancelled'
  ), placements as (
    select he.entry_id, p.competitor_id
    from heats h
    join public.event_competition_heat_entries he on he.heat_id = h.id and he.status <> 'scratched'
    join public.event_competition_entry_participants p on p.entry_id = he.entry_id and p.event_id = he.event_id
  ), duplicates as (
    select pl.competitor_id from placements pl group by pl.competitor_id having count(distinct pl.entry_id) > 1
  )
  select 'competitor_conflict', d.competitor_id,
         btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) || ' is dancing in more than one entry in this heat'
  from duplicates d left join public.event_competition_competitors c on c.id = d.competitor_id
  union all
  select 'incompatible_music', null::uuid, string_agg(distinct k.key, ' / ')
  from (select public._comp10d_heat_music_key(h.id) as key from heats h) k
  having count(distinct k.key) > 1;
$$;

create function public._comp10d_scoring_heat_duplicate(p_heat_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))
  from public.event_competition_heat_entries he
  join public.event_competition_entry_participants p on p.entry_id = he.entry_id and p.event_id = he.event_id
  left join public.event_competition_competitors c on c.id = p.competitor_id
  where he.heat_id = p_heat_id and he.status <> 'scratched'
  group by p.competitor_id, c.first_name, c.last_name
  having count(distinct he.entry_id) > 1
  limit 1;
$$;

revoke all on function public._comp10d_heat_music_key(uuid) from public, anon, authenticated;
revoke all on function public._comp10d_floor_heat_problems(uuid) from public, anon, authenticated;
revoke all on function public._comp10d_scoring_heat_duplicate(uuid) from public, anon, authenticated;

-- Organizer-facing problem list for a version (managers only).
create function public.competition_floor_schedule_problems(p_version_id uuid)
returns table (floor_heat_id uuid, heat_number integer, problem text, competitor_id uuid, detail text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
begin
  select event_id into v_event from public.event_competition_schedule_versions where id = p_version_id;
  if v_event is null or not (public.can_manage_event_competition(v_event) or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'Schedule version was not found or cannot be managed.';
  end if;
  return query
    select f.id, f.heat_number, pr.problem, pr.competitor_id, pr.detail
    from public.event_competition_floor_heats f
    cross join lateral public._comp10d_floor_heat_problems(f.id) pr
    where f.schedule_version_id = p_version_id
    order by f.heat_number, pr.problem;
end;
$$;
revoke all on function public.competition_floor_schedule_problems(uuid) from public, anon;
grant execute on function public.competition_floor_schedule_problems(uuid) to authenticated, service_role;

-- Deferred integrity check: runs at commit, so multi-row RPCs validate their final state.
create function public._comp10d_check_floor_heat_integrity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_heat uuid;
  v_floor uuid;
  v_number integer;
  v_name text;
  v_problem record;
begin
  if tg_table_name = 'event_competition_heats' then
    v_heat := new.id;
    v_floor := new.floor_heat_id;
  else
    v_heat := new.heat_id;
    select floor_heat_id into v_floor from public.event_competition_heats where id = v_heat;
  end if;
  v_name := public._comp10d_scoring_heat_duplicate(v_heat);
  if v_name is not null then
    raise exception 'COMP10D_COMPETITOR_CONFLICT: % is entered more than once in the same scoring heat.', v_name
      using errcode = '23514';
  end if;
  if v_floor is not null then
    select heat_number into v_number from public.event_competition_floor_heats where id = v_floor;
    for v_problem in
      select * from public._comp10d_floor_heat_problems(v_floor) pr order by (pr.problem = 'competitor_conflict') desc
    loop
      if v_problem.problem = 'competitor_conflict' then
        raise exception 'COMP10D_COMPETITOR_CONFLICT: % (heat %).', v_problem.detail, v_number using errcode = '23514';
      end if;
      raise exception 'COMP10D_INCOMPATIBLE_MUSIC: heat % would mix % -- divisions on the floor together must share the same dance or music.',
        v_number, v_problem.detail using errcode = '23514';
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function public._comp10d_check_floor_heat_integrity() from public, anon, authenticated;

create constraint trigger comp10d_heat_floor_integrity
  after insert or update of floor_heat_id, status on public.event_competition_heats
  deferrable initially deferred
  for each row execute function public._comp10d_check_floor_heat_integrity();
create constraint trigger comp10d_heat_entry_floor_integrity
  after insert or update on public.event_competition_heat_entries
  deferrable initially deferred
  for each row execute function public._comp10d_check_floor_heat_integrity();
create constraint trigger comp10d_heat_dance_floor_integrity
  after insert or update on public.event_competition_heat_dances
  deferrable initially deferred
  for each row execute function public._comp10d_check_floor_heat_integrity();

-- ---------------------------------------------------------------------------
-- 4. Draft-only mutation (published running orders are frozen)
-- ---------------------------------------------------------------------------
-- Editable when there is no version, the version is a draft, or the row is going away with its event or
-- version (cascades must keep working).
create function public._comp10d_version_editable(p_event_id uuid, p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_version_id is null
    or not exists (select 1 from public.events where id = p_event_id)
    or coalesce((select status = 'draft' from public.event_competition_schedule_versions where id = p_version_id), true);
$$;
revoke all on function public._comp10d_version_editable(uuid, uuid) from public, anon, authenticated;

create function public._comp10d_guard_floor_heat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and not public._comp10d_version_editable(old.event_id, old.schedule_version_id) then
    raise exception 'COMP10D_SCHEDULE_PUBLISHED: a published running order cannot be changed; create a new version to edit it.'
      using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not public._comp10d_version_editable(new.event_id, new.schedule_version_id) then
    raise exception 'COMP10D_SCHEDULE_PUBLISHED: a published running order cannot be changed; create a new version to edit it.'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.event_id, new.schedule_version_id) is distinct from (old.event_id, old.schedule_version_id) then
    raise exception 'COMP10D_PLACEMENT: a floor heat cannot move to another event or schedule version.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public._comp10d_guard_floor_heat() from public, anon, authenticated;
create trigger comp10d_guard_floor_heat
  before insert or update or delete on public.event_competition_floor_heats
  for each row execute function public._comp10d_guard_floor_heat();

-- Heat entries / heat dances: assignment changes only while the version is a draft. Status updates
-- (check-in, scratch, danced) stay allowed on published heats.
create function public._comp10d_guard_heat_child()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_heat_id uuid := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  v_event uuid;
  v_version uuid;
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - array['status', 'updated_at']) = (to_jsonb(old) - array['status', 'updated_at']) then
    return new;
  end if;
  select event_id, schedule_version_id into v_event, v_version from public.event_competition_heats where id = v_heat_id;
  if v_version is not null and not public._comp10d_version_editable(v_event, v_version) then
    raise exception 'COMP10D_SCHEDULE_PUBLISHED: heats in a published running order cannot be reassigned; create a new version to edit it.'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.heat_id is distinct from new.heat_id then
    select event_id, schedule_version_id into v_event, v_version from public.event_competition_heats where id = old.heat_id;
    if v_version is not null and not public._comp10d_version_editable(v_event, v_version) then
      raise exception 'COMP10D_SCHEDULE_PUBLISHED: heats in a published running order cannot be reassigned; create a new version to edit it.'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public._comp10d_guard_heat_child() from public, anon, authenticated;
create trigger comp10d_guard_heat_entry
  before insert or update or delete on public.event_competition_heat_entries
  for each row execute function public._comp10d_guard_heat_child();
create trigger comp10d_guard_heat_dance
  before insert or update or delete on public.event_competition_heat_dances
  for each row execute function public._comp10d_guard_heat_child();

create function public._comp10d_guard_heat_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.schedule_version_id is not null and not public._comp10d_version_editable(old.event_id, old.schedule_version_id) then
    raise exception 'COMP10D_SCHEDULE_PUBLISHED: heats in a published schedule cannot be deleted; create a new version to edit it.'
      using errcode = '42501';
  end if;
  return old;
end;
$$;
revoke all on function public._comp10d_guard_heat_delete() from public, anon, authenticated;
create trigger comp10d_guard_heat_delete
  before delete on public.event_competition_heats
  for each row execute function public._comp10d_guard_heat_delete();

-- ---------------------------------------------------------------------------
-- 5. Placement trigger: floor heats (SIMPLE) or blocks (ADVANCED)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_competition_heat_schedule_placement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  version_status text;
  block_start timestamptz;
  block_end timestamptz;
  block_floor_id uuid;
  division_contest_id uuid;
begin
  if new.schedule_version_id is null then
    return new;
  end if;

  select status into version_status
  from public.event_competition_schedule_versions
  where id = new.schedule_version_id and event_id = new.event_id;
  if version_status is distinct from 'draft' then
    raise exception 'Heats may only be placed into an editable draft schedule.';
  end if;

  -- 10D: SIMPLE planning places a scoring heat in a numbered floor heat (sequence first, no time
  -- block). ADVANCED planning keeps the time-block rules below unchanged. A heat uses one or the other.
  if new.floor_heat_id is not null then
    if new.schedule_block_id is not null then
      raise exception 'COMP10D_PLACEMENT: a heat is placed either in a floor heat or in a schedule block, not both.';
    end if;
    select contest_id into division_contest_id
    from public.event_competition_divisions
    where id = new.division_id and event_id = new.event_id;
    if new.contest_id is distinct from division_contest_id then
      raise exception 'Heat contest must match the division competition event.';
    end if;
    return new;
  end if;

  select starts_at, ends_at, floor_id into block_start, block_end, block_floor_id
  from public.event_competition_schedule_blocks
  where id = new.schedule_block_id
    and schedule_version_id = new.schedule_version_id
    and event_id = new.event_id;
  if block_start is null then
    raise exception 'A valid schedule block is required.';
  end if;
  if new.scheduled_at is null or new.estimated_ends_at is null
    or new.scheduled_at < block_start or new.estimated_ends_at > block_end then
    raise exception 'Heat timing must be contained within its schedule block.';
  end if;
  if new.floor_id is distinct from block_floor_id then
    raise exception 'Heat floor must match its schedule block.';
  end if;

  select contest_id into division_contest_id
  from public.event_competition_divisions
  where id = new.division_id and event_id = new.event_id;
  if new.contest_id is distinct from division_contest_id then
    raise exception 'Heat contest must match the division competition event.';
  end if;
  return new;
end;
$function$
;

drop trigger validate_competition_heat_schedule_placement on public.event_competition_heats;
create trigger validate_competition_heat_schedule_placement
before insert or update of event_id, division_id, contest_id, schedule_version_id,
  schedule_block_id, floor_id, scheduled_at, estimated_ends_at, floor_heat_id
on public.event_competition_heats
for each row execute function public.validate_competition_heat_schedule_placement();

-- ---------------------------------------------------------------------------
-- 6. Organizer operations (managers; draft versions only)
-- ---------------------------------------------------------------------------
create function public._comp10d_require_draft(p_version_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
  v_status text;
begin
  select event_id, status into v_event, v_status from public.event_competition_schedule_versions where id = p_version_id;
  if v_event is null or not (public.can_manage_event_competition(v_event) or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'COMP10D_NOT_FOUND: schedule version was not found or cannot be managed.';
  end if;
  if v_status <> 'draft' then
    raise exception 'COMP10D_SCHEDULE_PUBLISHED: a published running order cannot be changed; create a new version to edit it.'
      using errcode = '42501';
  end if;
  return v_event;
end;
$$;
revoke all on function public._comp10d_require_draft(uuid) from public, anon, authenticated;

-- Applies a generated plan to an empty draft version in one transaction:
--   {"floorHeats":[{"number":1,"scoringHeats":[{"divisionId","roundId","heatNumber","name","danceIds":[],"entryIds":[]}]}]}
create function public.apply_competition_floor_plan(p_version_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid := public._comp10d_require_draft(p_version_id);
  v_floor jsonb;
  v_score jsonb;
  v_floor_id uuid;
  v_heat_id uuid;
  v_expected integer := 0;
  v_division record;
  v_round record;
  v_mode text;
  v_capacity integer;
  v_dance record;
  v_dance_ids uuid[];
  v_entry record;
  v_seq integer;
  v_heats integer := 0;
  v_entries integer := 0;
  v_key text;
begin
  if exists (select 1 from public.event_competition_floor_heats where schedule_version_id = p_version_id)
     or exists (select 1 from public.event_competition_heats where schedule_version_id = p_version_id and status <> 'cancelled') then
    raise exception 'COMP10D_PLAN_EXISTS: this draft already has heats; clear it before generating again.';
  end if;
  if jsonb_typeof(p_plan->'floorHeats') is distinct from 'array' or jsonb_array_length(p_plan->'floorHeats') = 0 then
    raise exception 'COMP10D_PLAN_INVALID: the plan has no heats.';
  end if;

  for v_floor in select x from jsonb_array_elements(p_plan->'floorHeats') x loop
    v_expected := v_expected + 1;
    if (v_floor->>'number') is distinct from v_expected::text then
      raise exception 'COMP10D_PLAN_INVALID: heats must be numbered 1, 2, 3 ...';
    end if;
    if jsonb_typeof(v_floor->'scoringHeats') is distinct from 'array' or jsonb_array_length(v_floor->'scoringHeats') = 0 then
      raise exception 'COMP10D_PLAN_INVALID: heat % has no divisions.', v_expected;
    end if;
    insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number)
    values (v_event, p_version_id, v_expected) returning id into v_floor_id;

    for v_score in select x from jsonb_array_elements(v_floor->'scoringHeats') x loop
      select d.id, d.name, d.contest_id into v_division
      from public.event_competition_divisions d
      where d.id = (v_score->>'divisionId')::uuid and d.event_id = v_event;
      select r.id, r.configuration into v_round
      from public.event_competition_rounds r
      where r.id = (v_score->>'roundId')::uuid and r.division_id = v_division.id and r.event_id = v_event;
      if v_division.id is null or v_round.id is null then
        raise exception 'COMP10D_PLAN_INVALID: a division or round does not belong to this event.';
      end if;
      select rr.dance_selection_mode into v_mode from public.event_competition_contest_registration_rules rr
      where rr.contest_id = v_division.contest_id and rr.event_id = v_event limit 1;
      v_capacity := coalesce(nullif(v_round.configuration->>'max_entries_per_heat', '')::integer, 8);
      if jsonb_array_length(coalesce(v_score->'entryIds', '[]'::jsonb)) > v_capacity then
        raise exception 'COMP10D_CAPACITY: % allows at most % entries per scoring heat.', v_division.name, v_capacity;
      end if;

      insert into public.event_competition_heats (
        event_id, division_id, round_id, heat_number, name, contest_id, schedule_version_id, floor_heat_id, status
      ) values (
        v_event, v_division.id, v_round.id, (v_score->>'heatNumber')::integer,
        nullif(left(btrim(coalesce(v_score->>'name', '')), 160), ''), v_division.contest_id, p_version_id, v_floor_id, 'scheduled'
      ) returning id into v_heat_id;
      v_heats := v_heats + 1;

      v_seq := 0;
      v_dance_ids := '{}';
      for v_dance in
        select n.id, n.dance_key, n.name
        from jsonb_array_elements_text(coalesce(v_score->'danceIds', '[]'::jsonb)) with ordinality s(dance_id, o)
        join public.event_competition_dances n on n.id = s.dance_id::uuid and n.event_id = v_event
        order by s.o
      loop
        if not exists (
          select 1 from public.event_competition_division_dances dd
          where dd.division_id = v_division.id and dd.dance_id = v_dance.id and dd.event_id = v_event and dd.active
        ) then
          raise exception 'COMP10D_PLAN_INVALID: % is not a dance of %.', v_dance.name, v_division.name;
        end if;
        v_seq := v_seq + 1;
        v_dance_ids := v_dance_ids || v_dance.id;
        insert into public.event_competition_heat_dances (event_id, heat_id, dance_id, dance_key, dance_label, sequence_number)
        values (v_event, v_heat_id, v_dance.id, v_dance.dance_key, v_dance.name, v_seq);
      end loop;
      if v_seq <> jsonb_array_length(coalesce(v_score->'danceIds', '[]'::jsonb)) then
        raise exception 'COMP10D_PLAN_INVALID: a dance does not belong to this event.';
      end if;
      v_key := public._comp10d_heat_music_key(v_heat_id);

      v_seq := 0;
      for v_entry in
        select e.id, e.division_id, e.status, e.eligibility_status, e.display_name
        from jsonb_array_elements_text(coalesce(v_score->'entryIds', '[]'::jsonb)) with ordinality s(entry_id, o)
        left join public.event_competition_entries e on e.id = s.entry_id::uuid and e.event_id = v_event
        order by s.o
      loop
        if v_entry.id is null or v_entry.division_id <> v_division.id then
          raise exception 'COMP10D_PLAN_INVALID: an entry does not belong to %.', v_division.name;
        end if;
        -- Only confirmed entries that are not ruled ineligible compete.
        if v_entry.status <> 'confirmed' or v_entry.eligibility_status = 'ineligible' then
          raise exception 'COMP10D_ENTRY_NOT_SCHEDULABLE: % is not a confirmed, eligible entry.', v_entry.display_name;
        end if;
        -- Per-dance divisions: the entry must be registered for this heat's dance.
        if coalesce(v_mode, '') in ('individual', 'choose_count') and cardinality(v_dance_ids) = 1 and not exists (
          select 1 from public.event_competition_entry_dances ed
          join public.event_competition_division_dances dd on dd.id = ed.division_dance_id
          where ed.entry_id = v_entry.id and dd.dance_id = v_dance_ids[1] and ed.status <> 'scratched'
        ) then
          raise exception 'COMP10D_ENTRY_NOT_SCHEDULABLE: % is not registered for this dance.', v_entry.display_name;
        end if;
        -- One placement per entry per round and run context in this version.
        if exists (
          select 1 from public.event_competition_heat_entries he
          join public.event_competition_heats h2 on h2.id = he.heat_id
          where he.entry_id = v_entry.id and h2.schedule_version_id = p_version_id and h2.round_id = v_round.id
            and h2.id <> v_heat_id and h2.status <> 'cancelled'
            and (public._comp10d_heat_music_key(h2.id) = v_key
                 or (v_key like 'exclusive:%' and public._comp10d_heat_music_key(h2.id) like 'exclusive:%'))
        ) then
          raise exception 'COMP10D_PLAN_INVALID: % is placed twice in the same round.', v_entry.display_name;
        end if;
        v_seq := v_seq + 1;
        insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
        values (v_event, v_division.id, v_heat_id, v_entry.id, v_seq);
        v_entries := v_entries + 1;
      end loop;
    end loop;
  end loop;
  return jsonb_build_object('floor_heats', v_expected, 'scoring_heats', v_heats, 'entries', v_entries);
end;
$$;

create function public.clear_competition_floor_plan(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid := public._comp10d_require_draft(p_version_id);
begin
  delete from public.event_competition_heats where schedule_version_id = p_version_id and floor_heat_id is not null;
  delete from public.event_competition_floor_heats where schedule_version_id = p_version_id;
end;
$$;

-- Moves a floor heat to a new position; the heats in between shift by one (one statement, so the
-- deferrable number key is checked once).
create function public.move_competition_floor_heat(p_floor_heat_id uuid, p_new_number integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version uuid;
  v_old integer;
  v_count integer;
begin
  select schedule_version_id, heat_number into v_version, v_old from public.event_competition_floor_heats where id = p_floor_heat_id;
  if v_version is null then raise exception 'COMP10D_NOT_FOUND: heat was not found.'; end if;
  perform public._comp10d_require_draft(v_version);
  select count(*) into v_count from public.event_competition_floor_heats where schedule_version_id = v_version;
  if p_new_number is null or p_new_number < 1 or p_new_number > v_count then
    raise exception 'COMP10D_HEAT_NUMBERS: choose a heat number between 1 and %.', v_count;
  end if;
  update public.event_competition_floor_heats
  set heat_number = case
    when id = p_floor_heat_id then p_new_number
    when v_old < p_new_number and heat_number > v_old and heat_number <= p_new_number then heat_number - 1
    when v_old > p_new_number and heat_number >= p_new_number and heat_number < v_old then heat_number + 1
    else heat_number end
  where schedule_version_id = v_version;
end;
$$;

-- Inserts an empty floor heat at a position (later heats shift up by one).
create function public.insert_competition_floor_heat(p_version_id uuid, p_at_number integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid := public._comp10d_require_draft(p_version_id);
  v_count integer;
  v_id uuid;
begin
  select count(*) into v_count from public.event_competition_floor_heats where schedule_version_id = p_version_id;
  if p_at_number is null or p_at_number < 1 or p_at_number > v_count + 1 then
    raise exception 'COMP10D_HEAT_NUMBERS: choose a heat number between 1 and %.', v_count + 1;
  end if;
  update public.event_competition_floor_heats set heat_number = heat_number + 1
  where schedule_version_id = p_version_id and heat_number >= p_at_number;
  insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number)
  values (v_event, p_version_id, p_at_number) returning id into v_id;
  return v_id;
end;
$$;

-- Deletes an EMPTY floor heat; later heats shift down by one.
create function public.delete_competition_floor_heat(p_floor_heat_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version uuid;
  v_number integer;
begin
  select schedule_version_id, heat_number into v_version, v_number from public.event_competition_floor_heats where id = p_floor_heat_id;
  if v_version is null then raise exception 'COMP10D_NOT_FOUND: heat was not found.'; end if;
  perform public._comp10d_require_draft(v_version);
  if exists (select 1 from public.event_competition_heats where floor_heat_id = p_floor_heat_id) then
    raise exception 'COMP10D_HEAT_NOT_EMPTY: move its divisions to another heat first.';
  end if;
  delete from public.event_competition_floor_heats where id = p_floor_heat_id;
  update public.event_competition_floor_heats set heat_number = heat_number - 1
  where schedule_version_id = v_version and heat_number > v_number;
end;
$$;

-- Moves a scoring heat into another floor heat (same version). An emptied source heat is removed and
-- the running order closes the gap. Conflicts and music compatibility are enforced at commit.
create function public.move_competition_scoring_heat(p_heat_id uuid, p_target_floor_heat_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version uuid;
  v_source uuid;
  v_target_version uuid;
begin
  select schedule_version_id, floor_heat_id into v_version, v_source from public.event_competition_heats where id = p_heat_id;
  if v_version is null or v_source is null then raise exception 'COMP10D_NOT_FOUND: scoring heat was not found in a running order.'; end if;
  perform public._comp10d_require_draft(v_version);
  select schedule_version_id into v_target_version from public.event_competition_floor_heats where id = p_target_floor_heat_id;
  if v_target_version is distinct from v_version then
    raise exception 'COMP10D_PLACEMENT: the target heat is not in the same schedule version.';
  end if;
  if p_target_floor_heat_id = v_source then return; end if;
  update public.event_competition_heats set floor_heat_id = p_target_floor_heat_id where id = p_heat_id;
  if not exists (select 1 from public.event_competition_heats where floor_heat_id = v_source) then
    perform public.delete_competition_floor_heat(v_source);
  end if;
end;
$$;

-- Moves a scoring heat into a NEW floor heat inserted at a position.
create function public.move_competition_scoring_heat_to_new_floor_heat(p_heat_id uuid, p_at_number integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version uuid;
  v_new uuid;
begin
  select schedule_version_id into v_version from public.event_competition_heats where id = p_heat_id and floor_heat_id is not null;
  if v_version is null then raise exception 'COMP10D_NOT_FOUND: scoring heat was not found in a running order.'; end if;
  v_new := public.insert_competition_floor_heat(v_version, p_at_number);
  perform public.move_competition_scoring_heat(p_heat_id, v_new);
  return v_new;
end;
$$;

-- Per-round scoring-heat capacity (DanceFlow default 8; rules profiles may supply their own later).
create function public.set_competition_round_heat_capacity(p_round_id uuid, p_capacity integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
begin
  select event_id into v_event from public.event_competition_rounds where id = p_round_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'COMP10D_NOT_FOUND: round was not found or cannot be managed.';
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 100 then
    raise exception 'COMP10D_CAPACITY: choose between 1 and 100 entries per scoring heat.';
  end if;
  update public.event_competition_rounds
  set configuration = jsonb_set(coalesce(configuration, '{}'::jsonb), '{max_entries_per_heat}', to_jsonb(p_capacity))
  where id = p_round_id;
end;
$$;

-- Copies a SIMPLE running order into a new draft version (used by create_competition_schedule_version).
-- Entries that are no longer confirmed/eligible are left out.
create function public._comp10d_copy_floor_plan(p_source_version_id uuid, p_new_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_floor record;
  v_heat record;
  v_new_floor uuid;
  v_new_heat uuid;
  v_event uuid;
begin
  select event_id into v_event from public.event_competition_schedule_versions
  where id = p_new_version_id and status = 'draft'
    and event_id = (select event_id from public.event_competition_schedule_versions where id = p_source_version_id);
  if v_event is null or not (public.can_manage_event_competition(v_event) or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'COMP10D_NOT_FOUND: schedule versions were not found or cannot be managed.';
  end if;
  for v_floor in
    select * from public.event_competition_floor_heats where schedule_version_id = p_source_version_id order by heat_number
  loop
    insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number, floor_id, planned_start_at, planned_duration_seconds, notes)
    values (v_floor.event_id, p_new_version_id, v_floor.heat_number, v_floor.floor_id, v_floor.planned_start_at, v_floor.planned_duration_seconds, v_floor.notes)
    returning id into v_new_floor;
    for v_heat in
      select * from public.event_competition_heats where floor_heat_id = v_floor.id and status <> 'cancelled' order by created_at, id
    loop
      insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, name, contest_id, schedule_version_id, floor_heat_id, status, configuration)
      values (v_heat.event_id, v_heat.division_id, v_heat.round_id, v_heat.heat_number, v_heat.name, v_heat.contest_id, p_new_version_id, v_new_floor, 'scheduled', v_heat.configuration)
      returning id into v_new_heat;
      insert into public.event_competition_heat_dances (event_id, heat_id, dance_id, dance_key, dance_label, sequence_number, duration_seconds)
      select event_id, v_new_heat, dance_id, dance_key, dance_label, sequence_number, duration_seconds
      from public.event_competition_heat_dances where heat_id = v_heat.id and status <> 'cancelled';
      insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
      select he.event_id, he.division_id, v_new_heat, he.entry_id, he.floor_order
      from public.event_competition_heat_entries he
      join public.event_competition_entries e on e.id = he.entry_id
      where he.heat_id = v_heat.id and he.status <> 'scratched'
        and e.status = 'confirmed' and e.eligibility_status <> 'ineligible';
    end loop;
  end loop;
end;
$$;
revoke all on function public._comp10d_copy_floor_plan(uuid, uuid) from public, anon;
grant execute on function public._comp10d_copy_floor_plan(uuid, uuid) to authenticated, service_role;

revoke all on function public.apply_competition_floor_plan(uuid, jsonb) from public, anon;
revoke all on function public.clear_competition_floor_plan(uuid) from public, anon;
revoke all on function public.move_competition_floor_heat(uuid, integer) from public, anon;
revoke all on function public.insert_competition_floor_heat(uuid, integer) from public, anon;
revoke all on function public.delete_competition_floor_heat(uuid) from public, anon;
revoke all on function public.move_competition_scoring_heat(uuid, uuid) from public, anon;
revoke all on function public.move_competition_scoring_heat_to_new_floor_heat(uuid, integer) from public, anon;
revoke all on function public.set_competition_round_heat_capacity(uuid, integer) from public, anon;
grant execute on function public.apply_competition_floor_plan(uuid, jsonb) to authenticated, service_role;
grant execute on function public.clear_competition_floor_plan(uuid) to authenticated, service_role;
grant execute on function public.move_competition_floor_heat(uuid, integer) to authenticated, service_role;
grant execute on function public.insert_competition_floor_heat(uuid, integer) to authenticated, service_role;
grant execute on function public.delete_competition_floor_heat(uuid) to authenticated, service_role;
grant execute on function public.move_competition_scoring_heat(uuid, uuid) to authenticated, service_role;
grant execute on function public.move_competition_scoring_heat_to_new_floor_heat(uuid, integer) to authenticated, service_role;
grant execute on function public.set_competition_round_heat_capacity(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. One publication / snapshot / versioning authority for both planning modes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_competition_schedule_version(selected_version_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  selected_event_id uuid;
  next_publication_number integer;
  publication_snapshot jsonb;
begin
  select event_id into selected_event_id
  from public.event_competition_schedule_versions
  where id = selected_version_id and status in ('draft', 'review');

  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Schedule version was not found or cannot be published.';
  end if;
  -- 10D: one publication authority for both planning modes (sessions/blocks, or numbered floor heats).
  if not exists (select 1 from public.event_competition_schedule_sessions where schedule_version_id = selected_version_id)
     and not exists (select 1 from public.event_competition_floor_heats where schedule_version_id = selected_version_id) then
    raise exception 'Add at least one session, or generate floor heats, before publishing.';
  end if;
  if exists (select 1 from public.event_competition_floor_heats where schedule_version_id = selected_version_id) then
    if exists (
      select 1 from public.event_competition_floor_heats f
      where f.schedule_version_id = selected_version_id
        and not exists (select 1 from public.event_competition_heats h where h.floor_heat_id = f.id and h.status <> 'cancelled')
    ) then
      raise exception 'COMP10D_EMPTY_FLOOR_HEAT: every numbered heat needs at least one division before publishing.';
    end if;
    if (select count(*) <> max(heat_number) or min(heat_number) <> 1 from public.event_competition_floor_heats
        where schedule_version_id = selected_version_id) then
      raise exception 'COMP10D_HEAT_NUMBERS: heat numbers must run 1, 2, 3 ... before publishing.';
    end if;
    if exists (select 1 from public.competition_floor_schedule_problems(selected_version_id)) then
      raise exception 'COMP10D_UNRESOLVED_CONFLICTS: resolve every heat conflict before publishing.';
    end if;
    if exists (
      select 1 from public.event_competition_heats h
      where h.schedule_version_id = selected_version_id and h.status <> 'cancelled'
        and h.floor_heat_id is null and h.schedule_block_id is null
    ) then
      raise exception 'COMP10D_UNPLACED_HEAT: every heat in this schedule must be in a numbered heat or a time block.';
    end if;
  end if;
  if exists (
    select 1
    from public.event_competition_schedule_blocks a
    join public.event_competition_schedule_blocks b
      on b.schedule_version_id = a.schedule_version_id and b.id > a.id
     and a.floor_id is not null and b.floor_id = a.floor_id
     and b.starts_at < a.ends_at and b.ends_at > a.starts_at
    where a.schedule_version_id = selected_version_id
  ) then
    raise exception 'Resolve overlapping blocks on the same floor before publishing.';
  end if;
  if exists (
    select 1 from public.event_competition_schedule_blocks b
    where b.schedule_version_id = selected_version_id and b.block_type = 'competition'
      and not exists (select 1 from public.event_competition_schedule_block_contests a where a.block_id = b.id)
  ) then
    raise exception 'Every competition block must include at least one competition event.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text || ':publication'));
  select coalesce(max(publication_number), 0) + 1 into next_publication_number
  from public.event_competition_schedule_publications where event_id = selected_event_id;
  publication_snapshot := public.build_competition_schedule_snapshot(selected_version_id);

  update public.event_competition_schedule_versions
  set status = 'superseded', updated_at = now()
  where event_id = selected_event_id and status in ('published', 'live');

  update public.event_competition_schedule_versions
  set status = 'published', published_at = now(), published_by = auth.uid(), updated_at = now()
  where id = selected_version_id;

  insert into public.event_competition_schedule_publications (
    event_id, schedule_version_id, publication_number, snapshot, snapshot_checksum, published_by
  ) values (
    selected_event_id, selected_version_id, next_publication_number, publication_snapshot,
    encode(digest(convert_to(publication_snapshot::text, 'UTF8'), 'sha256'), 'hex'), auth.uid()
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.build_competition_schedule_snapshot(selected_version_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'version', jsonb_build_object('id', v.id, 'event_id', v.event_id, 'version_number', v.version_number, 'name', v.name),
    'sessions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id, 'name', s.name, 'session_date', s.session_date,
          'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'blocks', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', b.id, 'name', b.name, 'block_type', b.block_type,
                'starts_at', b.starts_at, 'ends_at', b.ends_at,
                'floor_name', b.floor_name_snapshot, 'floor_capacity', b.floor_capacity_snapshot,
                'contests', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'contest_id', a.contest_id, 'contest_name', c.name,
                    'planned_round_type', a.planned_round_type, 'sort_order', a.sort_order
                  ) order by a.sort_order, c.name)
                  from public.event_competition_schedule_block_contests a
                  join public.event_competition_contests c on c.id = a.contest_id
                  where a.block_id = b.id
                ), '[]'::jsonb)
              ) order by b.starts_at, b.sort_order, b.id
            ) from public.event_competition_schedule_blocks b where b.session_id = s.id
          ), '[]'::jsonb)
        ) order by s.starts_at, s.sort_order, s.id
      ) from public.event_competition_schedule_sessions s where s.schedule_version_id = v.id
    ), '[]'::jsonb),
    -- 10D: numbered floor heats (SIMPLE planning); empty for time-block (ADVANCED) schedules.
    'floor_heats', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', f.id, 'heat_number', f.heat_number, 'floor_id', f.floor_id, 'floor_name', fl.name,
          'planned_start_at', f.planned_start_at, 'planned_duration_seconds', f.planned_duration_seconds,
          'scoring_heats', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'heat_id', h.id, 'contest_id', h.contest_id, 'division_id', h.division_id, 'division_name', dv.name,
                'round_id', h.round_id, 'round_name', rd.name, 'round_type', rd.round_type,
                'heat_number', h.heat_number, 'name', h.name,
                'dances', coalesce((
                  select jsonb_agg(jsonb_build_object('dance_id', hd.dance_id, 'dance_key', hd.dance_key, 'dance_label', hd.dance_label)
                    order by hd.sequence_number)
                  from public.event_competition_heat_dances hd where hd.heat_id = h.id and hd.status <> 'cancelled'
                ), '[]'::jsonb),
                'entries', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'entry_id', e.id, 'entry_number', e.entry_number, 'display_name', e.display_name,
                      'floor_order', he.floor_order, 'status', he.status,
                      'competitors', coalesce((
                        select jsonb_agg(jsonb_build_object(
                          'competitor_id', p.competitor_id, 'name', p.display_name,
                          'participant_role', p.participant_role, 'dance_role', p.dance_role
                        ) order by p.sort_order, p.id)
                        from public.event_competition_entry_participants p where p.entry_id = e.id
                      ), '[]'::jsonb)
                    ) order by he.floor_order, e.id)
                  from public.event_competition_heat_entries he
                  join public.event_competition_entries e on e.id = he.entry_id
                  where he.heat_id = h.id
                ), '[]'::jsonb)
              ) order by h.created_at, h.id)
            from public.event_competition_heats h
            join public.event_competition_divisions dv on dv.id = h.division_id
            join public.event_competition_rounds rd on rd.id = h.round_id
            where h.floor_heat_id = f.id and h.status <> 'cancelled'
          ), '[]'::jsonb)
        ) order by f.heat_number)
      from public.event_competition_floor_heats f
      left join public.event_competition_schedule_floors fl on fl.id = f.floor_id
      where f.schedule_version_id = v.id
    ), '[]'::jsonb),
    'heats', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', h.id, 'contest_id', h.contest_id, 'division_id', h.division_id,
          'round_id', h.round_id, 'block_id', h.schedule_block_id,
          'heat_number', h.heat_number, 'name', h.name,
          'scheduled_at', h.scheduled_at, 'estimated_ends_at', h.estimated_ends_at,
          'duration_seconds', h.duration_seconds, 'schedule_sequence', h.schedule_sequence,
          'floor_id', h.floor_id, 'floor_label', h.floor_label, 'status', h.status,
          'lock_state', h.lock_state,
          'dances', coalesce((
            select jsonb_agg(jsonb_build_object(
              'dance_id', d.dance_id, 'dance_key', d.dance_key, 'dance_label', d.dance_label,
              'sequence_number', d.sequence_number, 'duration_seconds', d.duration_seconds
            ) order by d.sequence_number)
            from public.event_competition_heat_dances d where d.heat_id = h.id and d.status <> 'cancelled'
          ), '[]'::jsonb),
          'entries', coalesce((
            select jsonb_agg(jsonb_build_object(
              'entry_id', he.entry_id, 'floor_order', he.floor_order, 'status', he.status
            ) order by he.floor_order, he.entry_id)
            from public.event_competition_heat_entries he where he.heat_id = h.id
          ), '[]'::jsonb)
        ) order by h.scheduled_at, h.schedule_sequence, h.id
      ) from public.event_competition_heats h
      where h.schedule_version_id = v.id and h.status <> 'cancelled'
    ), '[]'::jsonb)
  )
  from public.event_competition_schedule_versions v
  where v.id = selected_version_id;
$function$
;

CREATE OR REPLACE FUNCTION public.create_competition_schedule_version(selected_event_id uuid, selected_name text DEFAULT NULL::text, source_version_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  next_number integer;
  new_version_id uuid;
  source_session record;
  source_block record;
  new_session_id uuid;
  new_block_id uuid;
begin
  if not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Not authorized to manage this competition.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text));
  select coalesce(max(version_number), 0) + 1 into next_number
  from public.event_competition_schedule_versions where event_id = selected_event_id;

  if source_version_id is not null and not exists (
    select 1 from public.event_competition_schedule_versions
    where id = source_version_id and event_id = selected_event_id
  ) then
    raise exception 'Source schedule version does not belong to this event.';
  end if;

  insert into public.event_competition_schedule_versions (
    event_id, version_number, name, based_on_version_id, created_by
  ) values (
    selected_event_id,
    next_number,
    coalesce(nullif(btrim(selected_name), ''), 'Schedule v' || next_number),
    source_version_id,
    auth.uid()
  ) returning id into new_version_id;

  if source_version_id is not null then
    for source_session in
      select * from public.event_competition_schedule_sessions
      where schedule_version_id = source_version_id order by starts_at, sort_order
    loop
      insert into public.event_competition_schedule_sessions (
        event_id, schedule_version_id, name, session_date, starts_at, ends_at, sort_order, notes
      ) values (
        selected_event_id, new_version_id, source_session.name, source_session.session_date,
        source_session.starts_at, source_session.ends_at, source_session.sort_order, source_session.notes
      ) returning id into new_session_id;

      for source_block in
        select * from public.event_competition_schedule_blocks
        where session_id = source_session.id order by starts_at, sort_order
      loop
        insert into public.event_competition_schedule_blocks (
          event_id, schedule_version_id, session_id, floor_id, name, block_type,
          starts_at, ends_at, sort_order, configuration
        ) values (
          selected_event_id, new_version_id, new_session_id, source_block.floor_id,
          source_block.name, source_block.block_type, source_block.starts_at, source_block.ends_at,
          source_block.sort_order, source_block.configuration
        ) returning id into new_block_id;

        insert into public.event_competition_schedule_block_contests (
          event_id, schedule_version_id, block_id, contest_id, planned_round_type, sort_order, constraints
        )
        select selected_event_id, new_version_id, new_block_id, contest_id,
          planned_round_type, sort_order, constraints
        from public.event_competition_schedule_block_contests
        where block_id = source_block.id;
      end loop;
    end loop;
  end if;

  -- 10D: a new version based on a SIMPLE (floor-heat) schedule starts as an editable copy of its running order.
  if source_version_id is not null then
    perform public._comp10d_copy_floor_plan(source_version_id, new_version_id);
  end if;

  return new_version_id;
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 8. Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'comp10d_heat_entry_floor_integrity' and tgdeferrable and tginitdeferred) then
    raise exception '10D postflight: deferred integrity trigger missing.';
  end if;
  if exists (select 1 from pg_constraint where conname = 'event_competition_heats_round_id_heat_number_key') then
    raise exception '10D postflight: old round/heat-number uniqueness still present.';
  end if;
end $$;

commit;
