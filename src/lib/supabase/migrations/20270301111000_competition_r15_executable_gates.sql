-- Competition S4 / R-15 -- executable gates (slot 20270301111000). Requires 20270301110000. BEHAVIOR CHANGE on dark Competition OS features; no data change.
--
-- Provisional planning stays possible; EXECUTION requires clearance. One predicate, wired once per gate:
--   * _cf1_entry_unavailable_reason (predicate P, shared by roster builders, lock, calculate, approve, F3 publish, advancement preview/apply,
--     callback Final start, A5 exclusion, A6 reinstatement, OD-17 M1 and the OD-17 gates) becomes coalesce(old P, clearance). Same signature and owner,
--     so every caller picks up the clearance with no rewrite: unverified, needs_review, unclear waived/eligible, stale and age-unestablished entries are
--     now "unavailable" for those executable stages. A5 therefore accepts a not-cleared couple that danced (reason kind 'other'), which removes the
--     lock/calculate/approve freeze the review found.
--   * OD-17 M2 (cf1_od17_guard_heat_entry, placement) keeps the LENIENT test (_r15_entry_availability_reason): provisional placement is allowed.
--   * NEW triggers (unconditional): round start, heat staging/active (floor call), schedule-version publish/live (INSERT and UPDATE), and a placement-context
--     / floor-state guard on heat entries: a provisional entry may be placed only in a draft/review schedule version (or a legacy draft/scheduled heat of a draft/scheduled round), and cannot be
--     checked in or marked danced.
-- Not changed: 10D/10D.1 placement checks, withdrawal, scratch, no-show, registration, reopen/correction edges.
--
-- Rollback: rollback/20270301111000_competition_r15_executable_gates_rollback.sql (never refuses).

begin;

do $$
declare
  v_def text;
begin
  if to_regprocedure('public._r15_entry_clearance_reason(uuid)') is null or to_regprocedure('public._r15_entry_availability_reason(uuid)') is null then
    raise exception 'R15 gates preflight: 20270301110000 (core) is not applied.';
  end if;
  if to_regprocedure('public.cf1_od17_guard_heat_entry()') is null or to_regprocedure('public._compe2_round_entries(uuid)') is null
     or to_regprocedure('public._cf1_entry_unavailable(uuid)') is null then
    raise exception 'R15 gates preflight: CF1/E2 objects are missing.';
  end if;
  -- _cf1_entry_unavailable_reason must still be the RB3 shape (refund-evidence tail), not an already-modified body.
  v_def := pg_get_functiondef('public._cf1_entry_unavailable_reason(uuid)'::regprocedure);
  if position('_cf1_entry_refund_evidence_reason' in v_def) = 0 or position('_r15_' in v_def) > 0 then
    raise exception 'R15 gates preflight: _cf1_entry_unavailable_reason is not the expected RB3 body; coordinate before changing it.';
  end if;
end $$;

-- Preflight report (counts only, no identifiers): provisional entries that sit in heats, by round status, and in published/live versions.
do $$
declare
  v_rep jsonb;
  v_bad integer;
