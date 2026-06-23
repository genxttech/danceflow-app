begin;

create table if not exists public.studio_wave_connections (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null unique references public.studios(id) on delete cascade,
  status text not null default 'connected' check (status in ('connected', 'reauthorization_required', 'error', 'disconnected')),
  wave_user_id text,
  wave_business_id text,
  wave_business_name text,
  business_currency text,
  is_classic_accounting boolean,
  default_anchor_account_id text,
  default_anchor_account_name text,
  scopes text[] not null default '{}',
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  last_accounts_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_wave_credentials (
  connection_id uuid primary key references public.studio_wave_connections(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_wave_businesses (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.studio_wave_connections(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  wave_business_id text not null,
  name text not null,
  currency text,
  is_personal boolean,
  is_classic_accounting boolean,
  refreshed_at timestamptz not null default now(),
  unique (connection_id, wave_business_id)
);

create table if not exists public.studio_wave_accounts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.studio_wave_connections(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  wave_account_id text not null,
  name text not null,
  account_type text,
  account_subtype text,
  normal_balance_type text,
  is_archived boolean not null default false,
  refreshed_at timestamptz not null default now(),
  unique (connection_id, wave_account_id)
);

create table if not exists public.studio_wave_account_mappings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_wave_connections(id) on delete cascade,
  accounting_category text not null,
  wave_account_id text not null,
  wave_account_name text not null,
  wave_account_type text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, accounting_category)
);

create index if not exists studio_wave_accounts_studio_idx on public.studio_wave_accounts(studio_id);
create index if not exists studio_wave_mappings_studio_idx on public.studio_wave_account_mappings(studio_id);

alter table public.studio_wave_connections enable row level security;
alter table public.studio_wave_credentials enable row level security;
alter table public.studio_wave_businesses enable row level security;
alter table public.studio_wave_accounts enable row level security;
alter table public.studio_wave_account_mappings enable row level security;

create or replace function public.can_manage_studio_wave(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
      and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])
  ) or exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.active = true
  );
$$;

revoke all on function public.can_manage_studio_wave(uuid) from public;
grant execute on function public.can_manage_studio_wave(uuid) to authenticated, service_role;

drop policy if exists studio_wave_connections_manage on public.studio_wave_connections;
create policy studio_wave_connections_manage on public.studio_wave_connections
for all to authenticated
using (public.can_manage_studio_wave(studio_id))
with check (public.can_manage_studio_wave(studio_id));

drop policy if exists studio_wave_businesses_manage on public.studio_wave_businesses;
create policy studio_wave_businesses_manage on public.studio_wave_businesses
for all to authenticated
using (public.can_manage_studio_wave(studio_id))
with check (public.can_manage_studio_wave(studio_id));

drop policy if exists studio_wave_accounts_manage on public.studio_wave_accounts;
create policy studio_wave_accounts_manage on public.studio_wave_accounts
for all to authenticated
using (public.can_manage_studio_wave(studio_id))
with check (public.can_manage_studio_wave(studio_id));

drop policy if exists studio_wave_account_mappings_manage on public.studio_wave_account_mappings;
create policy studio_wave_account_mappings_manage on public.studio_wave_account_mappings
for all to authenticated
using (public.can_manage_studio_wave(studio_id))
with check (public.can_manage_studio_wave(studio_id));

-- No authenticated policy is intentionally created for studio_wave_credentials.
-- Only the Supabase service role may read or write OAuth credentials.

commit;
