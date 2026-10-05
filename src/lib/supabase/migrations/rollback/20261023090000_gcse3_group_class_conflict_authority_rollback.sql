-- ============================================================================
-- ROLLBACK for 20261023090000_gcse3_group_class_conflict_authority.sql (GC-S1E-3).
--
-- Restores the released definitions of the four replaced functions verbatim (from
-- 20260910100000_gc1_4, 20261015090000_gcsb1 and 20261019090000_gcsc5), drops the two direct-write
-- triggers, then drops the new helpers. No table, column or data is touched; classes written under
-- S1E-3 remain ordinary rows. Roll the APPLICATION back first if the deployed app maps GCSE3_CONFLICT
-- (the older app simply shows its generic error for those refusals).
-- Also removes the objects of the review remediation 20261023090100 if present (its BEFORE ROW lock
-- triggers would otherwise call a helper this file drops), so this file alone fully rolls back GC-S1E-3.
-- ============================================================================

begin;

drop trigger if exists appointments_gcse3_lock_direct_class_insert on public.appointments;
drop trigger if exists appointments_gcse3_lock_direct_class_update on public.appointments;
drop function if exists public._gcse3_lock_direct_class_row();
drop trigger if exists appointments_gcse3_direct_class_schedule_insert on public.appointments;
drop trigger if exists appointments_gcse3_direct_class_schedule_update on public.appointments;

create or replace function public.create_group_class_appointment(
  p_studio_id uuid,
  p_instructor_id uuid,
  p_room_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_id uuid;
begin
  if not public._gc1_4_has_broad_studio_authority(p_studio_id) then
    raise exception 'Not authorized to create a group class for this studio.';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A group class requires a valid start and end time.';
  end if;

  insert into public.appointments (
    studio_id, instructor_id, room_id, appointment_type, title,
    starts_at, ends_at, client_id, status, created_by
  )
  values (
    p_studio_id, p_instructor_id, p_room_id, 'group_class'::public.appointment_type, p_title,
    p_starts_at, p_ends_at, null, 'scheduled'::appointment_status, auth.uid()
  )
  returning id into v_appointment_id;

  return v_appointment_id;
end;
$$;

revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from anon;
revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from service_role;
grant execute on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) to authenticated;

