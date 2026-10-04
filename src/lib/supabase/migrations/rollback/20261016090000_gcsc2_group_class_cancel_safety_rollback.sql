-- Rollback for 20261016090000_gcsc2_group_class_cancel_safety.sql.
-- Restores the exact pre-S1C-2 body of public.cancel_group_class_appointment
-- (as created by 20260910100000_gc1_4_group_class_enrollment_write_rpcs.sql;
-- DEV and PROD hashes matched before S1C-2). Same signature, so CREATE OR
-- REPLACE; grants are restated identically. Safe to run at any time: the
-- function holds no data. After rollback the terminal-attendance refusal and
-- the already-cancelled no-op are gone, so the application must not be
-- running the S1C-2 release.

begin;

create or replace function public.cancel_group_class_appointment(
  p_appointment_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_affected_client_ids uuid[];
begin
  select studio_id into v_studio_id
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio_id) then
    raise exception 'Not authorized to cancel this class.';
  end if;

  select coalesce(array_agg(client_id), array[]::uuid[]) into v_affected_client_ids
    from public.appointment_attendees
    where appointment_id = p_appointment_id
      and status = 'booked';

  update public.appointments
  set status = 'cancelled'::appointment_status, cancelled_at = now()
  where id = p_appointment_id;

  update public.appointment_attendees
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where appointment_id = p_appointment_id
    and status = 'booked';

  return v_affected_client_ids;
end;
$$;

revoke all on function public.cancel_group_class_appointment(uuid) from public;
revoke all on function public.cancel_group_class_appointment(uuid) from anon;
grant execute on function public.cancel_group_class_appointment(uuid) to authenticated;
revoke all on function public.cancel_group_class_appointment(uuid) from service_role;

commit;
