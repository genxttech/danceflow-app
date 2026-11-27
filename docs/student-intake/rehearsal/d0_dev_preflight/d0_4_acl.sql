set transaction read only;
select 'default_acl ' || pg_get_userbyid(d.defaclrole) || ' in ' || coalesce(n.nspname, '<all schemas>') || ' on ' || d.defaclobjtype::text k,
       array_to_string(array(select x from unnest(d.defaclacl::text[]) x order by 1), ' ') v
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
union all select 'default_acl_unexpected_grantees_in_public', coalesce((select string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ' ')
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
    where n.nspname = 'public' and a.grantee <> d.defaclrole
      and (a.grantee = 0 or pg_get_userbyid(a.grantee) not in ('anon', 'authenticated', 'service_role', 'postgres', 'supabase_admin'))), '<none>')
union all select 'schema_public_acl', (select coalesce(nspacl::text, '<default>') from pg_namespace where nspname = 'public')
union all select 'schema_extensions_acl', (select coalesce(nspacl::text, '<default>') from pg_namespace where nspname = 'extensions')
union all select 'api_role_privs_on_intake_objects', ((select count(*) from pg_class c, unnest(array['anon','authenticated','service_role']) r where c.relname like 'intake\_%' and has_table_privilege(r, c.oid, 'SELECT'))
    + (select count(*) from pg_proc p, unnest(array['anon','authenticated','service_role']) r where p.proname like 'intake\_%' and has_function_privilege(r, p.oid, 'EXECUTE')))::text
union all select 'public_tables_without_rls', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity)::text
union all select 'public_tables_count', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r')::text;
