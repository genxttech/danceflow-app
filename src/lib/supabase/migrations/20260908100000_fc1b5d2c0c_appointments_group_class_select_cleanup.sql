-- FC-1B5D2c-0C: Remove Temporary group_class Appointment SELECT Compatibility
-- Branch.
--
-- FC-1B5D2 D2C (20260907050000) introduced `appointments_select` with a
-- fifth, explicitly TEMPORARY branch: any active studio member (any role,
-- including an ordinary instructor with no assignment to the row) could
-- SELECT any group_class appointment, matching the un-hardened attendance/
-- recap surfaces' effective breadth for that one type at the time. FC-1B5D2c-0A
-- (application layer, requireAppointmentRelationshipAccess) and FC-1B5D2c-0B
-- (RLS on attendance_records/group_lesson_recaps/group_lesson_recap_recipients/
-- group_lesson_recap_syllabus_steps) have since replaced that dependency with
-- relationship-aware authorization. A full dependency audit (calendar,
-- appointment detail, attendance page/actions, recap actions, portal
-- schedule/detail/dashboard, independent-instructor schedule, exports, and a
-- broad grep sweep for any other group_class-scoped read) found no remaining
-- legitimate workflow relies on this branch -- see the FC-1B5D2c-0C preflight.
--
-- This migration removes ONLY that branch. Branches 1-4 (platform_admin,
-- broad operational roles, own teaching relationship, own floor rental) are
-- reproduced byte-identical. No other policy on `appointments`, no helper
-- function, and no table schema is touched.

begin;

drop policy if exists "appointments_select" on public.appointments;

create policy "appointments_select" on public.appointments
for select
to authenticated
using (
  -- 1. platform admin: broad, studio-role-independent.
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  -- 2. broad operational roles at this studio.
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  -- 3. own teaching relationship.
  or (
    instructor_id is not null
    and public.is_own_instructor_appointment(studio_id, instructor_id)
  )
  -- 4. own floor rental (independent instructor, staff-side /app surface).
  or (
    appointment_type = 'floor_space_rental'::appointment_type
    and client_id is not null
    and public.user_has_client_portal_access(studio_id, client_id)
  )
);

commit;
