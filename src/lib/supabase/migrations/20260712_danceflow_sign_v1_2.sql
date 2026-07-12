begin;

alter table public.document_sign_envelopes
  alter column token_hash drop not null,
  add column if not exists page_sizes jsonb not null default '[]'::jsonb;

alter table public.document_sign_fields
  add column if not exists placeholder_text text null,
  add column if not exists default_value text null;

create index if not exists document_sign_envelopes_draft_idx
  on public.document_sign_envelopes(studio_id, status, updated_at desc)
  where status = 'draft';

commit;
