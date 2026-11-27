set transaction read only;
-- NSI I1 D-5 full-foundation (M1-M5) postflight (read-only). Same file locally (psql -1) and on DEV (supabase db query --linked).
-- Derived from the D-4 postflight; the M5 row now reports M5 presence; RPC privilege rows added at the end.
select 'ro' k, current_setting('transaction_read_only') v
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'intake_tables', (select count(*)::text || ' ' || string_agg(relname, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r')
union all select 'intake_other_relations', (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ((n.nspname = 'public' and c.relname like 'intake\_%') or n.nspname = 'intake_private') and c.relkind not in ('r', 'i'))
union all select 'm5_objects_present', 'functions_m5=' || (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'intake_private' and p.proname in ('lock_client', 'schema_max_answer_bytes', 'validate_answers', 'appointment_snapshot', 'compute_draft_retention',
             'has_intake_records', 'drift_detected', 'assert_drift_free', 'erase_client_impl'))
       or (n.nspname = 'public' and p.proname in ('intake_save_template_draft', 'intake_publish_template_version', 'intake_set_reintake_floor', 'intake_set_service_assignment',
             'intake_update_settings', 'intake_set_retention_choice', 'intake_get_status', 'intake_get_answers', 'intake_designate_guardian', 'intake_select_guardian_recipient',
             'intake_record_minor_determination', 'intake_drift_report', 'intake_extend_draft_retention', 'intake_ensure_request', 'intake_save_draft', 'intake_submit_response',
             'intake_erase_client', 'intake_release_erasure_barrier', 'intake_create_legal_hold', 'intake_release_legal_hold')))
union all select 'intake_functions', (select count(*)::text || ' ' || string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname, p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
union all select 'fp_functions', (select md5(string_agg(p.oid::regprocedure::text || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ';'), '') || ':' || coalesce(p.proacl::text, '<null>') || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
union all select 'function_execute_grants', (select string_agg(n.nspname || '.' || p.proname || '=' || coalesce(array_to_string(array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
       from aclexplode(p.proacl) a where a.grantee <> p.proowner order by 1), ','), ''), ' ' order by n.nspname, p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and p.proacl is not null
      and exists (select 1 from aclexplode(p.proacl) a where a.grantee <> p.proowner))
union all select 'intake_triggers', (select count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname like 'intake\_%' and not t.tgisinternal)
union all select 'fp_triggers', (select md5(string_agg(c.relname || ' :: ' || pg_get_triggerdef(t.oid) || ' :: ' || t.tgenabled::text, '|' order by c.relname, t.tgname))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname like 'intake\_%' and not t.tgisinternal)
union all select 'intake_policies', (select count(*)::text from pg_policies where tablename like 'intake\_%')
union all select 'fp_policies', (select md5(string_agg(tablename || '.' || policyname || ':' || permissive || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname)) from pg_policies where tablename like 'intake\_%')
union all select 'fp_tables', (select md5(string_agg(c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, '<null>'), '|' order by c.relname))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r')
union all select 'table_grants', (select string_agg(c.relname || '=' || coalesce(array_to_string(array(select pg_get_userbyid(a.grantee) || ':' || a.privilege_type from aclexplode(c.relacl) a where a.grantee <> c.relowner order by 1), ','), ''), ' ' order by c.relname)
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r')
union all select 'rls_all_on', (select bool_and(relrowsecurity)::text from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r')
union all select 'column_grants', (select count(*)::text from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relname like 'intake\_%' and a.attacl is not null)
union all select 'fp_table_columns', (select md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, '|' order by c.relname, a.attnum))
    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped)
union all select 'fp_table_constraints', (select md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname))
    from pg_constraint where conrelid::regclass::text like '%intake\_%')
union all select 'role', (select format('login=%s inherit=%s bypassrls=%s super=%s createrole=%s createdb=%s replication=%s connlimit=%s', rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolconnlimit) from pg_roles where rolname = 'intake_destructive')
union all select 'role_memberships', (select string_agg(m.rolname || '(admin=' || am.admin_option || ',inherit=' || am.inherit_option || ',set=' || am.set_option || ')', ' ' order by m.rolname, am.admin_option) from pg_auth_members am join pg_roles m on m.oid = am.member where am.roleid = 'intake_destructive'::regrole)
union all select 'role_member_of', (select count(*)::text from pg_auth_members where member = 'intake_destructive'::regrole)
union all select 'role_table_privileges', (select count(*)::text from pg_class c where (c.relname like 'intake\_%' or c.relnamespace = 'public'::regnamespace) and c.relkind = 'r'
    and has_table_privilege('intake_destructive', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
union all select 'role_function_execute_intake', (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and has_function_privilege('intake_destructive', p.oid, 'EXECUTE'))
union all select 'role_schema', format('intake_private usage=%s create=%s; public create=%s', has_schema_privilege('intake_destructive', 'intake_private', 'USAGE'),
    has_schema_privilege('intake_destructive', 'intake_private', 'CREATE'), has_schema_privilege('intake_destructive', 'public', 'CREATE'))
union all select 'role_owns_objects', (select (count(*))::text from pg_class where relowner = 'intake_destructive'::regrole) || ' relations / ' || (select count(*)::text from pg_proc where proowner = 'intake_destructive'::regrole) || ' functions'
union all select 'private_schema_acl', (select pg_get_userbyid(nspowner) || ' ' || coalesce(nspacl::text, '<null>') from pg_namespace where nspname = 'intake_private')
union all select 'api_roles_private_schema', (select string_agg(r || ':usage=' || has_schema_privilege(r, 'intake_private', 'USAGE') || ',create=' || has_schema_privilege(r, 'intake_private', 'CREATE'), ' ') from unnest(array['anon', 'authenticated', 'service_role', 'authenticator']) r)
union all select 'private_default_acl', (select count(*)::text from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'intake_private')
union all select 'api_role_table_privs', (select string_agg(r || ':' || (select count(*) from pg_class c where c.relname like 'intake\_%' and c.relkind = 'r'
       and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text, ' ') from unnest(array['anon', 'authenticated', 'service_role']) r)
union all select 'authenticated_select_only', (select (count(*) = 0)::text from pg_class c where c.relname like 'intake\_%' and c.relkind = 'r'
       and has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'platform_policy', (select row(p.*)::text from public.intake_platform_policy() p)
union all select 'config_rows', (select (select count(*) from public.intake_templates) + (select count(*) from public.intake_template_versions) + (select count(*) from public.intake_service_assignments)
    + (select count(*) from public.intake_studio_retention_choices) + (select count(*) from public.intake_settings))::text
union all select 'appointments_fp', coalesce(md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass)), '<NULL>')
union all select 'non_intake_relations', (select count(*)::text || ' ' || md5(string_agg(c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, '|' order by c.relname))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S') and c.relname not like 'intake\_%')
union all select 'non_intake_columns', (select count(*)::text || ' ' || md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, '|' order by c.relname, a.attnum))
    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and c.relname not like 'intake\_%')
union all select 'non_intake_constraints', (select count(*)::text || ' ' || md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname))
    from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text not like '%intake\_%')
