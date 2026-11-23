set transaction read only;
select 'ctx' k, format('db=%s user=%s ro=%s', current_database(), current_user, current_setting('transaction_read_only')) v
union all select 'server_version', current_setting('server_version')
union all select 'version', version()
union all select 'postgres_role', format('super=%s createrole=%s createdb=%s bypassrls=%s inherit=%s login=%s replication=%s', rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit, rolcanlogin, rolreplication) from pg_roles where rolname = 'postgres'
union all select 'createrole_self_grant', coalesce(nullif(current_setting('createrole_self_grant', true), ''), '<empty>')
union all select 'session_replication_role', current_setting('session_replication_role')
union all select 'supautils.privileged_role', coalesce(current_setting('supautils.privileged_role', true), '<unset>')
union all select 'supautils.reserved_roles', coalesce(current_setting('supautils.reserved_roles', true), '<unset>')
union all select 'supautils.reserved_memberships', coalesce(current_setting('supautils.reserved_memberships', true), '<unset>')
union all select 'supautils.superuser', coalesce(current_setting('supautils.superuser', true), '<unset>')
union all select 'postgres_member_of', coalesce((select string_agg(r.rolname || '(a=' || am.admin_option || ',i=' || am.inherit_option || ',s=' || am.set_option || ')', ' ' order by r.rolname) from pg_auth_members am join pg_roles r on r.oid = am.roleid where am.member = 'postgres'::regrole), '<none>')
union all select 'api_roles', (select string_agg(rolname || '(login=' || rolcanlogin || ',bypassrls=' || rolbypassrls || ',inherit=' || rolinherit || ')', ' ' order by rolname) from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator'))
union all select 'db_create_for_postgres', has_database_privilege('postgres', current_database(), 'CREATE')::text
union all select 'row_counts', (select count(*) from public.appointments)::text || ' appts / ' || (select count(*) from public.clients)::text || ' clients / ' || (select count(*) from public.studios)::text || ' studios';
