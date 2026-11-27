set transaction read only;
-- NSI I1 D-1 M1-scoped postflight (read-only). Same file locally (psql -1) and on DEV (supabase db query --linked).
select 'ro' k, current_setting('transaction_read_only') v
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'intake_tables', (select count(*)::text || ' ' || string_agg(relname, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r')
union all select 'intake_other_relations', (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ((n.nspname = 'public' and c.relname like 'intake\_%') or n.nspname = 'intake_private') and c.relkind not in ('r', 'i'))
union all select 'm2_m5_tables_absent', (select (count(*) = 0)::text from pg_class where relname in ('intake_audit_events', 'intake_legal_holds', 'intake_requests', 'intake_responses', 'intake_consent_evidence'))
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
union all select 'marker_or_personal_tables', (select count(*)::text from pg_class where relname in ('intake_audit_events', 'intake_requests', 'intake_responses', 'intake_respondents', 'intake_consent_evidence'));