union all select 'non_intake_indexes', (select count(*)::text || ' ' || md5(string_agg(indexdef, '|' order by tablename, indexname)) from pg_indexes where schemaname = 'public' and tablename not like 'intake\_%')
union all select 'non_intake_triggers', (select count(*)::text || ' ' || md5(string_agg(t.tgrelid::regclass::text || ':' || pg_get_triggerdef(t.oid), '|' order by t.tgrelid::regclass::text, t.tgname))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and c.relname not like 'intake\_%')
union all select 'non_intake_functions', (select count(*)::text || ' ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') || ':' || p.prosecdef, '|' order by p.oid::regprocedure::text))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 'intake\_%')
union all select 'non_intake_policies', (select count(*)::text || ' ' || md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname))
    from pg_policies where schemaname = 'public' and tablename not like 'intake\_%')
union all select 'non_intake_roles', (select count(*)::text || ' ' || md5(string_agg(rolname || ':' || rolsuper || rolinherit || rolcreaterole || rolcreatedb || rolcanlogin || rolbypassrls, '|' order by rolname)) from pg_roles where rolname <> 'intake_destructive')
union all select 'schemas', (select string_agg(nspname, ' ' order by nspname) from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema')
union all select 'personal_tables', (select count(*)::text from pg_class where relname in ('intake_requests', 'intake_responses', 'intake_respondents', 'intake_consent_evidence'))
-- M3 live personal tables
union all select 'm3_live_table_rows', (select string_agg(x, ' ' order by x) from (
       select 'requests=' || (select count(*) from public.intake_requests) x
       union all select 'request_appointments=' || (select count(*) from public.intake_request_appointments)
       union all select 'respondents=' || (select count(*) from public.intake_respondents)
       union all select 'responses=' || (select count(*) from public.intake_responses)
       union all select 'response_revisions=' || (select count(*) from public.intake_response_revisions)
       union all select 'minor_determinations=' || (select count(*) from public.intake_minor_determinations)
       union all select 'completions=' || (select count(*) from public.intake_completions)
       union all select 'relationship_state=' || (select count(*) from public.intake_client_relationship_state)
       union all select 'guardian_designations=' || (select count(*) from public.intake_guardian_designations)) s)
union all select 'm3_live_tables_present', (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('intake_requests', 'intake_request_appointments',
       'intake_respondents', 'intake_responses', 'intake_response_revisions', 'intake_minor_determinations', 'intake_completions', 'intake_client_relationship_state', 'intake_guardian_designations'))
union all select 'm3_api_role_privileges', (select count(*)::text from pg_class c, unnest(array['anon', 'authenticated', 'service_role']) r
    where c.relname in ('intake_requests', 'intake_request_appointments', 'intake_respondents', 'intake_responses', 'intake_response_revisions', 'intake_minor_determinations',
      'intake_completions', 'intake_client_relationship_state', 'intake_guardian_designations')
      and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
union all select 'm3_role_table_grants', (select string_agg(distinct a.privilege_type, ',') || ' on ' || count(distinct c.relname)::text || ' tables' from pg_class c, aclexplode(c.relacl) a
    where c.relname like 'intake\_%' and a.grantee = 'intake_destructive'::regrole)
union all select 'm3_inbound_and_outbound_fks', (select string_agg(conrelid::regclass::text || '->' || confrelid::regclass::text || ':' || confdeltype::text, ' ' order by conrelid::regclass::text, conname)
    from pg_constraint where contype = 'f' and conrelid::regclass::text like '%intake\_%' and confrelid::regclass::text not like '%intake\_%')
-- M4 retained evidence
union all select 'm4_evidence_rows', 'evidence=' || (select count(*) from public.intake_consent_evidence)::text || ' identity=' || (select count(*) from public.intake_consent_evidence_identity)::text
union all select 'm4_tables', (select string_agg(relname || ':owner=' || pg_get_userbyid(relowner) || ':rls=' || relrowsecurity || ':force=' || relforcerowsecurity
       || ':grants=' || coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type, ',' order by 1)
                                  from aclexplode(relacl) a where a.grantee <> relowner), 'none'), ' ' order by relname)
    from pg_class where relnamespace = 'public'::regnamespace and relname in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm4_api_and_role_privileges', (select string_agg(r || '=' || (select count(*) from pg_class c where c.relname in ('intake_consent_evidence', 'intake_consent_evidence_identity')
       and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text, ' ') from unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) r)
