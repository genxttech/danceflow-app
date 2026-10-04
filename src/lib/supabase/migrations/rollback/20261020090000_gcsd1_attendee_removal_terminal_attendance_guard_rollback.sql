-- Rollback for 20261020090000_gcsd1_attendee_removal_terminal_attendance_guard.sql.
-- Drops the attendee-removal terminal-attendance guard and restores the released GC-1.4A cancel_class_attendee body
-- (no class-row lock). No data is changed. After rollback the roster UI still hides Remove for terminal attendance and the
-- server action still refuses it; only the database backstop is gone.

begin;

drop trigger if exists appointment_attendees_00_guard_cancel_terminal_attendance on public.appointment_attendees;
drop function if exists public.enforce_attendee_cancel_no_terminal_attendance();

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
