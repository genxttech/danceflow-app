-- 20260524_organizer_roles_and_event_rls.sql
-- Adds organizer_owner as a supported organizer role and allows organizer users
-- to insert/update organizer-owned events through RLS.

begin;

alter table public.organizer_users
  drop constraint if exists organizer_users_role_check;

alter table public.organizer_users
  add constraint organizer_users_role_check
  check (
    role in (
      'organizer_owner',
      'organizer_admin',
      'organizer_staff'
    )
  );

drop policy if exists events_insert_by_studio_or_organizer_access
  on public.events;

create policy events_insert_by_studio_or_organizer_access
  on public.events
  for insert
  to public
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = events.studio_id
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = events.organizer_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

drop policy if exists events_update_by_studio_or_organizer_access
  on public.events;

create policy events_update_by_studio_or_organizer_access
  on public.events
  for update
  to public
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = events.studio_id
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = events.organizer_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = events.studio_id
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = events.organizer_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

commit;
