create table if not exists public.event_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  session_date date not null,
  start_time time,
  end_time time,
  session_label text,
  status text not null default 'scheduled',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_sessions_status_check
  check (
    status = any (
      array[
        'scheduled',
        'cancelled',
        'completed'
      ]::text[]
    )
  ),

  constraint event_sessions_unique_event_date
  unique (event_id, session_date)
);

create index if not exists event_sessions_event_id_idx
on public.event_sessions(event_id);

create index if not exists event_sessions_studio_id_idx
on public.event_sessions(studio_id);

create index if not exists event_sessions_session_date_idx
on public.event_sessions(session_date);