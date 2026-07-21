begin;

alter table public.document_sign_envelopes
  add column if not exists revision_of_envelope_id uuid null,
  add column if not exists superseded_by_envelope_id uuid null,
  add column if not exists revision_kind text null,
  add column if not exists revision_reason text null,
  add column if not exists revision_number integer not null default 1,
  add column if not exists superseded_at timestamptz null,
  add column if not exists superseded_by uuid null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_sign_envelopes_revision_of_fk'
      and conrelid = 'public.document_sign_envelopes'::regclass
  ) then
    alter table public.document_sign_envelopes
      add constraint document_sign_envelopes_revision_of_fk
      foreign key (revision_of_envelope_id)
      references public.document_sign_envelopes(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_sign_envelopes_superseded_by_fk'
      and conrelid = 'public.document_sign_envelopes'::regclass
  ) then
    alter table public.document_sign_envelopes
      add constraint document_sign_envelopes_superseded_by_fk
      foreign key (superseded_by_envelope_id)
      references public.document_sign_envelopes(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_sign_envelopes_revision_kind_check'
      and conrelid = 'public.document_sign_envelopes'::regclass
  ) then
    alter table public.document_sign_envelopes
      add constraint document_sign_envelopes_revision_kind_check
      check (revision_kind is null or revision_kind in ('revision', 'duplicate'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_sign_envelopes_revision_number_check'
      and conrelid = 'public.document_sign_envelopes'::regclass
  ) then
    alter table public.document_sign_envelopes
      add constraint document_sign_envelopes_revision_number_check
      check (revision_number >= 1);
  end if;
end
$$;

create index if not exists document_sign_envelopes_revision_of_idx
  on public.document_sign_envelopes (revision_of_envelope_id)
  where revision_of_envelope_id is not null;

create index if not exists document_sign_envelopes_superseded_by_idx
  on public.document_sign_envelopes (superseded_by_envelope_id)
  where superseded_by_envelope_id is not null;

create index if not exists document_sign_envelopes_revision_chain_idx
  on public.document_sign_envelopes (studio_id, revision_of_envelope_id, revision_number);

comment on column public.document_sign_envelopes.revision_of_envelope_id is
  'Prior signing request used as the protected source for this replacement or duplicate.';
comment on column public.document_sign_envelopes.superseded_by_envelope_id is
  'Replacement draft that superseded this request. The original audit history remains immutable.';
comment on column public.document_sign_envelopes.revision_kind is
  'revision replaces a non-completed request; duplicate creates a new request from a completed record.';
comment on column public.document_sign_envelopes.revision_reason is
  'Staff-provided reason explaining why the replacement or duplicate was created.';
comment on column public.document_sign_envelopes.revision_number is
  'One-based sequence number within a signing-request revision chain.';

commit;
