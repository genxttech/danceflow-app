select 'versions_total' k, count(*)::text v from supabase_migrations.schema_migrations
union all select 'nsi_rows', string_agg(version||':'||coalesce(name,''), ' | ' order by version) from supabase_migrations.schema_migrations where version between '20261118090000' and '20261118098000'
union all select 'min_max', min(version)||' .. '||max(version) from supabase_migrations.schema_migrations
union all select 'after_nsi_range', count(*)::text from supabase_migrations.schema_migrations where version > '20261118098000'
union all select 'after_nsi_first5', (select string_agg(version,',') from (select version from supabase_migrations.schema_migrations where version > '20261118098000' order by version limit 5) s)
union all select 'gate_open', coalesce(to_regprocedure('intake_private.retention_gate_open()')::text,'absent')
union all select 'appointments_fp', coalesce(md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass)), '<NULL>')
union all select 'intake_tables', count(*)::text from pg_class where relnamespace='public'::regnamespace and relname like 'intake\_%' and relkind='r'
