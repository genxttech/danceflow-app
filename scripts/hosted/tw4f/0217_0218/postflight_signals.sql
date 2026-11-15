-- TW-4F 20270218090000 postflight only (the table exists only after the forward apply). Read-only; run through sb.sh dev-read | prod-read.
-- Expected right after the apply: rows 0 (the live app does not write START signals yet); 3 indexes besides the primary key.
select (select count(*) from public.studio_sms_inbound_start_signals) as start_signal_rows,
       (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'studio_sms_inbound_start_signals') as indexes,
       has_table_privilege('anon', 'public.studio_sms_inbound_start_signals', 'select') as anon_select,
       has_table_privilege('authenticated', 'public.studio_sms_inbound_start_signals', 'select') as authenticated_select,
       has_table_privilege('service_role', 'public.studio_sms_inbound_start_signals', 'select') as service_role_select,
       has_function_privilege('anon', 'public.tw4_inbound_start_sids(text, text, text[])', 'execute') as anon_start_sids,
       has_function_privilege('authenticated', 'public.sms_inbound_start_signal_record(uuid, text, text)', 'execute') as authenticated_signal_record;
