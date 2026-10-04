-- Rollback for 20261017090000_gcsc3_group_class_db_authority.sql.
-- Drops the five GC-S1C-3 triggers and their functions and restores the exact GC-3.1
-- body of enforce_group_class_roster_capacity (as created by
-- 20260913090800_gc3a_group_class_roster_capacity.sql; DEV and repo matched before
-- GC-S1C-3). No other appointments or appointment_attendees trigger is touched and no
-- data is changed. After rollback a tenant can again cancel a group class by table
-- UPDATE, book into a cancelled class, lower capacity below the booked count, and
-- (subject only to the enrollment-policy foreign key) delete a series occurrence, so
-- the application must not be running the GC-S1C-3 release.

begin;

drop trigger if exists appointments_gcsc3_cancel_pending_reminders on public.appointments;
drop function if exists public._gcsc3_cancel_pending_class_reminders();

drop trigger if exists appointments_guard_series_occurrence_delete on public.appointments;
drop function if exists public._gcsc3_guard_series_occurrence_delete();

drop trigger if exists appointments_03_guard_group_class_cancel_authority on public.appointments;
drop function if exists public._gcsc3_guard_group_class_cancel_authority();

drop trigger if exists appointments_04_guard_group_class_capacity_floor on public.appointments;
drop function if exists public.enforce_group_class_capacity_floor();

create or replace function public.enforce_group_class_roster_capacity()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_was_booked boolean;
  v_roster_capacity integer;
  v_reserved_count integer;
begin
  -- Not entering a counting state at all: nothing to check. Covers both
  -- "moving OUT of booked" (cancellation, always releases capacity) and
  -- "already not booked, staying not booked".
  if new.status <> 'booked' then
    return new;
  end if;

  v_was_booked := (tg_op = 'UPDATE') and (old.status = 'booked');

  -- No-op: already booked, still booked -- this write is not a new
  -- reservation (e.g. a billing-field correction on an active enrollment).
  if v_was_booked then
    return new;
  end if;

  -- Lock the group-class appointment row first -- this is what serializes
  -- concurrent enrollment attempts against the same class's roster.
  select roster_capacity into v_roster_capacity
    from public.appointments
    where id = new.appointment_id
    for update;

  if v_roster_capacity is null then
    return new;
  end if;

  v_reserved_count := public._group_class_roster_reserved_count(new.appointment_id);

  if v_reserved_count >= v_roster_capacity then
    raise exception 'This class has no available seats remaining.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_roster_capacity() from public, anon, authenticated, service_role;

commit;
