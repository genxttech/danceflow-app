begin;

create table if not exists public.legal_agreement_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  acceptance_version text not null,
  terms_version text not null,
  privacy_version text not null,
  dpa_version text,
  electronic_signature_version text,
  source text not null,
  account_intent text,
  accepted_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),

  constraint legal_agreement_acceptances_source_check
    check (source in ('business_signup', 'business_reacceptance')),

  constraint legal_agreement_acceptances_account_intent_check
    check (account_intent is null or account_intent in ('studio', 'organizer')),

  constraint legal_agreement_acceptances_version_length_check
    check (
      char_length(acceptance_version) between 1 and 100
      and char_length(terms_version) between 1 and 100
      and char_length(privacy_version) between 1 and 100
      and (dpa_version is null or char_length(dpa_version) between 1 and 100)
      and (
        electronic_signature_version is null
        or char_length(electronic_signature_version) between 1 and 100
      )
    )
);

create index if not exists legal_agreement_acceptances_user_version_idx
  on public.legal_agreement_acceptances (
    user_id,
    acceptance_version,
    terms_version,
    privacy_version,
    dpa_version
  );

create index if not exists legal_agreement_acceptances_accepted_at_idx
  on public.legal_agreement_acceptances (accepted_at desc);

alter table public.legal_agreement_acceptances enable row level security;

drop policy if exists "Users can read their legal acceptances"
  on public.legal_agreement_acceptances;

create policy "Users can read their legal acceptances"
  on public.legal_agreement_acceptances
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can record their legal acceptances"
  on public.legal_agreement_acceptances;

create policy "Users can record their legal acceptances"
  on public.legal_agreement_acceptances
  for insert
  to authenticated
  with check (auth.uid() = user_id);

revoke all on table public.legal_agreement_acceptances from anon;
grant select, insert on table public.legal_agreement_acceptances to authenticated;
grant all on table public.legal_agreement_acceptances to service_role;

commit;
