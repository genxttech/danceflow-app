-- ============================================================================
-- GC-S1C-5 -- "This and following classes" series editing (successor split).
--
-- 1. group_class_series.split_from_series_id (+ composite same-studio FK, no self
--    reference, at most ONE direct successor per series): explicit successor lineage.
--    The split lineage of a series is therefore a LINEAR CHAIN predecessor -> successor, and
--    split_from_series_id means the POSITIONAL predecessor segment, not immutable creation
--    history: splitting an earlier segment re-parents a later successor beneath the new one.
-- 2. group_class_series_edit_requests: idempotency ledger for series edits (studio +
--    client request id, request fingerprint, stored result). RPC-only (no tenant grants).
-- 3. edit_group_class_series_from(p_appointment_id, p_client_request_id, p_changes,
--    p_overwrite) -> jsonb: ONE SECURITY DEFINER transaction, broad staff only (the same
--    authority helper as every other series RPC; assigned instructors are refused).
--    The client supplies only the selected occurrence's id, a request id, the changed
--    values and the preserve/overwrite choice: the studio, the series, the target
--    occurrences, their classification and their override state are all derived here.
--      * Editable (series-level) fields: title, instructor, room, location, maximum
--        students, start time of day, duration. Recurrence shape, the occurrence date,
--        notes and enrollment policy are never touched.
--      * Targets = every occurrence with index >= the selected one in the selected
--        series and in its successors. Only 'eligible' occurrences (not cancelled, not
--        attended/no_show, not ended, no recorded terminal attendance) are edited;
--        cancelled / historical / terminal-attendance occurrences keep every value (and a
--        cancelled one stays cancelled). The selected occurrence itself must be eligible.
--      * Customized occurrences (series_overridden_fields intersecting the edited fields)
--        keep their own values by default; with p_overwrite only the edited fields are
--        replaced and only those fields' override flags are cleared. Unrelated flags stay.
--      * Successor split: when earlier occurrences exist in the selected series, a new
--        series row (split_from_series_id = the selected series) receives the selected and
--        later occurrences of that series BY RE-POINTING THE EXISTING ROWS (ids, indexes,
--        rosters, attendance, usage and enrollment policies are untouched; nothing is
--        recreated or renumbered). The predecessor's recurrence extent is trimmed to what
--        it still holds. A later successor of the selected series is re-parented under
--        the new one and edited in place, keeping the chain linear. When nothing earlier
--        exists the series row is edited in place (no empty predecessor is created): this is
--        an explicit S1C-5 rule, and the occurrence rows keep their identity either way.
--      * Override flags stay truthful (GC-S1C-5 remediation): for every EDITED field group, a
--        flagged occurrence is either preserved (it keeps a value that differs from the new
--        series default and keeps the flag), or ends up equal to the new series default and has
--        that flag cleared (explicit overwrite, or a customized value that already equals the new
--        default, e.g. propagating the selected class's own customization). Flags for fields not
--        in the edit are never touched.
--      * The whole operation is atomic: a capacity floor (GCSC3), conflict, assignability
--        or any other refusal rolls everything back. Apply revalidates conflicts
--        transactionally against the database state visible to the operation, using the
--        same rules as the app's schedule-conflict engine. This does NOT serialize against
--        outside writers (for example a private-lesson booking committed at the same moment):
--        the database has no scheduling constraint, and normal appointment editing has the
--        same limitation.
--      * Locking is series-first (selected series, then its successors in chain order),
--        then the target occurrence rows in index order -- the S1C-4 discipline.
--      * Idempotent: a repeated request id returns the stored result; the same id with a
--        different request is refused.
--    No notification is sent (edit notifications belong to S1E).
-- 4. preview_group_class_series_edit(...) -> jsonb: read-only, same plan function as the
--    apply, for the confirmation summary.
-- 5. S1C-4 interoperation (CREATE OR REPLACE of the two released S1C-4 RPCs): "this and
--    following" cancellation now spans the split lineage (a successor holds later classes
--    of the same logical series), locks series-first across it, and re-reads the selected
--    class's series after locking so a concurrent split cannot make it miss moved classes.
--    Behavior for a never-split series is unchanged.
--
-- Error codes (stable prefixes): GCSC5_NOT_FOUND, GCSC5_UNAUTHORIZED, GCSC5_NOT_A_SERIES_OCCURRENCE,
-- GCSC5_ANCHOR_NOT_EDITABLE, GCSC5_SERIES_NOT_EDITABLE, GCSC5_INVALID_CHANGES, GCSC5_NO_CHANGES,
-- GCSC5_INSTRUCTOR_UNASSIGNABLE, GCSC5_ROOM_INVALID, GCSC5_CONFLICT, GCSC5_REQUEST_ID_REQUIRED,
-- GCSC5_IDEMPOTENCY_CONFLICT. Capacity floor failures surface as GCSC3_CAPACITY_BELOW_BOOKED.
--
-- Rollback: rollback/20261019090000_gcsc5_series_following_edit_rollback.sql
-- Must run in BOTH DEV and PROD.
-- ============================================================================

