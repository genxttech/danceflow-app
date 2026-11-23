select 'erase_marker' k, case when prosrc ~ 'nsi-body:m14' then 'm14' when prosrc ~ 'nsi-body:m12' then 'm12' else 'other' end v from pg_proc where proname='erase_client_impl' and pronamespace='intake_private'::regnamespace
union all select 'purge_marker', case when prosrc ~ 'nsi-body:m14' then 'm14' when prosrc ~ 'nsi-body:m13' then 'm13' else 'older' end from pg_proc where proname='purge_expired_impl' and pronamespace='intake_private'::regnamespace
union all select 'hold_insert_guard_exists', (to_regprocedure('intake_private.legal_hold_insert_guard()') is not null)::text
union all select 'hold_insert_trigger', count(*)::text from pg_trigger where tgname='intake_legal_holds_05_lock' and not tgisinternal
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'intake_rows_total', (select sum((xpath('/row/c/text()', query_to_xml('select count(*) c from public.'||quote_ident(relname), false, true, '')))[1]::text::int)::text from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'intake\_%')
union all select 'outbound_intake_rows', count(*)::text from public.outbound_deliveries where template_key like 'intake%'
union all select 'busy_intake_sessions', count(*)::text from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid() and query ~* 'intake_'
union all select 'appointments_fp', md5((select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid='public.appointments'::regclass and not tgisinternal))
order by 1;
