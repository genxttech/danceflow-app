-- Phase 8B -- schema-history reconciliation: event_document_requirements (verification only)
--
-- Origin: public.event_document_requirements originates in the production baseline snapshot
-- (danceflow-production-pre-accounting-v1-2026-07-15). Like studios / clients / events / organizers, it predates this
-- repository's migration history; no repository migration has ever created it.
--
-- Supported database model: Supabase base schemas, then the production baseline snapshot, then the repository's
-- forward migrations layered on that baseline. The table therefore exists before its first repository dependency,
-- 20260712_danceflow_sign_v1_7_1_event_registration_completion.sql (pre-baseline; its effects are in the baseline).
-- Replaying the repository from an empty schema is not a supported model for this project.
--
-- This migration records and verifies the required canonical shape. It performs no DDL and no data change:
--   * table absent  -> FAIL CLOSED: the required baseline schema is missing, so the database was not built on the
--                      supported baseline. This migration does not (and cannot faithfully) reconstruct the table.
--   * table present -> its catalog fingerprint (md5 over columns, constraints, indexes, RLS flags, policies and
--                      triggers) must equal the reviewed value 7426ac2d0aa74eccba5ff5098c0398e7, or it fails closed.
--
-- The fingerprint is computed under a pinned search_path so the deparsed predicates (auth.users, auth.uid()) are
-- identical whatever runner applies it. Reviewed shape (as-is, not redesigned): 11 columns; pkey + 6 foreign keys;
-- 6 indexes including the duplicate (event_id, active) pair and the partial unique active (event_id, template_id);
-- RLS enabled; the organizer, public-read and studio policies; the set_updated_at trigger. Grants follow the
-- project's default privileges and are not part of the fingerprint.

begin;

set local search_path to pg_catalog, public;

do $$
declare
  v_fp text;
begin
  if to_regclass('public.event_document_requirements') is null then
    raise exception 'Phase 8B: public.event_document_requirements is missing. It originates in the production baseline snapshot; this database was not built on the supported baseline. Refusing to continue.';
  end if;

  select md5(string_agg(k || '|' || n || '|' || v, E'\n' order by k collate "C", n collate "C")) into v_fp
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
  ) s;

  if v_fp is distinct from '7426ac2d0aa74eccba5ff5098c0398e7' then
    raise exception 'Phase 8B: event_document_requirements does not match the reviewed canonical definition (fp=%). Refusing to continue.', v_fp;
  end if;
end;
$$;

commit;
