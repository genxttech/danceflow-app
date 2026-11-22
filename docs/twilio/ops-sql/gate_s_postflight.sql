-- Gate S POSTFLIGHT (read-only). Expected after the apply: ok = true.
with p as (
 select
  to_regclass('public.studio_sms_pending_opt_outs') is not null as table_exists,
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.studio_sms_pending_opt_outs')), false) as rls_on,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='studio_sms_pending_opt_outs' and grantee in ('anon','authenticated','public','service_role')) as table_grants_client_or_service,
  (select count(*) from (values ('public.sms_pending_opt_out_record(uuid,text,text)'),('public.sms_pending_opt_out_supersede(uuid,text)'),('public.sms_pending_opt_out_apply(integer)'),('public.sms_pending_opt_out_blocks(uuid,text)')) f(sig) where to_regprocedure(sig) is not null) as fns_present,
  (select count(*) from (values ('public.sms_pending_opt_out_record(uuid,text,text)'),('public.sms_pending_opt_out_supersede(uuid,text)'),('public.sms_pending_opt_out_apply(integer)'),('public.sms_pending_opt_out_blocks(uuid,text)')) f(sig) where to_regprocedure(sig) is not null and has_function_privilege('service_role', to_regprocedure(sig), 'execute')) as fns_service_exec,
  (select count(*) from (values ('public.sms_pending_opt_out_record(uuid,text,text)'),('public.sms_pending_opt_out_supersede(uuid,text)'),('public.sms_pending_opt_out_apply(integer)'),('public.sms_pending_opt_out_blocks(uuid,text)')) f(sig) where to_regprocedure(sig) is not null and (has_function_privilege('anon', to_regprocedure(sig), 'execute') or has_function_privilege('authenticated', to_regprocedure(sig), 'execute'))) as fns_client_exec,
  (select count(*) from pg_proc where proname like 'sms_pending_opt_out_%' and pronamespace='public'::regnamespace and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) as fns_secdef_pinned,
  (select count(*) from pg_indexes where tablename='studio_sms_pending_opt_outs' and indexname='uq_studio_sms_pending_opt_outs_open') as open_unique_idx,
  case when to_regprocedure('public.sms_pending_opt_out_blocks(uuid,text)') is not null then public.sms_pending_opt_out_blocks('00000000-0000-4000-8000-000000000000','+15550000000') end as blocks_probe,
  (select count(*) from public.studio_sms_pending_opt_outs) as rows_now
)
select json_build_object('now', now(), 'detail', to_jsonb(p),
 'ok', (table_exists and rls_on and table_grants_client_or_service = 0 and fns_present = 4 and fns_service_exec = 4 and fns_client_exec = 0
        and fns_secdef_pinned = 4 and open_unique_idx = 1 and blocks_probe = false and rows_now = 0)) as r from p;
