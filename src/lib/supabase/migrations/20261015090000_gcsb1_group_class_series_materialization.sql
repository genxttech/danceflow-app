-- ============================================================================
-- GC-S1B B1 -- canonical group-class series: SQL generation + atomic
-- materialization foundation. SQL only: no application, UI or conflict code.
--
-- 1. group_class_series.client_request_id (+ partial unique index): the repo's
--    standard client-generated-request-id idempotency pattern (payments,
--    event orders), so a retried/duplicated create resolves to the same series.
-- 2. _gcsb1_series_dates / _gcsb1_generate_series_occurrences (internal, no
--    grants): the ONE deterministic generator shared by preview and create.
--    ISO weekdays; anchored to the ISO-week Monday containing starts_on;
--    every interval_weeks; dates before starts_on dropped; ascending order;
--    exactly one finite end rule (count or ends_on); at most 104 occurrences;
--    end date at most 730 days after starts_on. Timestamps come from
--    (calendar date + local wall time) AT TIME ZONE <series timezone>; no UTC
--    interval arithmetic. series_occurrence_index is assigned BEFORE skips
--    and is never renumbered.
--
--    DST (observed on PostgreSQL 17.6 in DEV, pinned by the SQL tests): a
--    nonexistent spring-forward wall time resolves with the offset in force
--    BEFORE the gap, i.e. it lands the gap length later (02:30 -> 03:30 EDT);
--    an ambiguous fall-back wall time resolves to the LATER occurrence
--    (standard time). Both are deterministic, so the native behavior is used
--    as-is and the generator only FLAGS affected dates via dst_note
--    ('nonexistent_adjusted' / 'ambiguous_later_selected') so previews can
--    warn the creator.
-- 3. preview_group_class_series: read-only, broad staff only, same generator.
-- 4. create_group_class_series: broad staff only; atomically creates the
--    series, every non-skipped occurrence (canonical group_class appointments
--    linked to the series) and one enrollment-policy row per occurrence. Any
--    failure aborts the whole call (no partial series). Never accepts
--    client-supplied timestamps; the studio timezone is read authoritatively.
--
-- Structured errors: the exception message starts with a stable GCSB1_*
-- code so the application layer can map them to safe copy. Conflict detection
-- stays in the application (B2). Existing standalone creation is untouched.
--
-- Rollback: rollback/20261015090000_gcsb1_group_class_series_materialization_rollback.sql
-- ============================================================================

begin;

-- ============================================================================
-- 1. Idempotency key
-- ============================================================================
alter table public.group_class_series
  add column client_request_id uuid;

create unique index uq_group_class_series_client_request
  on public.group_class_series (studio_id, client_request_id)
  where client_request_id is not null;

-- ============================================================================
-- 2a. Date generation (internal): validated inputs -> (index, local date).
-- ============================================================================
create function public._gcsb1_series_dates(
  p_weekdays smallint[],
  p_interval_weeks integer,
  p_starts_on date,
  p_ends_on date,
  p_occurrence_count integer
)
returns table (idx integer, ld date)
language sql
immutable
security invoker
set search_path = 'public'
as $$
  with anchor as (
    select (p_starts_on - (extract(isodow from p_starts_on)::integer - 1)) as monday
  ),
  bounds as (
    select monday,
           case
             when p_occurrence_count is not null then p_occurrence_count
             else (p_ends_on - monday) / (7 * p_interval_weeks)
           end as kmax
    from anchor
  ),
  cand as (
    select (b.monday + 7 * p_interval_weeks * k + (d - 1))::date as ld
    from bounds b
    cross join lateral generate_series(0, b.kmax) as k
    cross join lateral unnest(p_weekdays) as d
  ),
  kept as (
    select ld from cand
    where ld >= p_starts_on
      and (p_ends_on is null or ld <= p_ends_on)
  ),
  numbered as (
    select ld, (row_number() over (order by ld))::integer as idx from kept
  )
  select idx, ld from numbered
  where p_occurrence_count is null or idx <= p_occurrence_count
  order by idx;
$$;

revoke all on function public._gcsb1_series_dates(smallint[], integer, date, date, integer)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 2b. Occurrence generation (internal): validation + timestamps + DST flag.
-- ============================================================================
create function public._gcsb1_generate_series_occurrences(
  p_timezone text,
  p_weekdays smallint[],
  p_interval_weeks integer,
  p_starts_on date,
  p_ends_on date,
  p_occurrence_count integer,
  p_local_start_time time,
  p_duration_minutes integer
)
returns table (
  occurrence_index integer,
  local_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  dst_note text
)
language plpgsql
stable
security invoker
set search_path = 'public'
as $$
declare
  v_weekdays smallint[];
  v_total integer;
