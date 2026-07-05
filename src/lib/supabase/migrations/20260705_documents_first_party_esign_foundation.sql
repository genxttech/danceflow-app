-- First-party document/e-signature foundation.
-- Run this in development and production before deploying code that writes the new fields.

alter table public.document_templates
  add column if not exists versioning_enabled boolean not null default true,
  add column if not exists current_version_id uuid,
  add column if not exists default_consent_text text,
  add column if not exists retention_policy text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.document_template_versions
  add column if not exists version_number integer,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists body text,
  add column if not exists requires_signature boolean not null default true,
  add column if not exists consent_text text,
  add column if not exists created_by uuid,
  add column if not exists published_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.document_assignments
  add column if not exists signer_user_id uuid,
  add column if not exists assigned_by uuid,
  add column if not exists completed_at timestamptz,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.document_signatures
  add column if not exists signer_user_id uuid,
  add column if not exists signature_method text not null default 'typed',
  add column if not exists signature_drawn_data_url text,
  add column if not exists signed_pdf_storage_path text,
  add column if not exists signed_pdf_sha256 text,
  add column if not exists ip_address inet,
  add column if not exists device_metadata jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.document_signature_audit_events (
  id uuid primary key default gen_random_uuid(),
  signature_id uuid references public.document_signatures(id) on delete cascade,
  assignment_id uuid references public.document_assignments(id) on delete cascade,
  template_id uuid references public.document_templates(id) on delete set null,
  template_version_id uuid references public.document_template_versions(id) on delete set null,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid,
  event_id uuid references public.events(id) on delete cascade,
  event_registration_id uuid references public.event_registrations(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  actor_user_id uuid,
  actor_email text,
  event_type text not null,
  event_summary text,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.document_signed_files (
  id uuid primary key default gen_random_uuid(),
  signature_id uuid not null references public.document_signatures(id) on delete cascade,
  assignment_id uuid references public.document_assignments(id) on delete cascade,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid,
  event_id uuid references public.events(id) on delete cascade,
  event_registration_id uuid references public.event_registrations(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  storage_bucket text not null default 'documents',
  storage_path text not null,
  content_type text not null default 'application/pdf',
  sha256 text,
  generated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_template_versions_template_version_idx
  on public.document_template_versions(template_id, version_number desc);

create index if not exists document_assignments_signer_status_idx
  on public.document_assignments(studio_id, signer_user_id, status);

create index if not exists document_assignments_event_registration_idx
  on public.document_assignments(event_registration_id);

create index if not exists document_signatures_assignment_idx
  on public.document_signatures(assignment_id);

create index if not exists document_signatures_event_registration_idx
  on public.document_signatures(event_registration_id);

create index if not exists document_signature_audit_signature_idx
  on public.document_signature_audit_events(signature_id, created_at desc);

create index if not exists document_signature_audit_assignment_idx
  on public.document_signature_audit_events(assignment_id, created_at desc);

create index if not exists document_signed_files_signature_idx
  on public.document_signed_files(signature_id);
