-- Gate S PREFLIGHT (read-only). Expected on PROD before the apply: all *_absent true, deps true, no open drift.
select json_build_object(
 'now', now(),
 'table_absent', to_regclass('public.studio_sms_pending_opt_outs') is null,
 'fn_record_absent',    to_regprocedure('public.sms_pending_opt_out_record(uuid,text,text)') is null,
 'fn_supersede_absent', to_regprocedure('public.sms_pending_opt_out_supersede(uuid,text)') is null,
 'fn_apply_absent',     to_regprocedure('public.sms_pending_opt_out_apply(integer)') is null,
 'fn_blocks_absent',    to_regprocedure('public.sms_pending_opt_out_blocks(uuid,text)') is null,
 'dep_studios', to_regclass('public.studios') is not null,
 'dep_studios_id_pk', exists (select 1 from pg_constraint where conrelid='public.studios'::regclass and contype='p'),
 'dep_opt_event_fn', to_regprocedure('public.record_sms_inbound_opt_event(uuid,text,text)') is not null,
 'dep_gen_random_uuid', to_regprocedure('gen_random_uuid()') is not null,
 'prior_0217_applied', (select position('v_starters' in pg_get_functiondef(to_regprocedure('public._tw4us_segments(text)'))) > 0),
 'prior_0218_applied', to_regprocedure('public.record_sms_inbound_opt_event(uuid,text,text)') is not null,
 'price_rows_active', (select count(*) from public.studio_sms_price_list where active),
 'price_pending', (select count(*) from public.studio_sms_price_change_requests where status='pending'),
 'monitor_last', (select max(recorded_at) from public.studio_sms_price_monitor_evidence where kind='run'),
 'long_running_txns', (select count(*) from pg_stat_activity where state <> 'idle' and xact_start < now() - interval '1 minute' and pid <> pg_backend_pid()),
 'blocking_locks_on_studios', (select count(*) from pg_locks l where l.relation='public.studios'::regclass and not l.granted)
) as r;
