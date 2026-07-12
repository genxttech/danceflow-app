begin;

alter table public.document_sign_envelopes
  add column if not exists template_id uuid null references public.document_templates(id) on delete set null,
  add column if not exists template_version_id uuid null references public.document_template_versions(id) on delete set null,
  add column if not exists client_id uuid null references public.clients(id) on delete set null,
  add column if not exists assignment_id uuid null references public.document_assignments(id) on delete set null,
  add column if not exists source_kind text not null default 'uploaded_pdf';

alter table public.document_sign_envelopes
  drop constraint if exists document_sign_envelopes_source_kind_check;

alter table public.document_sign_envelopes
  add constraint document_sign_envelopes_source_kind_check
  check (source_kind in ('uploaded_pdf', 'template_version'));

alter table public.document_assignments
  add column if not exists sign_envelope_id uuid null references public.document_sign_envelopes(id) on delete set null;

create unique index if not exists document_assignments_sign_envelope_uidx
  on public.document_assignments(sign_envelope_id)
  where sign_envelope_id is not null;

create index if not exists document_sign_envelopes_template_idx
  on public.document_sign_envelopes(studio_id, template_id, created_at desc)
  where template_id is not null;

create index if not exists document_sign_envelopes_client_idx
  on public.document_sign_envelopes(studio_id, client_id, created_at desc)
  where client_id is not null;

commit;
