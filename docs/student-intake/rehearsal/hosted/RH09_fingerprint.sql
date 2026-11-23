-- RH09 — catalog fingerprint (read-only)
select 'role' k, rolname||' super='||rolsuper||' login='||rolcanlogin||' inherit='||rolinherit||' bypassrls='||rolbypassrls||' createrole='||rolcreaterole||' createdb='||rolcreatedb v from pg_roles where rolname='intake_destructive'
union all select 'membership', m.rolname||' in '||r.rolname||' admin='||am.admin_option||' inherit='||am.inherit_option||' set='||am.set_option from pg_auth_members am join pg_roles r on r.oid=am.roleid join pg_roles m on m.oid=am.member where r.rolname='intake_destructive' or m.rolname='intake_destructive'
union all select 'schema_acl', nspname||' owner='||pg_get_userbyid(nspowner)||' acl='||coalesce(nspacl::text,'null') from pg_namespace where nspname='intake_private'
union all select 'fn', n.nspname||'.'||p.proname||' owner='||pg_get_userbyid(p.proowner)||' secdef='||p.prosecdef||' cfg='||coalesce(p.proconfig::text,'null')||' acl='||coalesce(p.proacl::text,'NULL') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='intake_private') or (n.nspname='public' and (p.proname like 'nsi_rh%' or p.proname like 'intake_%'))
union all select 'table', relname||' owner='||pg_get_userbyid(relowner)||' rls='||relrowsecurity||' acl='||coalesce(relacl::text,'null') from pg_class where relname like 'nsi_rh_%' and relkind='r'
union all select 'policy', tablename||'.'||policyname||' cmd='||cmd||' roles='||roles::text||' qual='||coalesce(qual,'') from pg_policies where tablename like 'nsi_rh_%'
union all select 'trigger', tgrelid::regclass::text||'.'||tgname||' fn='||tgfoid::regproc::text from pg_trigger where tgrelid::regclass::text like '%nsi_rh_%' and not tgisinternal
union all select 'role_owned_objects', count(*)::text from pg_proc where proowner=(select oid from pg_roles where rolname='intake_destructive')
union all select 'role_auth_schema_usage', has_schema_privilege('intake_destructive','auth','USAGE')::text
union all select 'role_public_create', has_schema_privilege('intake_destructive','public','CREATE')::text
order by 1,2;
