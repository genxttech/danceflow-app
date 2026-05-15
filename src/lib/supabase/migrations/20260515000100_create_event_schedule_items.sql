create table if not exists public.event_schedule_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  schedule_date date not null,
  start_time time not null,
  end_time time,
  title text not null,
  description text,
  presenter_name text,
  location_label text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_schedule_items_event_id_idx
on public.event_schedule_items(event_id);

create index if not exists event_schedule_items_event_date_sort_idx
on public.event_schedule_items(event_id, schedule_date, start_time, sort_order);