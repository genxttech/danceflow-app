-- Phase 8B -- reconciliation migration: event_document_requirements
--
-- public.event_document_requirements exists on DEV and PROD (identical catalog metadata at Phase 8B review: columns,
-- defaults, constraints, indexes, RLS, policies, trigger). Like studios / clients / events / organizers, it predates
-- this repository's migration history and was never created by a repository migration (none exists in git history).
--
-- Schema history: this project rebuilds a database from the production baseline snapshot
-- (danceflow-production-pre-accounting-v1-2026-07-15) followed by the repository migrations dated 2026-07-15 and later.
-- That baseline already contains this table with exactly the reviewed definition (fingerprint below), so in a rebuilt
-- database it exists before its first dependency, 20260712_danceflow_sign_v1_7_1_event_registration_completion.sql
-- (pre-baseline; its effects are part of the baseline). A backdated bootstrap migration would never execute in that
-- rebuild, and the repository cannot be replayed from an empty schema at all (its base tables are baseline-only), so
-- none is added. This migration is the forward record and defensive verification: a strict no-op on a correct table,
-- the exact definition where the table is absent, and a hard failure on drift. Verified (Phase 8B) by a disposable
-- rebuild: baseline + 195 forward migrations, this file a no-op, fingerprint unchanged.
--
-- Fail-closed:
--   * Preflight: if the table exists, its catalog fingerprint (md5 over columns, constraints, indexes, RLS flags,
--     policies and triggers) must equal the reviewed value, or the migration raises before touching anything.
--   * Every statement is conditional (IF NOT EXISTS / existence checks), so the existing table, its policies, its
--     trigger and its data are never dropped, recreated or altered -- not even transiently.
--   * Postflight: the fingerprint must equal the reviewed value afterwards, whether the table was created here or
--     already existed. This also proves the create path reproduces the live schema exactly.
--
-- Recorded as-is (not redesigned here): the duplicate (event_id, active) and template indexes, and the existing
-- policy predicates. Table grants follow the project's default privileges and are not part of the fingerprint.

begin;

create or replace function pg_temp.p8b_event_document_requirements_fingerprint()
returns text
language sql
stable
-- Pinned so the deparsed predicates (auth.users, auth.uid()) are identical whatever the caller search_path is.
set search_path to pg_catalog, public
as $fn$
  select md5(string_agg(k || '|' || n || '|' || v, E'\n' order by k collate "C", n collate "C"))
  from (
    select 'col' k, lpad(ordinal_position::text, 2, '0') || ' ' || column_name::text n,
           data_type::text || '|' || is_nullable::text || '|' || coalesce(column_default::text, '') v
    from information_schema.columns
    where table_schema = 'public' and table_name = 'event_document_requirements'
    union all
    select 'con', conname::text, pg_get_constraintdef(oid)
    from pg_constraint where conrelid = to_regclass('public.event_document_requirements')
    union all
    select 'idx', indexname::text, indexdef
    from pg_indexes where schemaname = 'public' and tablename = 'event_document_requirements'
    union all
    select 'rls', 'relrowsecurity', relrowsecurity::text || '/' || relforcerowsecurity::text
    from pg_class where oid = to_regclass('public.event_document_requirements')
    union all
    select 'pol', policyname::text || ' | ' || cmd || ' | ' || array_to_string(roles, ','),
           coalesce(qual, '') || ' || ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements'
    union all
    select 'trg', tgname::text, pg_get_triggerdef(oid)
    from pg_trigger where tgrelid = to_regclass('public.event_document_requirements') and not tgisinternal
  ) s
$fn$;

-- Preflight
do $$
declare
  v_fp text;
begin
  if to_regclass('public.event_document_requirements') is not null then
    v_fp := pg_temp.p8b_event_document_requirements_fingerprint();
    if v_fp is distinct from '7426ac2d0aa74eccba5ff5098c0398e7' then
      raise exception 'Phase 8B preflight: event_document_requirements schema drifted from the reviewed definition (fp=%)', v_fp;
    end if;
  end if;
end;
$$;

