-- ============================================================================
-- GC-S1C-3 -- canonical group-class database authority backstops.
--
-- Closes four tenant-reachable gaps that were protected only in the application
-- (reproduced in DEV before this migration was written):
--   R1. a direct tenant-role UPDATE of appointments.status to 'cancelled' (the
--       assigned instructor, or broad staff) bypassed cancel_group_class_appointment
--       and left booked attendees on a cancelled class;
--   R2. enroll_class_attendee (and every other booked-attendee writer) could book a
--       client into a CANCELLED group class;
--   R3. a direct UPDATE could lower roster_capacity below the booked attendee count;
--   R4. deleting a series occurrence was refused only by the application (the table
--       was incidentally protected by the enrollment-policy foreign key while a
--       policy row exists; nothing explicit).
-- Plus the narrow queued-reminder invalidation (D11): a cancelled class cannot send
-- an already-queued class reminder (the send route also revalidates at send time).
--
-- 1. enforce_group_class_roster_capacity (CREATE OR REPLACE, GC-3.1 body preserved):
--    the same trigger that already locks the class row FOR UPDATE before counting
--    now also reads the class status under that lock and refuses a booked
--    enrollment on a cancelled class (GCSC3_CLASS_CANCELLED). Lock order unchanged
--    (the appointment row is taken first), so it serializes with
--    cancel_group_class_appointment's FOR UPDATE: exactly one wins.
-- 2. appointments_04_guard_group_class_capacity_floor (BEFORE UPDATE OF
--    roster_capacity): a LOWERING of capacity below the reserved (booked) count is
--    refused (GCSC3_CAPACITY_BELOW_BOOKED). The UPDATE already holds the row lock,
--    and enrollment takes the same lock before counting, so it is race-safe.
--    Raising capacity, setting it to the booked count, clearing it, and updates that
--    do not change it are untouched. Applies to every writer (an invariant).
-- 3. appointments_03_guard_group_class_cancel_authority (BEFORE UPDATE OF status):
--    a tenant role (anon/authenticated) can no longer move a group class to
--    'cancelled' by table UPDATE; the SECURITY DEFINER cancellation RPC (which runs
--    as the function owner) and service_role are not affected. Named "_03_" so the
--    S1C-2 appointment-side guard ("_02_", GCSC2_ATTENDANCE_RECORDED) still speaks
--    first for a class with recorded attendance. Non-cancellation edits, including
--    the assigned instructor's single-occurrence edits, are untouched.
-- 4. appointments_guard_series_occurrence_delete (BEFORE DELETE): a tenant role
--    cannot delete an appointment that belongs to a group_class_series. Standalone
--    and non-series appointments are untouched.
-- 5. appointments_gcsc3_cancel_pending_reminders (AFTER UPDATE OF status):
--    when a group class becomes cancelled, its still-pending client reminders in
--    notification_deliveries are marked 'cancelled'. SECURITY DEFINER, trigger-only.
--
-- Every new function is trigger-only with EXECUTE revoked from public, anon,
-- authenticated and service_role. No grant or RLS policy changes. No data is
-- changed by this migration.
--
-- Rollback: rollback/20261017090000_gcsc3_group_class_db_authority_rollback.sql
-- (restores the exact GC-3.1 body of enforce_group_class_roster_capacity and drops
-- the new triggers and functions). Must run in BOTH DEV and PROD.
-- ============================================================================

begin;

-- ============================================================================
-- 1. Booked enrollment into a cancelled class (extends the GC-3.1 trigger)
-- ============================================================================
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
  v_class_status public.appointment_status;
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
  -- concurrent enrollment attempts against the same class's roster, and (GC-S1C-3)
  -- against a concurrent cancellation, which takes the same lock.
  select roster_capacity, status into v_roster_capacity, v_class_status
    from public.appointments
    where id = new.appointment_id
    for update;

  -- GC-S1C-3: a cancelled class takes no new booked enrollment.
  if v_class_status = 'cancelled'::public.appointment_status then
    raise exception 'GCSC3_CLASS_CANCELLED: This class has been cancelled and can''t take new students.';
  end if;

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

