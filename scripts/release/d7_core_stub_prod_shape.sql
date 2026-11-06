-- Minimal PROD-shaped stand-in for the objects the D7 core migrations touch. LOCAL REHEARSAL ONLY (disposable Postgres).
-- Roles anon / authenticated / service_role must already exist (cluster level).
create table public.studios(id uuid primary key default gen_random_uuid(), timezone text);
create table public.organizers(id uuid primary key default gen_random_uuid());
create table public.events(id uuid primary key default gen_random_uuid(), studio_id uuid, organizer_id uuid);
create table public.event_orders(id uuid primary key default gen_random_uuid(), event_id uuid, created_at timestamptz default now());
create table public.usage_addon_entitlements (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  workspace_type text not null,
  feature_key text not null,
  source text not null,
  status text not null default 'active',
  quantity_included integer not null default 1,
  period_start date, period_end date,
  stripe_subscription_item_id text unique,
  notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint one_workspace check ((workspace_type='studio' and studio_id is not null and organizer_id is null) or (workspace_type='organizer' and organizer_id is not null and studio_id is null)),
  constraint status_check check (status in ('active','canceled','expired')),
  constraint qty_check check (quantity_included > 0)
);
alter table public.usage_addon_entitlements enable row level security;
create policy studio_owner_read on public.usage_addon_entitlements for select using (true);
create policy organizer_owner_read on public.usage_addon_entitlements for select using (true);
-- PROD pre-state ACL (read from hosted PROD 2026-11-01): everything to anon / authenticated / service_role
grant all on public.usage_addon_entitlements to anon, authenticated, service_role;
create function public.record_competition_checkin_payment(uuid, uuid, numeric, text, text default null) returns jsonb language sql as $$ select '{}'::jsonb $$;
-- seed like PROD: two active, open-ended manual grants
insert into public.studios(id, timezone) values ('00000000-0000-0000-0000-0000000000a1','America/New_York'),('00000000-0000-0000-0000-0000000000a2','America/Chicago');
insert into public.usage_addon_entitlements(id, studio_id, workspace_type, feature_key, source) values
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','studio','organizer_suite','manual_grant'),
 ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a2','studio','organizer_suite','manual_grant');
