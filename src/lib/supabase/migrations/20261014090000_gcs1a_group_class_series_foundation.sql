-- ============================================================================
-- GC-S1A -- canonical group-class series: schema and authority foundation.
--
-- Scope (schema only): no RPC, no UI, no series-creation flow, no behavior
-- change for any existing appointment. A group-class SERIES is the reusable,
-- finite scheduling definition (structured recurrence + defaults); each
-- OCCURRENCE is a real canonical appointments row (appointment_type =
-- 'group_class') that points at its series. Operational state (roster,
-- attendance, credit consumption, capacity, instructor, room, cancellation)
-- stays on the occurrence; the series only carries the schedule definition
-- and the defaults future (GC-S1B) materialization copies onto occurrences.
--
-- 1. group_class_series -- finite, structured recurrence (weekdays,
--    interval_weeks, starts_on, exactly one of ends_on / occurrence_count,
--    local_start_time, IANA timezone, duration) + defaults. No RRULE, no
--    open-ended recurrence. direct_payment_amount is dormant structural
--    data mirroring group_class_enrollment_policies (no payment behavior).
-- 2. appointments: group_class_series_id, series_occurrence_index,
--    occurrence_original_start, series_overridden_fields. The private-lesson
--    recurrence_series_id / recurrence_* columns are neither reused nor
--    touched.
-- 3. Composite FK appointments(group_class_series_id, studio_id) ->
--    group_class_series(id, studio_id) ON DELETE RESTRICT: an occurrence can
--    never belong to another studio's series (database-enforced).
-- 4. enforce_group_class_series_shape (SECURITY DEFINER): timezone validity,
--    weekday normalization, same-studio + assignable default instructor,
--    same-studio default room, studio_id immutable.
-- 5. _guard_appointments_group_class_series_fields (SECURITY INVOKER, decides
--    on current_user like the repo's other guard triggers): direct anon /
--    authenticated writes can neither attach an appointment to a series nor
--    change its series identity, and every real change to an occurrence's
--    authoritative values appends the matching entry to
--    series_overridden_fields (never removed by direct writes). SECURITY
--    DEFINER writers (future series RPCs, GC-S1B/C) run as the function
--    owner and therefore are neither guarded nor tracked.
-- 6. enforce_group_class_canonical_shape(): CREATE OR REPLACE, every existing
--    rule preserved, plus: only a group_class may belong to a series.
-- 7. RLS: SELECT only (platform admin, active studio_owner/studio_admin/
--    front_desk, or the instructor assigned as series default or on any of
--    its occurrences). No INSERT/UPDATE/DELETE policy and no write grant --
--    all writes will be RPC-only.
--
-- Rollback: rollback/20261014090000_gcs1a_group_class_series_foundation_rollback.sql
-- ============================================================================

begin;

-- ============================================================================
-- 1. group_class_series
-- ============================================================================
create table public.group_class_series (
  id                       uuid primary key default gen_random_uuid(),
  studio_id                uuid not null references public.studios(id),
  title                    text not null,
  description              text,
  status                   text not null default 'active',

  -- Schedule definition (finite, structured). The occurrence wall-clock is
  -- local_start_time in `timezone` (IANA name), never a fixed UTC offset.
  timezone                 text not null,
  weekdays                 smallint[] not null,
  interval_weeks           smallint not null default 1,
  starts_on                date not null,
  ends_on                  date,
  occurrence_count         integer,
  local_start_time         time not null,
  duration_minutes         integer not null,

  -- Defaults copied onto occurrences at materialization (GC-S1B).
  default_instructor_id    uuid references public.instructors(id),
  default_room_id          uuid references public.rooms(id),
  default_location_name    text,
  default_roster_capacity  integer,

  -- Enrollment-policy defaults, mirroring group_class_enrollment_policies
  -- (GC-3.2) exactly. direct_payment_amount is DORMANT structural data: GC-S1A
  -- activates no paid enrollment and defines no pricing semantics (Phase 7).
  publicly_discoverable    boolean not null default false,
  self_enrollment_allowed  boolean not null default false,
  accepted_funding_types   text[],
  direct_payment_amount    numeric,

  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Target of the appointments composite same-studio FK.
  constraint group_class_series_id_studio_id_key unique (id, studio_id),

  constraint group_class_series_title_nonblank check (length(btrim(title)) > 0),
  constraint group_class_series_status_valid check (status in ('active', 'ended', 'cancelled')),
  constraint group_class_series_timezone_nonblank check (length(btrim(timezone)) > 0),
  constraint group_class_series_weekdays_valid
    check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  constraint group_class_series_interval_weeks_valid check (interval_weeks between 1 and 52),
  -- Finite only: exactly one end boundary.
  constraint group_class_series_finite_end_exclusive check (num_nonnulls(ends_on, occurrence_count) = 1),
  constraint group_class_series_ends_on_after_start check (ends_on is null or ends_on >= starts_on),
  constraint group_class_series_occurrence_count_valid check (occurrence_count is null or occurrence_count between 1 and 104),
  constraint group_class_series_duration_valid check (duration_minutes between 5 and 720),
  -- appointments.roster_capacity has no database bound (NULL = unlimited); a
  -- series default of zero or fewer seats is meaningless, so it is bounded here.
  constraint group_class_series_default_capacity_positive check (default_roster_capacity is null or default_roster_capacity >= 1),

  -- Policy-default checks: identical to group_class_enrollment_policies.
  constraint group_class_series_funding_types_valid
    check (
      accepted_funding_types is null
      or accepted_funding_types <@ array['membership', 'package', 'direct_payment', 'manual_other']::text[]
    ),
  constraint group_class_series_direct_payment_amount_positive
    check (direct_payment_amount is null or direct_payment_amount > 0),
  constraint group_class_series_direct_payment_requires_amount
    check (
      not ('direct_payment' = any (coalesce(accepted_funding_types, array[]::text[])))
      or direct_payment_amount is not null
    ),
  constraint group_class_series_discovery_requires_funding
    check (
      (not publicly_discoverable and not self_enrollment_allowed)
      or (accepted_funding_types is not null and cardinality(accepted_funding_types) > 0)
    )
);

comment on table public.group_class_series is
  'GC-S1A: finite canonical group-class series definition (structured recurrence + defaults). '
  'Each occurrence is an appointments row (appointment_type = group_class) with group_class_series_id set; '
  'the occurrence, not the series, is authoritative for operational state. Writes are RPC-only (no tenant write grants).';

create index idx_group_class_series_studio_status
  on public.group_class_series (studio_id, status);

-- ============================================================================
-- 2. Series shape trigger -- validation / normalization (SECURITY DEFINER so
--    it can read instructors/rooms regardless of the writer; reachable only
--    as a trigger body).
-- ============================================================================
create function public.enforce_group_class_series_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if tg_op = 'UPDATE' and new.studio_id is distinct from old.studio_id then
    raise exception 'A group-class series'' studio cannot be changed after creation.';
  end if;

  new.title := btrim(new.title);

  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone for a group-class series.';
  end if;

  -- Normalize weekdays to distinct, ascending values (the CHECK then bounds
  -- the count and the 1..7 range).
  -- An empty array is left as-is so the CHECK reports it.
  new.weekdays := coalesce(
    (select array_agg(distinct d order by d) from unnest(new.weekdays) as d),
    new.weekdays
  );

  if new.default_instructor_id is not null
     and (tg_op = 'INSERT' or new.default_instructor_id is distinct from old.default_instructor_id)
  then
    -- Same studio, active, can_instruct, linked login (landmark1a helper).
    perform public._landmark1a_assert_assignable_instructor(new.studio_id, new.default_instructor_id);
  end if;

  if new.default_room_id is not null
     and (tg_op = 'INSERT' or new.default_room_id is distinct from old.default_room_id)
  then
    if not exists (
      select 1 from public.rooms r
      where r.id = new.default_room_id
        and r.studio_id = new.studio_id
    ) then
      raise exception 'The default room does not belong to this studio.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_series_shape() from public, anon, authenticated, service_role;
-- No grant execute: reachable only as a trigger body.

create trigger group_class_series_enforce_shape
  before insert or update on public.group_class_series
  for each row
  execute function public.enforce_group_class_series_shape();

create trigger set_group_class_series_updated_at
  before update on public.group_class_series
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- 3. Series RLS / grants. SELECT only; every write is RPC-only (GC-S1B+).
--    The platform's default privileges grant anon/authenticated full table
--    privileges on new tables, so they are revoked explicitly first.
-- ============================================================================
alter table public.group_class_series enable row level security;

revoke all on table public.group_class_series from public, anon, authenticated;
grant select on table public.group_class_series to authenticated;

-- (SELECT policy is created after section 4, which adds the appointments column it references.)

-- ============================================================================
-- 4. appointments: occurrence columns, integrity constraints, indexes.
--    All nullable / defaulted: standalone classes and every other
--    appointment_type stay valid with no series. recurrence_series_id and
--    recurrence_* (private-lesson recurrence) are untouched.
-- ============================================================================
alter table public.appointments
  add column group_class_series_id uuid,
  add column series_occurrence_index integer,
  add column occurrence_original_start timestamptz,
  add column series_overridden_fields text[] not null default '{}'::text[];

alter table public.appointments
  add constraint appointments_series_occurrence_index_positive
    check (series_occurrence_index is null or series_occurrence_index >= 1),
  add constraint appointments_series_overridden_fields_valid
    check (series_overridden_fields <@ array['title', 'instructor', 'room', 'location', 'capacity', 'time']::text[]),
  add constraint appointments_series_fields_all_or_none
    check (
      (
        group_class_series_id is null
        and series_occurrence_index is null
        and occurrence_original_start is null
        and cardinality(series_overridden_fields) = 0
      )
      or (
        group_class_series_id is not null
        and series_occurrence_index is not null
        and occurrence_original_start is not null
      )
    ),
  add constraint appointments_group_class_series_fk
    foreign key (group_class_series_id, studio_id)
    references public.group_class_series (id, studio_id)
    on delete restrict;

comment on column public.appointments.group_class_series_id is
  'GC-S1A: the group_class_series this occurrence belongs to (NULL = standalone). Same-studio enforced by composite FK; group_class only.';
comment on column public.appointments.series_overridden_fields is
  'GC-S1A: fields explicitly changed on this occurrence after materialization (title, instructor, room, location, capacity, time). Appended automatically for direct tenant edits; never removed by them.';

create unique index uq_appointments_series_occurrence
  on public.appointments (group_class_series_id, series_occurrence_index)
  where group_class_series_id is not null;

create index idx_appointments_series_starts
  on public.appointments (group_class_series_id, starts_at)
  where group_class_series_id is not null;

-- Series SELECT policy (needs appointments.group_class_series_id from above).
create policy "group_class_series_select" on public.group_class_series
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_class_series.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    group_class_series.default_instructor_id is not null
    and public.is_own_instructor_appointment(group_class_series.studio_id, group_class_series.default_instructor_id)
  )
  or exists (
    select 1 from public.appointments a
    where a.group_class_series_id = group_class_series.id
      and a.studio_id = group_class_series.studio_id
      and a.instructor_id is not null
      and public.is_own_instructor_appointment(a.studio_id, a.instructor_id)
  )
);