begin;

-- ============================================================================
-- 1. Lineage
-- ============================================================================
alter table public.group_class_series
  add column split_from_series_id uuid;

alter table public.group_class_series
  add constraint group_class_series_split_from_fk
    foreign key (split_from_series_id, studio_id)
    references public.group_class_series (id, studio_id)
    on delete restrict,
  add constraint group_class_series_split_not_self
    check (split_from_series_id is null or split_from_series_id <> id);

create unique index uq_group_class_series_split_from
  on public.group_class_series (split_from_series_id)
  where split_from_series_id is not null;

comment on column public.group_class_series.split_from_series_id is
  'GC-S1C-5: the POSITIONAL predecessor segment this series was split from by a "this and following" edit (NULL = first segment). At most one successor per series, so lineage is a linear chain; re-splitting an earlier segment re-parents a later successor, so this is not immutable creation-history provenance.';

-- ============================================================================
-- 2. Idempotency ledger (RPC-only)
-- ============================================================================
create table public.group_class_series_edit_requests (
  studio_id uuid not null references public.studios(id),
  client_request_id uuid not null,
  anchor_appointment_id uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (studio_id, client_request_id)
);

alter table public.group_class_series_edit_requests enable row level security;
revoke all on table public.group_class_series_edit_requests from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. Internal helpers (no grants)
-- ============================================================================

-- The series and every successor after it, in chain order (depth 0 = the series itself).
create function public._gcsc5_series_family(p_series_id uuid)
returns table (series_id uuid, depth integer)
language sql
stable
security definer
set search_path = 'public'
as $$
  with recursive fam(series_id, depth) as (
    select s.id, 0 from public.group_class_series s where s.id = p_series_id
    union all
    select c.id, f.depth + 1
    from public.group_class_series c
    join fam f on c.split_from_series_id = f.series_id
    where f.depth < 60
  )
  select fam.series_id, fam.depth from fam order by fam.depth;
$$;

revoke all on function public._gcsc5_series_family(uuid) from public, anon, authenticated, service_role;

-- Override groups touched by a change set.
create function public._gcsc5_edit_groups(p_changes jsonb)
returns text[]
language sql
stable
set search_path = 'public'
as $$
  select coalesce(array_agg(distinct g order by g), array[]::text[])
  from (
    select case k
      when 'title' then 'title'
      when 'instructor_id' then 'instructor'
      when 'room_id' then 'room'
      when 'location_name' then 'location'
      when 'roster_capacity' then 'capacity'
      when 'local_start_time' then 'time'
      when 'duration_minutes' then 'time'
    end as g
    from jsonb_object_keys(p_changes) as k
  ) x
  where g is not null;
$$;

revoke all on function public._gcsc5_edit_groups(jsonb) from public, anon, authenticated, service_role;

