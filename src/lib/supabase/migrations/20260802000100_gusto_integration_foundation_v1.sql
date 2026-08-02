begin;

-- Gusto App Integration foundation.
-- DanceFlow remains the payroll-preparation source of truth.
-- This migration stores connection identity, encrypted OAuth credentials,
-- connection health, and an append-only audit trail. It does not submit payroll.

create table if not exists public.studio_gusto_connections (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  status text not null default 'disconnected'
    check (status in ('connected', 'needs_reauth', 'disconnected', 'error')),
  environment text not null default 'demo'
    check (environment in ('demo', 'production')),
  gusto_company_uuid uuid,
  gusto_company_name text,
  scopes text[] not null default '{}',
  connected_by uuid references public.profiles(id) on delete set null,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_health_check_at timestamptz,
  last_health_status text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id)
);

create unique index if not exists studio_gusto_connections_company_unique
  on public.studio_gusto_connections (environment, gusto_company_uuid)
  where gusto_company_uuid is not null and status <> 'disconnected';

create table if not exists public.studio_gusto_credentials (
  connection_id uuid primary key references public.studio_gusto_connections(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_gusto_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid references public.studio_gusto_connections(id) on delete set null,
  event_type text not null,
  outcome text not null check (outcome in ('started', 'succeeded', 'failed', 'attention')),
  actor_user_id uuid references public.profiles(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists studio_gusto_audit_events_studio_created_idx
  on public.studio_gusto_audit_events (studio_id, created_at desc);

alter table public.studio_gusto_connections enable row level security;
alter table public.studio_gusto_credentials enable row level security;
alter table public.studio_gusto_audit_events enable row level security;

create or replace function public.can_manage_studio_gusto(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = target_studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  );
$$;

revoke all on function public.can_manage_studio_gusto(uuid) from public, anon;
grant execute on function public.can_manage_studio_gusto(uuid) to authenticated, service_role;

drop policy if exists "Payroll managers can read Gusto connections"
  on public.studio_gusto_connections;
create policy "Payroll managers can read Gusto connections"
on public.studio_gusto_connections
for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

drop policy if exists "Payroll managers can read Gusto audit events"
  on public.studio_gusto_audit_events;
create policy "Payroll managers can read Gusto audit events"
on public.studio_gusto_audit_events
for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

-- Credentials intentionally have no authenticated policies.
-- Only trusted server code using the service role may read or write token values.

commit;
