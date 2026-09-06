-- Rollback for 20260906090000_fc1b5d_phaseb_clients_rls_tightening.sql
--
-- Restores the exact pre-Phase-B live policy definitions on
-- public.clients, read directly from the DEV catalog immediately before
-- the forward migration was written:
--   - "studio staff manage clients" regains 'instructor' in its permitted
--     role array (studio_owner, studio_admin, front_desk, instructor),
--     with the platform-admin OR-clause and USING/WITH CHECK semantics
--     unchanged;
--   - "studio members can view clients" is recreated as the role-agnostic
--     SELECT policy backed by public.user_has_studio_access(studio_id).
--
-- Wrapped in an explicit transaction to match the forward migration --
-- both policy changes must land together or not at all.

begin;

drop policy if exists "studio staff manage clients" on public.clients;

create policy "studio staff manage clients" on public.clients
for all
using (
  (exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = clients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::public.app_role[])
      and usr.active = true
  ))
  or (exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  ))
)
with check (
  (exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = clients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::public.app_role[])
      and usr.active = true
  ))
  or (exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  ))
);

drop policy if exists "studio members can view clients" on public.clients;

create policy "studio members can view clients" on public.clients
for select
using ( public.user_has_studio_access(clients.studio_id) );

commit;