union all select 'm4_policies', (select count(*)::text from pg_policies where tablename in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm4_triggers', (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in ('intake_consent_evidence', 'intake_consent_evidence_identity') and not t.tgisinternal)
union all select 'm4_constraints_fp', (select count(*)::text || ' ' || md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname))
    from pg_constraint where conrelid::regclass::text in ('intake_consent_evidence', 'intake_consent_evidence_identity'))
union all select 'm4_digest_check_dependency', (select count(*)::text from pg_depend d where d.classid = 'pg_constraint'::regclass and d.refobjid = to_regprocedure('extensions.digest(text,text)')
    and d.objid in (select oid from pg_constraint where conrelid::regclass::text = 'intake_consent_evidence'))
union all select 'fk_to_appointments_from_intake', (select count(*)::text from pg_constraint where contype = 'f' and confrelid = 'public.appointments'::regclass and conrelid::regclass::text like '%intake\_%')
-- M2 governance
union all select 'audit_rows', (select count(*)::text from public.intake_audit_events)
union all select 'hold_rows', (select count(*)::text from public.intake_legal_holds)
union all select 'first_use_marker', (select count(*)::text from public.intake_audit_events where retention_class = 'environment_marker')
union all select 'erasure_events', (select count(*)::text from public.intake_audit_events where event_type in ('erasure_record', 'erasure_barrier_released', 'erasure_refused_hold'))
union all select 'm2_table_grants_beyond_owner', (select count(*)::text from pg_class c, aclexplode(c.relacl) a where c.relname in ('intake_audit_events', 'intake_legal_holds') and a.grantee <> c.relowner)
union all select 'm2_tables_rls', (select string_agg(relname || '=' || relrowsecurity, ' ' order by relname) from pg_class where relname in ('intake_audit_events', 'intake_legal_holds'))
union all select 'm2_api_role_privileges', (select count(*)::text from pg_class c, unnest(array['anon', 'authenticated', 'service_role']) r
    where c.relname in ('intake_audit_events', 'intake_legal_holds') and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
union all select 'm2_role_execute', (select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'intake_private'::regnamespace and has_function_privilege('intake_destructive', p.oid, 'EXECUTE'))
union all select 'm2_studio_fks', (select string_agg(conrelid::regclass::text || ':' || pg_get_constraintdef(oid), ' ' order by conrelid::regclass::text) from pg_constraint where contype = 'f' and conrelid::regclass::text in ('intake_audit_events', 'intake_legal_holds'))
union all select 'rollback_eligible', (select (not exists (select 1 from public.intake_audit_events where retention_class <> 'operational'
       or request_ref is not null or client_ref is not null or hold_ref is not null)
     and not exists (select 1 from public.intake_audit_events where retention_class = 'environment_marker')
     and not exists (select 1 from public.intake_legal_holds))::text
     || ' config_rows=' || ((select count(*) from public.intake_templates) + (select count(*) from public.intake_template_versions) + (select count(*) from public.intake_service_assignments)
     + (select count(*) from public.intake_studio_retention_choices) + (select count(*) from public.intake_settings))::text)
-- M5 / full-foundation RPC privileges
union all select 'rpc_authenticated', (select count(*)::text || ' ' || string_agg(p.proname, ',' order by p.proname) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'intake\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
union all select 'rpc_service_role', (select count(*)::text || ' ' || string_agg(p.proname, ',' order by p.proname) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'intake\_%' and has_function_privilege('service_role', p.oid, 'EXECUTE'))
union all select 'rpc_anon', (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and has_function_privilege('anon', p.oid, 'EXECUTE'))
union all select 'private_functions_api_execute', (select count(*)::text from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
    where p.pronamespace = 'intake_private'::regnamespace and has_function_privilege(r, p.oid, 'EXECUTE'))
union all select 'service_role_table_privileges', (select count(*)::text from pg_class c where c.relname like 'intake\_%' and c.relkind = 'r'
    and has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
union all select 'role_owned_impl', (select string_agg(p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' secdef=' || p.prosecdef || ' acl=' || coalesce(p.proacl::text, '<null>'), ' ')
    from pg_proc p where p.proowner = 'intake_destructive'::regrole)
union all select 'role_execute_list', (select string_agg(n.nspname || '.' || p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and has_function_privilege('intake_destructive', p.oid, 'EXECUTE'));
