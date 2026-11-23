-- Rollback of 20270223110000: restores the 20260524 policy set (any active staff role can read feed rows; owners/admins manage).
begin;
drop policy if exists "Instructors can view their own calendar feed" on public.instructor_calendar_feeds;
drop policy if exists "Studio users can view instructor calendar feeds" on public.instructor_calendar_feeds;
create policy "Studio users can view instructor calendar feeds"
on public.instructor_calendar_feeds
for select
to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.active = true
  )
);
commit;