-- ============================================================================
-- 2. Capacity floor
-- ============================================================================
create function public.enforce_group_class_capacity_floor()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_reserved integer;
begin
  -- Only a LOWERING of a limit can strand booked students: clearing the limit or
  -- raising it never can.
  if new.roster_capacity is null
     or (old.roster_capacity is not null and new.roster_capacity >= old.roster_capacity)
  then
    return new;
  end if;

  -- The UPDATE already holds this row's lock; enrollment takes the same lock before
  -- it counts, so the count below cannot race a booking.
  v_reserved := public._group_class_roster_reserved_count(new.id);

  if v_reserved > new.roster_capacity then
    raise exception 'GCSC3_CAPACITY_BELOW_BOOKED: Maximum students cannot be lower than the % students already booked.', v_reserved;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_capacity_floor() from public, anon, authenticated, service_role;

create trigger appointments_04_guard_group_class_capacity_floor
  before update of roster_capacity on public.appointments
  for each row
  when (new.appointment_type = 'group_class'::public.appointment_type
        and new.roster_capacity is not null
        and new.roster_capacity is distinct from old.roster_capacity)
  execute function public.enforce_group_class_capacity_floor();

-- ============================================================================
-- 3. Canonical cancellation authority (tenant roles cannot cancel by table UPDATE)
--    SECURITY INVOKER and decided on current_user, like the repo's other tenant
--    guards: the SECURITY DEFINER RPC runs as the function owner.
-- ============================================================================
create function public._gcsc3_guard_group_class_cancel_authority()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'GCSC3_CANCEL_VIA_RPC_ONLY: A class can only be cancelled through the class cancellation workflow.';
  end if;

  return new;
end;
$$;

revoke all on function public._gcsc3_guard_group_class_cancel_authority() from public, anon, authenticated, service_role;

create trigger appointments_03_guard_group_class_cancel_authority
  before update of status on public.appointments
  for each row
  when (new.appointment_type = 'group_class'::public.appointment_type
        and old.status is distinct from 'cancelled'::public.appointment_status
        and new.status = 'cancelled'::public.appointment_status)
  execute function public._gcsc3_guard_group_class_cancel_authority();

-- ============================================================================
-- 4. Series-occurrence delete authority
-- ============================================================================
create function public._gcsc3_guard_series_occurrence_delete()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'GCSC3_SERIES_OCCURRENCE_DELETE: A class that belongs to a series cannot be deleted. Cancel it instead.';
  end if;

  return old;
end;
$$;

revoke all on function public._gcsc3_guard_series_occurrence_delete() from public, anon, authenticated, service_role;

create trigger appointments_guard_series_occurrence_delete
  before delete on public.appointments
  for each row
  when (old.group_class_series_id is not null)
  execute function public._gcsc3_guard_series_occurrence_delete();

-- ============================================================================
-- 5. Queued class reminders die with the class (D11, narrow)
-- ============================================================================
create function public._gcsc3_cancel_pending_class_reminders()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  update public.notification_deliveries
     set status = 'cancelled',
         failure_reason = 'class_cancelled'
   where related_appointment_id = new.id
     and status = 'pending'
     and delivery_type in ('student_lesson_reminder_24h', 'student_lesson_reminder_2h');

  return null;
end;
$$;

revoke all on function public._gcsc3_cancel_pending_class_reminders() from public, anon, authenticated, service_role;

create trigger appointments_gcsc3_cancel_pending_reminders
  after update of status on public.appointments
  for each row
  when (new.appointment_type = 'group_class'::public.appointment_type
        and old.status is distinct from 'cancelled'::public.appointment_status
        and new.status = 'cancelled'::public.appointment_status)
  execute function public._gcsc3_cancel_pending_class_reminders();

commit;
