-- DanceFlow Source-Specific Migration Support
-- WellnessLiving Slice 2: client/staff identity and relationship reconciliation.
--
-- Apply after:
--   20260728000300_wellnessliving_migration_mapping_foundation_v1.sql

create table if not exists public.client_source_relationships (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  source_system text not null,
  source_relationship_id text not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  source_client_external_id text,
  related_client_id uuid references public.clients(id) on delete set null,
  related_source_external_id text,
  household_external_id text,
  relationship_type text not null default 'household_member',
  related_first_name text,
  related_last_name text,
  related_email text,
  related_phone text,
  resolution_status text not null default 'needs_review'
    check (resolution_status in ('resolved', 'needs_review', 'dismissed')),
  import_batch_id uuid references public.import_batches(id) on delete set null,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, source_system, source_relationship_id)
);

create index if not exists client_source_relationships_studio_status_idx
  on public.client_source_relationships(studio_id, resolution_status, updated_at desc);

create index if not exists client_source_relationships_source_client_idx
  on public.client_source_relationships(studio_id, source_system, source_client_external_id);

create index if not exists client_source_relationships_related_source_idx
  on public.client_source_relationships(studio_id, source_system, related_source_external_id);

alter table public.client_source_relationships enable row level security;

drop policy if exists client_source_relationships_studio_read
  on public.client_source_relationships;
create policy client_source_relationships_studio_read
  on public.client_source_relationships
  for select
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = client_source_relationships.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'front_desk')
    )
  );

drop policy if exists client_source_relationships_studio_write
  on public.client_source_relationships;
create policy client_source_relationships_studio_write
  on public.client_source_relationships
  for all
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = client_source_relationships.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'front_desk')
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = client_source_relationships.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'front_desk')
    )
  );

comment on table public.client_source_relationships is
  'Auditable staging/reconciliation records for family, guardian, household, and other source-system client relationships. These records do not automatically grant portal access or account permissions.';

comment on column public.client_source_relationships.resolution_status is
  'resolved when both DanceFlow client records are identified; needs_review when owner judgment is still required.';
