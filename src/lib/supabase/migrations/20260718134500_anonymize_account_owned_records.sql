alter table public.legal_agreement_acceptances
  add column if not exists user_reference_hash text;

alter table public.legal_agreement_acceptances
  alter column user_id drop not null;

create index if not exists legal_agreement_acceptances_user_reference_hash_idx
  on public.legal_agreement_acceptances(user_reference_hash);
