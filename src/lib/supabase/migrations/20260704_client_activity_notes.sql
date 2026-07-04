create table if not exists public.client_activity_notes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  note_type text not null default 'general',
  body text not null,
  occurred_at timestamp with time zone not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists client_activity_notes_client_created_idx
on public.client_activity_notes (studio_id, client_id, occurred_at desc, created_at desc);

create index if not exists client_activity_notes_note_type_idx
on public.client_activity_notes (studio_id, note_type);
