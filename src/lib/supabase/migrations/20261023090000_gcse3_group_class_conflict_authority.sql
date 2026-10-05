-- ============================================================================
-- GC-S1E-3 -- Group-class conflict authority.
--
-- Makes the group-class scheduling-conflict rule database-authoritative and safe against
-- concurrent writers. Function-only plus two statement-level triggers: no table, column,
-- index, policy or data change.
--
-- 1. _gcse3_schedule_conflict: the ONE conflict rule for canonical group-class writes
--    (instructor overlap, instructor schedule block, room unavailable, exclusive room,
--    room simultaneous-booking peak capacity), the same semantics as the app's
--    detectAppointmentConflicts: active = scheduled / confirmed / rescheduled / attended,
--    half-open intervals (back-to-back is allowed), studio-scoped, no client-overlap rule
--    for classes. Returns a reason code (instructor | instructor_block | room_unavailable |
--    room_busy) or NULL. It replaces the hand-copied S1C-5 rule: _gcsc5_edit_conflict now
--    delegates to it.
-- 2. _gcse3_lock_resources: the resource-lock protocol. Row locks (FOR NO KEY UPDATE) on
--    the instructors rows, then the rooms rows, each set in id order. This is the order the
--    existing P4 helper _lock_and_check_scheduling_resources (membership private-lesson
--    RPCs) already uses (instructor row, then room row, FOR UPDATE), so those writers take
--    part in the same protocol. Row locks need no key namespace or hashing: a uuid primary
--    key identifies exactly one resource of exactly one type, and they are released at
--    commit / rollback. A conflict check made after acquiring the locks sees every
--    conflicting write already committed by another participant, including the
--    "empty space" case where no conflicting appointment row existed before.
-- 3. Canonical writers, each: derive the studio / resources server-side, lock, validate,
--    refuse atomically:
--      * create_group_class_appointment (one-time class): lock + check before the insert
--        (previously no conflict check at all, in the app or the database).
--      * create_group_class_series: lock + check every materialized occurrence (and that
--        the generated occurrences do not overlap each other) before anything is written.
--      * edit_group_class_series_from (S1C-5): locks the old and new resources of every
--        moving occurrence before the update; the final-state re-validation now uses the
--        shared rule. Everything else is unchanged.
--      * direct single-occurrence edit (and any other direct anon / authenticated insert or
--        update of a group_class row): statement-level AFTER triggers, decided on
--        current_user like the S1A series guard, lock the old and new resources of every
--        changed class row in deterministic order and re-validate it against the final
--        state. The single edit stays a direct, RLS-governed write so the released S1C
--        authority (broad staff, or the assigned instructor) and the S1A override tracking
--        (which records only direct anon / authenticated writes) are untouched.
--    Refusals raise 'GCSE3_CONFLICT: reason=<code>[ index=<n> count=<n>]'. No other
--    studio's booking details are ever returned.
-- ============================================================================

begin;

