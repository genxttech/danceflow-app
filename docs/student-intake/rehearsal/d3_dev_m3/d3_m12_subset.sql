set transaction read only;
-- M1+M2 objects only, same formulas as the D-2 postflight (expected = D-2 DEV values).
select 'm12_fp_functions' k, (select md5(string_agg(p.oid::regprocedure::text || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ';'), '') || ':' || coalesce(p.proacl::text, '<null>') || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
      and p.proname not in ('subject_of', 'collection_gate', 'delete_guard', 'tenant_guard', 'requests_guard', 'request_appointments_guard', 'respondents_guard',
                            'responses_guard', 'append_only_guard', 'relationship_state_guard', 'designations_guard', 'assurance_rank', 'fulfillment_state')) v
union all select 'm12_fp_triggers', (select md5(string_agg(c.relname || ' :: ' || pg_get_triggerdef(t.oid) || ' :: ' || t.tgenabled::text, '|' order by c.relname, t.tgname))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in ('intake_templates', 'intake_template_versions', 'intake_service_assignments',
      'intake_studio_retention_choices', 'intake_settings', 'intake_audit_events', 'intake_legal_holds') and not t.tgisinternal)
union all select 'm12_fp_policies', (select md5(string_agg(tablename || '.' || policyname || ':' || permissive || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname))
    from pg_policies where tablename in ('intake_templates', 'intake_template_versions', 'intake_service_assignments', 'intake_studio_retention_choices', 'intake_settings', 'intake_audit_events', 'intake_legal_holds'))
union all select 'm12_fp_tables', (select md5(string_agg(c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, '<null>'), '|' order by c.relname))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('intake_templates', 'intake_template_versions', 'intake_service_assignments',
      'intake_studio_retention_choices', 'intake_settings', 'intake_audit_events', 'intake_legal_holds'))
union all select 'm12_fp_table_columns', (select md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, '|' order by c.relname, a.attnum))
    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and c.relname in ('intake_templates', 'intake_template_versions', 'intake_service_assignments', 'intake_studio_retention_choices', 'intake_settings', 'intake_audit_events', 'intake_legal_holds'))
union all select 'm12_fp_table_constraints', (select md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname))
    from pg_constraint where conrelid::regclass::text in ('intake_templates', 'intake_template_versions', 'intake_service_assignments', 'intake_studio_retention_choices',
      'intake_settings', 'intake_audit_events', 'intake_legal_holds'));
