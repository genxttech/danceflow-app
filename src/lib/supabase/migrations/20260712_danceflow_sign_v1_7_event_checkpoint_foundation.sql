begin;

alter table public.document_sign_envelopes
  add column if not exists context_type text,
  add column if not exists context_id uuid,
  add column if not exists return_url text,
  add column if not exists sequence_group_id uuid,
  add column if not exists sequence_position integer,
  add column if not exists sequence_total integer;

alter table public.document_sign_envelopes
  drop constraint if exists document_sign_envelopes_context_type_check;

alter table public.document_sign_envelopes
  add constraint document_sign_envelopes_context_type_check
  check (
    context_type is null
    or context_type in (
      'client_assignment',
      'event_registration',
      'event_order',
      'event_checkout'
    )
  );

create index if not exists document_sign_envelopes_context_idx
  on public.document_sign_envelopes (context_type, context_id);

create index if not exists document_sign_envelopes_sequence_idx
  on public.document_sign_envelopes (sequence_group_id, sequence_position);

commit;