-- ============================================================================
-- 1. The shared conflict rule
-- ============================================================================
create function public._gcse3_schedule_conflict(
  p_studio_id uuid,
  p_self_id uuid,
  p_instructor_id uuid,
  p_room_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_exclusive boolean default false
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
      where a.studio_id = p_studio_id and a.instructor_id = p_instructor_id
        and (p_self_id is null or a.id <> p_self_id)
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

    -- Exclusivity: an existing exclusive occupant blocks any use; a write that itself asks for
    -- exclusive use is blocked by any occupant.
    if exists (
      select 1 from public.appointments a
      where a.studio_id = p_studio_id and a.room_id = p_room_id
        and (p_self_id is null or a.id <> p_self_id)
        and a.appointment_type <> 'room_unavailable'::public.appointment_type
        and a.status = any (v_active) and a.starts_at < p_ends_at and a.ends_at > p_starts_at
        and (a.exclusive_room_use is true or coalesce(p_exclusive, false))
    ) then
      return 'room_busy';
    end if;

    select r.max_simultaneous_bookings into v_cap
      from public.rooms r where r.id = p_room_id and r.studio_id = p_studio_id;

    if v_cap is not null then
      -- Peak concurrent occupancy of the other occupants within the requested window: the peak
      -- of half-open intervals is reached at some clipped start, and an occupant ending exactly
      -- at that instant does not count (back-to-back never double-counts).
      with occ as (
        select greatest(a.starts_at, p_starts_at) as s, least(a.ends_at, p_ends_at) as e
        from public.appointments a
        where a.studio_id = p_studio_id and a.room_id = p_room_id
          and (p_self_id is null or a.id <> p_self_id)
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

revoke all on function public._gcse3_schedule_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz, boolean) from public, anon, authenticated, service_role;

-- ============================================================================
-- 2. The resource-lock protocol
-- ============================================================================
-- Every participant locks ALL the instructors it touches (old and new), then ALL the rooms,
-- each in id order, before its conflict check, and holds them to commit. One global order
-- (instructors by id, then rooms by id) means two participants can never wait on each other
-- in a cycle, whichever direction they move a class (A -> B and B -> A both lock A, B). FOR NO
-- KEY UPDATE conflicts with itself and with the P4 helper's FOR UPDATE, but not with the KEY
-- SHARE locks that foreign-key checks take, so ordinary inserts referencing the instructor or
-- room are never blocked by it.
create function public._gcse3_lock_resources(
  p_instructor_ids uuid[],
  p_room_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  perform 1 from public.instructors i
    where i.id = any (coalesce(p_instructor_ids, array[]::uuid[]))
    order by i.id
    for no key update of i;

  perform 1 from public.rooms r
    where r.id = any (coalesce(p_room_ids, array[]::uuid[]))
    order by r.id
    for no key update of r;
end;
$$;

revoke all on function public._gcse3_lock_resources(uuid[], uuid[]) from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. The S1C-5 helper now delegates to the shared rule (the preview keeps calling it).
-- ============================================================================
create or replace function public._gcsc5_edit_conflict(
  p_studio_id uuid,
  p_self_id uuid,
  p_instructor_id uuid,
  p_room_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select public._gcse3_schedule_conflict(p_studio_id, p_self_id, p_instructor_id, p_room_id, p_starts_at, p_ends_at, false);
$$;

revoke all on function public._gcsc5_edit_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. Direct writes of group_class rows (the single-occurrence edit)
-- ============================================================================
-- Fires only when the statement runs as anon / authenticated (the trigger's WHEN clause sees
-- the caller's role; inside a SECURITY DEFINER RPC current_user is the owner, and those RPCs
-- lock and check on their own). Checks only rows that are active classes after the write and
-- whose instructor, room, time, exclusivity or studio changed (or that became active), against
-- the final state, after locking the old and new resources of all of them.
create function public._gcse3_guard_direct_class_schedule()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_active public.appointment_status[] := array[
    'scheduled', 'confirmed', 'rescheduled', 'attended'
  ]::public.appointment_status[];
  v_ids uuid[];
  v_instructors uuid[];
  v_rooms uuid[];
  v_id uuid;
  v_row record;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    select array_agg(n.id order by n.id),
           array_agg(distinct n.instructor_id) filter (where n.instructor_id is not null),
           array_agg(distinct n.room_id) filter (where n.room_id is not null)
      into v_ids, v_instructors, v_rooms
      from new_rows n
     where n.appointment_type = 'group_class'::public.appointment_type
       and n.status = any (v_active);
  else
    with changed as (
      select n.id, n.instructor_id as new_instructor, o.instructor_id as old_instructor,
             n.room_id as new_room, o.room_id as old_room
      from new_rows n
      join old_rows o on o.id = n.id
      where n.appointment_type = 'group_class'::public.appointment_type
        and n.status = any (v_active)
        and (n.instructor_id is distinct from o.instructor_id
             or n.room_id is distinct from o.room_id
             or n.starts_at is distinct from o.starts_at
             or n.ends_at is distinct from o.ends_at
             or n.exclusive_room_use is distinct from o.exclusive_room_use
             or n.studio_id is distinct from o.studio_id
             or not (o.status = any (v_active)))
    )
    select (select array_agg(c.id order by c.id) from changed c),
           (select array_agg(distinct x) from changed c, unnest(array[c.new_instructor, c.old_instructor]) x where x is not null),
           (select array_agg(distinct x) from changed c, unnest(array[c.new_room, c.old_room]) x where x is not null)
      into v_ids, v_instructors, v_rooms;
  end if;

  if v_ids is null then
    return null;
  end if;

  perform public._gcse3_lock_resources(v_instructors, v_rooms);

  foreach v_id in array v_ids loop
    select a.studio_id, a.instructor_id, a.room_id, a.starts_at, a.ends_at, a.exclusive_room_use
      into v_row
      from public.appointments a
     where a.id = v_id
       and a.appointment_type = 'group_class'::public.appointment_type
       and a.status = any (v_active);
    continue when not found;

    v_reason := public._gcse3_schedule_conflict(
      v_row.studio_id, v_id, v_row.instructor_id, v_row.room_id, v_row.starts_at, v_row.ends_at, v_row.exclusive_room_use
    );
    if v_reason is not null then
      raise exception 'GCSE3_CONFLICT: reason=%', v_reason;
    end if;
  end loop;

  return null;
end;
$$;

revoke all on function public._gcse3_guard_direct_class_schedule() from public, anon, authenticated, service_role;
-- No grant execute: reachable only as a trigger body.

create trigger appointments_gcse3_direct_class_schedule_insert
  after insert on public.appointments
  referencing new table as new_rows
  for each statement
  when (current_user in ('anon', 'authenticated'))
  execute function public._gcse3_guard_direct_class_schedule();

create trigger appointments_gcse3_direct_class_schedule_update
  after update on public.appointments
  referencing old table as old_rows new table as new_rows
  for each statement
  when (current_user in ('anon', 'authenticated'))
  execute function public._gcse3_guard_direct_class_schedule();

-- ============================================================================
-- 5. Canonical writers (replaced in place; signatures and grants unchanged)
-- ============================================================================
-- 5a. One-time class create (GC-1.4A). Body unchanged apart from the lock + check.
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
  v_reason text;
begin
  if not public._gc1_4_has_broad_studio_authority(p_studio_id) then
    raise exception 'Not authorized to create a group class for this studio.';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A group class requires a valid start and end time.';
  end if;

  -- GC-S1E-3: lock the class's resources, then refuse a conflicting class before writing it.
  perform public._gcse3_lock_resources(array[p_instructor_id], array[p_room_id]);
  v_reason := public._gcse3_schedule_conflict(p_studio_id, null, p_instructor_id, p_room_id, p_starts_at, p_ends_at, false);
  if v_reason is not null then
    raise exception 'GCSE3_CONFLICT: reason=%', v_reason;
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

-- 5b. Series create (GC-S1B B1). Body unchanged apart from the overlap guard and the lock + check.
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
  v_conflicts integer;
  v_conflict_index integer;
  v_conflict_reason text;
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

  -- GC-S1E-3: the classes to materialize never overlap each other (the generator's bounds make
  -- this impossible; checked so it is a guarantee) ...
  if exists (
    select 1
    from public._gcsb1_generate_series_occurrences(
      v_timezone, v_weekdays, p_interval_weeks, p_starts_on, p_ends_on,
      p_occurrence_count, p_local_start_time, p_duration_minutes
    ) g1
    join public._gcsb1_generate_series_occurrences(
      v_timezone, v_weekdays, p_interval_weeks, p_starts_on, p_ends_on,
      p_occurrence_count, p_local_start_time, p_duration_minutes
    ) g2 on g1.occurrence_index < g2.occurrence_index
        and g1.starts_at < g2.ends_at and g2.starts_at < g1.ends_at
    where g1.occurrence_index <> all (v_skip) and g2.occurrence_index <> all (v_skip)
  ) then
    raise exception 'GCSB1_INVALID_RECURRENCE: The classes in this series would overlap each other.';
  end if;

  -- ... and, with the instructor and room locked, none of them conflicts with the schedule.
  -- Any conflict refuses the whole series before anything is written.
  if p_instructor_id is not null or p_room_id is not null then
    perform public._gcse3_lock_resources(array[p_instructor_id], array[p_room_id]);

    select count(*)::integer,
           (array_agg(c.occurrence_index order by c.occurrence_index))[1],
           (array_agg(c.reason order by c.occurrence_index))[1]
      into v_conflicts, v_conflict_index, v_conflict_reason
      from (
        select g.occurrence_index,
               public._gcse3_schedule_conflict(p_studio_id, null, p_instructor_id, p_room_id, g.starts_at, g.ends_at, false) as reason
        from public._gcsb1_generate_series_occurrences(
          v_timezone, v_weekdays, p_interval_weeks, p_starts_on, p_ends_on,
          p_occurrence_count, p_local_start_time, p_duration_minutes
        ) g
        where g.occurrence_index <> all (v_skip)
      ) c
     where c.reason is not null;

    if v_conflicts > 0 then
      raise exception 'GCSE3_CONFLICT: reason=% index=% count=%', v_conflict_reason, v_conflict_index, v_conflicts;
    end if;
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

-- 5c. S1C-5 "this and following" edit. Body unchanged apart from the lock step and the shared rule.
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
  v_lock_instructors uuid[];
  v_lock_rooms uuid[];
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

  -- GC-S1E-3: lock the current and new instructor / room of every moving occurrence (the shared
  -- resource-lock protocol) before writing, so the re-validation below cannot be raced.
  select coalesce(array_agg(distinct x) filter (where x is not null), array[]::uuid[])
    into v_lock_instructors
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, v_overwrite) p
    join public.appointments a on a.id = p.appointment_id
    cross join lateral unnest(array[a.instructor_id, p.new_instructor_id]) x
   where a.id = any (v_check);

  select coalesce(array_agg(distinct x) filter (where x is not null), array[]::uuid[])
    into v_lock_rooms
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, v_overwrite) p
    join public.appointments a on a.id = p.appointment_id
    cross join lateral unnest(array[a.room_id, p.new_room_id]) x
   where a.id = any (v_check);

  perform public._gcse3_lock_resources(v_lock_instructors, v_lock_rooms);

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
    select a.series_occurrence_index, a.instructor_id, a.room_id, a.starts_at, a.ends_at, a.exclusive_room_use
      into v_row
      from public.appointments a where a.id = v_id;

    v_reason := public._gcse3_schedule_conflict(
      v_studio, v_id, v_row.instructor_id, v_row.room_id, v_row.starts_at, v_row.ends_at, v_row.exclusive_room_use
    );
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

commit;
