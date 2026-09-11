-- GC-1.4A rollback -- 20260910100000_gc1_4_group_class_enrollment_write_rpcs.
--
-- IMPORTANT PRECONDITION: only run this together with reverting the
-- Release A application deploy that depends on these functions. Running it
-- while GC-1.4A application code is still live will immediately break
-- every class write/check-in action with "function does not exist" errors
-- -- a worse failure mode than whatever prompted the rollback.
--
-- Restores get_client_appointments_for_checkin and
-- get_client_appointment_for_checkin_validation to their exact pre-GC-1.4A
-- definitions (FC-1B5D2 D2C-0B, 20260907040000). Reverts
-- appointment_attendees.source's CHECK constraint to its original four
-- values -- guarded: aborts if any row already has source='instructor',
-- since reverting the constraint over existing 'instructor'-sourced rows
-- would violate the constraint being added back. Drops every other GC-1.4A
-- object outright (purely additive from those objects' own perspective).

begin;

do $$
begin
  if exists (
    select 1 from public.appointment_attendees where source = 'instructor'
  ) then
    raise exception 'Cannot roll back appointment_attendees.source CHECK constraint: rows with source = ''instructor'' already exist. Re-classify or remove them before rolling back, or skip this constraint revert and keep the widened constraint in place.';
  end if;
end;
$$;

alter table public.appointment_attendees
  drop constraint appointment_attendees_source_check;

alter table public.appointment_attendees
  add constraint appointment_attendees_source_check
  check (source = any (array['staff', 'portal', 'self_service', 'booking_request']::text[]));

drop trigger if exists appointments_enforce_group_class_shape on public.appointments;
drop function if exists public.enforce_group_class_canonical_shape();
drop function if exists public.check_in_own_class_attendance(uuid, uuid);
drop function if exists public.cancel_group_class_appointment(uuid);
drop function if exists public.cancel_class_attendee(uuid);
drop function if exists public.enroll_class_attendee(uuid, uuid, text, uuid, uuid);
drop function if exists public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz);
drop function if exists public._gc1_4_class_enrollment_authority(uuid, uuid);
drop function if exists public._gc1_4_has_broad_studio_authority(uuid);

create or replace function public.get_client_appointments_for_checkin(
  target_studio_id uuid,
  qr_token text,
  range_start timestamptz,
  range_end timestamptz
)
returns table (
  id uuid,
  title text,
  appointment_type text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  instructor_first_name text,
  instructor_last_name text,
  room_name text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.title,
    a.appointment_type,
    a.status,
    a.starts_at,
    a.ends_at,
    i.first_name as instructor_first_name,
    i.last_name as instructor_last_name,
    r.name as room_name
  from public.appointments a
  left join public.instructors i on i.id = a.instructor_id
  left join public.rooms r on r.id = a.room_id
  where a.studio_id = target_studio_id
    and a.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token)
    and a.starts_at >= range_start
    and a.starts_at < range_end
  order by a.starts_at asc;
$$;

revoke all on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) from anon;
grant execute on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) to service_role;

create or replace function public.get_client_appointment_for_checkin_validation(
  target_studio_id uuid,
  qr_token text,
  target_appointment_id uuid
)
returns table (
  id uuid,
  appointment_type text,
  status text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.appointment_type,
    a.status
  from public.appointments a
  where a.id = target_appointment_id
    and a.studio_id = target_studio_id
    and a.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token);
$$;

revoke all on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) from public;
revoke all on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) from anon;
grant execute on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) to authenticated;
grant execute on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) to service_role;

commit;
