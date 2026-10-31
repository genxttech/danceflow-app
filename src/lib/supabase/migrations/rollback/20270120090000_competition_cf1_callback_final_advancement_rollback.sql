-- Rollback for 20270120090000_competition_cf1_callback_final_advancement.sql (CF1 package A0).
-- Order: the CF1 packages roll back newest first (A6, A5, A3, A2, A4a, then this file, then A1); CF1 as a whole before HL1.
-- ROLL-FORWARD ONLY once an advancement, capacity-event or Final-withdrawal row exists: those rows are evidence.
-- Restores the pinned texts of the seven functions A0 redefined (md5 verified), the result-events kind check, and drops the CF1 core.
-- Rolling back also restores today's unaudited capacity editing (the pre-CF1 behaviour), by design.

begin;

lock table public.event_competition_round_advancements, public.event_competition_round_capacity_events, public.event_competition_final_withdrawals in access exclusive mode;

do $$
declare
  v_names constant text[] := array[
    '_cf1_callback_successor', '_cf1_callback_source', '_cf1_has_advancement', '_cf1_active_advancement', '_cf1_withdrawn_entries',
    '_cf1_auth_apply', '_cf1_auth_apply_heat', '_cf1_auth_apply_floor_heat', '_cf1_auth_revoke', '_cf1_auth_cancel', '_cf1_reason_is_substantive',
    '_cf1_callback_target_check', 'cf1_guard_callback_target_capacity', 'cf1_guard_callback_target_program_lock', 'cf1_guard_round_capacity',
    'set_competition_round_heat_capacity', 'cf1_guard_final_heat_insert', 'cf1_guard_final_heat_status', 'cf1_guard_final_heat_identity',
    'cf1_guard_final_heat_entry', 'cf1_guard_final_heat_dance', 'cf1_check_final_single_live_heat', 'cf1_check_one_active_advancement',
    'cf1_guard_publish_final_heats', 'cf1_guard_final_start', 'cf1_guard_advancement_approval', '_cf1_revoke_advancement',
    'cf1_guard_advancement_correction', 'competition_round_advancement_preview', 'apply_competition_round_advancement',
    'complete_competition_round', 'competition_audit_log', '_comp10d_copy_floor_plan', '_comp10d_guard_floor_heat', '_comp10d_guard_heat_child',
    'validate_competition_heat_schedule_placement'];
  v_user text;
begin
  if exists (select 1 from public.event_competition_round_advancements)
     or exists (select 1 from public.event_competition_round_capacity_events)
     or exists (select 1 from public.event_competition_final_withdrawals) then
    raise exception 'CF1-A0 rollback refused: advancement / capacity-event / withdrawal rows exist (append-only evidence); roll forward.';
  end if;
  if exists (select 1 from public.event_competition_result_events e where e.kind in ('advancement_applied', 'advancement_revoked')) then
    raise exception 'CF1-A0 rollback refused: advancement audit events exist; roll forward.';
  end if;
  select string_agg(distinct p.oid::regprocedure::text, ', ') into v_user
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where p.proname <> all (v_names)
    and (exists (select 1 from unnest(v_names) f where f like '%cf1%' and f not like '\_cf1\_%' and p.prosrc like '%' || f || '%')
         or exists (select 1 from unnest(v_names) f where f like '\_cf1\_%' and f <> '_cf1_reason_is_substantive' and p.prosrc like '%' || f || '%'
                    and p.proname not like '\_cf1\_%')
         or p.prosrc like '%event_competition_round_advancement%' or p.prosrc like '%event_competition_final_withdrawals%'
         or p.prosrc like '%event_competition_round_capacity_events%');
  if v_user is not null then
    raise exception 'CF1-A0 rollback refused: still referenced by % (roll back the later CF1 packages first).', v_user;
  end if;
  if exists (select 1 from pg_constraint c
             where c.confrelid in ('public.event_competition_round_advancements'::regclass, 'public.event_competition_final_withdrawals'::regclass,
                                   'public.event_competition_round_capacity_events'::regclass)
               and c.conrelid::regclass::text not like 'event_competition_round_advancement%'
               and c.conrelid::regclass::text <> 'event_competition_final_withdrawals') then
    raise exception 'CF1-A0 rollback refused: another table references a CF1 core table.';
  end if;
end $$;

