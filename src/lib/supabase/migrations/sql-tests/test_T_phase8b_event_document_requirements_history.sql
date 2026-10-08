-- T-phase8b: event_document_requirements schema-history reconciliation (20261030090000, verification only).
-- Runs against DEV (or a disposable rebuild) inside ONE transaction that is always rolled back.
--   A  the table exists (it originates in the production baseline snapshot)
--   B  exact reviewed catalog fingerprint
--   C  expected constraints / indexes / policies / trigger / RLS; dependents still reference it
--   D  the partial unique index rejects a second active requirement for the same event + template
--   E  the 20261030 verification passes on the canonical schema and changes nothing (no DDL)
--   F  with the table absent, the 20261030 verification FAILS CLOSED (the drop happens inside an exception block,
--      so it is undone even before the final rollback)
--
-- pg_temp.p8b_verify() is the 20261030 migration's DO-block body VERBATIM (a unit test asserts the two stay
-- byte-identical), so E and F exercise the real migration logic.

begin;

set local search_path to pg_catalog, public;

create function pg_temp.p8b_verify() returns void language plpgsql as $verify$
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
$verify$;

do $$
declare
  v_count int;
  v_event uuid;
  v_template uuid;
  v_rel_before xid;
  v_rel_after xid;
  v_rows_before bigint;
  v_rows_after bigint;
begin
  -- A
  if to_regclass('public.event_document_requirements') is null then
    raise exception 'FAIL A table missing';
  end if;

  -- B (and E part 1: the real verification passes on the canonical schema)
  perform pg_temp.p8b_verify();

  -- C
  if not (select relrowsecurity from pg_class where oid = 'public.event_document_requirements'::regclass) then
    raise exception 'FAIL C RLS disabled';
  end if;
  select count(*) into v_count from pg_constraint
  where conrelid = 'public.event_document_requirements'::regclass and contype = 'f';
  if v_count <> 6 then raise exception 'FAIL C foreign key count %', v_count; end if;
  select count(*) into v_count from pg_indexes
  where schemaname = 'public' and tablename = 'event_document_requirements';
  if v_count <> 6 then raise exception 'FAIL C index count %', v_count; end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_event_document_requirements_active'
      and indexdef like 'CREATE UNIQUE INDEX%WHERE (active = true)'
  ) then
    raise exception 'FAIL C partial unique active index missing';
  end if;
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'event_document_requirements'
    and policyname in (
      'Organizer users can manage event document requirements',
      'Public can view active event document requirements',
      'Studio users can manage event document requirements'
    );
  if v_count <> 3 then raise exception 'FAIL C reviewed policies %', v_count; end if;
  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements';
  if v_count <> 3 then raise exception 'FAIL C unexpected policy count %', v_count; end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.event_document_requirements'::regclass
      and tgname = 'set_event_document_requirements_updated_at' and not tgisinternal
  ) then
    raise exception 'FAIL C trigger missing';
  end if;
  select count(*) into v_count from pg_constraint
  where contype = 'f' and confrelid = 'public.event_document_requirements'::regclass
    and conrelid in ('public.document_assignments'::regclass, 'public.document_sign_envelopes'::regclass);
  if v_count < 2 then raise exception 'FAIL C dependent FK count %', v_count; end if;

  -- D
  select event_id, template_id into v_event, v_template
  from public.event_document_requirements where active limit 1;
  if v_event is not null then
    begin
      insert into public.event_document_requirements (event_id, template_id, active) values (v_event, v_template, true);
      raise exception 'FAIL D duplicate active requirement accepted';
    exception when unique_violation then
      null;
    end;
  end if;

  -- E part 2: the verification is a no-op (no catalog or row change)
  select xmin into v_rel_before from pg_class where oid = 'public.event_document_requirements'::regclass;
  select count(*) into v_rows_before from public.event_document_requirements;
  perform pg_temp.p8b_verify();
  select xmin into v_rel_after from pg_class where oid = 'public.event_document_requirements'::regclass;
  select count(*) into v_rows_after from public.event_document_requirements;
  if v_rel_before is distinct from v_rel_after or v_rows_before <> v_rows_after then
    raise exception 'FAIL E verification changed the table';
  end if;

  -- F: absent table must fail closed (the drop is undone by this block's exception handler)
  begin
    drop table public.event_document_requirements cascade;
    perform pg_temp.p8b_verify();
    raise exception 'FAIL F absent table was silently accepted';
  exception when others then
    if sqlerrm not like 'Phase 8B: public.event_document_requirements is missing.%' then
      raise;
    end if;
  end;
  if to_regclass('public.event_document_requirements') is null then
    raise exception 'FAIL F table not restored after the absent-table check';
  end if;
end;
$$;

select 'PASS T-phase8b event_document_requirements history (A B C D E F)' as result;

rollback;
