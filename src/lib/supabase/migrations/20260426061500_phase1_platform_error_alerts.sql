-- Phase 1 platform admin server-side error alerts.
-- Adds a lightweight backend error log table the platform dashboard can query.

create table if not exists platform_error_logs (
  id uuid primary key default gen_random_uuid(),
  severity text not null default 'error',
  source text not null,
  message text not null,
  details jsonb,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index if not exists platform_error_logs_created_at_idx
on platform_error_logs (created_at desc);

create index if not exists platform_error_logs_unresolved_idx
on platform_error_logs (resolved_at)
where resolved_at is null;

alter table platform_error_logs enable row level security;

drop policy if exists "Platform admins can view platform error logs"
on platform_error_logs;

create policy "Platform admins can view platform error logs"
on platform_error_logs
for select
using (
  exists (
    select 1
    from profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
);

drop policy if exists "Platform admins can update platform error logs"
on platform_error_logs;

create policy "Platform admins can update platform error logs"
on platform_error_logs
for update
using (
  exists (
    select 1
    from profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
);