-- ============================================================================
-- 5. enforce_group_class_canonical_shape() -- CREATE OR REPLACE. Every
--    existing rule is preserved verbatim; the only addition is that a
--    non-group_class appointment can never belong to a series.
--    (The trigger appointments_enforce_group_class_shape already exists.)
-- ============================================================================
create or replace function public.enforce_group_class_canonical_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.appointment_type = 'group_class'::public.appointment_type then
    if new.client_id is not null
       or new.partner_client_id is not null
       or new.client_package_id is not null
       or new.client_membership_id is not null
       or new.price_amount is not null
    then
      raise exception 'A shared group class cannot carry a singular attendee, package, membership, or price -- use appointment_attendees.';
    end if;
  else
    -- GC-3.1: roster_capacity is a group_class-only concept. Any other
    -- appointment_type must never carry a non-null value -- NULL (the
    -- column default) remains valid everywhere, including here.
    if new.roster_capacity is not null then
      raise exception 'Only a group class may carry a roster capacity.';
    end if;

    -- GC-S1A: series membership is a group_class-only concept.
    if new.group_class_series_id is not null then
      raise exception 'Only a group class may belong to a group-class series.';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.appointment_type is distinct from new.appointment_type then
    if old.appointment_type = 'group_class'::public.appointment_type
       or new.appointment_type = 'group_class'::public.appointment_type
    then
      raise exception 'Appointment type cannot be changed to or from group_class -- create a new appointment through the canonical class-creation path instead.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_canonical_shape() from public;
