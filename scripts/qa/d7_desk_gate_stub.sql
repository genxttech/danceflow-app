-- Minimal PROD-shaped stand-in for the objects public.record_competition_checkin_payment and the D7 desk gate touch.
-- LOCAL REHEARSAL ONLY (disposable Postgres). Roles anon / authenticated / service_role must already exist (cluster level).
-- The real migrations 20270203090000 (helpers) and the function definition from 20261116094000 are applied on top by
-- scripts/qa/d7_desk_gate_sql.sh; this file only supplies the tables they read and write.
create schema if not exists auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.studios(id uuid primary key default gen_random_uuid(), timezone text);
create table public.organizers(id uuid primary key default gen_random_uuid());
create table public.profiles(id uuid primary key, platform_role text);
create table public.user_studio_roles(id uuid primary key default gen_random_uuid(), studio_id uuid, user_id uuid, role text, active boolean default true);
create table public.organizer_users(id uuid primary key default gen_random_uuid(), organizer_id uuid, user_id uuid, role text, active boolean default true);
create table public.events(id uuid primary key default gen_random_uuid(), studio_id uuid, organizer_id uuid);
create table public.event_orders(
  id uuid primary key default gen_random_uuid(), event_id uuid, status text, payment_status text,
  total_amount numeric, currency text, paid_at timestamptz, metadata jsonb, updated_at timestamptz default now());
create table public.event_registrations(
  id uuid primary key default gen_random_uuid(), event_id uuid, order_id uuid, status text, payment_status text,
  currency text, updated_at timestamptz default now());
create table public.event_payments(
  id uuid primary key default gen_random_uuid(), registration_id uuid, amount numeric, refund_amount numeric, currency text,
  payment_method text, status text, source text, notes text);
create table public.event_competition_checkin_sessions(
  id uuid primary key default gen_random_uuid(), event_id uuid, registration_id uuid, order_id uuid, status text,
  balance_due numeric, updated_at timestamptz default now());
-- identical column list to 20261116094000
create table public.event_competition_checkin_payment_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  checkin_session_id uuid not null,
  registration_id uuid not null,
  order_id uuid null,
  event_payment_id uuid not null,
  amount numeric not null,
  currency text not null,
  payment_method text not null,
  balance_before numeric not null,
  balance_after numeric not null,
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
create table public.subscription_plans(id uuid primary key default gen_random_uuid(), code text);
create table public.studio_subscriptions(
  id uuid primary key default gen_random_uuid(), studio_id uuid unique references public.studios(id) on delete cascade,
  subscription_plan_id uuid references public.subscription_plans(id) on delete set null, status text);
alter table public.studio_subscriptions add constraint studio_subscriptions_status_check
  check (status in ('inactive', 'trialing', 'active', 'past_due', 'cancelled'));
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
grant all on public.usage_addon_entitlements to anon, authenticated, service_role;