drop trigger cf1_guard_final_heat_insert on public.event_competition_heats;
drop trigger cf1_guard_final_heat_status on public.event_competition_heats;
drop trigger cf1_guard_final_heat_identity on public.event_competition_heats;
drop trigger cf1_check_final_single_live_heat on public.event_competition_heats;
drop trigger cf1_guard_final_heat_entry on public.event_competition_heat_entries;
drop trigger cf1_guard_final_heat_dance on public.event_competition_heat_dances;
drop trigger cf1_guard_publish_final_heats on public.event_competition_schedule_versions;
drop trigger cf1_guard_final_start on public.event_competition_rounds;
drop trigger cf1_guard_advancement_correction on public.event_competition_rounds;
drop trigger cf1_guard_round_capacity on public.event_competition_rounds;
drop trigger cf1_guard_callback_target_capacity on public.event_competition_rounds;
drop trigger cf1_guard_callback_target_program_lock on public.event_competition_programs;
drop trigger cf1_guard_advancement_approval on public.event_competition_result_versions;
drop trigger cf1_check_one_active_advancement on public.event_competition_round_advancements;

drop function public.set_competition_round_heat_capacity(uuid, integer, text, uuid);

-- Restore the pinned function texts (as installed before A0).

-- complete_competition_round
CREATE OR REPLACE FUNCTION public.complete_competition_round(p_round_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_ver public.event_competition_result_versions;
  v_pub boolean := false;
begin
  if v_uid is null or v_role is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'round_state_changed' and v_prev.to_state = 'complete' and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', 'complete');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'published' then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: only a published round can be completed (round is %).', v_round.status using errcode = 'P0001';
  end if;

  -- Publication precondition (fail closed): an unknown publication shape or table is a refusal, never a pass.
  if to_regclass('public.event_competition_result_publications') is null then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: publication (F3) is not installed, so a published result cannot be verified; completion is refused.'
      using errcode = 'P0001';
  end if;
  begin
    execute 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1 and p.withdrawn_at is null and p.superseded_by is null)'
      into v_pub using p_round_id;
  exception when others then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: publication state could not be verified; completion is refused.' using errcode = 'P0001';
  end;
  if not coalesce(v_pub, false) then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: the round has no current publication.' using errcode = 'P0001';
  end if;

  select * into v_ver from public.event_competition_result_versions v
  where v.round_id = p_round_id and v.status = 'approved' order by v.version desc limit 1;
  if not found then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: the round has no approved result version.' using errcode = 'P0001';
  end if;
  -- Advancement (K0 section 6): its writer (apply_competition_round_advancement) is a later slice, so a round whose result
  -- advances any entry cannot complete yet.
  if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is true) then
    raise exception 'COMP_ADVANCEMENT_NOT_APPROVED: this result advances entries and advancement has not been applied; completion is refused.' using errcode = 'P0001';
  end if;

  perform public._compf2_event(v_round.event_id, p_round_id, v_ver.id, 'round_state_changed', v_uid, 'published', 'complete', p_request_id, null,
    jsonb_build_object('version', v_ver.version, 'actor_role', v_role));
  update public.event_competition_rounds set status = 'complete', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'complete');
end;
$function$;

