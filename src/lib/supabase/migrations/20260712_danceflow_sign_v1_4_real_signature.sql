begin;

alter table if exists public.document_sign_envelopes
  add column if not exists signature_method text,
  add column if not exists signed_timezone text,
  add column if not exists consent_text text;

alter table if exists public.document_sign_values
  add column if not exists signature_method text,
  add column if not exists signature_data_url text;

alter table if exists public.document_sign_envelopes
  drop constraint if exists document_sign_envelopes_signature_method_check;

alter table if exists public.document_sign_envelopes
  add constraint document_sign_envelopes_signature_method_check
  check (signature_method is null or signature_method in ('typed', 'drawn', 'mixed'));

alter table if exists public.document_sign_values
  drop constraint if exists document_sign_values_signature_method_check;

alter table if exists public.document_sign_values
  add constraint document_sign_values_signature_method_check
  check (signature_method is null or signature_method in ('typed', 'drawn'));

commit;
