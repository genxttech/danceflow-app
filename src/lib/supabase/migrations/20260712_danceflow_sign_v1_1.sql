begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('document-files', 'document-files', false, 15728640, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.document_sign_envelopes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  organizer_id uuid null references public.organizers(id) on delete cascade,
  assignment_id uuid null references public.document_assignments(id) on delete set null,
  template_id uuid null references public.document_templates(id) on delete set null,
  template_version_id uuid null references public.document_template_versions(id) on delete set null,
  client_id uuid null references public.clients(id) on delete set null,
  title text not null,
  signer_name text not null,
  signer_email text not null,
  status text not null default 'draft' check (status in ('draft','sent','viewed','started','completed','declined','expired','void')),
  token_hash text not null unique,
  source_bucket text not null default 'document-files',
  source_path text not null,
  signed_bucket text null,
  signed_path text null,
  certificate_bucket text null,
  certificate_path text null,
  source_sha256 text not null,
  signed_sha256 text null,
  page_count integer not null check (page_count > 0),
  expires_at timestamptz not null,
  sent_at timestamptz null,
  viewed_at timestamptz null,
  started_at timestamptz null,
  completed_at timestamptz null,
  declined_at timestamptz null,
  voided_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_sign_fields (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references public.document_sign_envelopes(id) on delete cascade,
  field_type text not null check (field_type in ('signature','initials','printed_name','date','text','checkbox')),
  page_number integer not null check (page_number > 0),
  x numeric(8,6) not null check (x >= 0 and x <= 1),
  y numeric(8,6) not null check (y >= 0 and y <= 1),
  width numeric(8,6) not null check (width > 0 and width <= 1),
  height numeric(8,6) not null check (height > 0 and height <= 1),
  label text not null,
  required boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.document_sign_values (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references public.document_sign_envelopes(id) on delete cascade,
  field_id uuid not null references public.document_sign_fields(id) on delete cascade,
  value_text text null,
  value_boolean boolean null,
  created_at timestamptz not null default now(),
  unique (envelope_id, field_id)
);

create table if not exists public.document_sign_events (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references public.document_sign_envelopes(id) on delete cascade,
  event_type text not null check (event_type in ('created','sent','viewed','started','completed','declined','expired','voided','delivery_exception')),
  actor_user_id uuid null references auth.users(id) on delete set null,
  actor_email text null,
  ip_address inet null,
  user_agent text null,
  summary text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists document_sign_envelopes_studio_status_idx on public.document_sign_envelopes(studio_id, status, created_at desc);
create index if not exists document_sign_fields_envelope_idx on public.document_sign_fields(envelope_id, page_number, sort_order);
create index if not exists document_sign_events_envelope_idx on public.document_sign_events(envelope_id, created_at);

alter table public.document_sign_envelopes enable row level security;
alter table public.document_sign_fields enable row level security;
alter table public.document_sign_values enable row level security;
alter table public.document_sign_events enable row level security;

-- Server-side actions use the service role. Authenticated studio users only receive read access.
drop policy if exists document_sign_envelopes_studio_read on public.document_sign_envelopes;
create policy document_sign_envelopes_studio_read on public.document_sign_envelopes
for select to authenticated using (
  exists (
    select 1 from public.user_studio_roles su
    where su.studio_id = document_sign_envelopes.studio_id
      and su.user_id = auth.uid()
      and su.active = true
  )
);

drop policy if exists document_sign_fields_studio_read on public.document_sign_fields;
create policy document_sign_fields_studio_read on public.document_sign_fields
for select to authenticated using (
  exists (
    select 1 from public.document_sign_envelopes e
    join public.user_studio_roles su on su.studio_id = e.studio_id
    where e.id = document_sign_fields.envelope_id
      and su.user_id = auth.uid()
      and su.active = true
  )
);

drop policy if exists document_sign_values_studio_read on public.document_sign_values;
create policy document_sign_values_studio_read on public.document_sign_values
for select to authenticated using (
  exists (
    select 1 from public.document_sign_envelopes e
    join public.user_studio_roles su on su.studio_id = e.studio_id
    where e.id = document_sign_values.envelope_id
      and su.user_id = auth.uid()
      and su.active = true
  )
);

drop policy if exists document_sign_events_studio_read on public.document_sign_events;
create policy document_sign_events_studio_read on public.document_sign_events
for select to authenticated using (
  exists (
    select 1 from public.document_sign_envelopes e
    join public.user_studio_roles su on su.studio_id = e.studio_id
    where e.id = document_sign_events.envelope_id
      and su.user_id = auth.uid()
      and su.active = true
  )
);

alter table if exists public.document_signed_files alter column storage_bucket set default 'document-files';

commit;
