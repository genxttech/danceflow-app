-- TW-4F platform-admin AAL2 (defence in depth). NOT APPLIED anywhere; Git only.
-- Paths where the platform admin's OWN token reaches the database (user-scoped client or PostgREST with the anon key) previously checked only
-- profiles.platform_role, so an aal1 session could skip the server-action guard and call them directly. Require the verified JWT's aal claim here too.
-- auth.jwt() is the caller's own token on these paths (the service-role tw4_* functions never see an end-user token and are unchanged).
-- Rollback: rollback/20261231090000_twilio_platform_admin_aal2_rollback.sql.
begin;
set local lock_timeout = '5s';

-- precondition: the objects being replaced must exist (otherwise create-or-replace would make a new function with default PUBLIC execute)
do $$ begin
  if to_regprocedure('public._sms_onb_is_platform_admin()') is null or to_regclass('public.studio_sms_registrations') is null then
    raise exception 'TW4F_AAL2_PRECONDITION: 20261119090000 and 20261012090000 must be applied first';
  end if;
end $$;

create or replace function public._sms_onb_is_platform_admin()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin');
$$;

drop policy "Platform admins read studio sms registrations" on public.studio_sms_registrations;
create policy "Platform admins read studio sms registrations"
on public.studio_sms_registrations for select to authenticated
using (
  coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
);

drop policy "Platform admins create studio sms registrations" on public.studio_sms_registrations;
create policy "Platform admins create studio sms registrations"
on public.studio_sms_registrations for insert to authenticated
with check (
  coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
);

drop policy "Platform admins update studio sms registrations" on public.studio_sms_registrations;
create policy "Platform admins update studio sms registrations"
on public.studio_sms_registrations for update to authenticated
using (
  coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
)
with check (
  coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
);

-- postcondition: exactly the three policies, each requiring aal2
do $$ begin
  if (select count(*) from pg_policies where schemaname='public' and tablename='studio_sms_registrations') <> 3
     or exists (select 1 from pg_policies where schemaname='public' and tablename='studio_sms_registrations'
                and coalesce(qual,'') || coalesce(with_check,'') not like '%aal2%') then
    raise exception 'TW4F_AAL2_POSTCONDITION: studio_sms_registrations policies are not exactly the three aal2 policies';
  end if;
end $$;

commit;
