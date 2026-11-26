-- Private lessons: narrow read access to event_guest_coaches and event_private_lesson_slots.
-- Visitors (the public event page and guest-coach schedule links) are now served by the app server with named columns, so the two
-- public SELECT policies are removed. The event's own staff keep the visibility they had through those policies (published, publicly
-- listed events of an active or trial studio), and event creators keep their existing manage policies. Nothing else changes.
--
-- APPLY ORDER: deploy the app change first, then this migration. See docs/events/Private_Lesson_Read_Scope_Release.md.
begin;
set local lock_timeout = '5s';

-- May the CURRENT caller read this event's private lessons as staff? True only for a published, publicly listed event of an
-- active or trial studio AND a staff role on it. The listing test lives here so it does not depend on the caller's own read
-- access to events or studios. No user parameter, so it cannot be used to probe others.
create or replace function public.can_view_event_private_lessons(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.events e
    join public.studios s on s.id = e.studio_id
    where e.id = p_event_id
      and e.status = 'published'
      and (e.visibility = 'public' or e.public_directory_enabled = true)
      and s.subscription_status in ('active', 'trialing')
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
using (active = true and public.can_view_event_private_lessons(event_id));

drop policy if exists "Event staff can read private lesson slots" on public.event_private_lesson_slots;
create policy "Event staff can read private lesson slots"
on public.event_private_lesson_slots
for select
to authenticated
using (status in ('available', 'held', 'booked') and public.can_view_event_private_lessons(event_id));

drop policy if exists "Public can read active guest coaches for public events" on public.event_guest_coaches;
drop policy if exists "Public can read available private lesson slots for public events" on public.event_private_lesson_slots;

-- Fail closed: a policy that exists only in a hosted database (under another name) must stop this migration, not survive it.
do $$
declare bad text;
begin
  select string_agg(tablename || ': ' || policyname, '; ') into bad
  from pg_policies
  where schemaname = 'public' and tablename in ('event_guest_coaches', 'event_private_lesson_slots')
    and roles && array['public', 'anon']::name[];
  if bad is not null then
    raise exception 'Unexpected visitor policy remains (%). Nothing was changed.', bad;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('event_guest_coaches', 'event_private_lesson_slots')
    group by tablename having count(*) <> 2
  ) then
    raise exception 'Expected exactly two policies per private-lesson table. Nothing was changed.';
  end if;
end $$;

commit;
