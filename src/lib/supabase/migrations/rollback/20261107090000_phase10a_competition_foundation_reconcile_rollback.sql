-- Rollback for 20261107090000_phase10a_competition_foundation_reconcile.sql
--
-- Reverts ONLY the Section B "NEW 10A HARDENING" changes and restores the exact reviewed
-- pre-10A definitions, policies, grants and FKs (pins re-checked in the postflight).
--
-- Section A "CAPTURED EXISTING OBJECTS" are NOT removed: the five schedule tables, their
-- constraints/indexes/policies/triggers/grants and create_competition_schedule_version
-- existed on DEV and PROD before 10A, so recording them in the repository must never make
-- a rollback drop them (or their data). validate_competition_schedule_item() is restored
-- to its exact deployed (pre-10A) body, not dropped.
--
-- Refuses, changing nothing, when:
--   * any heat lock event exists (it is audit evidence of an authorized override), or
--   * any entry history row references an entry or user that no longer exists (the
--     restored ON DELETE SET NULL FKs could not be re-validated without rewriting
--     evidence).
-- Roll the APPLICATION back first if it calls set_competition_heat_lock_state with a
-- reason argument (10A itself ships no such caller).

begin;

do $$
declare
  v_lock_events int;
  v_dangling int;
begin
  select count(*) into v_lock_events from public.event_competition_heat_lock_events;
  select count(*) into v_dangling
  from public.event_competition_entry_changes h
  where (h.entry_id is not null and not exists (select 1 from public.event_competition_entries e where e.id = h.entry_id))
     or (h.performed_by is not null and not exists (select 1 from auth.users u where u.id = h.performed_by));
  if v_lock_events > 0 or v_dangling > 0 then
    raise exception 'Phase 10A rollback refused: % heat lock events and % entry history rows with deleted entry/user references exist; they are audit evidence.',
      v_lock_events, v_dangling;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- B7. Pre-10A search_path
-- ---------------------------------------------------------------------------
alter function public.create_competition_generation_run(uuid, uuid, text, uuid)
  set search_path = public, pg_temp;
alter function public.create_competition_heat_plan_run(uuid, uuid, text, text, jsonb)
  set search_path = public, pg_temp;
alter function public.publish_competition_schedule_version(uuid)
  set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- B6. Exact deployed schedule validation body
-- ---------------------------------------------------------------------------
create or replace function public.validate_competition_schedule_item()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  item_event_id uuid;
  item_version_id uuid;
  item_session_id uuid;
  session_start timestamptz;
  session_end timestamptz;
  version_status text;
  selected_floor_name text;
  selected_floor_capacity integer;
begin
  item_event_id := coalesce(new.event_id, old.event_id);
  item_version_id := coalesce(new.schedule_version_id, old.schedule_version_id);
  item_session_id := coalesce(new.session_id, old.session_id);

  select status into version_status
  from public.event_competition_schedule_versions
  where id = item_version_id and event_id = item_event_id;

  if version_status is distinct from 'draft' then
    raise exception 'Only draft schedule versions may be edited.';
  end if;

  if tg_table_name = 'event_competition_schedule_blocks' and tg_op <> 'DELETE' then
    select starts_at, ends_at into session_start, session_end
    from public.event_competition_schedule_sessions
    where id = item_session_id and schedule_version_id = item_version_id and event_id = item_event_id;

    if new.starts_at < session_start or new.ends_at > session_end then
      raise exception 'Schedule block must be contained within its session.';
    end if;

    if new.floor_id is not null then
      select name, capacity into selected_floor_name, selected_floor_capacity
      from public.event_competition_schedule_floors
      where id = new.floor_id and event_id = item_event_id;
      new.floor_name_snapshot := selected_floor_name;
      new.floor_capacity_snapshot := selected_floor_capacity;
    else
      new.floor_name_snapshot := null;
      new.floor_capacity_snapshot := null;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- B5. Pre-10A grant posture
-- ---------------------------------------------------------------------------
grant execute on function public.apply_competition_configuration_template(uuid, text) to anon;
grant execute on function public.restart_event_competition_setup(uuid, text) to anon;
alter function public.restart_event_competition_setup(uuid, text) set search_path = public;
grant execute on function public.default_competition_registration_rule(uuid) to anon, authenticated;
grant execute on function public.create_default_competition_registration_rule() to public, anon, authenticated;
grant execute on function public.sync_competition_entries_from_registration() to anon, authenticated;
grant execute on function public.sync_competition_registration_cart_from_order() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- B4. Pre-10A can_manage_event_competition (20260620_competition_foundation_v1.sql)
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_event_competition(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.events e
    where e.id = target_event_id
      and (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.platform_role = 'platform_admin'
        )
        or e.created_by = auth.uid()
        or exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = e.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin')
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.organizer_id = e.organizer_id
            and ou.user_id = auth.uid()
            and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
        )
      )
  );
