-- 20260709_platform_ops_review_dismissals_v1.sql
-- Platform ARIA/Ops Review reviewed/skipped signal tracking.
-- Run in both dev and production before deploying /platform/ops-review actions.

create table if not exists public.platform_ops_review_dismissals (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  signal_key text not null,
  status text not null default 'reviewed',
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint platform_ops_review_dismissals_status_check check (
    status in ('reviewed', 'skipped')
  ),
  constraint platform_ops_review_dismissals_signal_key_check check (
    length(trim(signal_key)) > 0
  )
);

create index if not exists platform_ops_review_dismissals_studio_id_idx
  on public.platform_ops_review_dismissals (studio_id);

create index if not exists platform_ops_review_dismissals_signal_key_idx
  on public.platform_ops_review_dismissals (signal_key);

create index if not exists platform_ops_review_dismissals_created_at_idx
  on public.platform_ops_review_dismissals (created_at desc);

create unique index if not exists platform_ops_review_dismissals_unique_active_signal_idx
  on public.platform_ops_review_dismissals (studio_id, signal_key, status);

alter table public.platform_ops_review_dismissals enable row level security;

drop policy if exists "Platform admins can read platform ops review dismissals"
  on public.platform_ops_review_dismissals;

drop policy if exists "Platform admins can insert platform ops review dismissals"
  on public.platform_ops_review_dismissals;

drop policy if exists "Platform admins can update platform ops review dismissals"
  on public.platform_ops_review_dismissals;

drop policy if exists "Platform admins can delete platform ops review dismissals"
  on public.platform_ops_review_dismissals;

create policy "Platform admins can read platform ops review dismissals"
on public.platform_ops_review_dismissals
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Platform admins can insert platform ops review dismissals"
on public.platform_ops_review_dismissals
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Platform admins can update platform ops review dismissals"
on public.platform_ops_review_dismissals
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Platform admins can delete platform ops review dismissals"
on public.platform_ops_review_dismissals
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);
