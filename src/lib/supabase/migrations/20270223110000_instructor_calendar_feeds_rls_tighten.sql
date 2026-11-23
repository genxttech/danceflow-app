-- 20270223110000_instructor_calendar_feeds_rls_tighten.sql
-- Integrations Slice 0 / ICS privacy. instructor_calendar_feeds.token is a bearer secret (the feed URL) stored in plaintext, and RLS
-- let ANY active staff role of the studio read it (and, where the 20260503 migration was applied, manage it too: that migration's
-- "Studio users can manage" policy was never dropped by 20260524). Narrow it to the people who need it:
--   studio_owner / studio_admin  read + manage (policy from 20260524, recreated here so a fresh database has exactly this set)
--   the instructor the feed belongs to  read their own row
-- Everyone else, including other staff roles, gets no access. The public feed route reads with the service role and is unaffected.
-- Hash-only token storage with a one-time reveal and revoke/rotate UI is a separate follow-up (needs UI changes).
begin;

drop policy if exists "Studio users can view instructor calendar feeds" on public.instructor_calendar_feeds;
drop policy if exists "Studio users can manage instructor calendar feeds" on public.instructor_calendar_feeds;
drop policy if exists "Studio owners and admins can manage instructor calendar feeds" on public.instructor_calendar_feeds;
drop policy if exists "Instructors can view their own calendar feed" on public.instructor_calendar_feeds;

create policy "Studio owners and admins can manage instructor calendar feeds"
on public.instructor_calendar_feeds
for all
to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

create policy "Instructors can view their own calendar feed"
on public.instructor_calendar_feeds
for select
to authenticated
using (
  exists (
    select 1 from public.instructors i
    where i.id = instructor_calendar_feeds.instructor_id
      and i.studio_id = instructor_calendar_feeds.studio_id
      and i.user_id = auth.uid()
      and i.active = true
  )
);

commit;
