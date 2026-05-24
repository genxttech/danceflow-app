begin;

drop policy if exists "Organizer users can view event registrations"
on public.event_registrations;

create policy "Organizer users can view event registrations"
on public.event_registrations
for select
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.organizer_users ou
      on ou.organizer_id = e.organizer_id
    where e.id = event_registrations.event_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in (
        'organizer_owner',
        'organizer_admin',
        'organizer_staff'
      )
  )
);

drop policy if exists "Organizer users can manage event registrations"
on public.event_registrations;

create policy "Organizer users can manage event registrations"
on public.event_registrations
for all
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.organizer_users ou
      on ou.organizer_id = e.organizer_id
    where e.id = event_registrations.event_id
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
    where e.id = event_registrations.event_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in (
        'organizer_owner',
        'organizer_admin',
        'organizer_staff'
      )
  )
);

drop policy if exists "Organizer users can view event registration attendees"
on public.event_registration_attendees;

create policy "Organizer users can view event registration attendees"
on public.event_registration_attendees
for select
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.organizer_users ou
      on ou.organizer_id = e.organizer_id
    where e.id = event_registration_attendees.event_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in (
        'organizer_owner',
        'organizer_admin',
        'organizer_staff'
      )
  )
);

drop policy if exists "Organizer users can manage event registration attendees"
on public.event_registration_attendees;

create policy "Organizer users can manage event registration attendees"
on public.event_registration_attendees
for all
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.organizer_users ou
      on ou.organizer_id = e.organizer_id
    where e.id = event_registration_attendees.event_id
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
    where e.id = event_registration_attendees.event_id
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