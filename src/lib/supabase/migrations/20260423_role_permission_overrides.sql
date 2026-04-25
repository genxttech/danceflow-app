-- DanceFlow / DanceStudioAdmin
-- Role permission overrides + export audit foundation
-- Purpose:
--   1. Allow studio/organizer owners to grant explicit permissions
--      beyond the default role matrix
--   2. Add audit visibility for sensitive exports

begin;

-- -------------------------------------------------------------------
-- Owner-granted permission overrides
-- -------------------------------------------------------------------

create table if not exists public.role_permission_overrides (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  user_id uuid not null,
  permission_key text not null,
  allowed boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint role_permission_overrides_permission_key_check
    check (
      permission_key in (
        'export_clients',
        'export_financials',
        'export_schedule',
        'export_events',
        'export_reports'
      )
    )
);

create unique index if not exists role_permission_overrides_unique_user_permission
  on public.role_permission_overrides (studio_id, user_id, permission_key);

create index if not exists role_permission_overrides_studio_id_idx
  on public.role_permission_overrides (studio_id);

create index if not exists role_permission_overrides_user_id_idx
  on public.role_permission_overrides (user_id);

create index if not exists role_permission_overrides_permission_key_idx
  on public.role_permission_overrides (permission_key);

-- -------------------------------------------------------------------
-- Updated-at trigger
-- -------------------------------------------------------------------

create or replace function public.set_role_permission_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_role_permission_overrides_updated_at
  on public.role_permission_overrides;

create trigger trg_role_permission_overrides_updated_at
before update on public.role_permission_overrides
for each row
execute function public.set_role_permission_overrides_updated_at();

-- -------------------------------------------------------------------
-- Export audit log
-- -------------------------------------------------------------------

create table if not exists public.export_audit_logs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  user_id uuid not null,
  export_key text not null,
  row_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint export_audit_logs_export_key_check
    check (
      export_key in (
        'export_clients',
        'export_financials',
        'export_schedule',
        'export_events',
        'export_reports'
      )
    ),
  constraint export_audit_logs_row_count_check
    check (row_count is null or row_count >= 0)
);

create index if not exists export_audit_logs_studio_id_idx
  on public.export_audit_logs (studio_id);

create index if not exists export_audit_logs_user_id_idx
  on public.export_audit_logs (user_id);

create index if not exists export_audit_logs_export_key_idx
  on public.export_audit_logs (export_key);

create index if not exists export_audit_logs_created_at_idx
  on public.export_audit_logs (created_at desc);

-- -------------------------------------------------------------------
-- Enable RLS
-- -------------------------------------------------------------------

alter table public.role_permission_overrides enable row level security;
alter table public.export_audit_logs enable row level security;

-- -------------------------------------------------------------------
-- Drop policies if re-running
-- -------------------------------------------------------------------

drop policy if exists role_permission_overrides_owner_select
  on public.role_permission_overrides;
drop policy if exists role_permission_overrides_owner_insert
  on public.role_permission_overrides;
drop policy if exists role_permission_overrides_owner_update
  on public.role_permission_overrides;
drop policy if exists role_permission_overrides_owner_delete
  on public.role_permission_overrides;

drop policy if exists export_audit_logs_owner_select
  on public.export_audit_logs;
drop policy if exists export_audit_logs_owner_insert
  on public.export_audit_logs;

-- -------------------------------------------------------------------
-- RLS: only workspace owners can manage permission overrides
-- Platform admin also allowed
-- -------------------------------------------------------------------

create policy role_permission_overrides_owner_select
on public.role_permission_overrides
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = role_permission_overrides.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

create policy role_permission_overrides_owner_insert
on public.role_permission_overrides
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = role_permission_overrides.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

create policy role_permission_overrides_owner_update
on public.role_permission_overrides
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = role_permission_overrides.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = role_permission_overrides.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

create policy role_permission_overrides_owner_delete
on public.role_permission_overrides
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = role_permission_overrides.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

-- -------------------------------------------------------------------
-- RLS: export audit logs
-- Owners/admins can view; server-side actions can insert
-- -------------------------------------------------------------------

create policy export_audit_logs_owner_select
on public.export_audit_logs
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = export_audit_logs.studio_id
      and usr.active = true
      and usr.role in (
        'platform_admin',
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin'
      )
  )
);

create policy export_audit_logs_owner_insert
on public.export_audit_logs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = export_audit_logs.studio_id
      and usr.active = true
      and usr.role in (
        'platform_admin',
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin'
      )
  )
);

commit;