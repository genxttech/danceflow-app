-- Rollback for 20260907050000_fc1b5d2_d2c_appointments_rls_tightening.sql
--
-- Restores the exact pre-D2C live DEV policy bodies (captured via direct
-- catalog query immediately before the forward migration was authored) and
-- drops the is_own_instructor_appointment helper. Wrapped in one explicit
-- transaction for the same atomicity reason as the forward migration.

begin;

-- Drop the four tightened command-specific policies.
drop policy if exists "appointments_select" on public.appointments;
drop policy if exists "appointments_insert" on public.appointments;
drop policy if exists "appointments_update" on public.appointments;
drop policy if exists "appointments_delete" on public.appointments;

-- Restore the exact original appointments_select.
create policy "appointments_select" on public.appointments
for select
to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.active = true
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
);

-- Restore the exact original appointments_insert.
create policy "appointments_insert" on public.appointments
for insert
to authenticated
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
      and usr.active = true
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
);

-- Restore the exact original appointments_update (USING and WITH CHECK
-- were identical in the pre-D2C live policy).
create policy "appointments_update" on public.appointments
for update
to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
      and usr.active = true
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
      and usr.active = true
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
);

-- Restore the exact original appointments_delete.
create policy "appointments_delete" on public.appointments
for delete
to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
);

-- Restore "studio members can view appointments" (originally PUBLIC role,
-- no explicit TO clause).
create policy "studio members can view appointments" on public.appointments
for select
using (
  public.user_has_studio_access(studio_id)
);

-- Restore "studio staff manage appointments" (originally PUBLIC role,
-- FOR ALL, no explicit TO clause -- the pre-existing broad-overlap policy
-- this migration series was written to remove).
create policy "studio staff manage appointments" on public.appointments
for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['platform_admin', 'studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
      and usr.active = true
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['platform_admin', 'studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
      and usr.active = true
  )
);

-- Restore the duplicate portal SELECT policy removed by the forward
-- migration (byte-identical body to "portal users can view own
-- appointments", which was never dropped).
create policy "portal users can view their own appointments" on public.appointments
for select
to authenticated
using (
  exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

drop function if exists public.is_own_instructor_appointment(uuid, uuid);
drop function if exists public.can_preserve_existing_group_class_for_instructor(uuid, uuid, uuid);

commit;