begin
  if p_starts_on is null or p_local_start_time is null then
    raise exception 'GCSB1_INVALID_RECURRENCE: A start date and start time are required.';
  end if;

  if p_weekdays is null or cardinality(p_weekdays) = 0
     or exists (select 1 from unnest(p_weekdays) as d where d is null or d not between 1 and 7)
  then
    raise exception 'GCSB1_INVALID_RECURRENCE: Choose at least one weekday.';
  end if;
  v_weekdays := (select array_agg(distinct d order by d) from unnest(p_weekdays) as d);

  if p_interval_weeks is null or p_interval_weeks not between 1 and 52 then
    raise exception 'GCSB1_INVALID_RECURRENCE: The repeat interval must be 1 to 52 weeks.';
  end if;

  if num_nonnulls(p_ends_on, p_occurrence_count) <> 1 then
    raise exception 'GCSB1_INVALID_RECURRENCE: Choose either an end date or a number of classes.';
  end if;

  if p_occurrence_count is not null then
    if p_occurrence_count < 1 then
      raise exception 'GCSB1_INVALID_RECURRENCE: The number of classes must be at least 1.';
    end if;
    if p_occurrence_count > 104 then
      raise exception 'GCSB1_OCCURRENCE_CAP_EXCEEDED: A series can have at most 104 classes.';
    end if;
  end if;

  if p_ends_on is not null then
    if p_ends_on < p_starts_on then
      raise exception 'GCSB1_INVALID_RECURRENCE: The end date must be on or after the start date.';
    end if;
    if p_ends_on > p_starts_on + 730 then
      raise exception 'GCSB1_INVALID_RECURRENCE: The end date must be within two years of the start date.';
    end if;
  end if;

  if p_duration_minutes is null or p_duration_minutes not between 5 and 720 then
    raise exception 'GCSB1_INVALID_RECURRENCE: A class must last between 5 minutes and 12 hours.';
  end if;

  if p_timezone is null
     or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone)
  then
    raise exception 'GCSB1_INVALID_TIMEZONE: The studio time zone is not valid.';
  end if;

  select count(*)::integer into v_total
  from public._gcsb1_series_dates(v_weekdays, p_interval_weeks, p_starts_on, p_ends_on, p_occurrence_count);

  if v_total > 104 then
    raise exception 'GCSB1_OCCURRENCE_CAP_EXCEEDED: A series can have at most 104 classes.';
  end if;
  if v_total < 1 then
    raise exception 'GCSB1_INVALID_RECURRENCE: The schedule produces no classes.';
  end if;

  return query
  select
    g.idx,
    g.ld,
    s.st,
    s.st + make_interval(mins => p_duration_minutes),
    case
      when (s.st at time zone p_timezone) <> (g.ld + p_local_start_time)
        then 'nonexistent_adjusted'
      when exists (
        select 1
        from unnest(array[-60, -30, 30, 60]) as m
        where ((s.st + make_interval(mins => m)) at time zone p_timezone) = (g.ld + p_local_start_time)
      )
        then 'ambiguous_later_selected'
      else null
    end
  from public._gcsb1_series_dates(v_weekdays, p_interval_weeks, p_starts_on, p_ends_on, p_occurrence_count) g
  cross join lateral (
    select ((g.ld + p_local_start_time)::timestamp at time zone p_timezone) as st
  ) s
  order by g.idx;
end;
$$;

revoke all on function public._gcsb1_generate_series_occurrences(text, smallint[], integer, date, date, integer, time, integer)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. preview_group_class_series -- read-only, broad staff only.
-- ============================================================================
create function public.preview_group_class_series(
  p_studio_id uuid,
  p_title text,
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
  p_duration_minutes integer
)
returns table (
  occurrence_index integer,
  local_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  instructor_id uuid,
  room_id uuid,
  location_name text,
  roster_capacity integer,
  dst_note text
)
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_timezone text;
  v_location text := nullif(btrim(coalesce(p_location_name, '')), '');
begin
  if not public._gc1_4_has_broad_studio_authority(p_studio_id) then
    raise exception 'GCSB1_UNAUTHORIZED: Not authorized to schedule classes for this studio.';
  end if;

  if p_roster_capacity is not null and p_roster_capacity < 1 then
    raise exception 'GCSB1_INVALID_DEFINITION: Class capacity must be at least 1.';
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

  return query
  select
    g.occurrence_index,
    g.local_date,
    g.starts_at,
    g.ends_at,
    p_instructor_id,
    p_room_id,
    v_location,
    p_roster_capacity,
    g.dst_note
  from public._gcsb1_generate_series_occurrences(
    v_timezone, p_weekdays, p_interval_weeks, p_starts_on, p_ends_on,
    p_occurrence_count, p_local_start_time, p_duration_minutes
  ) g
  order by g.occurrence_index;
end;
$$;

revoke all on function public.preview_group_class_series(uuid, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer) from public;
revoke all on function public.preview_group_class_series(uuid, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer) from anon;
revoke all on function public.preview_group_class_series(uuid, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer) from service_role;
grant execute on function public.preview_group_class_series(uuid, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer) to authenticated;

-- ============================================================================
-- 4. create_group_class_series -- atomic create + materialize.
--
-- Returns {series_id, materialized_count, replay}. Replay: the same
-- (studio, client_request_id) with an identical definition (including the
-- skip set, derived from which generated indices have no occurrence row)
-- returns the existing series; a different definition is an idempotency
-- conflict. Duplicate concurrent submissions are serialized by a
-- transaction-scoped advisory lock, with the unique index as the backstop.
-- ============================================================================
create function public.create_group_class_series(
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

commit;
