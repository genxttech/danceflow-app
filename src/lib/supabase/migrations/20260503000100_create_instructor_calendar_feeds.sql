create table if not exists public.instructor_calendar_feeds (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,

  token text not null unique,
  active boolean not null default true,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  last_accessed_at timestamp with time zone null,

  constraint instructor_calendar_feeds_unique_instructor
    unique (instructor_id)
);

create index if not exists instructor_calendar_feeds_studio_id_idx
on public.instructor_calendar_feeds(studio_id);

create index if not exists instructor_calendar_feeds_instructor_id_idx
on public.instructor_calendar_feeds(instructor_id);

create index if not exists instructor_calendar_feeds_token_idx
on public.instructor_calendar_feeds(token);

alter table public.instructor_calendar_feeds enable row level security;

drop policy if exists "Studio users can view instructor calendar feeds"
on public.instructor_calendar_feeds;

drop policy if exists "Studio users can manage instructor calendar feeds"
on public.instructor_calendar_feeds;

create policy "Studio users can view instructor calendar feeds"
on public.instructor_calendar_feeds
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio users can manage instructor calendar feeds"
on public.instructor_calendar_feeds
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_calendar_feeds.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

notify pgrst, 'reload schema';