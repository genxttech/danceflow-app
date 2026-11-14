-- TW-4F 20270217090000 + 20270218090000: read-only preflight / postflight (run through danceflow-ops/sb.sh dev-read | prod-read).
-- One row. Expected values: docs/twilio/TW-4F_0217_0218_Apply_Package.md section 3.
select jsonb_build_object(
  -- (no migration-history table: the TW-4F chains are applied as plain SQL, so state is read from the catalog)
  'segments_fn', to_regprocedure('public._tw4us_segments(text)') is not null,
  'segments_md5', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public._tw4us_segments(text)')),
  'segments_acl', (select coalesce(proacl::text, 'default') from pg_proc where oid = to_regprocedure('public._tw4us_segments(text)')),
  'recover_fn', to_regprocedure('public.tw4_inbound_recover(uuid, text, jsonb)') is not null,
  'recover_md5', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.tw4_inbound_recover(uuid, text, jsonb)')),
  'recover_acl', (select coalesce(proacl::text, 'default') from pg_proc where oid = to_regprocedure('public.tw4_inbound_recover(uuid, text, jsonb)')),
  'entity_studios_table', to_regclass('public.studio_sms_entity_studios') is not null,
  'start_signals_table', to_regclass('public.studio_sms_inbound_start_signals') is not null,
  'start_signals_rows', (select count(*) from pg_class c where c.oid = to_regclass('public.studio_sms_inbound_start_signals')),
  'start_signal_record_fn', to_regprocedure('public.sms_inbound_start_signal_record(uuid, text, text)') is not null,
  'start_sids_fn', to_regprocedure('public.tw4_inbound_start_sids(text, text, text[])') is not null,
  'start_sids_acl', (select coalesce(proacl::text, 'default') from pg_proc where oid = to_regprocedure('public.tw4_inbound_start_sids(text, text, text[])')),
  'signal_record_acl', (select coalesce(proacl::text, 'default') from pg_proc where oid = to_regprocedure('public.sms_inbound_start_signal_record(uuid, text, text)')),
  'pending_opt_outs_table', to_regclass('public.studio_sms_pending_opt_outs') is not null,
  'local_qa_marker', to_regclass('public.tw4_local_qa_only') is not null,
  'billed_senders', (select count(*) from public.studio_sms_billed_senders),
  'usage_attempts', (select count(*) from public.studio_sms_usage_attempts),
  'server_version', current_setting('server_version')
) as tw4f_0217_0218;
