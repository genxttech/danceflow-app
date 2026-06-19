-- Stripe Terminal V0 foundation
-- Run in dev first, then production before enabling the card reader setup UI.

create table if not exists public.stripe_terminal_locations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  stripe_account_id text not null,
  stripe_location_id text not null,
  display_name text not null,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text default 'US',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_location_id),
  unique (studio_id, stripe_location_id)
);

create table if not exists public.stripe_terminal_readers (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  terminal_location_id uuid references public.stripe_terminal_locations(id) on delete set null,
  stripe_account_id text not null,
  stripe_reader_id text not null,
  stripe_location_id text,
  label text,
  device_type text,
  status text,
  ip_address text,
  last_seen_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_reader_id),
  unique (studio_id, stripe_reader_id)
);

create table if not exists public.terminal_payment_sessions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  terminal_reader_id uuid references public.stripe_terminal_readers(id) on delete set null,
  terminal_location_id uuid references public.stripe_terminal_locations(id) on delete set null,
  source_type text,
  source_id text,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'usd',
  stripe_account_id text not null,
  stripe_payment_intent_id text,
  status text not null default 'created',
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (stripe_payment_intent_id)
);

create index if not exists stripe_terminal_locations_studio_id_idx
  on public.stripe_terminal_locations(studio_id);

create index if not exists stripe_terminal_readers_studio_id_idx
  on public.stripe_terminal_readers(studio_id);

create index if not exists stripe_terminal_readers_location_idx
  on public.stripe_terminal_readers(terminal_location_id);

create index if not exists terminal_payment_sessions_studio_id_idx
  on public.terminal_payment_sessions(studio_id);

create index if not exists terminal_payment_sessions_payment_id_idx
  on public.terminal_payment_sessions(payment_id);

create index if not exists terminal_payment_sessions_payment_intent_idx
  on public.terminal_payment_sessions(stripe_payment_intent_id);

alter table public.payments
  add column if not exists payment_channel text not null default 'manual',
  add column if not exists stripe_terminal_reader_id text,
  add column if not exists stripe_terminal_location_id text,
  add column if not exists terminal_payment_session_id uuid references public.terminal_payment_sessions(id) on delete set null;

create index if not exists payments_payment_channel_idx
  on public.payments(payment_channel);

create index if not exists payments_terminal_payment_session_idx
  on public.payments(terminal_payment_session_id);

-- Keep these tables protected from direct browser access. DanceFlow server routes handle access checks.
alter table public.stripe_terminal_locations enable row level security;
alter table public.stripe_terminal_readers enable row level security;
alter table public.terminal_payment_sessions enable row level security;

-- The app currently accesses these tables through server routes/actions.
-- Add broader studio-member RLS policies later if direct client-side access is needed.
