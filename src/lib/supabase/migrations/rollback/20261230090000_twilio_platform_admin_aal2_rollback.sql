-- Rollback of 20261230090000_twilio_platform_admin_aal2.sql: restores the role-only checks (as in 20261119090000 and 20261012090000).
begin;

create or replace function public._sms_onb_is_platform_admin()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin');
$$;

drop policy if exists "Platform admins read studio sms registrations" on public.studio_sms_registrations;
create policy "Platform admins read studio sms registrations"
on public.studio_sms_registrations for select to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'));

drop policy if exists "Platform admins create studio sms registrations" on public.studio_sms_registrations;
create policy "Platform admins create studio sms registrations"
on public.studio_sms_registrations for insert to authenticated
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'));

drop policy if exists "Platform admins update studio sms registrations" on public.studio_sms_registrations;
create policy "Platform admins update studio sms registrations"
on public.studio_sms_registrations for update to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'));

commit;
