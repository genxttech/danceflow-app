-- Usage Add-ons Foundation V1
-- Supports AI action metering now and SMS metering later.
-- Run in Supabase SQL editor or add to your migrations folder.

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  workspace_type text not null check (workspace_type in ('studio', 'organizer')),
  feature_key text not null,
  quantity integer not null default 1 check (quantity > 0),
  source text,
  related_table text,
  related_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  period_start date not null,
  period_end date not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint usage_events_one_workspace_check check (
    (workspace_type = 'studio' and studio_id is not null and organizer_id is null)
    or
    (workspace_type = 'organizer' and organizer_id is not null and studio_id is null)
  )
);

create index if not exists usage_events_studio_period_idx
  on public.usage_events (studio_id, feature_key, period_start, created_at desc)
  where studio_id is not null;

create index if not exists usage_events_organizer_period_idx
  on public.usage_events (organizer_id, feature_key, period_start, created_at desc)
  where organizer_id is not null;

create table if not exists public.usage_monthly_summaries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  workspace_type text not null check (workspace_type in ('studio', 'organizer')),
  feature_key text not null,
  period_start date not null,
  period_end date not null,
  quantity_used integer not null default 0 check (quantity_used >= 0),
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint usage_monthly_summaries_one_workspace_check check (
    (workspace_type = 'studio' and studio_id is not null and organizer_id is null)
    or
    (workspace_type = 'organizer' and organizer_id is not null and studio_id is null)
  )
);

create unique index if not exists usage_monthly_summaries_studio_unique
  on public.usage_monthly_summaries (studio_id, feature_key, period_start)
  where studio_id is not null;

create unique index if not exists usage_monthly_summaries_organizer_unique
  on public.usage_monthly_summaries (organizer_id, feature_key, period_start)
  where organizer_id is not null;

create table if not exists public.usage_addon_entitlements (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  workspace_type text not null check (workspace_type in ('studio', 'organizer')),
  feature_key text not null,
  quantity_included integer not null check (quantity_included > 0),
  source text not null default 'manual',
  stripe_subscription_item_id text,
  status text not null default 'active' check (status in ('active', 'canceled', 'expired')),
  period_start date,
  period_end date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint usage_addon_entitlements_one_workspace_check check (
    (workspace_type = 'studio' and studio_id is not null and organizer_id is null)
    or
    (workspace_type = 'organizer' and organizer_id is not null and studio_id is null)
  )
);

create index if not exists usage_addon_entitlements_studio_idx
  on public.usage_addon_entitlements (studio_id, feature_key, status)
  where studio_id is not null;

create index if not exists usage_addon_entitlements_organizer_idx
  on public.usage_addon_entitlements (organizer_id, feature_key, status)
  where organizer_id is not null;

create or replace function public.increment_usage_monthly_summary()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.workspace_type = 'studio' then
    insert into public.usage_monthly_summaries (
      studio_id,
      organizer_id,
      workspace_type,
      feature_key,
      period_start,
      period_end,
      quantity_used,
      last_event_at
    ) values (
      new.studio_id,
      null,
      new.workspace_type,
      new.feature_key,
      new.period_start,
      new.period_end,
      new.quantity,
      new.created_at
    )
    on conflict (studio_id, feature_key, period_start)
    where studio_id is not null
    do update set
      quantity_used = public.usage_monthly_summaries.quantity_used + excluded.quantity_used,
      last_event_at = excluded.last_event_at,
      updated_at = now();
  else
    insert into public.usage_monthly_summaries (
      studio_id,
      organizer_id,
      workspace_type,
      feature_key,
      period_start,
      period_end,
      quantity_used,
      last_event_at
    ) values (
      null,
      new.organizer_id,
      new.workspace_type,
      new.feature_key,
      new.period_start,
      new.period_end,
      new.quantity,
      new.created_at
    )
    on conflict (organizer_id, feature_key, period_start)
    where organizer_id is not null
    do update set
      quantity_used = public.usage_monthly_summaries.quantity_used + excluded.quantity_used,
      last_event_at = excluded.last_event_at,
      updated_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists usage_events_increment_summary on public.usage_events;
create trigger usage_events_increment_summary
after insert on public.usage_events
for each row execute function public.increment_usage_monthly_summary();

alter table public.usage_events enable row level security;
alter table public.usage_monthly_summaries enable row level security;
alter table public.usage_addon_entitlements enable row level security;

-- Studio members can read usage for their studio.
drop policy if exists "studio members can read usage events" on public.usage_events;
create policy "studio members can read usage events"
  on public.usage_events
  for select
  using (
    studio_id is not null
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = usage_events.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "studio members can read usage summaries" on public.usage_monthly_summaries;
create policy "studio members can read usage summaries"
  on public.usage_monthly_summaries
  for select
  using (
    studio_id is not null
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = usage_monthly_summaries.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "studio owners can read usage entitlements" on public.usage_addon_entitlements;
create policy "studio owners can read usage entitlements"
  on public.usage_addon_entitlements
  for select
  using (
    studio_id is not null
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = usage_addon_entitlements.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin')
    )
  );

-- Organizer members can read usage for their organizer account.
drop policy if exists "organizer members can read usage events" on public.usage_events;
create policy "organizer members can read usage events"
  on public.usage_events
  for select
  using (
    organizer_id is not null
    and exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = usage_events.organizer_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  );

drop policy if exists "organizer members can read usage summaries" on public.usage_monthly_summaries;
create policy "organizer members can read usage summaries"
  on public.usage_monthly_summaries
  for select
  using (
    organizer_id is not null
    and exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = usage_monthly_summaries.organizer_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  );

drop policy if exists "organizer owners can read usage entitlements" on public.usage_addon_entitlements;
create policy "organizer owners can read usage entitlements"
  on public.usage_addon_entitlements
  for select
  using (
    organizer_id is not null
    and exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = usage_addon_entitlements.organizer_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role in ('organizer_owner', 'organizer_admin')
    )
  );
