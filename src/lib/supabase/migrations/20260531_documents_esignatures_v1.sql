-- Documents & E-Signatures V1 foundation
-- Creates reusable document templates, version history, assignments, and signatures.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.document_templates (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  scope text not null default 'studio' check (scope in ('studio', 'organizer')),
  document_type text not null default 'waiver' check (document_type in ('waiver', 'policy', 'agreement', 'release', 'membership_terms', 'package_policy', 'cancellation_policy', 'minor_guardian', 'custom')),
  title text not null,
  description text,
  body text not null,
  applies_to text not null default 'manual' check (applies_to in ('manual', 'all_clients', 'event_registrants', 'package_buyers', 'membership_buyers', 'minors_guardians')),
  requires_signature boolean not null default true,
  is_required boolean not null default false,
  is_active boolean not null default true,
  current_version integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_templates_scope_owner_check check (
    (scope = 'studio' and studio_id is not null and organizer_id is null) or
    (scope = 'organizer' and organizer_id is not null)
  )
);

create table if not exists public.document_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete cascade,
  version_number integer not null,
  title text not null,
  description text,
  body text not null,
  requires_signature boolean not null default true,
  is_required boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version_number)
);

create table if not exists public.document_assignments (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete cascade,
  template_version_id uuid references public.document_template_versions(id) on delete set null,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  event_registration_id uuid references public.event_registrations(id) on delete cascade,
  organizer_contact_id uuid references public.organizer_contacts(id) on delete cascade,
  assigned_to_email text,
  status text not null default 'pending' check (status in ('pending', 'signed', 'waived', 'void')),
  due_at timestamptz,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_signatures (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references public.document_assignments(id) on delete set null,
  template_id uuid not null references public.document_templates(id) on delete restrict,
  template_version_id uuid references public.document_template_versions(id) on delete set null,
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  event_registration_id uuid references public.event_registrations(id) on delete set null,
  organizer_contact_id uuid references public.organizer_contacts(id) on delete set null,
  signer_name text not null,
  signer_email text,
  signer_user_id uuid references auth.users(id) on delete set null,
  signed_body text not null,
  signature_text text not null,
  consent_text text not null,
  ip_address inet,
  user_agent text,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_document_templates_studio on public.document_templates(studio_id, is_active);
create index if not exists idx_document_templates_organizer on public.document_templates(organizer_id, is_active);
create index if not exists idx_document_assignments_client on public.document_assignments(client_id, status);
create index if not exists idx_document_assignments_registration on public.document_assignments(event_registration_id, status);
create index if not exists idx_document_signatures_client on public.document_signatures(client_id, signed_at desc);
create index if not exists idx_document_signatures_registration on public.document_signatures(event_registration_id, signed_at desc);

create or replace trigger set_document_templates_updated_at
before update on public.document_templates
for each row execute function public.set_updated_at();

create or replace trigger set_document_assignments_updated_at
before update on public.document_assignments
for each row execute function public.set_updated_at();

alter table public.document_templates enable row level security;
alter table public.document_template_versions enable row level security;
alter table public.document_assignments enable row level security;
alter table public.document_signatures enable row level security;

-- Drop/recreate V1 policies so the migration can be rerun safely.
drop policy if exists "Studio users can view document templates" on public.document_templates;
drop policy if exists "Studio admins can manage document templates" on public.document_templates;
drop policy if exists "Studio users can view document versions" on public.document_template_versions;
drop policy if exists "Studio admins can manage document versions" on public.document_template_versions;
drop policy if exists "Studio users can view document assignments" on public.document_assignments;
drop policy if exists "Studio admins can manage document assignments" on public.document_assignments;
drop policy if exists "Studio users can view document signatures" on public.document_signatures;
drop policy if exists "Portal users can create document signatures" on public.document_signatures;

create policy "Studio users can view document templates"
on public.document_templates for select
to authenticated
using (
  (
    studio_id is not null and exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = document_templates.studio_id
        and usr.user_id = auth.uid()
        and coalesce(usr.active, true) = true
    )
  )
  or
  (
    organizer_id is not null and exists (
      select 1 from public.organizer_users ou
      where ou.organizer_id = document_templates.organizer_id
        and ou.user_id = auth.uid()
        and coalesce(ou.active, true) = true
    )
  )
);

create policy "Studio admins can manage document templates"
on public.document_templates for all
to authenticated
using (
  (
    studio_id is not null and exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = document_templates.studio_id
        and usr.user_id = auth.uid()
        and coalesce(usr.active, true) = true
        and usr.role::text in ('studio_owner','studio_admin','owner','admin','front_desk')
    )
  )
  or
  (
    organizer_id is not null and exists (
      select 1 from public.organizer_users ou
      where ou.organizer_id = document_templates.organizer_id
        and ou.user_id = auth.uid()
        and coalesce(ou.active, true) = true
        and ou.role::text in ('organizer_owner','organizer_admin','organizer_staff')
    )
  )
)
with check (
  (
    studio_id is not null and exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = document_templates.studio_id
        and usr.user_id = auth.uid()
        and coalesce(usr.active, true) = true
        and usr.role::text in ('studio_owner','studio_admin','owner','admin','front_desk')
    )
  )
  or
  (
    organizer_id is not null and exists (
      select 1 from public.organizer_users ou
      where ou.organizer_id = document_templates.organizer_id
        and ou.user_id = auth.uid()
        and coalesce(ou.active, true) = true
        and ou.role::text in ('organizer_owner','organizer_admin','organizer_staff')
    )
  )
);

