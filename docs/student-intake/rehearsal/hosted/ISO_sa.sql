set transaction read only;
select 'ctx' k, format('db=%s user=%s session_user=%s ver=%s ro=%s', current_database(), current_user, session_user, current_setting('server_version'), current_setting('transaction_read_only')) v
union all select 'public_relations', (select count(*)::text from pg_class where relnamespace='public'::regnamespace)
union all select 'public_functions', (select count(*)::text from pg_proc where pronamespace='public'::regnamespace)
union all select 'danceflow_tables_present', (select count(*)::text from pg_class where relname in ('clients','appointments','studios','profiles','outbound_deliveries'))
union all select 'auth_users', (select count(*)::text from auth.users)
union all select 'vault_secrets', coalesce((select count(*)::text from vault.secrets), 'n/a')
union all select 'extensions', (select string_agg(extname, ',' order by extname) from pg_extension)
union all select 'pg_net_or_hook_triggers', (select count(*)::text from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('supabase_functions','net') and not t.tgisinternal)
union all select 'supabase_migrations_schema', (select count(*)::text from pg_namespace where nspname='supabase_migrations')
union all select 'role_intake_destructive', (select count(*)::text from pg_roles where rolname='intake_destructive')
union all select 'postgres_role', (select format('super=%s createrole=%s bypassrls=%s inherit=%s', rolsuper, rolcreaterole, rolbypassrls, rolinherit) from pg_roles where rolname='postgres')
union all select 'createrole_self_grant', coalesce(current_setting('createrole_self_grant', true),'<unset>')
union all select 'supautils_reserved_roles', coalesce(current_setting('supautils.reserved_roles', true),'<unset>')
union all select 'client_connections', (select coalesce(string_agg(distinct coalesce(usename,'?')||'/'||coalesce(application_name,''), ', '),'none') from pg_stat_activity where backend_type='client backend' and pid<>pg_backend_pid())
union all select 'pgrst_db_schemas', coalesce(current_setting('pgrst.db_schemas', true), '<unset>');
