select 'm12_tables_present' k, count(*)::text v from pg_class where relnamespace='public'::regnamespace and relname in ('intake_invitations','intake_sessions','intake_rate_limits')
union all select 'ensure_marker', case when position('nsi-body:m11' in prosrc)>0 then 'm11' when position('nsi-body:m10' in prosrc)>0 then 'm10' else 'other' end from pg_proc where proname='intake_ensure_request' and pronamespace='public'::regnamespace
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'outbound_deliveries_exists', (to_regclass('public.outbound_deliveries') is not null)::text
union all select 'intake_rows_total', (select sum((xpath('/row/c/text()', query_to_xml('select count(*) c from public.'||quote_ident(relname), false, true, '')))[1]::text::int)::text from pg_class where relnamespace='public'::regnamespace and relname like 'intake\_%' and relkind='r')
union all select 'outbound_intake_rows', count(*)::text from public.outbound_deliveries where template_key like 'intake%'
union all select 'active_sessions_other_than_me', count(*)::text from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid() and query ~* 'intake_'