begin
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_rep from (
    select coalesce(r.status, 'no_round') k, count(distinct he.entry_id) n
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id
    left join public.event_competition_rounds r on r.id = h.round_id
    where he.status <> 'scratched' and public._r15_entry_clearance_reason(he.entry_id) is not null
    group by 1) q;
  raise notice 'R15 gates preflight: provisional (not cleared) entries placed in heats by round status: %', v_rep;
  select count(distinct he.entry_id) into v_bad
  from public.event_competition_heat_entries he
  join public.event_competition_heats h on h.id = he.heat_id
  join public.event_competition_schedule_versions v on v.id = h.schedule_version_id
  where he.status <> 'scratched' and v.status in ('published', 'live') and public._r15_entry_clearance_reason(he.entry_id) is not null;
  raise notice 'R15 gates preflight: provisional entries placed in published/live schedule versions: %', v_bad;
  -- Refuse only where OD-17 enforcement is already ON and a not-cleared couple would be stranded in a running round.
  if to_regclass('public.competition_cf1_od17_enforcement') is not null then
    select count(*) into v_bad
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id
    join public.event_competition_rounds r on r.id = h.round_id
    join public.competition_cf1_od17_enforcement o on o.event_id = he.event_id and o.enabled
    where he.status <> 'scratched' and r.status in ('active', 'ballots_locked', 'calculated', 'approved', 'published')
      and public._r15_entry_clearance_reason(he.entry_id) is not null;
    if v_bad > 0 then
      raise exception 'R15 gates preflight: % heat placement(s) of not-cleared entries sit in running rounds of OD-17-enforced events; clear or withdraw them first.', v_bad;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Predicate P becomes strict (same signature, same owner, grants preserved by CREATE OR REPLACE)
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public._cf1_entry_unavailable_reason(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public._r15_entry_availability_reason(p_entry_id), public._r15_entry_clearance_reason(p_entry_id));
$$;
revoke all on function public._cf1_entry_unavailable_reason(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. OD-17 M2 placement keeps the lenient availability test (provisional placement is allowed by R-15)
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_old constant text := 'public._cf1_entry_unavailable_reason(new.entry_id)';
  v_new constant text := 'public._r15_entry_availability_reason(new.entry_id)';
begin
  v_def := replace(pg_get_functiondef('public.cf1_od17_guard_heat_entry()'::regprocedure), E'\r', '');
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'R15 gates: cf1_od17_guard_heat_entry does not contain exactly one %; refusing to patch.', v_old;
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. New unconditional gates
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public.r15_raise_not_cleared(p_stage text, p_ids uuid[], p_ref jsonb)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_bad jsonb;
begin
  select jsonb_agg(jsonb_build_object('entry_id', x.id, 'reason', x.reason) order by x.id) into v_bad
  from (select e.id, public._r15_entry_clearance_reason(e.id) as reason
        from public.event_competition_entries e
        where e.id = any (coalesce(p_ids, '{}'::uuid[])) and e.status not in ('withdrawn', 'scratched', 'disqualified')) x
  where x.reason is not null;
  if v_bad is not null then
    raise exception 'COMP_R15_ENTRY_NOT_CLEARED: % entr% not cleared by the organizer and cannot take part in this step.', jsonb_array_length(v_bad), case when jsonb_array_length(v_bad) = 1 then 'y is' else 'ies are' end
      using errcode = 'P0001', detail = (jsonb_build_object('stage', p_stage, 'entries', v_bad) || coalesce(p_ref, '{}'::jsonb))::text;
  end if;
end;
$$;
revoke all on function public.r15_raise_not_cleared(text, uuid[], jsonb) from public, anon, authenticated, service_role;

create function public.r15_guard_round_start()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.event_competition_entries e where e.id = any (public._compe2_round_entries(new.id)) order by e.id for share;
  perform public.r15_raise_not_cleared('start', public._compe2_round_entries(new.id), jsonb_build_object('round_id', new.id));
  return new;
end;
$$;
revoke all on function public.r15_guard_round_start() from public, anon, authenticated, service_role;
create trigger r15_guard_round_start
  before update of status on public.event_competition_rounds
  for each row when (old.status = 'scheduled' and new.status = 'active')
  execute function public.r15_guard_round_start();

create function public.r15_guard_heat_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(he.entry_id order by he.entry_id), '{}'::uuid[]) into v_ids
  from public.event_competition_heat_entries he where he.heat_id = new.id and he.status <> 'scratched';
  perform 1 from public.event_competition_entries e where e.id = any (v_ids) order by e.id for share;
  perform public.r15_raise_not_cleared('floor_call', v_ids, jsonb_build_object('heat_id', new.id));
  return new;
end;
$$;
revoke all on function public.r15_guard_heat_status() from public, anon, authenticated, service_role;
create trigger r15_guard_heat_status
  before update of status on public.event_competition_heats
  for each row when (new.status in ('staging', 'active') and old.status is distinct from new.status)
  execute function public.r15_guard_heat_status();