-- Validates the requested changes (shape, values, same-studio references).
create function public._gcsc5_validate_changes(p_studio_id uuid, p_changes jsonb)
returns void
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_key text;
  v_instructor uuid;
  v_room uuid;
  v_text text;
  v_int integer;
  v_time time;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'GCSC5_INVALID_CHANGES: Choose at least one change to apply.';
  end if;

  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('title', 'instructor_id', 'room_id', 'location_name', 'roster_capacity', 'local_start_time', 'duration_minutes') then
      raise exception 'GCSC5_INVALID_CHANGES: One of the changes is not supported for a series.';
    end if;
  end loop;

  begin
    if p_changes ? 'title' then
      if jsonb_typeof(p_changes -> 'title') <> 'string' or length(btrim(p_changes ->> 'title')) = 0 then
        raise exception 'GCSC5_INVALID_CHANGES: A class title is required.';
      end if;
    end if;

    if p_changes ? 'instructor_id' then
      if jsonb_typeof(p_changes -> 'instructor_id') not in ('null', 'string') then
        raise exception 'GCSC5_INVALID_CHANGES: The instructor is not valid.';
      end if;
      v_instructor := (p_changes ->> 'instructor_id')::uuid;
    end if;

    if p_changes ? 'room_id' then
      if jsonb_typeof(p_changes -> 'room_id') not in ('null', 'string') then
        raise exception 'GCSC5_INVALID_CHANGES: The room is not valid.';
      end if;
      v_room := (p_changes ->> 'room_id')::uuid;
    end if;

    if p_changes ? 'location_name' and jsonb_typeof(p_changes -> 'location_name') not in ('null', 'string') then
      raise exception 'GCSC5_INVALID_CHANGES: The location is not valid.';
    end if;

    if p_changes ? 'roster_capacity' then
      if jsonb_typeof(p_changes -> 'roster_capacity') not in ('null', 'number') then
        raise exception 'GCSC5_INVALID_CHANGES: Maximum students is not valid.';
      end if;
      v_text := p_changes ->> 'roster_capacity';
      if v_text is not null then
        if v_text !~ '^[0-9]+$' then
          raise exception 'GCSC5_INVALID_CHANGES: Maximum students is not valid.';
        end if;
        v_int := v_text::integer;
        if v_int < 1 or v_int > 10000 then
          raise exception 'GCSC5_INVALID_CHANGES: Maximum students is not valid.';
        end if;
      end if;
    end if;

    if p_changes ? 'local_start_time' then
      if jsonb_typeof(p_changes -> 'local_start_time') <> 'string' then
        raise exception 'GCSC5_INVALID_CHANGES: The start time is not valid.';
      end if;
      v_time := (p_changes ->> 'local_start_time')::time;
    end if;

    if p_changes ? 'duration_minutes' then
      if jsonb_typeof(p_changes -> 'duration_minutes') <> 'number' or (p_changes ->> 'duration_minutes') !~ '^[0-9]+$' then
        raise exception 'GCSC5_INVALID_CHANGES: The class length is not valid.';
      end if;
      v_int := (p_changes ->> 'duration_minutes')::integer;
      if v_int < 5 or v_int > 720 then
        raise exception 'GCSC5_INVALID_CHANGES: The class length is not valid.';
      end if;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
      raise exception 'GCSC5_INVALID_CHANGES: One of the values is not valid.';
  end;

  if v_instructor is not null then
    begin
      perform public._landmark1a_assert_assignable_instructor(p_studio_id, v_instructor);
    exception when raise_exception then
      raise exception 'GCSC5_INSTRUCTOR_UNASSIGNABLE: This instructor is not available for assignment.';
    end;
  end if;

  if v_room is not null and not exists (
    select 1 from public.rooms r where r.id = v_room and r.studio_id = p_studio_id and r.active = true
  ) then
    raise exception 'GCSC5_ROOM_INVALID: That room does not belong to this studio.';
  end if;
end;
$$;

revoke all on function public._gcsc5_validate_changes(uuid, jsonb) from public, anon, authenticated, service_role;

