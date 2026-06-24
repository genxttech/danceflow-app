-- Adds organizer and platform-admin access to event_public_styles.
-- Existing studio-member and public-read policies are intentionally preserved.

begin;

alter table public.event_public_styles enable row level security;

drop policy if exists "Organizer users can view event public styles"
  on public.event_public_styles;

create policy "Organizer users can view event public styles"
  on public.event_public_styles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_public_styles.event_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

drop policy if exists "Organizer users can manage event public styles"
  on public.event_public_styles;

create policy "Organizer users can manage event public styles"
  on public.event_public_styles
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_public_styles.event_id
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
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_public_styles.event_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

drop policy if exists "Platform admins can manage event public styles"
  on public.event_public_styles;

create policy "Platform admins can manage event public styles"
  on public.event_public_styles
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.platform_role = 'platform_admin'
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.platform_role = 'platform_admin'
    )
  );

notify pgrst, 'reload schema';

commit;
