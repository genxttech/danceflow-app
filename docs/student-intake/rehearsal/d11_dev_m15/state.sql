select 'erase_marker' k, case when prosrc ~ 'nsi-body:m14' then 'm14' else 'other' end v from pg_proc where proname='erase_client_impl' and pronamespace='intake_private'::regnamespace
union all select 'm15_present', (to_regprocedure('public.intake_determine_minor_from_birthday(uuid,uuid)') is not null)::text
union all select 'fulfillment_marker', case when prosrc ~ 'nsi-body:m15' then 'm15' else 'm3' end from pg_proc where proname='fulfillment_state' and pronamespace='intake_private'::regnamespace
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'intake_rows_total', (select sum((xpath('/row/c/text()', query_to_xml('select count(*) c from public.'||quote_ident(relname), false, true, '')))[1]::text::int)::text from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'intake\_%')
union all select 'outbound_intake_rows', count(*)::text from public.outbound_deliveries where template_key like 'intake%'
union all select 'busy_intake_sessions', count(*)::text from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid() and query ~* 'intake_'
union all select 'col_studio_settings_timezone_id', (select count(*)::text from information_schema.columns where table_schema='public' and table_name='studio_settings' and column_name in ('timezone','id','studio_id'))
union all select 'col_studios_timezone', (select count(*)::text from information_schema.columns where table_schema='public' and table_name='studios' and column_name='timezone')
union all select 'col_clients_birthday_date', (select count(*)::text from information_schema.columns where table_schema='public' and table_name='clients' and column_name='birthday' and data_type='date')
union all select 'col_intake_settings_threshold', (select count(*)::text from information_schema.columns where table_schema='public' and table_name='intake_settings' and column_name='minor_age_threshold')
union all select 'studio_settings_studio_id_unique', (select count(*)::text from pg_constraint c where c.conrelid='public.studio_settings'::regclass and c.contype in ('u','p') and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid=c.conrelid and a.attnum = any(c.conkey))=array['studio_id'])

order by 1;