create table if not exists public.event_document_requirements (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  template_id uuid not null,
  template_version_id uuid null,
  studio_id uuid null,
  organizer_id uuid null,
  is_required boolean not null default true,
  active boolean not null default true,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_document_requirements_pkey primary key (id),
  constraint event_document_requirements_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  constraint event_document_requirements_event_id_fkey
    foreign key (event_id) references public.events(id) on delete cascade,
  constraint event_document_requirements_organizer_id_fkey
    foreign key (organizer_id) references public.organizers(id) on delete cascade,
  constraint event_document_requirements_studio_id_fkey
    foreign key (studio_id) references public.studios(id) on delete cascade,
  constraint event_document_requirements_template_id_fkey
    foreign key (template_id) references public.document_templates(id) on delete cascade,
  constraint event_document_requirements_template_version_id_fkey
    foreign key (template_version_id) references public.document_template_versions(id) on delete set null
);

create index if not exists idx_event_document_requirements_event_active
  on public.event_document_requirements using btree (event_id, active);
create index if not exists idx_event_document_requirements_event_id_active
  on public.event_document_requirements using btree (event_id, active);
create index if not exists idx_event_document_requirements_template
  on public.event_document_requirements using btree (template_id, active);
create index if not exists idx_event_document_requirements_template_id
  on public.event_document_requirements using btree (template_id);
create unique index if not exists uq_event_document_requirements_active
  on public.event_document_requirements using btree (event_id, template_id) where (active = true);

alter table public.event_document_requirements enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements'
      and policyname = 'Organizer users can manage event document requirements'
  ) then
    create policy "Organizer users can manage event document requirements"
      on public.event_document_requirements
      for all
      using (
        (organizer_id is not null) and (exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = event_document_requirements.organizer_id
            and ou.user_id = auth.uid()
            and ou.active = true
            and ou.role = any (array['organizer_owner'::text, 'organizer_admin'::text, 'organizer_staff'::text])
        ))
      )
      with check (
        (organizer_id is not null) and (exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = event_document_requirements.organizer_id
            and ou.user_id = auth.uid()
            and ou.active = true
            and ou.role = any (array['organizer_owner'::text, 'organizer_admin'::text, 'organizer_staff'::text])
        ))
      );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements'
      and policyname = 'Public can view active event document requirements'
  ) then
    create policy "Public can view active event document requirements"
      on public.event_document_requirements
      for select
      using (
        (active = true) and (exists (
          select 1 from public.events e
          where e.id = event_document_requirements.event_id
            and e.status = 'published'::text
            and e.visibility = any (array['public'::text, 'unlisted'::text])
        ))
      );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements'
      and policyname = 'Studio users can manage event document requirements'
  ) then
    create policy "Studio users can manage event document requirements"
      on public.event_document_requirements
      for all
      using (
        exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = event_document_requirements.studio_id
            and usr.user_id = auth.uid()
            and usr.role = any (array['studio_owner'::public.app_role, 'studio_admin'::public.app_role, 'front_desk'::public.app_role])
        )
      )
      with check (
        exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = event_document_requirements.studio_id
            and usr.user_id = auth.uid()
            and usr.role = any (array['studio_owner'::public.app_role, 'studio_admin'::public.app_role, 'front_desk'::public.app_role])
        )
      );
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.event_document_requirements'::regclass
      and tgname = 'set_event_document_requirements_updated_at'
      and not tgisinternal
  ) then
    create trigger set_event_document_requirements_updated_at
      before update on public.event_document_requirements
      for each row execute function public.set_updated_at();
  end if;
end;
$$;

-- Postflight
do $$
declare
  v_fp text;
begin
  v_fp := pg_temp.p8b_event_document_requirements_fingerprint();
  if v_fp is distinct from '7426ac2d0aa74eccba5ff5098c0398e7' then
    raise exception 'Phase 8B postflight: event_document_requirements does not match the reviewed definition (fp=%)', v_fp;
  end if;
end;
$$;

drop function pg_temp.p8b_event_document_requirements_fingerprint();

commit;
