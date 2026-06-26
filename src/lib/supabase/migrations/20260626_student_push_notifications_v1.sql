-- Student mobile push notification foundation.
-- Run in dev first, then production before enabling mobile push publicly.

create table if not exists public.mobile_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null unique,
  platform text not null check (platform in ('ios', 'android', 'web', 'unknown')),
  app_slug text not null default 'danceflow-student',
  device_name text,
  enabled boolean not null default true,
  last_registered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mobile_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  push_enabled boolean not null default true,
  schedule_updates boolean not null default true,
  event_updates boolean not null default true,
  favorite_updates boolean not null default true,
  learning_updates boolean not null default false,
  account_updates boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mobile_notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('schedule', 'event', 'favorites', 'learning', 'account', 'system')),
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  error_message text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_mobile_push_tokens_user_id on public.mobile_push_tokens(user_id);
create index if not exists idx_mobile_push_tokens_enabled on public.mobile_push_tokens(enabled);
create index if not exists idx_mobile_notification_log_user_id_created_at on public.mobile_notification_log(user_id, created_at desc);
create index if not exists idx_mobile_notification_log_status_created_at on public.mobile_notification_log(status, created_at desc);

alter table public.mobile_push_tokens enable row level security;
alter table public.mobile_notification_preferences enable row level security;
alter table public.mobile_notification_log enable row level security;

drop policy if exists "mobile_push_tokens_select_own" on public.mobile_push_tokens;
create policy "mobile_push_tokens_select_own"
  on public.mobile_push_tokens
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "mobile_push_tokens_insert_own" on public.mobile_push_tokens;
create policy "mobile_push_tokens_insert_own"
  on public.mobile_push_tokens
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "mobile_push_tokens_update_own" on public.mobile_push_tokens;
create policy "mobile_push_tokens_update_own"
  on public.mobile_push_tokens
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "mobile_push_tokens_delete_own" on public.mobile_push_tokens;
create policy "mobile_push_tokens_delete_own"
  on public.mobile_push_tokens
  for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "mobile_notification_preferences_select_own" on public.mobile_notification_preferences;
create policy "mobile_notification_preferences_select_own"
  on public.mobile_notification_preferences
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "mobile_notification_preferences_insert_own" on public.mobile_notification_preferences;
create policy "mobile_notification_preferences_insert_own"
  on public.mobile_notification_preferences
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "mobile_notification_preferences_update_own" on public.mobile_notification_preferences;
create policy "mobile_notification_preferences_update_own"
  on public.mobile_notification_preferences
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "mobile_notification_log_select_own" on public.mobile_notification_log;
create policy "mobile_notification_log_select_own"
  on public.mobile_notification_log
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.touch_mobile_push_token_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_mobile_push_tokens_updated_at on public.mobile_push_tokens;
create trigger trg_touch_mobile_push_tokens_updated_at
before update on public.mobile_push_tokens
for each row execute function public.touch_mobile_push_token_updated_at();

create or replace function public.touch_mobile_notification_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_mobile_notification_preferences_updated_at on public.mobile_notification_preferences;
create trigger trg_touch_mobile_notification_preferences_updated_at
before update on public.mobile_notification_preferences
for each row execute function public.touch_mobile_notification_preferences_updated_at();
