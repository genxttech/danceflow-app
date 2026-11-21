-- D7 pre-expiry release (desk RPC database guard, migration 20270205100000): PREFLIGHT (read-only; DEV and PROD, before applying).
-- Run via:  D7_FLIGHT_PREFIX=d7_desk bash scripts/release/d7_core_flight.sh preflight <dev|prod> <evidence-dir>
-- Every row must have ok = true. The migration replaces public.record_competition_checkin_payment WHOLESALE, so it must only be applied
-- where the live definition IS the repository's 20261116094000 definition (src_md5 is the hash of the function body text and is
-- independent of the PostgreSQL version; def_md5 hashes pg_get_functiondef and may legitimately differ across majors, so it is INFO).
with
 fn as (select p.* from pg_proc p where p.oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)')),
 checks(seq, check_name, ok, detail) as (
  select 1, 'dependency: migration 20270203090000 is applied (usage_addon_entitlement_is_current exists)',
         to_regprocedure('public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)') is not null, null
  union all select 2, 'the desk RPC exists exactly once', (select count(*) from fn) = 1, null
  union all select 3, 'LIVE BODY EQUALS THE REPOSITORY 20261116094000 DEFINITION (src_md5 387aacac2effd055340e27211b8f7e4f): no drift',
         coalesce((select md5(prosrc) = '387aacac2effd055340e27211b8f7e4f' from fn), false), (select md5(prosrc) from fn)
  union all select 4, 'owner is postgres and the function is SECURITY DEFINER',
         coalesce((select pg_get_userbyid(proowner) = 'postgres' and prosecdef from fn), false), (select pg_get_userbyid(proowner) || ' definer=' || prosecdef::text from fn)
  union all select 5, 'authenticated can execute; anon and PUBLIC cannot',
         coalesce((select has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE')
                          and not exists (select 1 from aclexplode(proacl) x where x.grantee = 0) from fn), false), (select proacl::text from fn)
  union all select 6, 'the new guard helper is ABSENT (not yet applied)',
         to_regprocedure('public._d7_competition_desk_suite_allows(uuid,timestamptz)') is null, null
  union all select 7, 'the tables the guard reads exist',
         to_regclass('public.studio_subscriptions') is not null and to_regclass('public.subscription_plans') is not null
         and to_regclass('public.usage_addon_entitlements') is not null and to_regclass('public.studios') is not null and to_regclass('public.event_orders') is not null, null
  union all select 8, 'INFO def_md5 of the live definition (the repo value on PostgreSQL 17 is 8fd8184a82861cbc43cb3d33ea88e54b)',
         true, (select md5(pg_get_functiondef(oid)) from fn)
  union all select 9, 'INFO function settings (search_path etc.)', true, coalesce((select proconfig::text from fn), 'none')
  union all select 10, 'INFO server version', true, current_setting('server_version')
  union all select 11, 'INFO day-one impact: PENDING organizer-event orders that the guard could refuse a desk payment on',
         true, (select count(*)::text from public.event_orders o join public.events e on e.id = o.event_id
                where e.organizer_id is not null and o.status = 'pending' and coalesce(o.payment_status, '') <> 'paid')
 )
select seq, check_name, coalesce(ok, false) as ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(coalesce(ok, false)), false), null from checks
order by seq;