-- The per-occurrence plan shared by preview and apply. One row per occurrence with index >=
-- the selected one in the selected series and its successors. Pure read; assumes validated changes.
create function public._gcsc5_edit_plan(p_anchor_id uuid, p_changes jsonb, p_overwrite boolean)
returns table (
  appointment_id uuid,
  series_id uuid,
  occurrence_index integer,
  classification text,
  booked_count integer,
  will_edit boolean,
  customized boolean,
  applied_groups text[],
  preserved_groups text[],
  overwritten_groups text[],
  new_title text,
  new_instructor_id uuid,
  new_room_id uuid,
  new_location_name text,
  new_roster_capacity integer,
  new_starts_at timestamptz,
  new_ends_at timestamptz,
  changed boolean,
  cleared_groups text[],
  values_changed boolean
)
language plpgsql
stable
security definer
set search_path = 'public'
as $$
#variable_conflict use_column
declare
  v_series uuid;
  v_index integer;
  v_groups text[] := public._gcsc5_edit_groups(p_changes);
  v_overwrite boolean := coalesce(p_overwrite, false);
begin
  select a.group_class_series_id, a.series_occurrence_index
    into v_series, v_index
    from public.appointments a
    where a.id = p_anchor_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_series is null then
    return;
  end if;

  return query
  with fam as (
    select f.series_id as fam_series_id from public._gcsc5_series_family(v_series) f
  ),
  base as (
    select
      a.id as b_id, a.group_class_series_id as b_series, a.series_occurrence_index as b_idx,
      a.title as b_title, a.instructor_id as b_instructor, a.room_id as b_room,
      a.location_name as b_location, a.roster_capacity as b_capacity,
      a.starts_at as b_starts, a.ends_at as b_ends, a.series_overridden_fields as b_overrides,
      s.timezone as b_tz,
      s.local_start_time as b_def_time,
      s.duration_minutes as b_def_dur,
      a.occurrence_original_start as b_orig,
      case
        when a.status = 'cancelled'::public.appointment_status then 'cancelled'
        when a.status in ('attended'::public.appointment_status, 'no_show'::public.appointment_status)
          or a.ends_at <= now() then 'historical'
        when exists (
          select 1 from public.attendance_records ar
          where ar.appointment_id = a.id and ar.status in ('attended', 'no_show')
        ) then 'terminal_attendance'
        else 'eligible'
      end as b_cls,
      (select count(*)::integer from public.appointment_attendees aa
        where aa.appointment_id = a.id and aa.status = 'booked') as b_booked
    from public.appointments a
    join public.group_class_series s on s.id = a.group_class_series_id
    where a.group_class_series_id in (select fam_series_id from fam)
      and a.appointment_type = 'group_class'::public.appointment_type
      and a.series_occurrence_index >= v_index
  ),
  grp as (
    -- g_eq: edited groups where the occurrence ALREADY holds the value the edit makes the new series default
    -- (so a customized flag on it would be stale, and nothing needs to be preserved or overwritten).
    select b.*,
      array_remove(array[
        case when p_changes ? 'title' and btrim(p_changes ->> 'title') = btrim(b.b_title) then 'title' end,
        case when p_changes ? 'instructor_id' and b.b_instructor is not distinct from (p_changes ->> 'instructor_id')::uuid then 'instructor' end,
        case when p_changes ? 'room_id' and b.b_room is not distinct from (p_changes ->> 'room_id')::uuid then 'room' end,
        case when p_changes ? 'location_name'
              and nullif(btrim(coalesce(b.b_location, '')), '') is not distinct from nullif(btrim(coalesce(p_changes ->> 'location_name', '')), '')
             then 'location' end,
        case when p_changes ? 'roster_capacity' and b.b_capacity is not distinct from (p_changes ->> 'roster_capacity')::integer then 'capacity' end,
        case when (p_changes ? 'local_start_time' or p_changes ? 'duration_minutes')
              and (b.b_starts at time zone b.b_tz)::date = (b.b_orig at time zone b.b_tz)::date
              and (b.b_starts at time zone b.b_tz)::time = coalesce((p_changes ->> 'local_start_time')::time, b.b_def_time)
              and (extract(epoch from (b.b_ends - b.b_starts)) / 60)::integer = coalesce((p_changes ->> 'duration_minutes')::integer, b.b_def_dur)
             then 'time' end
      ], null::text) as g_eq,
      case when b.b_cls = 'eligible'
        then array(select x from unnest(v_groups) x where x = any (b.b_overrides))
        else array[]::text[]
      end as g_ov
    from base b
  ),
  app as (
    -- a_pres: flagged groups kept as they are (preserve mode, value differs from the new default)
    -- a_ovw : flagged groups whose differing value is replaced (overwrite mode)
    -- a_clr : flagged groups that end up equal to the new default, whose flag is cleared
    select g.*,
      case when g.b_cls = 'eligible' and not v_overwrite
        then array(select x from unnest(g.g_ov) x where x <> all (g.g_eq))
        else array[]::text[]
      end as a_pres,
      case when g.b_cls = 'eligible' and v_overwrite
        then array(select x from unnest(g.g_ov) x where x <> all (g.g_eq))
        else array[]::text[]
      end as a_ovw
    from grp g
  ),
  app2 as (
    select a.*,
      case when a.b_cls = 'eligible'
        then array(select x from unnest(v_groups) x where x <> all (a.a_pres))
        else array[]::text[]
      end as a_app,
      case when a.b_cls = 'eligible'
        then array(select x from unnest(a.g_ov) x where x <> all (a.a_pres))
        else array[]::text[]
      end as a_clr
    from app a
  ),
  nv as (
    select a.*,
      case when 'title' = any (a.a_app) and p_changes ? 'title' then btrim(p_changes ->> 'title') else a.b_title end as n_title,
      case when 'instructor' = any (a.a_app) and p_changes ? 'instructor_id' then (p_changes ->> 'instructor_id')::uuid else a.b_instructor end as n_instructor,
      case when 'room' = any (a.a_app) and p_changes ? 'room_id' then (p_changes ->> 'room_id')::uuid else a.b_room end as n_room,
      case when 'location' = any (a.a_app) and p_changes ? 'location_name' then nullif(btrim(coalesce(p_changes ->> 'location_name', '')), '') else a.b_location end as n_location,
      case when 'capacity' = any (a.a_app) and p_changes ? 'roster_capacity' then (p_changes ->> 'roster_capacity')::integer else a.b_capacity end as n_capacity,
      case when 'time' = any (a.a_app) and p_changes ? 'local_start_time'
        then ((((a.b_starts at time zone a.b_tz)::date + (p_changes ->> 'local_start_time')::time)::timestamp) at time zone a.b_tz)
        else a.b_starts
      end as n_starts
    from app2 a
  ),
  fin as (
    select n.*,
      case when 'time' = any (n.a_app)
        then n.n_starts + case
          when p_changes ? 'duration_minutes' then make_interval(mins => (p_changes ->> 'duration_minutes')::integer)
          else (n.b_ends - n.b_starts)
        end
        else n.b_ends
      end as n_ends
    from nv n
  )
  select
    f.b_id, f.b_series, f.b_idx, f.b_cls, f.b_booked,
    (f.b_cls = 'eligible'),
    (f.b_cls = 'eligible' and cardinality(f.a_pres) + cardinality(f.a_ovw) > 0),
    f.a_app, f.a_pres, f.a_ovw,
    f.n_title, f.n_instructor, f.n_room, f.n_location, f.n_capacity, f.n_starts, f.n_ends,
    (f.b_cls = 'eligible' and (
      f.n_title is distinct from f.b_title
      or f.n_instructor is distinct from f.b_instructor
      or f.n_room is distinct from f.b_room
      or f.n_location is distinct from f.b_location
      or f.n_capacity is distinct from f.b_capacity
      or f.n_starts is distinct from f.b_starts
      or f.n_ends is distinct from f.b_ends
      or cardinality(f.a_clr) > 0
    )),
    f.a_clr,
    (f.b_cls = 'eligible' and (
      f.n_title is distinct from f.b_title
      or f.n_instructor is distinct from f.b_instructor
      or f.n_room is distinct from f.b_room
      or f.n_location is distinct from f.b_location
      or f.n_capacity is distinct from f.b_capacity
      or f.n_starts is distinct from f.b_starts
      or f.n_ends is distinct from f.b_ends
    ))
  from fin f
  order by f.b_idx;
