select 'assert_catalog' k, (select 'ok' from (select intake_private.assert_catalog()) x) v
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'ensure_marker', case when position('nsi-body:m10' in prosrc)>0 then 'm10' when position('nsi-body:m8' in prosrc)>0 then 'm8' else 'other' end from pg_proc where proname='intake_ensure_request' and pronamespace='public'::regnamespace
union all select 'intake_rows_total', (select sum((xpath('/row/c/text()', query_to_xml('select count(*) c from public.'||quote_ident(relname), false, true, '')))[1]::text::int)::text from pg_class where relnamespace='public'::regnamespace and relname like 'intake\_%' and relkind='r')
union all select 'outbound_intake_rows', count(*)::text from public.outbound_deliveries where template_key like 'intake%'
