-- FC-1B5D2c-0C rollback -- restores the exact pre-migration live `appointments_
-- select` body (the full 5-branch version, including the temporary group_class
-- compatibility branch), captured verbatim from the live DEV `pg_policies`
-- catalog and cross-checked against the FC-1B5D2 D2C migration source
-- (20260907050000_fc1b5d2_d2c_appointments_rls_tightening.sql) immediately
-- before this migration was applied. Branches 1-4 are unchanged by the
-- forward migration; this rollback re-adds branch 5 to restore the exact
-- prior state.

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
  -- 5. TEMPORARY LEGACY COMPATIBILITY -- remove/review in FC-1B5D2c.
  -- Any active studio member may SELECT a group_class row regardless of
  -- teaching assignment, matching the un-hardened attendance/recap
  -- surfaces' current effective (role-blind) visibility for this one
  -- appointment_type only. SELECT-only: no equivalent branch exists on
  -- INSERT, UPDATE, or DELETE below.
  or (
    appointment_type = 'group_class'::appointment_type
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = appointments.studio_id
        and usr.active = true
    )
  )
);

commit;