end;
$$;

revoke all on function public._gcsc5_edit_plan(uuid, jsonb, boolean) from public, anon, authenticated, service_role;

-- Schedule-conflict rules (instructor overlap and blocks, room unavailable / exclusive /
-- simultaneous capacity), mirroring the app's canonical conflict engine so the operation can
-- revalidate transactionally against the database state it can see (no lock or constraint
-- stops an outside writer from committing a conflicting row concurrently). Returns a reason
-- code or NULL.
create function public._gcsc5_edit_conflict(
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

-- ============================================================================
-- 4. Preview (read-only, broad staff)
-- ============================================================================
create function public.preview_group_class_series_edit(
  p_appointment_id uuid,
  p_changes jsonb,
  p_overwrite boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_studio uuid;
  v_series uuid;
  v_index integer;
  v_status text;
  v_anchor_cls text;
  v_has_earlier boolean;
  v_conflicts integer := 0;
  v_first jsonb := null;
  v_row record;
  v_reason text;
  v_blocked integer;
  v_result jsonb;
begin
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

  select s.status into v_status from public.group_class_series s where s.id = v_series;
  if v_status is distinct from 'active' then
    raise exception 'GCSC5_SERIES_NOT_EDITABLE: This series can no longer be edited.';
  end if;

  select p.classification into v_anchor_cls
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, p_overwrite) p
    where p.appointment_id = p_appointment_id;

  if v_anchor_cls is distinct from 'eligible' then
    raise exception 'GCSC5_ANCHOR_NOT_EDITABLE: This class can no longer be edited with the classes that follow it.';
  end if;

  select exists (
    select 1 from public.appointments a
    where a.group_class_series_id = v_series and a.series_occurrence_index < v_index
  ) into v_has_earlier;

  for v_row in
    select p.*, a.instructor_id as cur_instructor, a.room_id as cur_room, a.starts_at as cur_starts,
           a.ends_at as cur_ends, a.roster_capacity as cur_capacity
    from public._gcsc5_edit_plan(p_appointment_id, p_changes, p_overwrite) p
    join public.appointments a on a.id = p.appointment_id
    where p.will_edit and p.changed
    order by p.occurrence_index
  loop
    if v_row.new_instructor_id is distinct from v_row.cur_instructor
       or v_row.new_room_id is distinct from v_row.cur_room
       or v_row.new_starts_at is distinct from v_row.cur_starts
       or v_row.new_ends_at is distinct from v_row.cur_ends
    then
      v_reason := public._gcsc5_edit_conflict(
        v_studio, v_row.appointment_id, v_row.new_instructor_id, v_row.new_room_id,
        v_row.new_starts_at, v_row.new_ends_at
      );
      if v_reason is not null then
        v_conflicts := v_conflicts + 1;
        if v_first is null then
          v_first := jsonb_build_object('occurrence_index', v_row.occurrence_index, 'reason', v_reason);
        end if;
      end if;
    end if;
  end loop;

  select count(*)::integer into v_blocked
  from public._gcsc5_edit_plan(p_appointment_id, p_changes, p_overwrite) p
  join public.appointments a on a.id = p.appointment_id
  where p.will_edit and p.new_roster_capacity is not null
    and p.new_roster_capacity is distinct from a.roster_capacity
    and p.booked_count > p.new_roster_capacity;

  select jsonb_build_object(
    'series_id', v_series,
    'anchor_index', v_index,
    'will_split', v_has_earlier,
    'class_count', count(*),
    'editable_count', count(*) filter (where p.will_edit),
    'changed_count', count(*) filter (where p.values_changed),
    'cancelled_count', count(*) filter (where p.classification = 'cancelled'),
    'historical_count', count(*) filter (where p.classification = 'historical'),
    'terminal_attendance_count', count(*) filter (where p.classification = 'terminal_attendance'),
    'customized_count', count(*) filter (where p.customized),
    'customized_fields', coalesce((
      select jsonb_object_agg(g.grp, g.n)
      from (
        select x as grp, count(*) as n
        from public._gcsc5_edit_plan(p_appointment_id, p_changes, p_overwrite) p2,
             lateral unnest(p2.preserved_groups || p2.overwritten_groups) x
        group by x
      ) g
    ), '{}'::jsonb),
    'overwrite', coalesce(p_overwrite, false),
    'conflict_count', v_conflicts,
    'first_conflict', v_first,
    'capacity_blocked_count', v_blocked
  )
  into v_result
  from public._gcsc5_edit_plan(p_appointment_id, p_changes, p_overwrite) p;

  return v_result;
end;
$$;

revoke all on function public.preview_group_class_series_edit(uuid, jsonb, boolean) from public;
revoke all on function public.preview_group_class_series_edit(uuid, jsonb, boolean) from anon;
grant execute on function public.preview_group_class_series_edit(uuid, jsonb, boolean) to authenticated;
revoke all on function public.preview_group_class_series_edit(uuid, jsonb, boolean) from service_role;

-- ============================================================================
-- 5. Apply
-- ============================================================================
create function public.edit_group_class_series_from(
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
grant execute on function public.edit_group_class_series_from(uuid, uuid, jsonb, boolean) to authenticated;
revoke all on function public.edit_group_class_series_from(uuid, uuid, jsonb, boolean) from service_role;

-- ============================================================================
-- 6. S1C-4 interoperation: "this and following" cancellation spans the split lineage.
--    Same behavior for a never-split series.
-- ============================================================================
create or replace function public.preview_group_class_series_cancellation(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_series uuid;
  v_index integer;
  v_studio uuid;
  v_result jsonb;
begin
  select a.group_class_series_id, a.series_occurrence_index, a.studio_id
    into v_series, v_index, v_studio
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio is null then
    raise exception 'GCSC4_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSC4_UNAUTHORIZED: Not authorized to cancel classes in this series.';
  end if;

  if v_series is null then
    raise exception 'GCSC4_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  select jsonb_build_object(
    'series_id', v_series,
    'occurrence_index', v_index,
    'eligible_class_count', count(*) filter (where t.classification = 'eligible'),
    'enrollments_affected', coalesce(sum(t.booked_count) filter (where t.classification = 'eligible'), 0),
    'dancers_affected', (
      select count(distinct aa.client_id)
      from public._gcsc5_series_family(v_series) f2
      cross join lateral public._gcsc4_series_cancel_targets(f2.series_id, v_index) t2
      join public.appointment_attendees aa on aa.appointment_id = t2.appointment_id and aa.status = 'booked'
      where t2.classification = 'eligible'
    ),
    'already_cancelled_count', count(*) filter (where t.classification = 'already_cancelled'),
    'historical_count', count(*) filter (where t.classification = 'historical'),
    'terminal_attendance_count', count(*) filter (where t.classification = 'terminal_attendance'),
    'series_would_be_cancelled', public._gcsc4_series_remaining_after(v_series, v_index) = 0
  )
  into v_result
  from public._gcsc5_series_family(v_series) f
  cross join lateral public._gcsc4_series_cancel_targets(f.series_id, v_index) t;

  return v_result;
end;
$$;

create or replace function public.cancel_group_class_series_from(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_series uuid;
  v_index integer;
  v_studio uuid;
  v_now_series uuid;
  v_fam record;
  v_target record;
  v_current public.appointment_status;
  v_ids uuid[];
  v_cancelled integer := 0;
  v_enrollments integer := 0;
  v_already integer := 0;
  v_historical integer := 0;
  v_terminal integer := 0;
  v_by_client jsonb := '{}'::jsonb;
  v_client uuid;
  v_remaining integer;
  v_series_cancelled boolean := false;
  v_status text;
begin
  select a.group_class_series_id, a.series_occurrence_index, a.studio_id
    into v_series, v_index, v_studio
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio is null then
    raise exception 'GCSC4_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSC4_UNAUTHORIZED: Not authorized to cancel classes in this series.';
  end if;

  if v_series is null then
    raise exception 'GCSC4_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  -- Serialize concurrent series operations first. The class's series is read again once locked
  -- (a concurrent GC-S1C-5 split may have moved it into a successor), then every successor is
  -- locked in chain order; occurrences are then locked one at a time in index order (inside the
  -- canonical single-class RPC), so no lock-order cycle exists.
  for i in 1..4 loop
    perform 1 from public.group_class_series s where s.id = v_series for update;
    select a.group_class_series_id into v_now_series from public.appointments a where a.id = p_appointment_id;
    exit when v_now_series = v_series;
    v_series := v_now_series;
  end loop;

  for v_fam in
    select f.series_id from public._gcsc5_series_family(v_series) f where f.depth > 0 order by f.depth
  loop
    perform 1 from public.group_class_series s where s.id = v_fam.series_id for update;
  end loop;

  select a.series_occurrence_index into v_index from public.appointments a where a.id = p_appointment_id;

  for v_target in
    select t.*
    from public._gcsc5_series_family(v_series) f
    cross join lateral public._gcsc4_series_cancel_targets(f.series_id, v_index) t
    order by t.occurrence_index
  loop
    if v_target.classification = 'already_cancelled' then
      v_already := v_already + 1;
    elsif v_target.classification = 'historical' then
      v_historical := v_historical + 1;
    elsif v_target.classification = 'terminal_attendance' then
      v_terminal := v_terminal + 1;
    else
      -- re-read under the occurrence lock: a concurrent cancellation may have won
      select a.status into v_current
        from public.appointments a where a.id = v_target.appointment_id for update;

      if v_current = 'cancelled'::public.appointment_status then
        v_already := v_already + 1;
      else
        begin
          v_ids := public.cancel_group_class_appointment(v_target.appointment_id);
          v_cancelled := v_cancelled + 1;
          v_enrollments := v_enrollments + coalesce(cardinality(v_ids), 0);

          foreach v_client in array coalesce(v_ids, array[]::uuid[]) loop
            v_by_client := jsonb_set(
              v_by_client,
              array[v_client::text],
              coalesce(v_by_client -> v_client::text, '[]'::jsonb) || to_jsonb(v_target.starts_at),
              true
            );
          end loop;
        exception when raise_exception then
          -- attendance recorded between classification and cancellation: preserved, not fatal
          if position('GCSC2_ATTENDANCE_RECORDED' in sqlerrm) = 1 then
            v_terminal := v_terminal + 1;
          else
            raise;
          end if;
        end;
      end if;
    end if;
  end loop;

  -- Stored status per series of the lineage: cancelled only when nothing upcoming and not
  -- cancelled remains in it (a predecessor that still has upcoming earlier classes stays active).
  for v_fam in
    select f.series_id from public._gcsc5_series_family(v_series) f order by f.depth
  loop
    v_remaining := public._gcsc4_series_remaining_after(v_fam.series_id, v_index);

    if v_remaining = 0 then
      update public.group_class_series
         set status = 'cancelled'
       where id = v_fam.series_id and status = 'active';

      if found and v_fam.series_id = v_series then
        v_series_cancelled := true;
      end if;
    end if;
  end loop;

  select s.status into v_status from public.group_class_series s where s.id = v_series;

  return jsonb_build_object(
    'series_id', v_series,
    'studio_id', v_studio,
    'occurrence_index', v_index,
    'cancelled_class_count', v_cancelled,
    'enrollments_cancelled', v_enrollments,
    'already_cancelled_count', v_already,
    'historical_count', v_historical,
    'terminal_attendance_count', v_terminal,
    'series_status', v_status,
    'series_cancelled_by_this_call', v_series_cancelled,
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', e.key, 'class_starts', e.value) order by e.key)
      from jsonb_each(v_by_client) e
    ), '[]'::jsonb)
  );
end;
$$;

commit;
