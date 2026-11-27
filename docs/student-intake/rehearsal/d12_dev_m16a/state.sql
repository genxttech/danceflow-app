select 'erase_marker' k, case when prosrc ~ 'nsi-body:m16a' then 'm16a' when prosrc ~ 'nsi-body:m14' then 'm14' else 'other' end v from pg_proc where proname='erase_client_impl' and pronamespace='intake_private'::regnamespace
union all select 'respondents_guard_marker', case when prosrc ~ 'nsi-body:m16a' then 'm16a' else 'm3' end from pg_proc where proname='respondents_guard' and pronamespace='intake_private'::regnamespace
union all select 'attestations_table', (to_regclass('public.intake_guardian_attestations') is not null)::text
union all select 'fulfillment_marker', case when prosrc ~ 'nsi-body:m15' then 'm15' else 'other' end from pg_proc where proname='fulfillment_state' and pronamespace='intake_private'::regnamespace
union all select 'assert_catalog', (select 'ok' from (select intake_private.assert_catalog()) x)
union all select 'gate_open', intake_private.retention_gate_open()::text
union all select 'intake_rows_total', (select sum((xpath('/row/c/text()', query_to_xml('select count(*) c from public.'||quote_ident(relname), false, true, '')))[1]::text::int)::text from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'intake\_%')
union all select 'outbound_intake_rows', count(*)::text from public.outbound_deliveries where template_key like 'intake%'
union all select 'busy_intake_sessions', count(*)::text from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid() and query ~* 'intake_'
union all select 'respondents_assurance_staff_attested', (select count(*)::text from public.intake_respondents where assurance = 'staff_attested')
order by 1;
