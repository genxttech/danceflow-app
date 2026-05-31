-- Documents & E-Signatures V1 Phase 2: client portal signing policies
-- Allows portal users to view/sign their own assigned documents and active all-client documents.

alter table public.document_templates enable row level security;
alter table public.document_template_versions enable row level security;
alter table public.document_assignments enable row level security;
alter table public.document_signatures enable row level security;

drop policy if exists "Portal users can view assigned document templates" on public.document_templates;
drop policy if exists "Portal users can view assigned document versions" on public.document_template_versions;
drop policy if exists "Portal users can view own document assignments" on public.document_assignments;
drop policy if exists "Portal users can mark own document assignments signed" on public.document_assignments;
drop policy if exists "Portal users can view own document signatures" on public.document_signatures;

create policy "Portal users can view assigned document templates"
on public.document_templates for select
to authenticated
using (
  (
    studio_id is not null
    and is_active = true
    and applies_to = 'all_clients'
    and exists (
      select 1
      from public.clients c
      where c.studio_id = document_templates.studio_id
        and c.portal_user_id = auth.uid()
    )
  )
  or
  exists (
    select 1
    from public.document_assignments da
    join public.clients c on c.id = da.client_id
    where da.template_id = document_templates.id
      and c.portal_user_id = auth.uid()
      and da.status <> 'void'
  )
);

create policy "Portal users can view assigned document versions"
on public.document_template_versions for select
to authenticated
using (
  exists (
    select 1
    from public.document_templates dt
    join public.clients c on c.studio_id = dt.studio_id
    where dt.id = document_template_versions.template_id
      and dt.is_active = true
      and dt.applies_to = 'all_clients'
      and c.portal_user_id = auth.uid()
  )
  or
  exists (
    select 1
    from public.document_assignments da
    join public.clients c on c.id = da.client_id
    where da.template_id = document_template_versions.template_id
      and c.portal_user_id = auth.uid()
      and da.status <> 'void'
  )
);

create policy "Portal users can view own document assignments"
on public.document_assignments for select
to authenticated
using (
  client_id is not null
  and exists (
    select 1
    from public.clients c
    where c.id = document_assignments.client_id
      and c.portal_user_id = auth.uid()
  )
);

create policy "Portal users can mark own document assignments signed"
on public.document_assignments for update
to authenticated
using (
  client_id is not null
  and exists (
    select 1
    from public.clients c
    where c.id = document_assignments.client_id
      and c.portal_user_id = auth.uid()
  )
)
with check (
  client_id is not null
  and status in ('pending', 'signed')
  and exists (
    select 1
    from public.clients c
    where c.id = document_assignments.client_id
      and c.portal_user_id = auth.uid()
  )
);

create policy "Portal users can view own document signatures"
on public.document_signatures for select
to authenticated
using (
  signer_user_id = auth.uid()
  or (
    client_id is not null
    and exists (
      select 1
      from public.clients c
      where c.id = document_signatures.client_id
        and c.portal_user_id = auth.uid()
    )
  )
);