create or replace function public.create_group_class_series(
  p_studio_id uuid,
  p_client_request_id uuid,
  p_title text,
  p_description text,
  p_instructor_id uuid,
  p_room_id uuid,
  p_location_name text,
  p_roster_capacity integer,
  p_weekdays smallint[],
  p_interval_weeks integer,
  p_starts_on date,
  p_ends_on date,
  p_occurrence_count integer,
  p_local_start_time time,
  p_duration_minutes integer,
  p_skip_indices integer[] default null,
  p_publicly_discoverable boolean default false,
  p_self_enrollment_allowed boolean default false,
  p_accepted_funding_types text[] default null,
  p_direct_payment_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_location text := nullif(btrim(coalesce(p_location_name, '')), '');
  v_weekdays smallint[];
  v_skip integer[];
  v_timezone text;
  v_series_id uuid;
  v_existing public.group_class_series%rowtype;
  v_existing_skip integer[];
  v_generated_count integer;
  v_materialized integer;
  v_constraint text;
begin
  if not public._gc1_4_has_broad_studio_authority(p_studio_id) then
    raise exception 'GCSB1_UNAUTHORIZED: Not authorized to schedule classes for this studio.';
  end if;

  if p_client_request_id is null then
    raise exception 'GCSB1_INVALID_DEFINITION: A request id is required.';
  end if;
  if length(v_title) = 0 then
    raise exception 'GCSB1_INVALID_DEFINITION: A class title is required.';
  end if;
  if p_roster_capacity is not null and p_roster_capacity < 1 then
    raise exception 'GCSB1_INVALID_DEFINITION: Class capacity must be at least 1.';
  end if;

  -- Normalized definition (also what a replay is compared against).
  v_weekdays := case
    when p_weekdays is null or cardinality(p_weekdays) = 0 then p_weekdays
    else (select array_agg(distinct d order by d) from unnest(p_weekdays) as d)
  end;
  v_skip := coalesce((
    select array_agg(distinct s order by s) from unnest(coalesce(p_skip_indices, array[]::integer[])) as s
  ), array[]::integer[]);

  -- Serialize duplicate submissions of the same request.
  perform pg_advisory_xact_lock(hashtextextended('gcsb1:' || p_studio_id::text || ':' || p_client_request_id::text, 0));

  select * into v_existing
  from public.group_class_series
  where studio_id = p_studio_id and client_request_id = p_client_request_id;

  if found then
    select coalesce(array_agg(g.occurrence_index order by g.occurrence_index), array[]::integer[])
      into v_existing_skip
    from public._gcsb1_generate_series_occurrences(
      v_existing.timezone, v_existing.weekdays, v_existing.interval_weeks::integer, v_existing.starts_on,
      v_existing.ends_on, v_existing.occurrence_count, v_existing.local_start_time, v_existing.duration_minutes
    ) g
    where not exists (
      select 1 from public.appointments a
      where a.group_class_series_id = v_existing.id
        and a.series_occurrence_index = g.occurrence_index
    );

    if v_existing.title is not distinct from v_title
       and v_existing.description is not distinct from v_description
       and v_existing.default_instructor_id is not distinct from p_instructor_id
       and v_existing.default_room_id is not distinct from p_room_id
       and v_existing.default_location_name is not distinct from v_location
       and v_existing.default_roster_capacity is not distinct from p_roster_capacity
       and v_existing.weekdays is not distinct from v_weekdays
       and v_existing.interval_weeks is not distinct from p_interval_weeks::smallint
       and v_existing.starts_on is not distinct from p_starts_on
       and v_existing.ends_on is not distinct from p_ends_on
       and v_existing.occurrence_count is not distinct from p_occurrence_count
       and v_existing.local_start_time is not distinct from p_local_start_time
       and v_existing.duration_minutes is not distinct from p_duration_minutes
       and v_existing.publicly_discoverable is not distinct from coalesce(p_publicly_discoverable, false)
       and v_existing.self_enrollment_allowed is not distinct from coalesce(p_self_enrollment_allowed, false)
       and v_existing.accepted_funding_types is not distinct from p_accepted_funding_types
       and v_existing.direct_payment_amount is not distinct from p_direct_payment_amount
       and v_existing_skip is not distinct from v_skip
    then
      select count(*)::integer into v_materialized
      from public.appointments a where a.group_class_series_id = v_existing.id;

      return jsonb_build_object(
        'series_id', v_existing.id,
        'materialized_count', v_materialized,
        'replay', true
      );
    end if;

    raise exception 'GCSB1_IDEMPOTENCY_CONFLICT: This request was already used for a different class series.';
  end if;

  if p_instructor_id is not null then
    begin
      perform public._landmark1a_assert_assignable_instructor(p_studio_id, p_instructor_id);
    exception when raise_exception then
      raise exception 'GCSB1_INSTRUCTOR_UNASSIGNABLE: This instructor is not available for assignment.';
    end;
  end if;

  if p_room_id is not null and not exists (
    select 1 from public.rooms r where r.id = p_room_id and r.studio_id = p_studio_id
  ) then
    raise exception 'GCSB1_ROOM_INVALID: That room does not belong to this studio.';
  end if;

  select s.timezone into v_timezone from public.studios s where s.id = p_studio_id;

  -- Same generator as the preview; it validates the recurrence itself.
  select count(*)::integer into v_generated_count
  from public._gcsb1_generate_series_occurrences(
    v_timezone, v_weekdays, p_interval_weeks, p_starts_on, p_ends_on,
    p_occurrence_count, p_local_start_time, p_duration_minutes
  );

  if exists (select 1 from unnest(v_skip) as s where s is null or s < 1 or s > v_generated_count) then
    raise exception 'GCSB1_INVALID_SKIP: One of the skipped dates is not part of this schedule.';
  end if;
  if cardinality(v_skip) >= v_generated_count then
    raise exception 'GCSB1_NO_OCCURRENCES: Every class in this series was skipped.';
  end if;

  begin
    insert into public.group_class_series (
      studio_id, title, description, status, timezone, weekdays, interval_weeks,
      starts_on, ends_on, occurrence_count, local_start_time, duration_minutes,
      default_instructor_id, default_room_id, default_location_name, default_roster_capacity,
      publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount,
      created_by, client_request_id
    ) values (
      p_studio_id, v_title, v_description, 'active', v_timezone, v_weekdays, p_interval_weeks,
      p_starts_on, p_ends_on, p_occurrence_count, p_local_start_time, p_duration_minutes,
      p_instructor_id, p_room_id, v_location, p_roster_capacity,
      coalesce(p_publicly_discoverable, false), coalesce(p_self_enrollment_allowed, false),
      p_accepted_funding_types, p_direct_payment_amount,
      auth.uid(), p_client_request_id
    )
    returning id into v_series_id;
  exception
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint in (
        'group_class_series_funding_types_valid',
        'group_class_series_direct_payment_amount_positive',
        'group_class_series_direct_payment_requires_amount',
        'group_class_series_discovery_requires_funding'
      ) then
        raise exception 'GCSB1_POLICY_INVALID: The enrollment options are not valid.';
      end if;
      raise exception 'GCSB1_INVALID_DEFINITION: The class series details are not valid.';
    when unique_violation then
      -- Backstop for a concurrent duplicate that slipped past the advisory lock.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'uq_group_class_series_client_request' then
        raise exception 'GCSB1_IDEMPOTENCY_CONFLICT: This request is already being processed. Retry to see the result.';
      end if;
      raise;
  end;

  insert into public.appointments (
    studio_id, appointment_type, status, title, instructor_id, room_id, location_name,
    roster_capacity, starts_at, ends_at, client_id, created_by,
    group_class_series_id, series_occurrence_index, occurrence_original_start
  )
  select
    p_studio_id, 'group_class'::public.appointment_type, 'scheduled'::appointment_status,
    v_title, p_instructor_id, p_room_id, v_location,
    p_roster_capacity, g.starts_at, g.ends_at, null, auth.uid(),
    v_series_id, g.occurrence_index, g.starts_at
  from public._gcsb1_generate_series_occurrences(
    v_timezone, v_weekdays, p_interval_weeks, p_starts_on, p_ends_on,
    p_occurrence_count, p_local_start_time, p_duration_minutes
  ) g
  where g.occurrence_index <> all (v_skip)
  order by g.occurrence_index;

  get diagnostics v_materialized = row_count;

  begin
    insert into public.group_class_enrollment_policies (
      studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed,
      accepted_funding_types, direct_payment_amount, created_by
    )
    select
      a.studio_id, a.id, coalesce(p_publicly_discoverable, false), coalesce(p_self_enrollment_allowed, false),
      p_accepted_funding_types, p_direct_payment_amount, auth.uid()
    from public.appointments a
    where a.group_class_series_id = v_series_id;
  exception when check_violation then
    raise exception 'GCSB1_POLICY_INVALID: The enrollment options are not valid.';
  end;

  return jsonb_build_object(
    'series_id', v_series_id,
    'materialized_count', v_materialized,
    'replay', false
  );
end;
$$;

revoke all on function public.create_group_class_series(uuid, uuid, text, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer, integer[], boolean, boolean, text[], numeric) from public;
revoke all on function public.create_group_class_series(uuid, uuid, text, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer, integer[], boolean, boolean, text[], numeric) from anon;
revoke all on function public.create_group_class_series(uuid, uuid, text, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer, integer[], boolean, boolean, text[], numeric) from service_role;
grant execute on function public.create_group_class_series(uuid, uuid, text, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer, integer[], boolean, boolean, text[], numeric) to authenticated;

create or replace function public.edit_group_class_series_from(
  p_appointment_id uuid,
  p_client_request_id uuid,
  p_changes jsonb,
  p_overwrite boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio uuid;
  v_series uuid;
  v_index integer;
  v_now_series uuid;
  v_status text;
  v_hash text;
  v_ledger public.group_class_series_edit_requests%rowtype;
  v_overwrite boolean := coalesce(p_overwrite, false);
  v_fam record;
  v_anchor_cls text;
  v_has_earlier boolean;
  v_next uuid;
  v_new uuid;
  v_pred public.group_class_series%rowtype;
  v_defaults_changed boolean;
  v_check uuid[];
  v_id uuid;
  v_row record;
  v_reason text;
  v_edited integer;
  v_eligible integer;
  v_customized_kept integer;
  v_customized_overwritten integer;
  v_cancelled integer;
  v_historical integer;
  v_terminal integer;
  v_moved integer := 0;
  v_result jsonb;
begin
  if p_client_request_id is null then
    raise exception 'GCSC5_REQUEST_ID_REQUIRED: A request id is required.';
  end if;

  select a.group_class_series_id, a.series_occurrence_index, a.studio_id
    into v_series, v_index, v_studio
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio is null then
    raise exception 'GCSC5_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSC5_UNAUTHORIZED: Not authorized to edit classes in this series.';
  end if;

  if v_series is null then
    raise exception 'GCSC5_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  perform public._gcsc5_validate_changes(v_studio, p_changes);

  v_hash := md5(p_appointment_id::text || '|' || v_overwrite::text || '|' || p_changes::text);

  -- Serialize duplicate submissions of the same request, then replay or refuse.
  perform pg_advisory_xact_lock(hashtextextended('gcsc5:' || v_studio::text || ':' || p_client_request_id::text, 0));

  select * into v_ledger
    from public.group_class_series_edit_requests r
    where r.studio_id = v_studio and r.client_request_id = p_client_request_id;

  if found then
    if v_ledger.request_hash = v_hash then
      return v_ledger.result || jsonb_build_object('replay', true);
    end if;
    raise exception 'GCSC5_IDEMPOTENCY_CONFLICT: This request was already used for a different edit.';
  end if;

  -- Series-first locking. The selected class's series is read again once locked: a concurrent
  -- split may have moved the class into a successor, which is then locked too (predecessor ->
  -- successor order, the only order any path uses).
  for i in 1..4 loop
    perform 1 from public.group_class_series s where s.id = v_series for update;
    select a.group_class_series_id into v_now_series from public.appointments a where a.id = p_appointment_id;
    exit when v_now_series = v_series;
    v_series := v_now_series;
  end loop;

  if v_now_series is distinct from v_series then
    raise exception 'GCSC5_SERIES_NOT_EDITABLE: This series changed while it was being edited. Please try again.';
  end if;

  for v_fam in
    select f.series_id from public._gcsc5_series_family(v_series) f where f.depth > 0 order by f.depth
  loop
    perform 1 from public.group_class_series s where s.id = v_fam.series_id for update;
  end loop;

  select a.series_occurrence_index into v_index from public.appointments a where a.id = p_appointment_id;

  select s.status into v_status from public.group_class_series s where s.id = v_series;
  if v_status is distinct from 'active' then
    raise exception 'GCSC5_SERIES_NOT_EDITABLE: This series can no longer be edited.';
  end if;

  -- Lock every target occurrence row in index order (enrollment, attendance and single
  -- cancellation serialize on these rows), then plan against the locked state.
  perform 1
    from public.appointments a
    where a.group_class_series_id in (select f.series_id from public._gcsc5_series_family(v_series) f)
      and a.appointment_type = 'group_class'::public.appointment_type
      and a.series_occurrence_index >= v_index
    order by a.series_occurrence_index
    for update;

  select p.classification into v_anchor_cls
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, v_overwrite) p
    where p.appointment_id = p_appointment_id;

  if v_anchor_cls is distinct from 'eligible' then
    raise exception 'GCSC5_ANCHOR_NOT_EDITABLE: This class can no longer be edited with the classes that follow it.';
  end if;

  select
    count(*) filter (where p.will_edit),
    count(*) filter (where p.values_changed),
    count(*) filter (where p.customized and not v_overwrite),
    count(*) filter (where p.customized and v_overwrite),
    count(*) filter (where p.classification = 'cancelled'),
    count(*) filter (where p.classification = 'historical'),
    count(*) filter (where p.classification = 'terminal_attendance')
  into v_eligible, v_edited, v_customized_kept, v_customized_overwritten, v_cancelled, v_historical, v_terminal
  from public._gcsc5_edit_plan(p_appointment_id, p_changes, v_overwrite) p;

  select * into v_pred from public.group_class_series s where s.id = v_series;

  v_defaults_changed :=
       (p_changes ? 'title' and btrim(p_changes ->> 'title') is distinct from v_pred.title)
    or (p_changes ? 'instructor_id' and (p_changes ->> 'instructor_id')::uuid is distinct from v_pred.default_instructor_id)
    or (p_changes ? 'room_id' and (p_changes ->> 'room_id')::uuid is distinct from v_pred.default_room_id)
    or (p_changes ? 'location_name' and nullif(btrim(coalesce(p_changes ->> 'location_name', '')), '') is distinct from v_pred.default_location_name)
    or (p_changes ? 'roster_capacity' and (p_changes ->> 'roster_capacity')::integer is distinct from v_pred.default_roster_capacity)
    or (p_changes ? 'local_start_time' and (p_changes ->> 'local_start_time')::time is distinct from v_pred.local_start_time)
    or (p_changes ? 'duration_minutes' and (p_changes ->> 'duration_minutes')::integer is distinct from v_pred.duration_minutes);

  if v_edited = 0 and not v_defaults_changed then
    raise exception 'GCSC5_NO_CHANGES: Nothing would change.';
  end if;

  -- Occurrences whose instructor / room / time actually change (re-validated for conflicts below).
  select coalesce(array_agg(p.appointment_id order by p.occurrence_index), array[]::uuid[])
    into v_check
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, v_overwrite) p
    join public.appointments a on a.id = p.appointment_id
    where p.will_edit and p.changed
      and (p.new_instructor_id is distinct from a.instructor_id
           or p.new_room_id is distinct from a.room_id
           or p.new_starts_at is distinct from a.starts_at
           or p.new_ends_at is distinct from a.ends_at);

  -- Occurrence edits (definer writer: not tracked as user overrides; flags handled explicitly).
  update public.appointments a
     set title = p.new_title,
         instructor_id = p.new_instructor_id,
         room_id = p.new_room_id,
         location_name = p.new_location_name,
         roster_capacity = p.new_roster_capacity,
         starts_at = p.new_starts_at,
         ends_at = p.new_ends_at,
         series_overridden_fields = array(
           select f from unnest(a.series_overridden_fields) f where f <> all (p.cleared_groups)
         ),
         updated_at = now()
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, v_overwrite) p
   where a.id = p.appointment_id
     and p.will_edit and p.changed;

  -- Successor split (only when something earlier remains in the selected series).
  select exists (
    select 1 from public.appointments a
    where a.group_class_series_id = v_series and a.series_occurrence_index < v_index
  ) into v_has_earlier;

  if v_has_earlier then
    select s.id into v_next from public.group_class_series s where s.split_from_series_id = v_series;

    if v_next is not null then
      update public.group_class_series set split_from_series_id = null where id = v_next;
    end if;

    insert into public.group_class_series (
      studio_id, title, description, status, timezone, weekdays, interval_weeks,
      starts_on, ends_on, occurrence_count, local_start_time, duration_minutes,
      default_instructor_id, default_room_id, default_location_name, default_roster_capacity,
      publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount,
      created_by, split_from_series_id
    )
    select
      v_pred.studio_id,
      case when p_changes ? 'title' then btrim(p_changes ->> 'title') else v_pred.title end,
      v_pred.description, 'active', v_pred.timezone, v_pred.weekdays, v_pred.interval_weeks,
      m.first_day, m.last_day, null,
      case when p_changes ? 'local_start_time' then (p_changes ->> 'local_start_time')::time else v_pred.local_start_time end,
      case when p_changes ? 'duration_minutes' then (p_changes ->> 'duration_minutes')::integer else v_pred.duration_minutes end,
      case when p_changes ? 'instructor_id' then (p_changes ->> 'instructor_id')::uuid else v_pred.default_instructor_id end,
      case when p_changes ? 'room_id' then (p_changes ->> 'room_id')::uuid else v_pred.default_room_id end,
      case when p_changes ? 'location_name' then nullif(btrim(coalesce(p_changes ->> 'location_name', '')), '') else v_pred.default_location_name end,
      case when p_changes ? 'roster_capacity' then (p_changes ->> 'roster_capacity')::integer else v_pred.default_roster_capacity end,
      v_pred.publicly_discoverable, v_pred.self_enrollment_allowed, v_pred.accepted_funding_types, v_pred.direct_payment_amount,
      auth.uid(), v_series
    from (
      select min((a.occurrence_original_start at time zone v_pred.timezone)::date) as first_day,
             max((a.occurrence_original_start at time zone v_pred.timezone)::date) as last_day
      from public.appointments a
      where a.group_class_series_id = v_series and a.series_occurrence_index >= v_index
    ) m
    returning id into v_new;

    if v_next is not null then
      update public.group_class_series set split_from_series_id = v_new where id = v_next;
    end if;

    -- The predecessor now describes only what it still holds.
    update public.group_class_series s
       set occurrence_count = null,
           ends_on = (
             select max((a.occurrence_original_start at time zone s.timezone)::date)
             from public.appointments a
             where a.group_class_series_id = v_series and a.series_occurrence_index < v_index
           )
     where s.id = v_series;

    -- Re-point (never recreate) the selected and later occurrences of the selected series.
    update public.appointments a
       set group_class_series_id = v_new
     where a.group_class_series_id = v_series
       and a.appointment_type = 'group_class'::public.appointment_type
       and a.series_occurrence_index >= v_index;
    get diagnostics v_moved = row_count;
  end if;

  -- Series definitions that stay in place (the selected series when nothing earlier exists,
  -- and every later successor) take the edited defaults.
  update public.group_class_series s
     set title = case when p_changes ? 'title' then btrim(p_changes ->> 'title') else s.title end,
         default_instructor_id = case when p_changes ? 'instructor_id' then (p_changes ->> 'instructor_id')::uuid else s.default_instructor_id end,
         default_room_id = case when p_changes ? 'room_id' then (p_changes ->> 'room_id')::uuid else s.default_room_id end,
         default_location_name = case when p_changes ? 'location_name' then nullif(btrim(coalesce(p_changes ->> 'location_name', '')), '') else s.default_location_name end,
         default_roster_capacity = case when p_changes ? 'roster_capacity' then (p_changes ->> 'roster_capacity')::integer else s.default_roster_capacity end,
         local_start_time = case when p_changes ? 'local_start_time' then (p_changes ->> 'local_start_time')::time else s.local_start_time end,
         duration_minutes = case when p_changes ? 'duration_minutes' then (p_changes ->> 'duration_minutes')::integer else s.duration_minutes end
   where s.id in (
     select f.series_id from public._gcsc5_series_family(coalesce(v_new, v_series)) f
     where f.depth > 0 or not v_has_earlier
   );

  -- Authoritative conflict re-validation against the final state; any conflict rolls back everything.
  foreach v_id in array v_check loop
    select a.series_occurrence_index, a.instructor_id, a.room_id, a.starts_at, a.ends_at
      into v_row
      from public.appointments a where a.id = v_id;

    v_reason := public._gcsc5_edit_conflict(v_studio, v_id, v_row.instructor_id, v_row.room_id, v_row.starts_at, v_row.ends_at);
    if v_reason is not null then
      raise exception 'GCSC5_CONFLICT: reason=% index=%', v_reason, v_row.series_occurrence_index;
    end if;
  end loop;

  v_result := jsonb_build_object(
    'series_id', coalesce(v_new, v_series),
    'predecessor_series_id', case when v_has_earlier then v_series else null end,
    'studio_id', v_studio,
    'anchor_index', v_index,
    'split_created', v_has_earlier,
    'moved_class_count', v_moved,
    'editable_class_count', v_eligible,
    'edited_class_count', v_edited,
    'preserved_customized_count', v_customized_kept,
    'overwritten_customized_count', v_customized_overwritten,
    'cancelled_class_count', v_cancelled,
    'historical_class_count', v_historical,
    'terminal_attendance_class_count', v_terminal,
    'replay', false
  );

  insert into public.group_class_series_edit_requests (
    studio_id, client_request_id, anchor_appointment_id, request_hash, result, created_by
  ) values (v_studio, p_client_request_id, p_appointment_id, v_hash, v_result, auth.uid());

  return v_result;
