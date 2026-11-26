-- Private lessons: narrow read access to event_guest_coaches and event_private_lesson_slots.
-- Visitors (the public event page and guest-coach schedule links) are now served by the app server with named columns, so the two
-- public SELECT policies are removed. The event's own staff keep the visibility they had through those policies (published, publicly
-- listed events of an active or trial studio), and event creators keep their existing manage policies. Nothing else changes.
--
-- APPLY ORDER: deploy the app change first, then this migration. See docs/events/Private_Lesson_Read_Scope_Release.md.
begin;
set local lock_timeout = '5s';

-- Is the CURRENT caller staff who may see this event's private lessons? No user parameter, so it cannot be used to probe others.
create or replace function public.can_view_event_private_lessons(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.events e
    where e.id = p_event_id
      and (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
        or exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = e.studio_id and usr.user_id = auth.uid() and usr.active = true
            and (usr.role in ('studio_owner', 'studio_admin') or (usr.role = 'front_desk' and e.organizer_id is null)))
        or exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = e.organizer_id and ou.user_id = auth.uid() and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff'))
      )
  );
$$;
-- Default privileges grant EXECUTE to client roles, so revoke from each explicitly before granting.
revoke all on function public.can_view_event_private_lessons(uuid) from public, anon, authenticated;
grant execute on function public.can_view_event_private_lessons(uuid) to authenticated, service_role;

drop policy if exists "Event staff can read guest coaches" on public.event_guest_coaches;
create policy "Event staff can read guest coaches"
on public.event_guest_coaches
for select
to authenticated
using (
  active = true
  and public.can_view_event_private_lessons(event_id)
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

drop policy if exists "Event staff can read private lesson slots" on public.event_private_lesson_slots;
create policy "Event staff can read private lesson slots"
on public.event_private_lesson_slots
for select
to authenticated
using (
  status in ('available', 'held', 'booked')
  and public.can_view_event_private_lessons(event_id)
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

drop policy if exists "Public can read active guest coaches for public events" on public.event_guest_coaches;
drop policy if exists "Public can read available private lesson slots for public events" on public.event_private_lesson_slots;

commit;
