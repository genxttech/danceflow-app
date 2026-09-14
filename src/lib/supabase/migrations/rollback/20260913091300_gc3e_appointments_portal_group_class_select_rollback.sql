-- Rollback for 20260913091300_gc3e_appointments_portal_group_class_select.sql
--
-- Restores appointments_select to its exact 4-branch pre-GC-3.3 definition
-- -- the live text from 20260908100000_fc1b5d2c0c_appointments_group_class_select_cleanup.sql,
-- reproduced verbatim, not a redesign. No guard needed: RLS policy text has
-- no "existing data" to preserve, unlike a table.
--
-- IMPLEMENTATION-TIME ADDITION: gc3e also introduced a helper function,
-- is_group_class_publicly_discoverable(uuid) (added to avoid an RLS-policy
-- recursion between appointments_select and group_class_enrollment_policies_select
-- -- see gc3e's own header comment). No other object depends on it once
-- branch 5 is removed, so it is dropped unconditionally after the policy
-- is restored.

begin;

drop policy if exists "appointments_select" on public.appointments;

create policy "appointments_select" on public.appointments
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
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    instructor_id is not null
    and public.is_own_instructor_appointment(studio_id, instructor_id)
  )
  or (
    appointment_type = 'floor_space_rental'::appointment_type
    and client_id is not null
    and public.user_has_client_portal_access(studio_id, client_id)
  )
);

drop function if exists public.is_group_class_publicly_discoverable(uuid);

commit;
