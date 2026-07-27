-- DanceFlow Migration Center mapping and reconciliation foundation v1
-- Adds reusable source mappings, staged migration definitions, and
-- reconciliation records for core, retail, and digital-entitlement migrations.

create extension if not exists pgcrypto;

create table if not exists public.import_mapping_templates (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  source_system text not null,
  import_type text not null,
  name text not null,
  version integer not null default 1,
  status text not null default 'active',
  is_system_template boolean not null default false,
  field_mappings jsonb not null default '{}'::jsonb,
  normalization_rules jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_mapping_templates_status_check
    check (status in ('draft', 'active', 'archived')),
  constraint import_mapping_templates_scope_unique
    unique nulls not distinct (studio_id, source_system, import_type, name, version)
);

create index if not exists import_mapping_templates_lookup_idx
  on public.import_mapping_templates(source_system, import_type, status);

create table if not exists public.import_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  onboarding_project_id uuid references public.onboarding_projects(id) on delete set null,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  stage_key text not null,
  status text not null default 'pending',
  source_record_count integer not null default 0,
  target_record_count integer not null default 0,
  matched_record_count integer not null default 0,
  exception_count integer not null default 0,
  source_totals jsonb not null default '{}'::jsonb,
  target_totals jsonb not null default '{}'::jsonb,
  difference_summary jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_reconciliation_runs_status_check
    check (status in ('pending', 'running', 'matched', 'exceptions', 'failed', 'waived'))
);

create index if not exists import_reconciliation_runs_project_stage_idx
  on public.import_reconciliation_runs(onboarding_project_id, stage_key, created_at desc);

create table if not exists public.import_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references public.import_reconciliation_runs(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  item_key text not null,
  item_type text not null,
  status text not null default 'unmatched',
  source_reference text,
  target_reference text,
  source_value jsonb,
  target_value jsonb,
  difference jsonb,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_reconciliation_items_status_check
    check (status in ('matched', 'unmatched', 'different', 'ignored', 'resolved')),
  constraint import_reconciliation_items_run_key_unique
    unique (reconciliation_run_id, item_key)
);

create index if not exists import_reconciliation_items_run_status_idx
  on public.import_reconciliation_items(reconciliation_run_id, status);

alter table public.import_batches
  add column if not exists mapping_template_id uuid references public.import_mapping_templates(id) on delete set null,
  add column if not exists source_record_count integer,
  add column if not exists target_record_count integer;

-- System migration stages. Retail stages are optional and do not block studios
-- that do not use DanceFlow commerce.
create table if not exists public.migration_stage_definitions (
  stage_key text primary key,
  title text not null,
  sequence_number integer not null,
  domain_key text not null,
  required_by_default boolean not null default true,
  execution_status text not null default 'supported',
  depends_on text[] not null default '{}',
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint migration_stage_execution_status_check
    check (execution_status in ('supported', 'mapping_only', 'assisted', 'planned'))
);

insert into public.migration_stage_definitions
  (stage_key, title, sequence_number, domain_key, required_by_default, execution_status, depends_on, description)
values
  ('clients', 'Clients', 10, 'identity', true, 'supported', '{}', 'Client identity, contact information, notes, and source references.'),
  ('instructors', 'Instructors', 20, 'staff', true, 'supported', '{}', 'Teaching staff and source references.'),
  ('products', 'Retail Products', 30, 'retail', false, 'mapping_only', '{}', 'Retail catalog, categories, SKUs, prices, and active status.'),
  ('inventory', 'Inventory', 40, 'retail', false, 'mapping_only', '{products}', 'Inventory quantities and low-stock thresholds.'),
  ('packages', 'Packages', 50, 'entitlements', false, 'mapping_only', '{clients}', 'Package definitions and remaining balances.'),
  ('memberships', 'Memberships', 60, 'entitlements', false, 'mapping_only', '{clients}', 'Membership status, renewal dates, and available benefits.'),
  ('appointments', 'Appointments', 70, 'schedule', true, 'supported', '{clients,instructors}', 'Future and historical lessons linked to clients and instructors.'),
  ('payments', 'Payments', 80, 'financial', true, 'supported', '{clients}', 'Historical payment records and normalized tender details.'),
  ('retail_orders', 'Retail Orders', 90, 'retail', false, 'mapping_only', '{clients,products,payments}', 'Historical retail orders and line items.'),
  ('digital_entitlements', 'Digital Entitlements', 100, 'digital', false, 'mapping_only', '{clients,products}', 'Existing access rights for digital content.')
on conflict (stage_key) do update set
  title = excluded.title,
  sequence_number = excluded.sequence_number,
  domain_key = excluded.domain_key,
  required_by_default = excluded.required_by_default,
  execution_status = excluded.execution_status,
  depends_on = excluded.depends_on,
  description = excluded.description,
  updated_at = now();

alter table public.import_mapping_templates enable row level security;
alter table public.import_reconciliation_runs enable row level security;
alter table public.import_reconciliation_items enable row level security;
alter table public.migration_stage_definitions enable row level security;

drop policy if exists import_mapping_templates_workspace_access on public.import_mapping_templates;
create policy import_mapping_templates_workspace_access
  on public.import_mapping_templates
  for all
  using (
    is_system_template = true
    or exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = import_mapping_templates.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  )
  with check (
    is_system_template = false
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = import_mapping_templates.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

do $$
declare
  table_name text;
begin
  foreach table_name in array array['import_reconciliation_runs', 'import_reconciliation_items']
  loop
    execute format('drop policy if exists %I_workspace_access on public.%I', table_name, table_name);
    execute format($policy$
      create policy %I_workspace_access on public.%I for all
      using (exists (
        select 1 from public.user_studio_roles usr
        where usr.studio_id = %I.studio_id
          and usr.user_id = auth.uid()
          and usr.active = true
      ))
      with check (exists (
        select 1 from public.user_studio_roles usr
        where usr.studio_id = %I.studio_id
          and usr.user_id = auth.uid()
          and usr.active = true
      ))
    $policy$, table_name, table_name, table_name, table_name);
  end loop;
end $$;

drop policy if exists migration_stage_definitions_read on public.migration_stage_definitions;
create policy migration_stage_definitions_read
  on public.migration_stage_definitions
  for select
  using (auth.uid() is not null);

comment on table public.import_mapping_templates is
  'Reusable source-specific field mapping and normalization templates for core and retail imports.';
comment on table public.import_reconciliation_runs is
  'Source-to-target reconciliation summaries for each onboarding migration stage.';
comment on table public.migration_stage_definitions is
  'Canonical dependency-aware migration stages including optional retail and digital entitlement stages.';