-- competition_audit_log
CREATE OR REPLACE FUNCTION public.competition_audit_log(p_event_id uuid, p_round_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 200)
 RETURNS TABLE(occurred_at timestamp with time zone, source text, kind text, actor_user_id uuid, round_id uuid, from_state text, to_state text, reason text, refs jsonb, record_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_o1 text := '';
begin
  if auth.uid() is null or p_event_id is null or not public.can_manage_event_competition(p_event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  -- O1 (round transitions) sorts after F2 in the slot order, so its branch exists only when its table does.
  if to_regclass('public.event_competition_round_transition_events') is not null then
    v_o1 := 'union all
    select t.created_at, ''round'', t.kind, t.actor, t.round_id, t.from_state, t.to_state, t.reason,
           t.refs || jsonb_build_object(''heat_id'', t.heat_id), t.id
    from public.event_competition_round_transition_events t
    where t.event_id = $1 and ($2 is null or t.round_id = $2)';
  end if;
  return query execute '
  select u.occurred_at, u.source, u.kind, u.actor_user_id, u.round_id, u.from_state, u.to_state, u.reason, u.refs, u.record_id
  from (
    select e.occurred_at, ''results''::text as source, e.kind, e.actor_user_id, e.round_id, e.from_state, e.to_state, e.reason,
           e.refs || jsonb_build_object(''result_version_id'', e.result_version_id) as refs, e.id as record_id
    from public.event_competition_result_events e
    where e.event_id = $1 and ($2 is null or e.round_id = $2)
    union all
    select b.occurred_at, ''ballots'', b.kind, b.actor_user_id, b.round_id, b.from_state, b.to_state, b.reason,
           b.refs || jsonb_build_object(''heat_id'', b.heat_id, ''official_id'', b.official_id, ''ballot_id'', b.ballot_id), b.id
    from public.event_competition_ballot_events b
    where b.event_id = $1 and ($2 is null or b.round_id = $2)
    union all
    select o.occurred_at, ''officials'', o.kind, o.actor_user_id, o.round_id, null::text, null::text, o.reason,
           o.refs || jsonb_build_object(''official_id'', o.official_id), o.id
    from public.event_competition_official_events o
    where o.event_id = $1 and ($2 is null or o.round_id = $2)
    ' || v_o1 || '
  ) u
  order by u.occurred_at desc, u.source, u.record_id
  limit ' || least(greatest(coalesce(p_limit, 200), 1), 1000)::text using p_event_id, p_round_id;
end;
$function$;

-- _comp10d_copy_floor_plan
CREATE OR REPLACE FUNCTION public._comp10d_copy_floor_plan(p_source_version_id uuid, p_new_version_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

-- _comp10d_guard_floor_heat
CREATE OR REPLACE FUNCTION public._comp10d_guard_floor_heat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

-- _comp10d_guard_heat_child
CREATE OR REPLACE FUNCTION public._comp10d_guard_heat_child()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

-- validate_competition_heat_schedule_placement
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
$function$;

-- set_competition_round_heat_capacity
CREATE OR REPLACE FUNCTION public.set_competition_round_heat_capacity(p_round_id uuid, p_capacity integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

do $$
declare
  v_pin record;
begin
  for v_pin in
    select * from (values
      ('public.complete_competition_round(uuid,uuid)',                          'dd0e1cd4c02bb51bbd75471c113a1f9f'),
      ('public.set_competition_round_heat_capacity(uuid,integer)',              '4fbc864079928710917ea67d7968d8bb'),
      ('public.competition_audit_log(uuid,uuid,integer)',                       'd38b87512d066907b37702addc6cd116'),
      ('public._comp10d_copy_floor_plan(uuid,uuid)',                            '8162a7341b7bcd00a141e81392c8c602'),
      ('public._comp10d_guard_floor_heat()',                                    'bd20973caffce985813daadde8be947a'),
      ('public._comp10d_guard_heat_child()',                                    '9bb78230385387a3c6a39e66f2d9f8d0'),
      ('public.validate_competition_heat_schedule_placement()',                 'f2079401a3a92c3289405547d2fe511b')
    ) as t(sig, pin)
  loop
    if md5(replace(pg_get_functiondef(v_pin.sig::regprocedure), E'\r', '')) <> v_pin.pin then
      raise exception 'CF1-A0 rollback: % did not restore to its pinned text.', v_pin.sig;
    end if;
  end loop;
end $$;

drop function public.apply_competition_round_advancement(uuid, uuid, uuid);
drop function public.competition_round_advancement_preview(uuid);
drop function public.cf1_guard_advancement_correction();
drop function public._cf1_revoke_advancement(uuid, text, text);
drop function public.cf1_guard_advancement_approval();
drop function public.cf1_guard_final_start();
drop function public.cf1_guard_publish_final_heats();
drop function public.cf1_check_one_active_advancement();
drop function public.cf1_check_final_single_live_heat();
drop function public.cf1_guard_final_heat_dance();
drop function public.cf1_guard_final_heat_entry();
drop function public.cf1_guard_final_heat_identity();
drop function public.cf1_guard_final_heat_status();
drop function public.cf1_guard_final_heat_insert();
drop function public.cf1_guard_round_capacity();
drop function public.cf1_guard_callback_target_program_lock();
drop function public.cf1_guard_callback_target_capacity();
drop function public._cf1_callback_target_check(integer, integer);
drop function public._cf1_reason_is_substantive(text);
drop function public._cf1_auth_cancel(uuid);
drop function public._cf1_auth_revoke(uuid);
drop function public._cf1_auth_apply_floor_heat(uuid, uuid, integer);
drop function public._cf1_auth_apply_heat(uuid);
drop function public._cf1_auth_apply(uuid);
drop function public._cf1_withdrawn_entries(uuid);
drop function public._cf1_active_advancement(uuid);
drop function public._cf1_has_advancement(uuid);
drop function public._cf1_callback_source(uuid);
drop function public._cf1_callback_successor(uuid);

drop table public.event_competition_round_capacity_events;
drop table public.event_competition_round_advancement_revocations;
drop table public.event_competition_round_advancement_heats;
drop table public.event_competition_round_advancement_entries;
drop table public.event_competition_round_advancements;
drop table public.event_competition_final_withdrawals;

alter table public.event_competition_result_events drop constraint event_competition_result_events_kind_check;
alter table public.event_competition_result_events add constraint event_competition_result_events_kind_check
  check (kind = any (array['round_state_changed', 'result_calculated', 'result_approved', 'result_approval_override', 'result_invalidated']));

commit;
