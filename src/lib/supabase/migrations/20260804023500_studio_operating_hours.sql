-- DanceFlow studio operating hours
-- Authoritative weekly operating schedule used by calendar presentation.
-- Instructor/self-service availability remains a separate, narrower layer.

create table if not exists public.studio_operating_hours (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  is_closed boolean not null default false,
  opens_at time,
  closes_at time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, weekday),
  constraint studio_operating_hours_time_check check (
    (is_closed = true and opens_at is null and closes_at is null)
    or
    (
      is_closed = false
      and opens_at is not null
      and closes_at is not null
      and closes_at > opens_at
    )
  )
);

create index if not exists studio_operating_hours_studio_weekday_idx
  on public.studio_operating_hours(studio_id, weekday);

alter table public.studio_operating_hours enable row level security;

drop policy if exists "Studio members can view operating hours"
  on public.studio_operating_hours;
create policy "Studio members can view operating hours"
on public.studio_operating_hours for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = studio_operating_hours.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio managers can manage operating hours"
  on public.studio_operating_hours;
create policy "Studio managers can manage operating hours"
on public.studio_operating_hours for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = studio_operating_hours.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = studio_operating_hours.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

insert into public.studio_operating_hours (
  studio_id,
  weekday,
  is_closed,
  opens_at,
  closes_at
)
select
  s.id,
  weekday,
  case when weekday = 0 then true else false end,
  case when weekday = 0 then null else time '09:00' end,
  case when weekday = 0 then null else time '21:00' end
from public.studios s
cross join generate_series(0, 6) as weekday
on conflict (studio_id, weekday) do nothing;
