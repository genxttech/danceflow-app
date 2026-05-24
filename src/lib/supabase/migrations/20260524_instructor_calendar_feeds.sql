begin;

create table if not exists public.instructor_calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  token text not null unique,
  active boolean not null default true,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instructor_calendar_feeds_instructor_unique unique (instructor_id)
);

create index if not exists idx_instructor_calendar_feeds_studio_id
on public.instructor_calendar_feeds (studio_id);

create index if not exists idx_instructor_calendar_feeds_instructor_id
on public.instructor_calendar_feeds (instructor_id);

create index if not exists idx_instructor_calendar_feeds_token
on public.instructor_calendar_feeds (token);

alter table public.instructor_calendar_feeds enable row level security;

drop policy if exists "Studio users can view instructor calendar feeds"
on public.instructor_calendar_feeds;

create policy "Studio users can view instructor calendar feeds"
on public.instructor_calendar_feeds
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.active = true
  )
);

drop policy if exists "Studio owners and admins can manage instructor calendar feeds"
on public.instructor_calendar_feeds;

create policy "Studio owners and admins can manage instructor calendar feeds"
on public.instructor_calendar_feeds
for all
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

notify pgrst, 'reload schema';

commit;