revoke all on function public.enforce_group_class_canonical_shape() from anon;
revoke all on function public.enforce_group_class_canonical_shape() from authenticated;
revoke all on function public.enforce_group_class_canonical_shape() from service_role;

-- ============================================================================
-- 6. Direct-write guard + override tracking on appointments.
--
-- SECURITY INVOKER and decided on current_user (the repo's established guard
-- pattern, e.g. appointments_00_guard_floor_rental_financial_fields): inside
-- a SECURITY DEFINER function current_user is the function owner, so the
-- definer series RPCs of GC-S1B/C are never guarded and never tracked (their
-- propagated values are not user overrides), while a direct PostgREST write
-- by anon/authenticated always is. Reads no tables, so RLS cannot interfere.
-- Named "_01_" so it sorts right after the existing "_00_" guard and before
-- the shape / assignability / updated_at triggers.
-- ============================================================================
create function public._guard_appointments_group_class_series_fields()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  v_fields text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.group_class_series_id is not null
       or new.series_occurrence_index is not null
       or new.occurrence_original_start is not null
       or cardinality(new.series_overridden_fields) > 0
    then
      raise exception 'A series occurrence can only be created through the group-class series workflow.';
    end if;
    return new;
  end if;

  if new.group_class_series_id is distinct from old.group_class_series_id
     or new.series_occurrence_index is distinct from old.series_occurrence_index
     or new.occurrence_original_start is distinct from old.occurrence_original_start
  then
    raise exception 'A class''s series membership can only be changed through the group-class series workflow.';
  end if;

  -- Override tracking. Start from the stored list: a direct write can never
  -- shrink or replace it, only grow it through a real value change.
  v_fields := old.series_overridden_fields;

  if old.group_class_series_id is not null then
    if nullif(btrim(coalesce(new.title, '')), '') is distinct from nullif(btrim(coalesce(old.title, '')), '')
       and not ('title' = any (v_fields)) then
      v_fields := v_fields || 'title'::text;
    end if;
    if new.instructor_id is distinct from old.instructor_id and not ('instructor' = any (v_fields)) then
      v_fields := v_fields || 'instructor'::text;
    end if;
    if new.room_id is distinct from old.room_id and not ('room' = any (v_fields)) then
      v_fields := v_fields || 'room'::text;
    end if;
    if nullif(btrim(coalesce(new.location_name, '')), '') is distinct from nullif(btrim(coalesce(old.location_name, '')), '')
       and not ('location' = any (v_fields)) then
      v_fields := v_fields || 'location'::text;
    end if;
    if new.roster_capacity is distinct from old.roster_capacity and not ('capacity' = any (v_fields)) then
      v_fields := v_fields || 'capacity'::text;
    end if;
    if (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at)
       and not ('time' = any (v_fields)) then
      v_fields := v_fields || 'time'::text;
    end if;
  end if;

  new.series_overridden_fields := v_fields;
  return new;
end;
$$;

revoke all on function public._guard_appointments_group_class_series_fields() from public, anon, authenticated, service_role;
-- No grant execute: reachable only as a trigger body.

create trigger appointments_01_guard_group_class_series
  before insert or update on public.appointments
  for each row
  execute function public._guard_appointments_group_class_series_fields();

commit;