create policy "Studio users can view document versions"
on public.document_template_versions for select
to authenticated
using (
  exists (
    select 1 from public.document_templates dt
    where dt.id = document_template_versions.template_id
      and (
        (dt.studio_id is not null and exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = dt.studio_id
            and usr.user_id = auth.uid()
            and coalesce(usr.active, true) = true
        ))
        or
        (dt.organizer_id is not null and exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = dt.organizer_id
            and ou.user_id = auth.uid()
            and coalesce(ou.active, true) = true
        ))
      )
  )
);

create policy "Studio admins can manage document versions"
on public.document_template_versions for all
to authenticated
using (
  exists (
    select 1 from public.document_templates dt
    where dt.id = document_template_versions.template_id
      and (
        (dt.studio_id is not null and exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = dt.studio_id
            and usr.user_id = auth.uid()
            and coalesce(usr.active, true) = true
            and usr.role::text in ('studio_owner','studio_admin','owner','admin','front_desk')
        ))
        or
        (dt.organizer_id is not null and exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = dt.organizer_id
            and ou.user_id = auth.uid()
            and coalesce(ou.active, true) = true
            and ou.role::text in ('organizer_owner','organizer_admin','organizer_staff')
        ))
      )
  )
)
with check (
  exists (
    select 1 from public.document_templates dt
    where dt.id = document_template_versions.template_id
      and (
        (dt.studio_id is not null and exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = dt.studio_id
            and usr.user_id = auth.uid()
            and coalesce(usr.active, true) = true
            and usr.role::text in ('studio_owner','studio_admin','owner','admin','front_desk')
        ))
        or
        (dt.organizer_id is not null and exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = dt.organizer_id
            and ou.user_id = auth.uid()
            and coalesce(ou.active, true) = true
            and ou.role::text in ('organizer_owner','organizer_admin','organizer_staff')
        ))
      )
  )
);

create policy "Studio users can view document assignments"
on public.document_assignments for select
to authenticated
using (
  (studio_id is not null and exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = document_assignments.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
  ))
  or
  (organizer_id is not null and exists (
    select 1 from public.organizer_users ou
    where ou.organizer_id = document_assignments.organizer_id
      and ou.user_id = auth.uid()
      and coalesce(ou.active, true) = true
  ))
);

create policy "Studio admins can manage document assignments"
on public.document_assignments for all
to authenticated
using (
  (studio_id is not null and exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = document_assignments.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
      and usr.role::text in ('studio_owner','studio_admin','owner','admin','front_desk')
  ))
  or
  (organizer_id is not null and exists (
    select 1 from public.organizer_users ou
    where ou.organizer_id = document_assignments.organizer_id
      and ou.user_id = auth.uid()
      and coalesce(ou.active, true) = true
      and ou.role::text in ('organizer_owner','organizer_admin','organizer_staff')
  ))
)
with check (
  (studio_id is not null and exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = document_assignments.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
      and usr.role::text in ('studio_owner','studio_admin','owner','admin','front_desk')
  ))
  or
  (organizer_id is not null and exists (
    select 1 from public.organizer_users ou
    where ou.organizer_id = document_assignments.organizer_id
      and ou.user_id = auth.uid()
      and coalesce(ou.active, true) = true
      and ou.role::text in ('organizer_owner','organizer_admin','organizer_staff')
  ))
);

create policy "Studio users can view document signatures"
on public.document_signatures for select
to authenticated
using (
  (studio_id is not null and exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = document_signatures.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
  ))
  or
  (organizer_id is not null and exists (
    select 1 from public.organizer_users ou
    where ou.organizer_id = document_signatures.organizer_id
      and ou.user_id = auth.uid()
      and coalesce(ou.active, true) = true
  ))
  or signer_user_id = auth.uid()
);

create policy "Portal users can create document signatures"
on public.document_signatures for insert
to authenticated
with check (
  signer_user_id = auth.uid()
  or
  (client_id is not null and exists (
    select 1 from public.clients c
    where c.id = document_signatures.client_id
      and c.portal_user_id = auth.uid()
  ))
);
