set transaction read only;
select 'public_relations' k, count(*)::text || ' ' || md5(string_agg(c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, '|' order by c.relname)) v
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
union all select 'public_columns', count(*)::text || ' ' || md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, '|' order by c.relname, a.attnum))
  from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
union all select 'public_constraints', count(*)::text || ' ' || md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname))
  from pg_constraint where connamespace = 'public'::regnamespace
union all select 'public_indexes', count(*)::text || ' ' || md5(string_agg(indexdef, '|' order by tablename, indexname)) from pg_indexes where schemaname = 'public'
union all select 'public_triggers', count(*)::text || ' ' || md5(string_agg(t.tgrelid::regclass::text || ':' || pg_get_triggerdef(t.oid), '|' order by t.tgrelid::regclass::text, t.tgname))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
union all select 'public_functions', count(*)::text || ' ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') || ':' || p.prosecdef, '|' order by p.oid::regprocedure::text))
  from pg_proc p where p.pronamespace = 'public'::regnamespace
union all select 'public_policies', count(*)::text || ' ' || md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname))
  from pg_policies where schemaname = 'public'
union all select 'roles', count(*)::text || ' ' || md5(string_agg(rolname || ':' || rolsuper || rolinherit || rolcreaterole || rolcreatedb || rolcanlogin || rolbypassrls, '|' order by rolname)) from pg_roles
union all select 'schemas', (select string_agg(nspname, ' ' order by nspname) from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema');
