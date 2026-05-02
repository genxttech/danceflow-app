create table if not exists public.event_locations (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,

  location_name text not null,
  venue_name text null,
  address_line_1 text null,
  address_line_2 text null,
  city text null,
  state text null,
  postal_code text null,
  country text not null default 'US',

  latitude numeric null,
  longitude numeric null,
  geocoded_at timestamp with time zone null,
  geocoding_status text not null default 'pending',
  geocoding_error text null,

  capacity integer null,
  sort_order integer not null default 0,
  active boolean not null default true,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint event_locations_capacity_check
    check (capacity is null or capacity >= 0),

  constraint event_locations_geocoding_status_check
    check (
      geocoding_status in (
        'pending',
        'geocoded',
        'failed',
        'manual',
        'not_needed'
      )
    )
);

create index if not exists event_locations_event_id_idx
on public.event_locations(event_id);

create index if not exists event_locations_studio_id_idx
on public.event_locations(studio_id);

create index if not exists event_locations_active_idx
on public.event_locations(event_id, active);

create index if not exists event_locations_lat_lng_idx
on public.event_locations(latitude, longitude)
where latitude is not null
  and longitude is not null;


create table if not exists public.event_location_sessions (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null references public.events(id) on delete cascade,
  event_location_id uuid not null references public.event_locations(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,

  session_date date not null,
  start_time time without time zone null,
  end_time time without time zone null,

  session_label text null,
  series_label text null,

  capacity integer null,
  status text not null default 'scheduled',
  sort_order integer not null default 0,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint event_location_sessions_capacity_check
    check (capacity is null or capacity >= 0),

  constraint event_location_sessions_status_check
    check (
      status in (
        'scheduled',
        'cancelled',
        'completed'
      )
    )
);

create unique index if not exists event_location_sessions_unique_idx
on public.event_location_sessions (
  event_location_id,
  session_date,
  coalesce(start_time, '00:00:00'::time)
);

create index if not exists event_location_sessions_event_id_idx
on public.event_location_sessions(event_id);

create index if not exists event_location_sessions_location_id_idx
on public.event_location_sessions(event_location_id);

create index if not exists event_location_sessions_studio_date_idx
on public.event_location_sessions(studio_id, session_date);

create index if not exists event_location_sessions_status_idx
on public.event_location_sessions(event_id, status);


alter table public.event_locations enable row level security;
alter table public.event_location_sessions enable row level security;


drop policy if exists "Studio users can view event locations" on public.event_locations;
drop policy if exists "Studio users can manage event locations" on public.event_locations;
drop policy if exists "Public can view public event locations" on public.event_locations;

create policy "Studio users can view event locations"
on public.event_locations
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_locations.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio users can manage event locations"
on public.event_locations
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_locations.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_locations.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Public can view public event locations"
on public.event_locations
for select
using (
  active = true
  and exists (
    select 1
    from public.events e
    where e.id = event_locations.event_id
      and e.visibility = 'public'
      and e.public_directory_enabled = true
      and e.status in ('published', 'open')
  )
);


drop policy if exists "Studio users can view event location sessions" on public.event_location_sessions;
drop policy if exists "Studio users can manage event location sessions" on public.event_location_sessions;
drop policy if exists "Public can view public event location sessions" on public.event_location_sessions;

create policy "Studio users can view event location sessions"
on public.event_location_sessions
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_location_sessions.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio users can manage event location sessions"
on public.event_location_sessions
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_location_sessions.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_location_sessions.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Public can view public event location sessions"
on public.event_location_sessions
for select
using (
  status = 'scheduled'
  and exists (
    select 1
    from public.events e
    where e.id = event_location_sessions.event_id
      and e.visibility = 'public'
      and e.public_directory_enabled = true
      and e.status in ('published', 'open')
  )
);

notify pgrst, 'reload schema';