-- 20261010090000_launchsec2a_owner_billing_authority_rollback.sql
--
-- Reviewed rollback for LAUNCH-SEC-2A. NEVER run automatically.
--
-- WARNING: this REOPENS organizer self-escalation (any active studio member can
-- again grant organizer roles and change organizer billing/payment fields).
-- Run only with explicit authorization.
--
-- Order for a full 2A rollback: roll the application back FIRST (the 2A app
-- writes organizers/organizer_users with the service role, which works under
-- either schema), then run this file.
--
-- Restores the exact pre-2A policies (definitions as captured from DEV/PROD
-- before 2A, identical on both) and removes the guard. No data change.

begin;

do $$
begin
  if to_regprocedure('public._guard_organizers_server_owned_fields()') is null
     or not exists (select 1 from pg_trigger
                    where tgrelid = 'public.organizers'::regclass
                      and tgname = 'guard_organizers_server_owned_fields') then
    raise exception 'LAUNCH-SEC-2A rollback: 2A guard is not present';
  end if;

  if exists (select 1 from pg_policy
             where polrelid in ('public.organizers'::regclass, 'public.organizer_users'::regclass)
               and polname in ('organizer_users_insert_by_studio_role',
                               'organizer_users_update_by_studio_role',
                               'organizers_insert_by_studio_role')) then
    raise exception 'LAUNCH-SEC-2A rollback: pre-2A policies already present';
  end if;
end $$;

drop trigger guard_organizers_server_owned_fields on public.organizers;
drop function public._guard_organizers_server_owned_fields();

create policy organizers_insert_by_studio_role on public.organizers
for insert
with check (
  (studio_id is not null)
  and (exists (
    select 1
    from user_studio_roles usr
    where ((usr.user_id = auth.uid()) and (usr.studio_id = organizers.studio_id) and (usr.active = true))
  ))
);

create policy organizer_users_insert_by_studio_role on public.organizer_users
for insert
with check (
  exists (
    select 1
    from (organizers o
      join user_studio_roles usr on ((usr.studio_id = o.studio_id)))
    where ((o.id = organizer_users.organizer_id) and (usr.user_id = auth.uid()) and (usr.active = true))
  )
);

create policy organizer_users_update_by_studio_role on public.organizer_users
for update
using (
  exists (
    select 1
    from (organizers o
      join user_studio_roles usr on ((usr.studio_id = o.studio_id)))
    where ((o.id = organizer_users.organizer_id) and (usr.user_id = auth.uid()) and (usr.active = true))
  )
)
with check (
  exists (
    select 1
    from (organizers o
      join user_studio_roles usr on ((usr.studio_id = o.studio_id)))
    where ((o.id = organizer_users.organizer_id) and (usr.user_id = auth.uid()) and (usr.active = true))
  )
);

-- Must restore the exact pre-2A definitions.
do $$
declare
  v_policies text;
begin
  select string_agg(
           c.relname || '.' || p.polname || ':' || p.polcmd::text || ':'
           || md5(coalesce(pg_get_expr(p.polqual, p.polrelid), '')) || ':'
           || md5(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')),
           ',' order by c.relname, p.polname)
    into v_policies
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polrelid in ('public.organizers'::regclass, 'public.organizer_users'::regclass);

  if v_policies is distinct from
       'organizer_users.organizer_users_insert_by_studio_role:a:d41d8cd98f00b204e9800998ecf8427e:1c51ed42a06f053a59956dd6462683e6,'
    || 'organizer_users.organizer_users_select_by_studio_role_or_self:r:510b4666f599690b715be267205f4f1f:d41d8cd98f00b204e9800998ecf8427e,'
    || 'organizer_users.organizer_users_update_by_studio_role:w:1c51ed42a06f053a59956dd6462683e6:1c51ed42a06f053a59956dd6462683e6,'
    || 'organizers.organizers_insert_by_studio_role:a:d41d8cd98f00b204e9800998ecf8427e:a8bcfbbc64e9d41536b3746a8d0ad255,'
    || 'organizers.organizers_public_read_active:r:4edddc86d6a5ca53305b1985a672869e:d41d8cd98f00b204e9800998ecf8427e,'
    || 'organizers.organizers_select_by_studio_role:r:e4b2ce858493206c2bf98149d8aa4d1d:d41d8cd98f00b204e9800998ecf8427e,'
    || 'organizers.organizers_update_by_studio_role:w:e4b2ce858493206c2bf98149d8aa4d1d:e4b2ce858493206c2bf98149d8aa4d1d' then
    raise exception 'LAUNCH-SEC-2A rollback: restored policies do not match the pre-2A definitions: %', v_policies;
  end if;
end $$;

commit;
