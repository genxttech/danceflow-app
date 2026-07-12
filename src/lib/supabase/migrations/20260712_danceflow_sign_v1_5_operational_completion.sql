begin;

alter table if exists public.document_sign_envelopes
  add column if not exists revoked_reason text,
  add column if not exists declined_reason text,
  add column if not exists last_reminded_at timestamptz,
  add column if not exists reminder_count integer not null default 0;

alter table if exists public.document_sign_events
  drop constraint if exists document_sign_events_event_type_check;

alter table if exists public.document_sign_events
  add constraint document_sign_events_event_type_check
  check (event_type in (
    'created','sent','resent','viewed','started','completed','declined',
    'expired','voided','revoked','delivery_exception','downloaded'
  ));

create index if not exists document_sign_envelopes_client_created_idx
  on public.document_sign_envelopes(client_id, created_at desc)
  where client_id is not null;

commit;
