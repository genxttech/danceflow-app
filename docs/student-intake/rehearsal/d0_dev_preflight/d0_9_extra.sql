set transaction read only;
select 'public_table_without_rls' k, coalesce((select string_agg(relname || ' acl=' || coalesce(relacl::text, '<default>'), ' ') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity), '<none>') v
union all select 'migration_support_schema', coalesce((select 'owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(nspacl::text, '<default>') from pg_namespace where nspname = 'migration_support'), 'absent')
union all select 'migration_support_objects', coalesce((select string_agg(c.relname || ':' || c.relkind::text, ' ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'migration_support'), '<none>')
  || ' functions=' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'migration_support')::text
union all select 'api_usage_on_migration_support', coalesce((select string_agg(r, ' ') from unnest(array['anon','authenticated','service_role']) r where has_schema_privilege(r, 'migration_support', 'USAGE')), '<none>');
