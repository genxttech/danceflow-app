-- 20260709_google_calendar_integration_v1.sql
-- Studio Google Calendar one-way outbound sync foundation.
-- Run in both dev and production before deploying Google Calendar integration routes/actions.

create table if not exists public.studio_google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  status text not null default 'connected',
  google_account_email text,
  calendar_id text,
  calendar_summary text,
  scopes text[] not null default '{}',
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  sync_lessons boolean not null default true,
  sync_classes boolean not null default true,
  sync_events boolean not null default false,
  sync_cancelled_items boolean not null default false,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_google_calendar_connections_studio_unique unique (studio_id),
  constraint studio_google_calendar_connections_status_check check (
    status in ('connected', 'needs_reauth', 'disconnected')
  ),
  constraint studio_google_calendar_connections_last_sync_status_check check (
    last_sync_status is null or last_sync_status in ('success', 'partial', 'failed')
  )
);

create table if not exists public.studio_google_calendar_sync_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_google_calendar_connections(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  google_calendar_id text not null,
  google_event_id text,
  google_event_html_link text,
  last_synced_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_google_calendar_sync_items_source_type_check check (
    source_type in ('appointment', 'event')
  ),
  constraint studio_google_calendar_sync_items_last_sync_status_check check (
    last_sync_status is null or last_sync_status in ('success', 'failed', 'deleted')
  ),
  constraint studio_google_calendar_sync_items_unique_source unique (connection_id, source_type, source_id)
);

create index if not exists studio_google_calendar_connections_studio_id_idx
  on public.studio_google_calendar_connections (studio_id);

create index if not exists studio_google_calendar_sync_items_studio_id_idx
  on public.studio_google_calendar_sync_items (studio_id);

create index if not exists studio_google_calendar_sync_items_connection_id_idx
  on public.studio_google_calendar_sync_items (connection_id);

create index if not exists studio_google_calendar_sync_items_source_idx
  on public.studio_google_calendar_sync_items (source_type, source_id);

create or replace function public.set_studio_google_calendar_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_studio_google_calendar_connections_updated_at
  on public.studio_google_calendar_connections;

create trigger set_studio_google_calendar_connections_updated_at
before update on public.studio_google_calendar_connections
for each row
execute function public.set_studio_google_calendar_updated_at();

drop trigger if exists set_studio_google_calendar_sync_items_updated_at
  on public.studio_google_calendar_sync_items;

create trigger set_studio_google_calendar_sync_items_updated_at
before update on public.studio_google_calendar_sync_items
for each row
execute function public.set_studio_google_calendar_updated_at();

alter table public.studio_google_calendar_connections enable row level security;
alter table public.studio_google_calendar_sync_items enable row level security;

drop policy if exists "Studio admins can read google calendar connections"
  on public.studio_google_calendar_connections;
drop policy if exists "Studio admins can manage google calendar connections"
  on public.studio_google_calendar_connections;
drop policy if exists "Studio admins can read google calendar sync items"
  on public.studio_google_calendar_sync_items;
drop policy if exists "Studio admins can manage google calendar sync items"
  on public.studio_google_calendar_sync_items;

create policy "Studio admins can read google calendar connections"
on public.studio_google_calendar_connections
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_google_calendar_connections.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Studio admins can manage google calendar connections"
on public.studio_google_calendar_connections
for all
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_google_calendar_connections.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_google_calendar_connections.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Studio admins can read google calendar sync items"
on public.studio_google_calendar_sync_items
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_google_calendar_sync_items.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Studio admins can manage google calendar sync items"
on public.studio_google_calendar_sync_items
for all
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_google_calendar_sync_items.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_google_calendar_sync_items.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);
