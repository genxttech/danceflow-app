-- T-phase8b: event_document_requirements schema-history reconciliation (20261030090000).
-- Read-only assertions, run against DEV inside a rolled-back transaction.
--   A1  catalog fingerprint equals the reviewed definition recorded in the migration
--   A2  RLS enabled; exactly the three reviewed policies; updated_at trigger present
--   A3  dependents still reference the table (assignments / envelopes requirement FKs)
--   A4  the partial unique index still rejects a second active requirement for the same event + template

begin;

-- Same pinned search_path as the migration fingerprint (deparsed predicates depend on it).
set local search_path to pg_catalog, public;

do $$
declare
  v_fp text;
  v_count int;
  v_event uuid;
  v_template uuid;
begin
  select md5(string_agg(k || '|' || n || '|' || v, E'\n' order by k collate "C", n collate "C")) into v_fp
  from (
    select 'col' k, lpad(ordinal_position::text, 2, '0') || ' ' || column_name::text n,
           data_type::text || '|' || is_nullable::text || '|' || coalesce(column_default::text, '') v
    from information_schema.columns where table_schema = 'public' and table_name = 'event_document_requirements'
    union all
    select 'con', conname::text, pg_get_constraintdef(oid) from pg_constraint where conrelid = to_regclass('public.event_document_requirements')
    union all
    select 'idx', indexname::text, indexdef from pg_indexes where schemaname = 'public' and tablename = 'event_document_requirements'
    union all
    select 'rls', 'relrowsecurity', relrowsecurity::text || '/' || relforcerowsecurity::text from pg_class where oid = to_regclass('public.event_document_requirements')
    union all
    select 'pol', policyname::text || ' | ' || cmd || ' | ' || array_to_string(roles, ','), coalesce(qual, '') || ' || ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements'
    union all
    select 'trg', tgname::text, pg_get_triggerdef(oid) from pg_trigger where tgrelid = to_regclass('public.event_document_requirements') and not tgisinternal
  ) s;
  if v_fp is distinct from '7426ac2d0aa74eccba5ff5098c0398e7' then
    raise exception 'FAIL A1 fingerprint %', v_fp;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.event_document_requirements'::regclass) then
    raise exception 'FAIL A2 RLS disabled';
  end if;
  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'event_document_requirements';
  if v_count <> 3 then
    raise exception 'FAIL A2 policy count %', v_count;
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.event_document_requirements'::regclass
      and tgname = 'set_event_document_requirements_updated_at' and not tgisinternal
  ) then
    raise exception 'FAIL A2 trigger missing';
  end if;

  select count(*) into v_count from pg_constraint
  where contype = 'f' and confrelid = 'public.event_document_requirements'::regclass
    and conrelid in ('public.document_assignments'::regclass, 'public.document_sign_envelopes'::regclass);
  if v_count < 2 then
    raise exception 'FAIL A3 dependent FK count %', v_count;
  end if;

  select event_id, template_id into v_event, v_template
  from public.event_document_requirements where active limit 1;
  if v_event is not null then
    begin
      insert into public.event_document_requirements (event_id, template_id, active) values (v_event, v_template, true);
      raise exception 'FAIL A4 duplicate active requirement accepted';
    exception when unique_violation then
      null;
    end;
  end if;
end;
$$;

select 'PASS T-phase8b event_document_requirements history (A1 A2 A3 A4)' as result;

rollback;