end;
$$;

revoke all on function public.edit_group_class_series_from(uuid, uuid, jsonb, boolean) from public;
revoke all on function public.edit_group_class_series_from(uuid, uuid, jsonb, boolean) from anon;
revoke all on function public.edit_group_class_series_from(uuid, uuid, jsonb, boolean) from service_role;
grant execute on function public.edit_group_class_series_from(uuid, uuid, jsonb, boolean) to authenticated;

create or replace function public._gcsc5_edit_conflict(
  p_studio_id uuid,
  p_self_id uuid,
  p_instructor_id uuid,
  p_room_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_cap integer;
  v_peak integer;
  v_active public.appointment_status[] := array[
    'scheduled', 'confirmed', 'rescheduled', 'attended'
  ]::public.appointment_status[];
begin
  if p_instructor_id is not null then
    if exists (
      select 1 from public.appointments a
      where a.studio_id = p_studio_id and a.instructor_id = p_instructor_id and a.id <> p_self_id
        and a.status = any (v_active) and a.starts_at < p_ends_at and a.ends_at > p_starts_at
    ) then
      return 'instructor';
    end if;

    if exists (
      select 1 from public.instructor_schedule_blocks b
      where b.studio_id = p_studio_id and b.instructor_id = p_instructor_id
        and b.starts_at < p_ends_at and b.ends_at > p_starts_at
    ) then
      return 'instructor_block';
    end if;
  end if;

  if p_room_id is not null then
    if exists (
      select 1 from public.appointments a
      where a.studio_id = p_studio_id and a.room_id = p_room_id
        and a.appointment_type = 'room_unavailable'::public.appointment_type
        and a.status = any (v_active) and a.starts_at < p_ends_at and a.ends_at > p_starts_at
    ) then
      return 'room_unavailable';
    end if;

    if exists (
      select 1 from public.appointments a
      where a.studio_id = p_studio_id and a.room_id = p_room_id and a.id <> p_self_id
        and a.appointment_type <> 'room_unavailable'::public.appointment_type
        and a.status = any (v_active) and a.starts_at < p_ends_at and a.ends_at > p_starts_at
        and a.exclusive_room_use is true
    ) then
      return 'room_busy';
    end if;

    select r.max_simultaneous_bookings into v_cap from public.rooms r where r.id = p_room_id;

    if v_cap is not null then
      with occ as (
        select greatest(a.starts_at, p_starts_at) as s, least(a.ends_at, p_ends_at) as e
        from public.appointments a
        where a.studio_id = p_studio_id and a.room_id = p_room_id and a.id <> p_self_id
          and a.appointment_type <> 'room_unavailable'::public.appointment_type
          and a.status = any (v_active) and a.starts_at < p_ends_at and a.ends_at > p_starts_at
      )
      select coalesce(max(c), 0) into v_peak
      from (
        select (select count(*) from occ o2 where o2.s <= o1.s and o2.e > o1.s) as c
        from occ o1
        where o1.s < o1.e
      ) x;

      if v_peak + 1 > v_cap then
        return 'room_busy';
      end if;
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public._gcsc5_edit_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;

drop function if exists public._gcse3_guard_direct_class_schedule();
drop function if exists public._gcse3_lock_resources(uuid[], uuid[]);
drop function if exists public._gcse3_schedule_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz, boolean);

commit;
