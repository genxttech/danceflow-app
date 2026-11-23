set transaction read only;
select 'supabase_migrations_schema' k, coalesce((select 'present owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(nspacl::text, '<default>') from pg_namespace where nspname = 'supabase_migrations'), 'absent') v
union all select 'supabase_migrations_relations', coalesce((select string_agg(c.relname || ':' || c.relkind::text, ' ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'supabase_migrations'), '<none>')
union all select 'schema_migrations_rows', case when to_regclass('supabase_migrations.schema_migrations') is null then 'n/a'
    else (select count(*)::text from supabase_migrations.schema_migrations) end
union all select 'schema_migrations_versions', case when to_regclass('supabase_migrations.schema_migrations') is null then 'n/a'
    else (select string_agg(version || ':' || coalesce(name, '<null>'), ' ' order by version) from supabase_migrations.schema_migrations) end;
