select 'purge_marker' k, case when position('nsi-body:m13' in prosrc)>0 then 'm13' else 'older' end v from pg_proc where proname='purge_expired_impl' and pronamespace='intake_private'::regnamespace
union all select 'issue_marker', case when position('nsi-body:m12' in prosrc)>0 then 'm12' else 'other' end from pg_proc where proname='intake_issue_invitation' and pronamespace='public'::regnamespace
union all select 'm12_tables_present', count(*)::text from pg_class where relnamespace='public'::regnamespace and relname in ('intake_invitations','intake_sessions','intake_rate_limits')
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'outbound_deliveries_exists', (to_regclass('public.outbound_deliveries') is not null)::text
union all select 'intake_rows_total', (select sum((xpath('/row/c/text()', query_to_xml('select count(*) c from public.'||quote_ident(relname), false, true, '')))[1]::text::int)::text from pg_class where relnamespace='public'::regnamespace and relname like 'intake\_%' and relkind='r')
union all select 'outbound_intake_rows', count(*)::text from public.outbound_deliveries where template_key like 'intake%'
union all select 'busy_intake_sessions', count(*)::text from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid() and query ~* 'intake_'
