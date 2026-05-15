create table if not exists public.event_guest_coaches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  name text not null,
  bio text,
  photo_url text,
  schedule_token text not null default encode(gen_random_bytes(32), 'hex'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_guest_coaches_event_id_idx
on public.event_guest_coaches(event_id);

create unique index if not exists event_guest_coaches_schedule_token_idx
on public.event_guest_coaches(schedule_token);


create table if not exists public.event_private_lesson_blocks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  coach_id uuid not null references public.event_guest_coaches(id) on delete cascade,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  lesson_date date not null,
  start_time time not null,
  end_time time not null,
  duration_minutes integer not null default 45,
  buffer_minutes integer not null default 0,
  price numeric(10,2) not null default 0,
  location_label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_private_lesson_blocks_event_id_idx
on public.event_private_lesson_blocks(event_id);

create index if not exists event_private_lesson_blocks_coach_id_idx
on public.event_private_lesson_blocks(coach_id);


create table if not exists public.event_private_lesson_slots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  coach_id uuid not null references public.event_guest_coaches(id) on delete cascade,
  block_id uuid references public.event_private_lesson_blocks(id) on delete cascade,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  price numeric(10,2) not null default 0,
  location_label text,
  status text not null default 'available',
  buyer_name text,
  buyer_email text,
  buyer_phone text,
  buyer_notes text,
  client_id uuid references public.clients(id) on delete set null,
  payment_status text not null default 'unpaid',
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  booked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_private_lesson_slots_status_check
    check (status in ('available', 'held', 'booked', 'cancelled')),
  constraint event_private_lesson_slots_payment_status_check
    check (payment_status in ('unpaid', 'pending', 'paid', 'refunded', 'waived'))
);

create index if not exists event_private_lesson_slots_event_id_idx
on public.event_private_lesson_slots(event_id);

create index if not exists event_private_lesson_slots_coach_id_idx
on public.event_private_lesson_slots(coach_id);

create index if not exists event_private_lesson_slots_status_idx
on public.event_private_lesson_slots(status);

create unique index if not exists event_private_lesson_slots_one_booking_per_slot_idx
on public.event_private_lesson_slots(id)
where status = 'booked';


alter table public.event_guest_coaches enable row level security;
alter table public.event_private_lesson_blocks enable row level security;
alter table public.event_private_lesson_slots enable row level security;