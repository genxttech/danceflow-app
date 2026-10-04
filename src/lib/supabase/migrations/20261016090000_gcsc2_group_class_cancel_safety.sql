-- ============================================================================
-- GC-S1C-2 -- authoritative group-class cancellation safety.
--
-- Hardens the EXISTING public.cancel_group_class_appointment(uuid) (GC-1.4A).
-- Same signature (uuid -> uuid[]), same SECURITY DEFINER posture, same fixed
-- search_path, same broad-staff authority helper, same grants. No new RPC,
-- no schema change.
--
-- Behavior added, in this order (cancellation is THIS OCCURRENCE ONLY):
--   1. Class not found / not authorized: unchanged messages.
--   2. The class row is locked (FOR UPDATE) and its status re-read, so two
--      concurrent cancellations serialize and the second sees 'cancelled'.
--   3. Already cancelled: idempotent no-op -- returns an empty recipient list,
--      does not restamp cancelled_at, does not touch attendees. The caller
--      therefore sends no second notification.
--   4. Any attendance_records row for this class with status 'attended' or
--      'no_show' (the consumption / historical-attendance states): refused
--      with GCSC2_ATTENDANCE_RECORDED. Recorded attendance is never rewritten
--      by an accidental cancellation; correct the attendance first. The rule
--      is based on recorded attendance only -- not on the class date, the
--      class status, or the mere existence of roster rows.
--   5. Otherwise: status -> cancelled, cancelled_at set, currently 'booked'
--      attendees -> 'cancelled', and ONLY those attendees' client ids are
--      returned for the existing cancellation notification.
--
-- Never touched here: attendance_records, client_membership_usage, package
-- items/usage, any credit, the appointment row's series identity
-- (group_class_series_id, series_occurrence_index, occurrence_original_start,
-- series_overridden_fields), neighboring occurrences, the series row, or any
-- legacy Events table. Booked-attendee cancellation is not a credit
-- restoration event.
--
-- A refusal raises an exception carrying a stable code; the application maps
-- it to fixed owner-facing copy and never shows database text.
--
-- Rollback: rollback/20261016090000_gcsc2_group_class_cancel_safety_rollback.sql
-- (restores the exact pre-S1C-2 body).
-- ============================================================================

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
  v_status public.appointment_status;
  v_affected_client_ids uuid[];
begin
  select a.studio_id into v_studio_id
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio_id) then
    raise exception 'Not authorized to cancel this class.';
  end if;

  -- Serialize concurrent cancellations of the same class and re-read the
  -- authoritative status under the lock.
  select a.status into v_status
    from public.appointments a
    where a.id = p_appointment_id
    for update;

  if v_status = 'cancelled'::public.appointment_status then
    return array[]::uuid[];
  end if;

  if exists (
    select 1
    from public.attendance_records ar
    where ar.appointment_id = p_appointment_id
      and ar.status in ('attended', 'no_show')
  ) then
    raise exception 'GCSC2_ATTENDANCE_RECORDED: This class already has attendance recorded. Correct the attendance record before cancelling the class.';
  end if;

  select coalesce(array_agg(aa.client_id), array[]::uuid[]) into v_affected_client_ids
    from public.appointment_attendees aa
    where aa.appointment_id = p_appointment_id
      and aa.status = 'booked';

  update public.appointments
  set status = 'cancelled'::public.appointment_status, cancelled_at = now()
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
