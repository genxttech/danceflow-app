-- 20260524_organizer_event_child_table_rls.sql
-- Adds organizer access to event child tables that are authorized through the parent event.
-- This preserves existing studio policies and adds organizer policies.

begin;

-- Event sessions ------------------------------------------------------------

drop policy if exists "Organizer users can view event sessions"
  on public.event_sessions;

create policy "Organizer users can view event sessions"
  on public.event_sessions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_sessions.event_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

drop policy if exists "Organizer users can manage event sessions"
  on public.event_sessions;

create policy "Organizer users can manage event sessions"
  on public.event_sessions
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_sessions.event_id
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
      where e.id = event_sessions.event_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

-- Event ticket types --------------------------------------------------------

drop policy if exists "Organizer users can view event ticket types"
  on public.event_ticket_types;

create policy "Organizer users can view event ticket types"
  on public.event_ticket_types
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_ticket_types.event_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

drop policy if exists "Organizer users can manage event ticket types"
  on public.event_ticket_types;

create policy "Organizer users can manage event ticket types"
  on public.event_ticket_types
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.events e
      join public.organizer_users ou
        on ou.organizer_id = e.organizer_id
      where e.id = event_ticket_types.event_id
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
      where e.id = event_ticket_types.event_id
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
