-- Step 2: add appointment confirmation audit fields and secure token storage.
-- Run only after 20260804043100_add_confirmed_appointment_status.sql has committed.

alter table public.appointments
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmation_source text,
  add column if not exists confirmation_actor_user_id uuid
    references auth.users(id) on delete set null;

alter table public.appointments
  drop constraint if exists appointments_confirmation_source_check;

alter table public.appointments
  add constraint appointments_confirmation_source_check
  check (
    confirmation_source is null
    or confirmation_source in ('email_link', 'student_portal', 'student_mobile')
  );

create table if not exists public.appointment_confirmation_tokens (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  token_hash text not null unique,
  recipient_email text,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists appointment_confirmation_tokens_appointment_idx
  on public.appointment_confirmation_tokens (appointment_id, created_at desc);

create index if not exists appointment_confirmation_tokens_expiry_idx
  on public.appointment_confirmation_tokens (expires_at)
  where confirmed_at is null and invalidated_at is null;

alter table public.appointment_confirmation_tokens enable row level security;

revoke all on public.appointment_confirmation_tokens from anon, authenticated;
