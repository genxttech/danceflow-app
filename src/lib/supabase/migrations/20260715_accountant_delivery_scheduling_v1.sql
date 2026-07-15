begin;
create table if not exists public.studio_accountant_deliveries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  accountant_profile_id uuid not null references public.studio_accountant_profiles(id) on delete cascade,
  recipient_email text not null,
  report_types text[] not null default '{}'::text[],
  report_range text not null default 'month' check (report_range in ('month','quarter','year')),
  status text not null default 'queued' check (status in ('queued','sent','failed','cancelled','expired')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  outbound_delivery_id uuid references public.outbound_deliveries(id) on delete set null,
  download_count integer not null default 0,
  first_downloaded_at timestamptz,
  last_downloaded_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  sent_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null
);
create index if not exists studio_accountant_deliveries_studio_created_idx on public.studio_accountant_deliveries(studio_id, created_at desc);
create index if not exists studio_accountant_deliveries_token_idx on public.studio_accountant_deliveries(token_hash);
alter table public.studio_accountant_deliveries enable row level security;
drop policy if exists studio_accountant_deliveries_select on public.studio_accountant_deliveries;
drop policy if exists studio_accountant_deliveries_insert on public.studio_accountant_deliveries;
drop policy if exists studio_accountant_deliveries_update on public.studio_accountant_deliveries;
create policy studio_accountant_deliveries_select on public.studio_accountant_deliveries for select to authenticated using (exists(select 1 from public.user_studio_roles usr where usr.studio_id=studio_accountant_deliveries.studio_id and usr.user_id=auth.uid() and usr.active=true and usr.role in ('studio_owner','studio_admin')));
create policy studio_accountant_deliveries_insert on public.studio_accountant_deliveries for insert to authenticated with check (exists(select 1 from public.user_studio_roles usr where usr.studio_id=studio_accountant_deliveries.studio_id and usr.user_id=auth.uid() and usr.active=true and usr.role in ('studio_owner','studio_admin')));
create policy studio_accountant_deliveries_update on public.studio_accountant_deliveries for update to authenticated using (exists(select 1 from public.user_studio_roles usr where usr.studio_id=studio_accountant_deliveries.studio_id and usr.user_id=auth.uid() and usr.active=true and usr.role in ('studio_owner','studio_admin'))) with check (exists(select 1 from public.user_studio_roles usr where usr.studio_id=studio_accountant_deliveries.studio_id and usr.user_id=auth.uid() and usr.active=true and usr.role in ('studio_owner','studio_admin')));
revoke all on public.studio_accountant_deliveries from anon;
grant select,insert,update on public.studio_accountant_deliveries to authenticated;
commit;
