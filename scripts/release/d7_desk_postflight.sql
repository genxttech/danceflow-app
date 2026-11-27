-- D7 pre-expiry release (desk RPC database guard, migration 20270205100000): POSTFLIGHT (read-only; DEV and PROD, after applying).
-- Run via:  D7_FLIGHT_PREFIX=d7_desk bash scripts/release/d7_core_flight.sh postflight <dev|prod> <evidence-dir>
-- Every row must have ok = true. Reports failing rows (never errors) on an unapplied target.
with
 fn as (select p.* from pg_proc p where p.oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)')),
 helper as (select p.* from pg_proc p where p.oid = to_regprocedure('public._d7_competition_desk_suite_allows(uuid,timestamptz)')),
 checks(seq, check_name, ok, detail) as (
  select 1, 'the desk RPC exists exactly once', (select count(*) from fn) = 1, null
  union all select 2, 'BODY IS THE REVIEWED NEW DEFINITION (src_md5 de5f23f0a9363e0c24a2ad8a8d178aba)',
         coalesce((select md5(prosrc) = 'de5f23f0a9363e0c24a2ad8a8d178aba' from fn), false), (select md5(prosrc) from fn)
  union all select 3, 'owner is postgres, SECURITY DEFINER, same settings',
         coalesce((select pg_get_userbyid(proowner) = 'postgres' and prosecdef from fn), false), (select coalesce(proconfig::text, 'none') from fn)
  union all select 4, 'grants unchanged: authenticated can execute; anon and PUBLIC cannot',
         coalesce((select has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE')
                          and not exists (select 1 from aclexplode(proacl) x where x.grantee = 0) from fn), false), (select proacl::text from fn)
  union all select 5, 'the guard helper exists, is owned by postgres and is executable by nobody else',
         coalesce((select pg_get_userbyid(proowner) = 'postgres'
                          and not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE')
                          and not has_function_privilege('service_role', oid, 'EXECUTE')
                          and not exists (select 1 from aclexplode(proacl) x where x.grantee = 0) from helper), false), (select proacl::text from helper)
  union all select 6, 'dependency still present (usage_addon_entitlement_is_current)',
         to_regprocedure('public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)') is not null, null
  union all select 7, 'INFO def_md5 after apply (on PostgreSQL 17 the reviewed value is 70285eaf8c11f4cb34cb487fa1d3f47a)',
         true, (select md5(pg_get_functiondef(oid)) from fn)
  union all select 8, 'INFO server version', true, current_setting('server_version')
 )
select seq, check_name, coalesce(ok, false) as ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(coalesce(ok, false)), false), null from checks
order by seq;