$$;
grant execute on function public.can_manage_event_competition(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- B3. Pre-10A heat lock (20260620_competition_generation_operations_v1.sql,
--     20260621_competition_heat_planning_v1.sql)
-- ---------------------------------------------------------------------------
drop function public.set_competition_heat_lock_state(uuid, text, text);

create function public.set_competition_heat_lock_state(
  selected_heat_id uuid,
  selected_state text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  heat_event_id uuid;
  current_state text;
begin
  if selected_state not in ('open', 'locked', 'certified') then
    raise exception 'Invalid heat lock state.';
  end if;

  select event_id, lock_state into heat_event_id, current_state
  from public.event_competition_heats where id = selected_heat_id;
  if heat_event_id is null or not public.can_manage_event_competition(heat_event_id) then
    raise exception 'Heat was not found or cannot be managed.';
  end if;
  if current_state = 'certified' and selected_state <> 'certified' then
    raise exception 'Certified heats require a formal correction workflow and cannot be reopened directly.';
  end if;

  perform set_config('app.competition_heat_override', 'on', true);
  update public.event_competition_heats
  set
    lock_state = selected_state,
    locked_at = case when selected_state in ('locked', 'certified') then coalesce(locked_at, now()) else null end,
    locked_by = case when selected_state in ('locked', 'certified') then coalesce(locked_by, auth.uid()) else null end,
    certified_at = case when selected_state = 'certified' then now() else null end,
    certified_by = case when selected_state = 'certified' then auth.uid() else null end,
    updated_at = now()
  where id = selected_heat_id;
end;
$$;
grant execute on function public.set_competition_heat_lock_state(uuid, text) to public, anon, authenticated, service_role;

create or replace function public.protect_locked_competition_heat()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.lock_state in ('locked', 'certified')
    and current_setting('app.competition_heat_override', true) is distinct from 'on' then
    raise exception 'Locked or certified heats require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
grant execute on function public.protect_locked_competition_heat() to public, anon, authenticated, service_role;

create or replace function public.protect_locked_competition_heat_children()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_heat_id uuid;
  selected_lock_state text;
begin
  selected_heat_id := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  select lock_state into selected_lock_state
  from public.event_competition_heats where id = selected_heat_id;
  if selected_lock_state in ('locked', 'certified')
    and current_setting('app.competition_heat_override', true) is distinct from 'on' then
    raise exception 'Locked or certified heat details require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop table public.event_competition_heat_lock_events;

-- ---------------------------------------------------------------------------
-- B2. Pre-10A entry history posture
-- ---------------------------------------------------------------------------
drop trigger protect_competition_entry_change_history on public.event_competition_entry_changes;
drop trigger protect_competition_entry_change_history_truncate on public.event_competition_entry_changes;
drop function public.protect_competition_history_evidence();

-- Exact deployed body (20260620_competition_generation_operations_v1.sql), SECURITY INVOKER.
create or replace function public.audit_competition_entry_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_type text;
  selected_reason text;
  selected_fee_handling text;
begin
  selected_reason := nullif(current_setting('app.competition_entry_change_reason', true), '');
  selected_fee_handling := coalesce(nullif(current_setting('app.competition_entry_fee_handling', true), ''), 'not_applicable');

  if tg_op = 'DELETE' then
    selected_type := coalesce(nullif(current_setting('app.competition_entry_change_type', true), ''), 'delete_error');
    insert into public.event_competition_entry_changes (
      event_id, entry_id, change_type, reason, fee_handling, previous_state, performed_by
    ) values (
      old.event_id, old.id, selected_type, selected_reason, selected_fee_handling, to_jsonb(old), auth.uid()
    );
    return old;
  end if;

  if new.status is distinct from old.status
    or new.division_id is distinct from old.division_id
    or new.program_id is distinct from old.program_id
    or new.eligibility_status is distinct from old.eligibility_status
    or new.late_entry is distinct from old.late_entry then
    selected_type := nullif(current_setting('app.competition_entry_change_type', true), '');
    if selected_type is null then
      selected_type := case
        when new.status = 'scratched' then 'scratch'
        when new.status = 'withdrawn' then 'withdraw'
        when new.division_id is distinct from old.division_id or new.program_id is distinct from old.program_id then 'move_entry'
        when new.eligibility_status is distinct from old.eligibility_status then 'eligibility_change'
        when new.late_entry and not old.late_entry then 'late_entry'
        else 'status_change'
      end;
    end if;

    insert into public.event_competition_entry_changes (
      event_id, entry_id, change_type, reason, fee_handling,
      previous_state, resulting_state, performed_by
    ) values (
      new.event_id, new.id, selected_type, selected_reason, selected_fee_handling,
      to_jsonb(old), to_jsonb(new), auth.uid()
    );
  end if;
  return new;
end;
$$;
grant execute on function public.audit_competition_entry_change() to public, anon, authenticated, service_role;

grant all on public.event_competition_entry_changes to anon, authenticated, service_role;
create policy competition_history_insert on public.event_competition_entry_changes
  for insert to authenticated with check (public.can_manage_event_competition(event_id));

alter table public.event_competition_entry_changes
  add constraint event_competition_entry_changes_entry_id_fkey
  foreign key (entry_id) references public.event_competition_entries(id) on delete set null;
alter table public.event_competition_entry_changes
  add constraint event_competition_entry_changes_performed_by_fkey
  foreign key (performed_by) references auth.users(id) on delete set null;

comment on table public.event_competition_entry_changes is
  'Attributed history distinguishing scratch, withdrawal, erroneous deletion, late entry, and movement.';

-- ---------------------------------------------------------------------------
-- B1. Pre-10A public catalog policies (20260621_competition_registration_cart_foundation_v1.sql)
-- ---------------------------------------------------------------------------
drop policy if exists competition_contests_public_registration_read on public.event_competition_contests;
create policy competition_contests_public_registration_read on public.event_competition_contests
  for select to public using (
    status = 'open' and exists (
      select 1 from public.event_competition_contest_registration_rules r
      where r.contest_id = id and r.registration_open
    )
  );
drop policy if exists competition_divisions_public_registration_read on public.event_competition_divisions;
create policy competition_divisions_public_registration_read on public.event_competition_divisions
  for select to public using (
    status = 'open' and exists (
      select 1 from public.event_competition_contest_registration_rules r
      where r.contest_id = contest_id and r.registration_open
    )
  );
drop policy if exists competition_dances_public_registration_read on public.event_competition_dances;
create policy competition_dances_public_registration_read on public.event_competition_dances
  for select to public using (
    active and exists (
      select 1 from public.event_competition_programs p
      where p.id = program_id and p.status in ('configured', 'active')
    )
  );
drop policy if exists competition_division_dances_public_registration_read on public.event_competition_division_dances;
create policy competition_division_dances_public_registration_read on public.event_competition_division_dances
  for select to public using (
    active and exists (
      select 1 from public.event_competition_divisions d
      join public.event_competition_contest_registration_rules r on r.contest_id = d.contest_id
      where d.id = division_id and d.status = 'open' and r.registration_open
    )
  );

-- ---------------------------------------------------------------------------
-- Postflight: the exact reviewed pre-10A pins
-- ---------------------------------------------------------------------------
do $$
declare
  v_key text;
  v_expected text;
  v_actual text;
begin
  for v_key, v_expected in
    select * from (values
      ('audit_competition_entry_change()', '93bfe9c01797421a4c7315183505c38d'),
      ('protect_locked_competition_heat()', '0b4a5061cdee9da37cbf25cacab8e05d'),
      ('protect_locked_competition_heat_children()', 'ca203897c7f2a954317e96fae279e533'),
      ('set_competition_heat_lock_state(selected_heat_id uuid, selected_state text)', '4d6eb01fd4168ec20a7d49b11f2be1c0'),
      ('can_manage_event_competition(target_event_id uuid)', '64c046569d9bbb183ca514643595e3a7'),
      ('validate_competition_schedule_item()', '12e32eea6529b5fef6fceabbf0e0e1cd'),
      ('create_competition_schedule_version(selected_event_id uuid, selected_name text, source_version_id uuid)', 'd8b91e2db9b24119e6b485ed26941c86')
    ) as pins(k, v)
  loop
    select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = v_key;
    if v_actual is distinct from v_expected then
      raise exception 'Phase 10A rollback postflight: % body is %, expected %.', v_key, coalesce(v_actual, 'missing'), v_expected;
    end if;
  end loop;

  for v_key, v_expected in
    select * from (values
      ('event_competition_contests.competition_contests_public_registration_read', '3ed9e4942c58943f43ba236ca772cf08'),
      ('event_competition_divisions.competition_divisions_public_registration_read', 'c7b082d7a0c78932141b3da717e39ae3'),
      ('event_competition_dances.competition_dances_public_registration_read', '3a6a5b4daf22f466597735943751e581'),
      ('event_competition_division_dances.competition_division_dances_public_registration_read', 'cbf7db4f647a5265d763d843067477df'),
      ('event_competition_entry_changes.competition_history_insert', 'e070aca9432ca6fed68f64ff28db5543')
    ) as pins(k, v)
  loop
    select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) into v_actual
    from pg_policies where schemaname = 'public' and tablename || '.' || policyname = v_key;
    if v_actual is distinct from v_expected then
      raise exception 'Phase 10A rollback postflight: policy % is %, expected %.', v_key, coalesce(v_actual, 'missing'), v_expected;
    end if;
  end loop;

  if to_regclass('public.event_competition_schedule_versions') is null
     or to_regclass('public.event_competition_schedule_block_contests') is null then
    raise exception 'Phase 10A rollback postflight: captured schedule tables must remain.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
