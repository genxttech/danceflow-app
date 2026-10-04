-- ============================================================================
-- GC-S1D-1 -- database backstop: a dancer with recorded terminal attendance cannot be removed from a class.
--
-- Roster management now exposes staff removal of an enrolled dancer as a supported workflow. Removing an enrollment
-- (appointment_attendees.status booked -> cancelled) must never sever a dancer from attendance that is already recorded
-- as a final outcome, so that rule is enforced where enrollment is authoritative, not only in the UI:
--
--   1. appointment_attendees_00_guard_cancel_terminal_attendance (BEFORE UPDATE OF status, only the booked -> cancelled
--      transition): refuses with GCSD1_ATTENDEE_ATTENDANCE_RECORDED when attendance_records holds an 'attended' or
--      'no_show' row for the same class and dancer. These are the same terminal states the S1C-2 class-cancellation guard
--      protects. 'registered' and 'checked_in' are NOT terminal, so a checked-in dancer can still be removed, exactly as
--      before. Like the S1C-2 guard it is unconditional (every writer, SECURITY DEFINER), so it covers cancel_class_attendee,
--      cancel_group_class_appointment (which already refuses a class with terminal attendance first) and a direct table
--      UPDATE by broad staff (the appointment_attendees UPDATE policy permits that today). Named "_00_" so it fires first.
--   2. cancel_class_attendee (CREATE OR REPLACE, same signature, same authority model, same result): it now takes the class
--      row FOR UPDATE before the attendee update. Attendance recording takes that row FOR SHARE for terminal outcomes, so a
--      removal and an attendance write for the same class serialize: whichever is second sees the other's committed state.
--      Lock order is class row, then attendee row, the same order cancel_group_class_appointment uses.
--
-- No attendance, credit, package or membership semantics change, and no data is touched. Error code (stable prefix):
-- GCSD1_ATTENDEE_ATTENDANCE_RECORDED.
--
-- Rollback: rollback/20261020090000_gcsd1_attendee_removal_terminal_attendance_guard_rollback.sql
-- Must run in BOTH DEV and PROD.
-- ============================================================================

begin;

create function public.enforce_attendee_cancel_no_terminal_attendance()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  if old.status is distinct from 'booked' or new.status is distinct from 'cancelled' then
    return new;
  end if;

  if exists (
    select 1
    from public.attendance_records ar
    where ar.appointment_id = new.appointment_id
      and ar.client_id = new.client_id
      and ar.status in ('attended', 'no_show')
  ) then
    raise exception 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED: This dancer already has attendance recorded for this class. Correct the attendance record before removing them from the class.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_attendee_cancel_no_terminal_attendance() from public, anon, authenticated, service_role;
-- No grant: reachable only as a trigger body.

create trigger appointment_attendees_00_guard_cancel_terminal_attendance
  before update of status on public.appointment_attendees
  for each row
  when (old.status = 'booked' and new.status = 'cancelled')
  execute function public.enforce_attendee_cancel_no_terminal_attendance();

create or replace function public.cancel_class_attendee(
  p_attendee_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_appointment_id uuid;
  v_authority text;
begin
  select studio_id, appointment_id into v_studio_id, v_appointment_id
    from public.appointment_attendees
    where id = p_attendee_id;

  if v_studio_id is null then
    raise exception 'Enrollment not found.';
  end if;

  v_authority := public._gc1_4_class_enrollment_authority(v_studio_id, v_appointment_id);

  if v_authority is null then
    raise exception 'Not authorized to manage this class''s roster.';
  end if;

  -- GC-S1D-1: serialize with attendance recording for this class (class row first, then the attendee row).
  perform 1 from public.appointments a where a.id = v_appointment_id for update;

  update public.appointment_attendees
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where id = p_attendee_id
    and status <> 'cancelled';
end;
$$;

revoke all on function public.cancel_class_attendee(uuid) from public;
revoke all on function public.cancel_class_attendee(uuid) from anon;
grant execute on function public.cancel_class_attendee(uuid) to authenticated;
revoke all on function public.cancel_class_attendee(uuid) from service_role;

commit;