create function public.r15_guard_version_publish()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(distinct he.entry_id), '{}'::uuid[]) into v_ids
  from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
  where h.schedule_version_id = new.id and he.status <> 'scratched';
  begin
    perform public.r15_raise_not_cleared('publish_schedule', v_ids, jsonb_build_object('schedule_version_id', new.id));
  exception when sqlstate 'P0001' then
    if sqlerrm like 'COMP_R15_ENTRY_NOT_CLEARED:%' then
      raise exception 'COMP_R15_PROVISIONAL_ASSIGNMENT: the running order holds entries that are not cleared; clear, withdraw or scratch them before publishing.'
        using errcode = 'P0001';
    end if;
    raise;
  end;
  return new;
end;
$$;
revoke all on function public.r15_guard_version_publish() from public, anon, authenticated, service_role;
create trigger r15_guard_version_publish
  before insert or update of status on public.event_competition_schedule_versions
  for each row when (new.status in ('published', 'live'))
  execute function public.r15_guard_version_publish();

-- A provisional entry may be PLACED only in an editable context, and cannot enter floor states. Cleared entries are unaffected.
create function public.r15_guard_heat_entry_clearance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ctx record;
  v_changed boolean;
begin
  if new.status = 'scratched' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_changed := new.entry_id is distinct from old.entry_id or new.heat_id is distinct from old.heat_id or old.status = 'scratched'
                 or (new.status in ('checked_in', 'danced', 'disqualified') and new.status is distinct from old.status);
    if not v_changed then
      return new;
    end if;
  end if;
  if public._r15_entry_clearance_reason(new.entry_id) is null then
    return new;
  end if;
  if new.status in ('checked_in', 'danced', 'disqualified') then
    perform public.r15_raise_not_cleared('floor_state', array[new.entry_id], jsonb_build_object('heat_id', new.heat_id));
  end if;
  select h.status as heat_status, r.status as round_status, v.status as version_status into v_ctx
  from public.event_competition_heats h
  left join public.event_competition_rounds r on r.id = h.round_id
  left join public.event_competition_schedule_versions v on v.id = h.schedule_version_id
  where h.id = new.heat_id;
  -- Editable context: a draft/review schedule version (its heats are planning copies even when the round is already running), or, for a
  -- legacy heat with no version, a draft/scheduled heat of a draft/scheduled round.
  if v_ctx.heat_status is null
     or not (coalesce(v_ctx.version_status, 'none') in ('draft', 'review')
             or (coalesce(v_ctx.version_status, 'none') = 'none' and v_ctx.heat_status in ('draft', 'scheduled') and coalesce(v_ctx.round_status, 'draft') in ('draft', 'scheduled'))) then
    perform public.r15_raise_not_cleared('place', array[new.entry_id], jsonb_build_object('heat_id', new.heat_id));
  end if;
  return new;
end;
$$;
revoke all on function public.r15_guard_heat_entry_clearance() from public, anon, authenticated, service_role;
create trigger r15_guard_heat_entry_clearance
  before insert or update of entry_id, heat_id, status on public.event_competition_heat_entries
  for each row execute function public.r15_guard_heat_entry_clearance();

-- Postflight
do $$
begin
  if public._cf1_entry_unavailable_reason(gen_random_uuid()) is distinct from 'entry_missing'
     or position('_r15_entry_availability_reason' in pg_get_functiondef('public.cf1_od17_guard_heat_entry()'::regprocedure)) = 0
     or (select count(*) from pg_trigger where tgname in ('r15_guard_round_start', 'r15_guard_heat_status', 'r15_guard_version_publish', 'r15_guard_heat_entry_clearance') and not tgisinternal and tgenabled <> 'D') <> 4
     or has_function_privilege('authenticated', 'public.r15_raise_not_cleared(text,uuid[],jsonb)', 'execute') then
    raise exception 'R15 gates postflight failed.';
  end if;
end $$;

commit;
