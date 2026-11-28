-- Rollback of 20270223150000. WARNING: this restores the broad visitor read access the migration removed. Use only if the app
-- cannot be fixed forward, and roll back this SQL BEFORE rolling the app back to a build that reads these tables as a visitor.
begin;
set local lock_timeout = '5s';

drop policy if exists "Public can read active guest coaches for public events" on public.event_guest_coaches;
create policy "Public can read active guest coaches for public events"
on public.event_guest_coaches
for select
using (
  active = true
  and exists (
    select 1
    from public.events e
    join public.studios s on s.id = e.studio_id
    where e.id = event_guest_coaches.event_id
      and e.status = 'published'
      and (e.visibility = 'public' or e.public_directory_enabled = true)
      and s.subscription_status in ('active', 'trialing')
  )
);

drop policy if exists "Public can read available private lesson slots for public events" on public.event_private_lesson_slots;
create policy "Public can read available private lesson slots for public events"
on public.event_private_lesson_slots
for select
using (
  status in ('available', 'held', 'booked')
  and exists (
    select 1
    from public.events e
    join public.studios s on s.id = e.studio_id
    where e.id = event_private_lesson_slots.event_id
      and e.status = 'published'
      and (e.visibility = 'public' or e.public_directory_enabled = true)
      and s.subscription_status in ('active', 'trialing')
  )
);

drop policy if exists "Event staff can read guest coaches" on public.event_guest_coaches;
drop policy if exists "Event staff can read private lesson slots" on public.event_private_lesson_slots;
drop function if exists public.can_view_event_private_lessons(uuid);

commit;
