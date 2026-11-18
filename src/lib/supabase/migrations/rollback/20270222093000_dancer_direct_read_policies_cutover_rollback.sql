-- Rollback of 20270222093000: restores the three dancer-self policies exactly as they were on PROD (2026-11-18 read-only capture).
begin;

drop policy if exists event_registrations_self_select on public.event_registrations;
create policy event_registrations_self_select on public.event_registrations
  for select to public
  using (user_id = auth.uid());

drop policy if exists event_registration_attendees_self_select on public.event_registration_attendees;
create policy event_registration_attendees_self_select on public.event_registration_attendees
  for select to authenticated
  using (exists (select 1 from public.event_registrations er
                 where er.id = event_registration_attendees.registration_id
                   and (er.user_id = auth.uid() or er.portal_user_id = auth.uid())));

drop policy if exists event_registration_attendees_self_insert on public.event_registration_attendees;
create policy event_registration_attendees_self_insert on public.event_registration_attendees
  for insert to authenticated
  with check (exists (select 1 from public.event_registrations er
                      where er.id = event_registration_attendees.registration_id
                        and (er.user_id = auth.uid() or er.portal_user_id = auth.uid())));

commit;
