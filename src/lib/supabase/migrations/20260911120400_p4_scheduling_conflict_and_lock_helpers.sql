-- Membership Usage-Period Alignment -- P4: scheduling-conflict helper +
-- deterministic scheduling-resource serialization.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, sections W, X.
--
-- Confirmed live before writing this file: zero exclusion or unique
-- constraints on public.appointments bound instructor/room overlap
-- (select conname, contype from pg_constraint where conrelid =
-- 'public.appointments'::regclass and contype in ('x','u') returns zero
-- rows), and no existing trigger prevents double-booking -- there is no
-- existing DB-level double-booking protection for any writer, of any
-- billing type, today. This migration is what closes that gap.

begin;

-- ============================================================================
-- 1. Scheduling conflict helper (plan section W). Plain range-overlap
--    checks against three independent resource-unavailability sources --
--    not a reimplementation of recurring slot generation.
-- ============================================================================
create or replace function public._assert_no_scheduling_conflict(
  p_studio_id uuid, p_instructor_id uuid, p_room_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_appointment_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  if p_instructor_id is not null and exists (
    select 1 from public.appointments a
    where a.studio_id = p_studio_id and a.instructor_id = p_instructor_id
      and a.status in ('scheduled', 'rescheduled')
      and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
      and a.starts_at < p_ends_at and a.ends_at > p_starts_at
  ) then
    raise exception 'This instructor is not available at the requested time.';
  end if;

  if p_room_id is not null and exists (
    select 1 from public.appointments a
    where a.studio_id = p_studio_id and a.room_id = p_room_id
      and a.status in ('scheduled', 'rescheduled')
      and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
      and a.starts_at < p_ends_at and a.ends_at > p_starts_at
  ) then
    raise exception 'This room is not available at the requested time.';
  end if;

  if exists (
    select 1 from public.instructor_schedule_blocks b
    where b.studio_id = p_studio_id
      and (b.instructor_id = p_instructor_id or b.room_id = p_room_id)
      and b.starts_at < p_ends_at and b.ends_at > p_starts_at
  ) then
    raise exception 'The requested time conflicts with an instructor schedule block.';
  end if;

  if exists (
    select 1 from public.studio_booking_blackouts bo
    where bo.studio_id = p_studio_id and bo.active = true
      and (bo.instructor_id is null or bo.instructor_id = p_instructor_id)
      and (bo.room_id is null or bo.room_id = p_room_id)
      and bo.starts_at < p_ends_at and bo.ends_at > p_starts_at
  ) then
    raise exception 'The requested time falls within a studio blackout period.';
  end if;
end;
$$;

revoke all on function public._assert_no_scheduling_conflict(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated, service_role;

-- ============================================================================
-- 2. Deterministic scheduling-resource serialization (plan section X).
--    Row-locks the instructors/rooms tables themselves (this codebase's
--    established idiom, e.g. GC-1.2's client_memberships/client_packages
--    FOR UPDATE locks) rather than introducing advisory locks, which have
--    no precedent anywhere in this codebase's migrations. Global lock
--    order for every caller, staff and student alike: instructors row,
--    then rooms row, then (inside the entitlement core that runs
--    immediately after this) client_memberships row(s).
-- ============================================================================
create or replace function public._lock_and_check_scheduling_resources(
  p_studio_id uuid, p_instructor_id uuid, p_room_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_appointment_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  if p_instructor_id is not null then
    perform 1 from public.instructors where id = p_instructor_id for update;
  end if;
  if p_room_id is not null then
    perform 1 from public.rooms where id = p_room_id for update;
  end if;

  -- Recheck AFTER acquiring the lock -- this is what makes the check-then-
  -- write sequence atomic: a concurrent transaction targeting the same
  -- instructor/room cannot even perform its own recheck until this
  -- transaction commits or rolls back.
  perform public._assert_no_scheduling_conflict(
    p_studio_id, p_instructor_id, p_room_id, p_starts_at, p_ends_at, p_exclude_appointment_id
  );
end;
$$;

revoke all on function public._lock_and_check_scheduling_resources(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated, service_role;

commit;
