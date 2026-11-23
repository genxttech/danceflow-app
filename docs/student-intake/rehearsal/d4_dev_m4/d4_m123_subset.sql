set transaction read only;
-- M1-M3 objects only, same formulas as the D-3 postflight (expected = D-3 DEV values).
select 'm123_fp_functions' k, (select md5(string_agg(p.oid::regprocedure::text || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ';'), '') || ':' || coalesce(p.proacl::text, '<null>') || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
      and p.proname not in ('evidence_insert_guard', 'evidence_identity_insert_guard', 'evidence_guard')) v
union all select 'm123_fp_triggers', (select md5(string_agg(c.relname || ' :: ' || pg_get_triggerdef(t.oid) || ' :: ' || t.tgenabled::text, '|' order by c.relname, t.tgname))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname like 'intake\_%' and not t.tgisinternal and c.relname not in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm123_fp_policies', (select md5(string_agg(tablename || '.' || policyname || ':' || permissive || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname))
    from pg_policies where tablename like 'intake\_%' and tablename not in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm123_fp_tables', (select md5(string_agg(c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, '<null>'), '|' order by c.relname))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'intake\_%' and c.relname not in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm123_fp_table_columns', (select md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, '|' order by c.relname, a.attnum))
    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and c.relname like 'intake\_%' and c.relname not in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm123_fp_table_constraints', (select md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname))
    from pg_constraint where conrelid::regclass::text like '%intake\_%' and conrelid::regclass::text not in ('intake_consent_evidence', 'intake_consent_evidence_identity'));
