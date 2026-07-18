create table if not exists public.user_account_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'deactivated', 'pending_deletion')),
  deactivated_at timestamptz,
  reactivated_at timestamptz,
  deactivation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_account_status enable row level security;

drop policy if exists user_account_status_self_select
  on public.user_account_status;
create policy user_account_status_self_select
  on public.user_account_status
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists user_account_status_self_insert
  on public.user_account_status;
create policy user_account_status_self_insert
  on public.user_account_status
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists user_account_status_self_update
  on public.user_account_status;
create policy user_account_status_self_update
  on public.user_account_status
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists user_account_status_status_idx
  on public.user_account_status(status);
