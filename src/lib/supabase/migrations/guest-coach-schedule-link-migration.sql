-- Guest Coach Schedule Link V1 support
-- Run once in Supabase SQL editor before enabling disable/re-enable controls.

alter table public.event_guest_coaches
add column if not exists schedule_token_enabled boolean not null default true;

alter table public.event_guest_coaches
add column if not exists schedule_token_created_at timestamptz not null default now();

create unique index if not exists event_guest_coaches_schedule_token_unique
on public.event_guest_coaches (schedule_token);
